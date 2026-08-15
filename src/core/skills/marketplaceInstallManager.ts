import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  installMarketplaceSkill,
  recoverSkillMarketplaceInstallations,
  type SkillMarketplaceEntry,
  type SkillMarketplaceInstallPhase,
  type SkillMarketplaceInstallProgress,
  type SkillMarketplaceRecoveryResult,
} from './marketplace'
import { SkillMarketplaceRequestController } from './marketplaceNetwork'

export type SkillMarketplaceInstallJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type SkillMarketplaceInstallJobPhase = 'queued' | SkillMarketplaceInstallPhase | 'failed' | 'canceled'

export interface SkillMarketplaceInstallJob {
  id: string
  marketplaceId: string
  skillId: string
  name: string
  status: SkillMarketplaceInstallJobStatus
  phase: SkillMarketplaceInstallJobPhase
  createdAt: number
  startedAt?: number
  updatedAt: number
  completedAt?: number
  queuePosition?: number
  filesCompleted: number
  filesTotal: number
  bytesCompleted: number
  bytesTotal: number
  progress: number
  bytesPerSecond: number
  currentFile?: string
  transport?: SkillMarketplaceInstallProgress['transport']
  retry?: SkillMarketplaceInstallProgress['retry']
  assessment?: SkillMarketplaceInstallProgress['assessment']
  circuits?: SkillMarketplaceInstallProgress['circuits']
  error?: string
  errorCode?: string
  retryable: boolean
}

export interface SkillMarketplaceInstallManagerSnapshot {
  jobs: SkillMarketplaceInstallJob[]
  recovery?: SkillMarketplaceRecoveryResult
}

export interface SkillMarketplaceInstallManagerOptions {
  targetRoot?: string
  statePath?: string
  concurrency?: number
  now?: () => number
  requestController?: SkillMarketplaceRequestController
}

export type SkillMarketplaceInstallJobListener = (job: SkillMarketplaceInstallJob) => void

interface QueueItem {
  jobId: string
  allowOverwrite: boolean
  controller: AbortController
  resolve: (entry: SkillMarketplaceEntry) => void
  reject: (error: unknown) => void
}

interface PersistedState {
  schemaVersion: 1
  jobs: SkillMarketplaceInstallJob[]
  recovery?: SkillMarketplaceRecoveryResult
}

function cloneJob(job: SkillMarketplaceInstallJob): SkillMarketplaceInstallJob {
  return JSON.parse(JSON.stringify(job)) as SkillMarketplaceInstallJob
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { code?: unknown }).code
  return typeof value === 'string' ? value : undefined
}

function isCanceled(error: unknown): boolean {
  return errorCode(error) === 'SKILL_INSTALL_CANCELED' || (error as { name?: unknown })?.name === 'AbortError'
}

function createCanceledError(): Error {
  return Object.assign(new Error('下载已取消'), { name: 'AbortError', code: 'SKILL_INSTALL_CANCELED' })
}

export class SkillMarketplaceInstallManager {
  private readonly targetRoot?: string
  private readonly statePath?: string
  private readonly concurrency: number
  private readonly now: () => number
  private readonly requestController: SkillMarketplaceRequestController
  private readonly jobs = new Map<string, SkillMarketplaceInstallJob>()
  private readonly queue: QueueItem[] = []
  private readonly active = new Map<string, QueueItem>()
  private readonly activeByMarketplaceId = new Map<string, string>()
  private readonly promisesByMarketplaceId = new Map<string, Promise<SkillMarketplaceEntry>>()
  private readonly listeners = new Set<SkillMarketplaceInstallJobListener>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private recovery?: SkillMarketplaceRecoveryResult
  private sequence = 0

  constructor(options: SkillMarketplaceInstallManagerOptions = {}) {
    this.targetRoot = options.targetRoot
    this.statePath = options.statePath
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2))
    this.now = options.now ?? Date.now
    this.requestController = options.requestController ?? new SkillMarketplaceRequestController()
  }

  async initialize(): Promise<SkillMarketplaceInstallManagerSnapshot> {
    await this.loadPersistedState()
    this.recovery = await recoverSkillMarketplaceInstallations(this.targetRoot)
    const interruptedAt = this.now()
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' && job.status !== 'running') continue
      Object.assign(job, {
        status: 'failed',
        phase: 'failed',
        updatedAt: interruptedAt,
        completedAt: interruptedAt,
        error: '应用上次退出时安装尚未完成，已清理临时状态，可以重试',
        errorCode: 'SKILL_INSTALL_INTERRUPTED',
        retryable: true,
        queuePosition: undefined,
      } satisfies Partial<SkillMarketplaceInstallJob>)
    }
    await this.persistNow()
    return this.snapshot()
  }

  subscribe(listener: SkillMarketplaceInstallJobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): SkillMarketplaceInstallManagerSnapshot {
    return {
      jobs: [...this.jobs.values()].sort((left, right) => right.createdAt - left.createdAt).map(cloneJob),
      recovery: this.recovery ? JSON.parse(JSON.stringify(this.recovery)) as SkillMarketplaceRecoveryResult : undefined,
    }
  }

  latestJob(marketplaceId: string): SkillMarketplaceInstallJob | undefined {
    return this.snapshot().jobs.find(job => job.marketplaceId === marketplaceId)
  }

  install(entry: Pick<SkillMarketplaceEntry, 'id' | 'skillId' | 'name'>, allowOverwrite = false): Promise<SkillMarketplaceEntry> {
    const existingPromise = this.promisesByMarketplaceId.get(entry.id)
    if (existingPromise) return existingPromise

    const timestamp = this.now()
    const jobId = `skill-install-${timestamp.toString(36)}-${(++this.sequence).toString(36)}`
    const job: SkillMarketplaceInstallJob = {
      id: jobId,
      marketplaceId: entry.id,
      skillId: entry.skillId,
      name: entry.name,
      status: 'queued',
      phase: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      queuePosition: this.queue.length + 1,
      filesCompleted: 0,
      filesTotal: 0,
      bytesCompleted: 0,
      bytesTotal: 0,
      progress: 0,
      bytesPerSecond: 0,
      retryable: false,
    }
    this.jobs.set(jobId, job)
    this.activeByMarketplaceId.set(entry.id, jobId)
    const promise = new Promise<SkillMarketplaceEntry>((resolveInstall, rejectInstall) => {
      this.queue.push({ jobId, allowOverwrite, controller: new AbortController(), resolve: resolveInstall, reject: rejectInstall })
    })
    this.promisesByMarketplaceId.set(entry.id, promise)
    this.refreshQueuePositions()
    this.emit(job)
    this.schedulePersist()
    this.drain()
    return promise
  }

  cancel(marketplaceId: string): SkillMarketplaceInstallJob | undefined {
    const jobId = this.activeByMarketplaceId.get(marketplaceId)
    if (!jobId) return this.latestJob(marketplaceId)
    const running = this.active.get(jobId)
    if (running) {
      running.controller.abort()
      return this.jobs.get(jobId) ? cloneJob(this.jobs.get(jobId)!) : undefined
    }
    const queueIndex = this.queue.findIndex(item => item.jobId === jobId)
    if (queueIndex < 0) return undefined
    const [queued] = this.queue.splice(queueIndex, 1)
    const job = this.jobs.get(jobId)!
    this.finishJob(job, 'canceled', createCanceledError())
    queued.reject(createCanceledError())
    this.activeByMarketplaceId.delete(marketplaceId)
    this.promisesByMarketplaceId.delete(marketplaceId)
    this.refreshQueuePositions()
    return cloneJob(job)
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!
      this.active.set(item.jobId, item)
      const job = this.jobs.get(item.jobId)!
      job.status = 'running'
      job.phase = 'resolving'
      job.startedAt = this.now()
      job.updatedAt = job.startedAt
      job.queuePosition = undefined
      this.emit(job)
      this.refreshQueuePositions()
      void this.run(item, job)
    }
  }

  private async run(item: QueueItem, job: SkillMarketplaceInstallJob): Promise<void> {
    try {
      const installed = await installMarketplaceSkill(job.marketplaceId, {
        targetRoot: this.targetRoot,
        allowOverwrite: item.allowOverwrite,
        signal: item.controller.signal,
        requestController: this.requestController,
        onProgress: progress => this.updateProgress(job, progress),
      })
      this.finishJob(job, 'completed')
      item.resolve(installed)
    } catch (error) {
      const status = isCanceled(error) ? 'canceled' : 'failed'
      this.finishJob(job, status, error)
      item.reject(error)
    } finally {
      this.active.delete(job.id)
      this.activeByMarketplaceId.delete(job.marketplaceId)
      this.promisesByMarketplaceId.delete(job.marketplaceId)
      this.drain()
    }
  }

  private updateProgress(job: SkillMarketplaceInstallJob, progress: SkillMarketplaceInstallProgress): void {
    const now = this.now()
    const elapsedSeconds = job.startedAt ? Math.max(0.001, (now - job.startedAt) / 1_000) : 0
    job.phase = progress.phase
    job.updatedAt = now
    job.filesCompleted = progress.filesCompleted
    job.filesTotal = progress.filesTotal
    job.bytesCompleted = progress.bytesCompleted
    job.bytesTotal = progress.bytesTotal
    job.progress = progress.bytesTotal > 0
      ? Math.max(0, Math.min(1, progress.bytesCompleted / progress.bytesTotal))
      : progress.filesTotal > 0
        ? Math.max(0, Math.min(1, progress.filesCompleted / progress.filesTotal))
        : 0
    job.bytesPerSecond = elapsedSeconds > 0 ? Math.round(progress.bytesCompleted / elapsedSeconds) : 0
    job.currentFile = progress.currentFile
    job.transport = progress.transport
    job.retry = progress.retry
    job.assessment = progress.assessment
    job.circuits = progress.circuits
    this.emit(job)
    this.schedulePersist()
  }

  private finishJob(job: SkillMarketplaceInstallJob, status: Extract<SkillMarketplaceInstallJobStatus, 'completed' | 'failed' | 'canceled'>, error?: unknown): void {
    const now = this.now()
    job.status = status
    job.phase = status
    job.updatedAt = now
    job.completedAt = now
    job.queuePosition = undefined
    job.currentFile = undefined
    job.retry = undefined
    if (status === 'completed') {
      job.progress = 1
      job.filesCompleted = job.filesTotal
      job.bytesCompleted = Math.max(job.bytesCompleted, job.bytesTotal)
      job.retryable = false
      job.error = undefined
      job.errorCode = undefined
    } else {
      job.error = error instanceof Error ? error.message : String(error || '安装失败')
      job.errorCode = errorCode(error)
      job.retryable = status === 'canceled' || !['SKILL_INSTALL_INSUFFICIENT_DISK', 'SKILL_INSTALL_INSUFFICIENT_FILE_SLOTS'].includes(job.errorCode || '')
    }
    this.emit(job)
    this.schedulePersist()
  }

  private refreshQueuePositions(): void {
    this.queue.forEach((item, index) => {
      const job = this.jobs.get(item.jobId)
      if (!job) return
      job.queuePosition = index + 1
      job.updatedAt = this.now()
      this.emit(job)
    })
  }

  private emit(job: SkillMarketplaceInstallJob): void {
    const snapshot = cloneJob(job)
    for (const listener of this.listeners) listener(snapshot)
  }

  private schedulePersist(): void {
    if (!this.statePath || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persistNow().catch(() => undefined)
    }, 200)
  }

  private async loadPersistedState(): Promise<void> {
    if (!this.statePath) return
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>
      if (state.schemaVersion !== 1 || !Array.isArray(state.jobs)) return
      for (const job of state.jobs.slice(0, 50)) {
        if (!job?.id || !job.marketplaceId || !job.skillId) continue
        this.jobs.set(job.id, job)
      }
      this.recovery = state.recovery
    } catch {
      // Missing or malformed state is recoverable; filesystem recovery remains authoritative.
    }
  }

  private async persistNow(): Promise<void> {
    if (!this.statePath) return
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.tmp`
    const state: PersistedState = {
      schemaVersion: 1,
      jobs: this.snapshot().jobs.slice(0, 50),
      recovery: this.recovery,
    }
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporaryPath, this.statePath)
  }
}
