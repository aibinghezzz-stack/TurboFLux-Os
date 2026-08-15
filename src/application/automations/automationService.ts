import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ApprovalPolicy } from '../../shared/agentTypes'
import { AtomicJsonStore } from '../platform/atomicJsonStore'

export type AutomationSchedule =
  | { kind: 'manual' }
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }

export type AutomationMisfirePolicy = 'run-once' | 'skip'
export type AutomationOverlapPolicy = 'skip' | 'queue-one'
export type AutomationRunTrigger = 'manual' | 'scheduled' | 'retry' | 'recovery'
export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_workspace'
  | 'waiting_for_approval'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'missed'

export interface AutomationRetryPolicy {
  maxRetries: number
  backoffMinutes: number
}

export interface AutomationRunRecord {
  id: string
  inputId?: string
  conversationId?: string
  trigger: AutomationRunTrigger
  status: AutomationRunStatus
  scheduledFor?: number
  attempt: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  retryAt?: number
  durationMs?: number
  resultSummary?: string
  error?: string
}

export interface AutomationRecord {
  id: string
  name: string
  prompt: string
  workspacePath: string
  schedule: AutomationSchedule
  timezone: string
  enabled: boolean
  approvalPolicy: ApprovalPolicy
  misfirePolicy: AutomationMisfirePolicy
  overlapPolicy: AutomationOverlapPolicy
  retryPolicy: AutomationRetryPolicy
  maxRuntimeMinutes: number
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  pendingRunAt?: number
  activeRunId?: string
  conversationId?: string
  lastRunAt?: number
  lastSuccessAt?: number
  lastDurationMs?: number
  lastStatus?: AutomationRunStatus
  lastError?: string
  lastInputId?: string
  history: AutomationRunRecord[]
}

export interface AutomationSchedulerHealth {
  status: 'idle' | 'watching' | 'running' | 'degraded'
  lastTickAt?: number
  nextWakeAt?: number
  activeRuns: number
  error?: string
}

export interface AutomationSnapshot {
  schemaVersion: 2
  warnings: string[]
  scheduler: AutomationSchedulerHealth
  automations: AutomationRecord[]
}

export interface AutomationClaim {
  automation: AutomationRecord
  run: AutomationRunRecord
}

interface AutomationStoreFile {
  schemaVersion: 1 | 2
  automations: AutomationRecord[]
}

interface AutomationCreateInput {
  name: string
  prompt: string
  workspacePath: string
  schedule: AutomationSchedule
  timezone?: string
  enabled?: boolean
  approvalPolicy?: ApprovalPolicy
  misfirePolicy?: AutomationMisfirePolicy
  overlapPolicy?: AutomationOverlapPolicy
  retryPolicy?: Partial<AutomationRetryPolicy>
  maxRuntimeMinutes?: number
}

export type AutomationUpdateInput = Partial<Pick<AutomationRecord,
  'name' | 'prompt' | 'enabled' | 'approvalPolicy' | 'timezone' | 'misfirePolicy' | 'overlapPolicy' | 'maxRuntimeMinutes'>> & {
    schedule?: AutomationSchedule
    retryPolicy?: Partial<AutomationRetryPolicy>
  }

const HISTORY_LIMIT = 100
const MISFIRE_GRACE_MS = 60_000

function validStore(value: unknown): value is AutomationStoreFile {
  if (!value || typeof value !== 'object') return false
  const store = value as Partial<AutomationStoreFile>
  return (store.schemaVersion === 1 || store.schemaVersion === 2) && Array.isArray(store.automations)
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function normalizeTimezone(value: unknown): string {
  const timezone = typeof value === 'string' && value.trim() ? value.trim() : defaultTimezone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
  } catch {
    throw new Error(`Invalid automation timezone: ${timezone}`)
  }
  return timezone
}

function normalizeSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === 'once') {
    const timestamp = Date.parse(schedule.at)
    if (!Number.isFinite(timestamp)) throw new Error('One-time automation must use a valid date and time')
    return { kind: 'once', at: new Date(timestamp).toISOString() }
  }
  if (schedule.kind === 'interval') {
    const everyMinutes = Math.floor(Number(schedule.everyMinutes))
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new Error('Automation interval must be at least one minute')
    return { kind: 'interval', everyMinutes: Math.min(525_600, everyMinutes) }
  }
  if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('Scheduled automation time must use HH:mm')
    if (schedule.kind === 'weekly') {
      if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) throw new Error('Weekly automation weekday must be between 0 and 6')
      return { kind: 'weekly', weekday: schedule.weekday, time: schedule.time }
    }
    return { kind: 'daily', time: schedule.time }
  }
  return { kind: 'manual' }
}

function zonedParts(timestamp: number, timezone: string): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday),
    hour: Number(value.hour),
    minute: Number(value.minute),
  }
}

export function nextAutomationRunAt(schedule: AutomationSchedule, timezone: string, after = Date.now()): number | undefined {
  if (schedule.kind === 'manual') return undefined
  if (schedule.kind === 'once') {
    const timestamp = Date.parse(schedule.at)
    return timestamp > after ? timestamp : undefined
  }
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000
  const [targetHour, targetMinute] = schedule.time.split(':').map(Number)
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000
  const searchMinutes = schedule.kind === 'weekly' ? 8 * 24 * 60 : 2 * 24 * 60
  for (let index = 0; index < searchMinutes; index += 1, candidate += 60_000) {
    const parts = zonedParts(candidate, timezone)
    if (parts.hour !== targetHour || parts.minute !== targetMinute) continue
    if (schedule.kind === 'weekly' && parts.weekday !== schedule.weekday) continue
    return candidate
  }
  throw new Error(`Unable to resolve the next automation time in ${timezone}`)
}

function nextFutureRunAt(schedule: AutomationSchedule, timezone: string, scheduledFor: number, now: number): number | undefined {
  if (schedule.kind === 'once' || schedule.kind === 'manual') return undefined
  if (schedule.kind === 'interval') {
    const intervalMs = schedule.everyMinutes * 60_000
    const elapsedIntervals = Math.floor(Math.max(0, now - scheduledFor) / intervalMs) + 1
    return scheduledFor + elapsedIntervals * intervalMs
  }
  let next = nextAutomationRunAt(schedule, timezone, scheduledFor)
  let guard = 0
  while (next !== undefined && next <= now && guard < 400) {
    next = nextAutomationRunAt(schedule, timezone, next)
    guard += 1
  }
  return next
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  return value === 'agent' || value === 'full' ? value : 'ask'
}

function normalizeMisfirePolicy(value: unknown): AutomationMisfirePolicy {
  return value === 'skip' ? 'skip' : 'run-once'
}

function normalizeOverlapPolicy(value: unknown): AutomationOverlapPolicy {
  return value === 'queue-one' ? 'queue-one' : 'skip'
}

function normalizeRetryPolicy(value: Partial<AutomationRetryPolicy> | undefined): AutomationRetryPolicy {
  return {
    maxRetries: Math.max(0, Math.min(10, Math.floor(Number(value?.maxRetries ?? 2)))),
    backoffMinutes: Math.max(1, Math.min(1_440, Math.floor(Number(value?.backoffMinutes ?? 2)))),
  }
}

function normalizeMaxRuntime(value: unknown): number {
  const minutes = Math.floor(Number(value ?? 60))
  return Math.max(1, Math.min(24 * 60, Number.isFinite(minutes) ? minutes : 60))
}

function cloneRun(run: AutomationRunRecord): AutomationRunRecord {
  return { ...run }
}

function cloneAutomation(automation: AutomationRecord): AutomationRecord {
  return {
    ...automation,
    schedule: { ...automation.schedule },
    retryPolicy: { ...automation.retryPolicy },
    history: automation.history.map(cloneRun),
  }
}

function terminalStatus(status: AutomationRunStatus): boolean {
  return ['completed', 'failed', 'canceled', 'interrupted', 'skipped', 'missed', 'retry_scheduled'].includes(status)
}

export class AutomationService {
  private readonly store: AtomicJsonStore<AutomationStoreFile>
  private data: AutomationStoreFile
  private warnings: string[]
  private scheduler: AutomationSchedulerHealth = { status: 'idle', activeRuns: 0 }

  constructor(storePath: string) {
    this.store = new AtomicJsonStore(storePath, () => ({ schemaVersion: 2, automations: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
    if (this.normalizeLoadedRecords()) this.persist()
  }

  list(workspacePath?: string): AutomationSnapshot {
    const normalizedWorkspace = workspacePath ? resolve(workspacePath) : undefined
    return {
      schemaVersion: 2,
      warnings: [...this.warnings],
      scheduler: { ...this.scheduler },
      automations: this.data.automations
        .filter(automation => !normalizedWorkspace || automation.workspacePath === normalizedWorkspace)
        .map(cloneAutomation)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt),
    }
  }

  recordSchedulerHealth(update: Partial<AutomationSchedulerHealth>): void {
    this.scheduler = { ...this.scheduler, ...update }
  }

  create(input: AutomationCreateInput): AutomationSnapshot {
    const name = input.name.trim().slice(0, 120)
    const prompt = input.prompt.trim().slice(0, 40_000)
    if (!name || !prompt) throw new Error('Automation name and prompt are required')
    const schedule = normalizeSchedule(input.schedule)
    const timezone = normalizeTimezone(input.timezone)
    const now = Date.now()
    const enabled = input.enabled !== false
    const scheduledAt = enabled ? nextAutomationRunAt(schedule, timezone, now) : undefined
    if (enabled && schedule.kind === 'once' && scheduledAt === undefined) throw new Error('One-time automation must be scheduled in the future')
    this.data.automations.push({
      id: `automation-${randomUUID()}`,
      name,
      prompt,
      workspacePath: resolve(input.workspacePath),
      schedule,
      timezone,
      enabled,
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
      misfirePolicy: normalizeMisfirePolicy(input.misfirePolicy),
      overlapPolicy: normalizeOverlapPolicy(input.overlapPolicy),
      retryPolicy: normalizeRetryPolicy(input.retryPolicy),
      maxRuntimeMinutes: normalizeMaxRuntime(input.maxRuntimeMinutes),
      createdAt: now,
      updatedAt: now,
      nextRunAt: scheduledAt,
      history: [],
    })
    this.persist()
    return this.list(input.workspacePath)
  }

  update(id: string, patch: AutomationUpdateInput): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120)
      if (!name) throw new Error('Automation name cannot be empty')
      automation.name = name
    }
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim().slice(0, 40_000)
      if (!prompt) throw new Error('Automation prompt cannot be empty')
      automation.prompt = prompt
    }
    const schedule = patch.schedule ? normalizeSchedule(patch.schedule) : automation.schedule
    const timezone = patch.timezone !== undefined ? normalizeTimezone(patch.timezone) : automation.timezone
    const enabled = patch.enabled ?? automation.enabled
    const updatedAt = Date.now()
    const scheduleChanged = patch.schedule !== undefined || patch.timezone !== undefined || patch.enabled !== undefined
    const scheduledAt = enabled
      ? scheduleChanged ? nextAutomationRunAt(schedule, timezone, updatedAt) : automation.nextRunAt
      : undefined
    if (enabled && schedule.kind === 'once' && scheduledAt === undefined && !automation.activeRunId) throw new Error('One-time automation must be scheduled in the future')
    automation.schedule = schedule
    automation.timezone = timezone
    automation.enabled = enabled
    if (patch.approvalPolicy !== undefined) automation.approvalPolicy = normalizeApprovalPolicy(patch.approvalPolicy)
    if (patch.misfirePolicy !== undefined) automation.misfirePolicy = normalizeMisfirePolicy(patch.misfirePolicy)
    if (patch.overlapPolicy !== undefined) automation.overlapPolicy = normalizeOverlapPolicy(patch.overlapPolicy)
    if (patch.retryPolicy !== undefined) automation.retryPolicy = normalizeRetryPolicy({ ...automation.retryPolicy, ...patch.retryPolicy })
    if (patch.maxRuntimeMinutes !== undefined) automation.maxRuntimeMinutes = normalizeMaxRuntime(patch.maxRuntimeMinutes)
    automation.updatedAt = updatedAt
    automation.nextRunAt = scheduledAt
    this.persist()
    return this.list(automation.workspacePath)
  }

  duplicate(id: string): AutomationSnapshot {
    const source = this.requireAutomation(id)
    return this.create({
      name: `${source.name} 副本`,
      prompt: source.prompt,
      workspacePath: source.workspacePath,
      schedule: source.schedule,
      timezone: source.timezone,
      enabled: false,
      approvalPolicy: source.approvalPolicy,
      misfirePolicy: source.misfirePolicy,
      overlapPolicy: source.overlapPolicy,
      retryPolicy: source.retryPolicy,
      maxRuntimeMinutes: source.maxRuntimeMinutes,
    })
  }

  remove(id: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('Stop the active automation run before deleting it')
    this.data.automations = this.data.automations.filter(item => item.id !== id)
    this.persist()
    return this.list(automation.workspacePath)
  }

  due(workspacePath: string, now = Date.now()): AutomationRecord[] {
    const normalizedWorkspace = resolve(workspacePath)
    return this.data.automations
      .filter(automation => automation.enabled
        && automation.workspacePath === normalizedWorkspace
        && !automation.activeRunId
        && (automation.pendingRunAt !== undefined || automation.nextRunAt !== undefined && automation.nextRunAt <= now || this.retryDue(automation, now)))
      .map(cloneAutomation)
  }

  nextWakeAt(workspacePath: string, now = Date.now()): number | undefined {
    const normalizedWorkspace = resolve(workspacePath)
    const times: number[] = []
    for (const automation of this.data.automations) {
      if (automation.workspacePath !== normalizedWorkspace || automation.activeRunId) continue
      if (automation.pendingRunAt !== undefined) times.push(now)
      if (automation.enabled && automation.nextRunAt !== undefined) times.push(automation.nextRunAt)
      for (const run of automation.history) if (run.status === 'retry_scheduled' && run.retryAt !== undefined) times.push(run.retryAt)
    }
    return times.length > 0 ? Math.min(...times) : undefined
  }

  claimDue(workspacePath: string, options: { now?: number; limit?: number } = {}): AutomationClaim[] {
    const normalizedWorkspace = resolve(workspacePath)
    const now = options.now ?? Date.now()
    const claims: AutomationClaim[] = []
    const limit = Math.max(1, Math.min(8, options.limit ?? 2))
    for (const automation of this.data.automations) {
      if (claims.length >= limit || automation.workspacePath !== normalizedWorkspace || automation.activeRunId) continue
      const retry = automation.history.find(run => run.status === 'retry_scheduled' && run.retryAt !== undefined && run.retryAt <= now)
      if (retry) {
        retry.status = 'failed'
        retry.updatedAt = now
        const run = this.createRun(automation, 'retry', now, retry.scheduledFor, retry.attempt + 1)
        claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
        continue
      }
      if (automation.pendingRunAt !== undefined) {
        const scheduledFor = automation.pendingRunAt
        automation.pendingRunAt = undefined
        const run = this.createRun(automation, 'scheduled', now, scheduledFor, 1)
        claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
        continue
      }
      if (!automation.enabled || automation.nextRunAt === undefined || automation.nextRunAt > now) continue
      const scheduledFor = automation.nextRunAt
      automation.nextRunAt = nextFutureRunAt(automation.schedule, automation.timezone, scheduledFor, now)
      if (automation.schedule.kind === 'once') automation.enabled = false
      const late = now - scheduledFor > MISFIRE_GRACE_MS
      if (late && automation.misfirePolicy === 'skip') {
        this.createTerminalRun(automation, 'skipped', 'scheduled', now, scheduledFor, 'Scheduled time passed while TurboFlux was unavailable.')
        continue
      }
      const run = this.createRun(automation, late ? 'recovery' : 'scheduled', now, scheduledFor, 1)
      claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
    }
    if (claims.length > 0) this.persist()
    return claims
  }

  claimManual(id: string, now = Date.now()): AutomationClaim {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('This automation is already running')
    const run = this.createRun(automation, 'manual', now, undefined, 1)
    this.persist()
    return { automation: cloneAutomation(automation), run: cloneRun(run) }
  }

  retryNow(id: string, runId: string, now = Date.now()): AutomationClaim {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('This automation is already running')
    const previous = automation.history.find(run => run.id === runId)
    if (!previous || !['failed', 'interrupted', 'canceled', 'retry_scheduled'].includes(previous.status)) {
      throw new Error('Only failed, interrupted, canceled, or pending retry runs can be retried')
    }
    if (previous.status === 'retry_scheduled') {
      previous.status = 'failed'
      previous.retryAt = undefined
      previous.updatedAt = now
    }
    const run = this.createRun(automation, 'retry', now, previous.scheduledFor, previous.attempt + 1)
    this.persist()
    return { automation: cloneAutomation(automation), run: cloneRun(run) }
  }

  attachConversation(id: string, conversationId: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    automation.conversationId = conversationId
    const active = automation.activeRunId ? automation.history.find(run => run.id === automation.activeRunId) : undefined
    if (active) active.conversationId = conversationId
    automation.updatedAt = Date.now()
    this.persist()
    return this.list(automation.workspacePath)
  }

  markRunStatus(
    id: string,
    runId: string,
    status: AutomationRunStatus,
    options: { inputId?: string; conversationId?: string; error?: string; resultSummary?: string; now?: number } = {},
  ): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    const run = automation.history.find(item => item.id === runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    const now = options.now ?? Date.now()
    run.status = status
    run.updatedAt = now
    run.inputId = options.inputId || run.inputId
    run.conversationId = options.conversationId || run.conversationId
    run.error = options.error?.slice(0, 2_000)
    run.resultSummary = options.resultSummary?.trim().slice(0, 4_000)
    if (terminalStatus(status)) {
      run.completedAt = now
      run.durationMs = Math.max(0, now - run.startedAt)
    }
    automation.lastRunAt = run.startedAt
    automation.lastStatus = status
    automation.lastInputId = run.inputId || automation.lastInputId
    automation.lastError = run.error
    automation.lastDurationMs = run.durationMs || automation.lastDurationMs
    if (status === 'completed') automation.lastSuccessAt = now
    if (automation.activeRunId === run.id && terminalStatus(status)) automation.activeRunId = undefined
    if (status === 'failed' || status === 'interrupted') this.scheduleRetry(automation, run, now)
    if (terminalStatus(status) && status !== 'retry_scheduled') this.reconcileOverlappingSchedule(automation, run, now)
    automation.updatedAt = now
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    this.persist()
    return this.list(automation.workspacePath)
  }

  markRun(id: string, status: AutomationRunStatus, options: { inputId?: string; error?: string; now?: number } = {}): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    let run = options.inputId ? automation.history.find(item => item.inputId === options.inputId) : undefined
    if (!run && automation.activeRunId) run = automation.history.find(item => item.id === automation.activeRunId)
    if (!run) {
      const claim = this.claimManual(id, options.now ?? Date.now())
      run = this.requireAutomation(id).history.find(item => item.id === claim.run.id)!
    }
    return this.markRunStatus(id, run.id, status, options)
  }

  cancelActiveRun(id: string, now = Date.now()): AutomationRunRecord | null {
    const automation = this.requireAutomation(id)
    if (!automation.activeRunId) return null
    const run = automation.history.find(item => item.id === automation.activeRunId)
    if (!run) return null
    this.markRunStatus(id, run.id, 'canceled', { now, error: 'Canceled by the user.' })
    return cloneRun(run)
  }

  get(id: string): AutomationRecord | null {
    const automation = this.data.automations.find(item => item.id === id)
    return automation ? cloneAutomation(automation) : null
  }

  getRun(id: string, runId: string): AutomationRunRecord | null {
    const automation = this.data.automations.find(item => item.id === id)
    const run = automation?.history.find(item => item.id === runId)
    return run ? cloneRun(run) : null
  }

  markInactiveDueWaiting(activeWorkspacePath: string, now = Date.now()): boolean {
    const activeWorkspace = resolve(activeWorkspacePath)
    let changed = false
    for (const automation of this.data.automations) {
      if (!automation.enabled || automation.workspacePath === activeWorkspace || automation.nextRunAt === undefined || automation.nextRunAt > now) continue
      if (automation.lastStatus === 'waiting_for_workspace') continue
      automation.lastStatus = 'waiting_for_workspace'
      automation.lastError = 'Open this workspace to run the automation.'
      automation.updatedAt = now
      changed = true
    }
    if (changed) this.persist()
    return changed
  }

  private createRun(
    automation: AutomationRecord,
    trigger: AutomationRunTrigger,
    now: number,
    scheduledFor: number | undefined,
    attempt: number,
  ): AutomationRunRecord {
    const run: AutomationRunRecord = {
      id: `automation-run-${randomUUID()}`,
      conversationId: automation.conversationId,
      trigger,
      status: 'queued',
      scheduledFor,
      attempt,
      startedAt: now,
      updatedAt: now,
    }
    automation.history.unshift(run)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    automation.activeRunId = run.id
    automation.lastRunAt = now
    automation.lastStatus = 'queued'
    automation.lastError = undefined
    automation.updatedAt = now
    return run
  }

  private createTerminalRun(
    automation: AutomationRecord,
    status: Extract<AutomationRunStatus, 'skipped' | 'missed'>,
    trigger: AutomationRunTrigger,
    now: number,
    scheduledFor: number | undefined,
    error: string,
  ): void {
    const run: AutomationRunRecord = {
      id: `automation-run-${randomUUID()}`,
      trigger,
      status,
      scheduledFor,
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      durationMs: 0,
      error,
    }
    automation.history.unshift(run)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    automation.lastRunAt = now
    automation.lastStatus = status
    automation.lastError = error
    automation.updatedAt = now
  }

  private scheduleRetry(automation: AutomationRecord, run: AutomationRunRecord, now: number): void {
    if (run.attempt > automation.retryPolicy.maxRetries) return
    const retryAt = now + automation.retryPolicy.backoffMinutes * 60_000 * (2 ** Math.max(0, run.attempt - 1))
    run.status = 'retry_scheduled'
    run.retryAt = retryAt
    run.completedAt = now
    run.durationMs = Math.max(0, now - run.startedAt)
    automation.lastStatus = 'retry_scheduled'
  }

  private retryDue(automation: AutomationRecord, now: number): boolean {
    return automation.history.some(run => run.status === 'retry_scheduled' && run.retryAt !== undefined && run.retryAt <= now)
  }

  private reconcileOverlappingSchedule(automation: AutomationRecord, completedRun: AutomationRunRecord, now: number): void {
    if (!automation.enabled || automation.nextRunAt === undefined || automation.nextRunAt > now) return
    const scheduledFor = automation.nextRunAt
    automation.nextRunAt = nextFutureRunAt(automation.schedule, automation.timezone, scheduledFor, now)
    if (automation.schedule.kind === 'once') automation.enabled = false
    if (automation.overlapPolicy === 'queue-one' && completedRun.status !== 'canceled') {
      automation.pendingRunAt = scheduledFor
      return
    }
    const skipped: AutomationRunRecord = {
      id: `automation-run-${randomUUID()}`,
      trigger: 'scheduled',
      status: 'skipped',
      scheduledFor,
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      durationMs: 0,
      error: completedRun.status === 'canceled'
        ? 'Skipped because the previous run was canceled.'
        : 'Skipped because the previous run was still active.',
    }
    const completedIndex = automation.history.findIndex(item => item.id === completedRun.id)
    automation.history.splice(completedIndex < 0 ? 0 : completedIndex + 1, 0, skipped)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
  }

  private normalizeLoadedRecords(): boolean {
    let changed = this.data.schemaVersion !== 2
    this.data.schemaVersion = 2
    const now = Date.now()
    for (const automation of this.data.automations) {
      if (!Array.isArray(automation.history)) {
        automation.history = []
        changed = true
      }
      try {
        automation.schedule = normalizeSchedule(automation.schedule)
        automation.timezone = normalizeTimezone(automation.timezone)
      } catch (error) {
        automation.schedule = { kind: 'manual' }
        automation.enabled = false
        automation.nextRunAt = undefined
        this.warnings.push(`Automation ${automation.name || automation.id} was disabled: ${error instanceof Error ? error.message : String(error)}`)
        changed = true
      }
      automation.approvalPolicy = normalizeApprovalPolicy(automation.approvalPolicy)
      automation.misfirePolicy = normalizeMisfirePolicy(automation.misfirePolicy)
      automation.overlapPolicy = normalizeOverlapPolicy(automation.overlapPolicy)
      automation.retryPolicy = normalizeRetryPolicy(automation.retryPolicy)
      automation.maxRuntimeMinutes = normalizeMaxRuntime(automation.maxRuntimeMinutes)
      automation.workspacePath = resolve(automation.workspacePath)
      if (automation.enabled && automation.nextRunAt === undefined) {
        automation.nextRunAt = nextAutomationRunAt(automation.schedule, automation.timezone, now)
        changed = true
      }
      for (const run of automation.history) {
        run.trigger = run.trigger || 'scheduled'
        run.attempt = Math.max(1, run.attempt || 1)
        if (['queued', 'running', 'waiting_for_approval', 'waiting_for_workspace'].includes(run.status)) {
          run.status = 'interrupted'
          run.updatedAt = now
          run.completedAt = now
          run.durationMs = Math.max(0, now - run.startedAt)
          run.error = 'TurboFlux exited before this run completed.'
          automation.activeRunId = undefined
          automation.lastStatus = 'interrupted'
          automation.lastError = run.error
          this.scheduleRetry(automation, run, now)
          changed = true
        }
      }
      automation.history = automation.history.slice(0, HISTORY_LIMIT)
    }
    return changed
  }

  private requireAutomation(id: string): AutomationRecord {
    const automation = this.data.automations.find(item => item.id === id)
    if (!automation) throw new Error(`Automation not found: ${id}`)
    return automation
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
