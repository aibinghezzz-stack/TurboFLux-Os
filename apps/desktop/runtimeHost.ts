import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, open as openFile, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeImage } from 'electron'
import {
  SKILL_MARKETPLACE_SOURCES,
  SkillMarketplaceInstallManager,
  WorkbenchRuntime,
  buildWorkPackCatalog,
  configureNetworkProxy,
  getModelReasoningCapabilities,
  listSkillMarketplace,
  loadConfig,
  uninstallMarketplaceSkill,
  type AgentAttachment,
  type AgentCapabilitySelection,
  type AgentMode,
  type ApprovalPolicy,
  type ArtifactSource,
  type AutomationSchedule,
  type AutomationUpdateInput,
  type McpClient,
  type NativeReasoningConfig,
  type PluginPermission,
  type PluginMarketplaceEntry,
  WorkbenchCommandId,
  WorkbenchDraftSnapshot,
  type WorkbenchEvent,
  WorkbenchFileReference,
  WorkbenchMemoryCreateInput,
  WorkbenchMemoryFilters,
  WorkbenchMemoryUpdateInput,
  WorkbenchSettingsUpdate,
  type TurboFluxConfig,
  type WorkbenchModelOption,
  type WorkbenchSnapshot,
} from '@turboflux/agent-core/workbench'
import { DESKTOP_EXPERIENCE_SYSTEM_PROMPT } from './productExperience'
import { fallbackTaskTitle, isPlaceholderTaskTitle, reusableEmptyConversation } from './conversationPolicy'
import { recoverContextUsage } from './contextUsageRecovery'
import type { DesktopWorkbenchSnapshot } from './desktopTypes'
import { projectHistoryRewrite } from './historyRewrite'
import { runtimeTransitionBlocker } from './runtimeTransitionPolicy'
import { generateTaskTitle } from './taskTitleGenerator'
import { TaskTitleApplyGateRegistry, type TaskTitleApplyGate } from './taskTitleApplyGate'

export type DesktopRuntimeEventListener = (event: WorkbenchEvent) => void

export interface TurboFluxProductWorkPack {
  id: string
  publisher: string
  trust: string
  description: string
  manifest: {
    id?: string
    name?: string
    version?: string
    publisher?: string
    trust?: string
    description?: string
    [key: string]: unknown
  }
  promptFiles: Record<string, string>
}

export interface DesktopRuntimeHostOptions {
  registerSystemPlugins?: (client: McpClient, context: { conversationId: string }) => void
  storagePath?: string
  unscopedWorkspacePath?: string
  externalTransitionBlocker?: () => string | null
}



interface ManagedTaskTitleState {
  title: string
  evaluatedPromptCount: number
}

function desktopTimingSummary(samples: readonly number[]) {
  if (samples.length === 0) return { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 }
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  return {
    count: samples.length,
    totalMs: Number(samples.reduce((total, value) => total + value, 0).toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p90Ms: Number(percentile(0.9).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  }
}



const MAX_IMPORTED_FILE_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024
const PREVIEW_THUMBNAIL_WIDTH = 560
const PREVIEW_THUMBNAIL_HEIGHT = 420
const PREVIEW_THUMBNAIL_CACHE_LIMIT = 48
const PREVIEW_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DESKTOP_REMOVED_TOOLS = ['web_search', 'web_fetch']
type ImagePreviewPurpose = 'thumbnail' | 'full'

function mimeForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
  } as Record<string, string>)[extension] || 'application/octet-stream'
}

function safeFilename(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'attachment'
}

export class DesktopRuntimeHost {
  private runtime: WorkbenchRuntime | null = null
  private unsubscribeRuntime: (() => void) | null = null
  private readonly listeners = new Set<DesktopRuntimeEventListener>()
  private workspacePath: string
  private registerSystemPlugins?: DesktopRuntimeHostOptions['registerSystemPlugins']
  private readonly storagePath?: string
  private readonly unscopedWorkspacePath?: string
  private readonly externalTransitionBlocker?: DesktopRuntimeHostOptions['externalTransitionBlocker']
  private localConfig: TurboFluxConfig | null = null
  private runtimeConfig: TurboFluxConfig | null = null
  private suppressRuntimeEvents = false
  private readonly managedTaskTitles = new Map<string, ManagedTaskTitleState>()
  private readonly taskPrompts = new Map<string, string[]>()
  private readonly submittedPromptCounts = new Map<string, number>()
  private readonly taskRunPromptCounts = new Map<string, number[]>()
  private readonly taskTitleUpdates = new Map<string, Promise<void>>()
  private readonly taskTitleRevisions = new Map<string, number>()
  private readonly taskTitleApplyGates = new TaskTitleApplyGateRegistry()
  private readonly historyRewriteConversations = new Set<string>()
  private readonly imageThumbnailCache = new Map<string, string>()
  private managedTaskTitleSave = Promise.resolve()
  private runtimeEpoch = 0
  private runtimeTransitioning = false
  private desktopStreamTraceActive = false
  private readonly desktopStreamListenerDurations = new Map<string, number[]>()
  private readonly skillInstallManager: SkillMarketplaceInstallManager

  private constructor(workspacePath: string, options: DesktopRuntimeHostOptions = {}) {
    this.workspacePath = workspacePath
    this.registerSystemPlugins = options.registerSystemPlugins
    this.storagePath = options.storagePath
    this.unscopedWorkspacePath = options.unscopedWorkspacePath ? resolve(options.unscopedWorkspacePath) : undefined
    this.externalTransitionBlocker = options.externalTransitionBlocker
    this.skillInstallManager = new SkillMarketplaceInstallManager({
      statePath: options.storagePath ? join(options.storagePath, 'skills', 'install-jobs.json') : undefined,
    })
    this.skillInstallManager.subscribe(job => {
      for (const listener of this.listeners) listener({ type: 'skill-marketplace-install', job })
    })
  }

  static async create(workspacePath: string, options: DesktopRuntimeHostOptions = {}): Promise<DesktopRuntimeHost> {
    configureNetworkProxy()
    const host = new DesktopRuntimeHost(resolve(workspacePath), options)
    await host.skillInstallManager.initialize()
    await host.loadManagedTaskTitles()
    await host.replaceRuntime(host.workspacePath)
    return host
  }

  subscribe(listener: DesktopRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setSystemPluginRegistrar(registrar: DesktopRuntimeHostOptions['registerSystemPlugins']): void {
    this.registerSystemPlugins = registrar
    if (registrar && this.runtime) this.runtime.registerSystemPlugins(registrar)
  }

  getSnapshot(): DesktopWorkbenchSnapshot {
    return this.decorateSnapshot(this.requireRuntime().getSnapshot())
  }

  transitionBlocker(options: { allowRecoverableError?: boolean } = {}): string | null {
    const externalBlocker = this.externalTransitionBlocker?.()
    if (externalBlocker) return externalBlocker
    if (this.runtimeTransitioning) return '工作环境正在更新，请稍后再试'
    return runtimeTransitionBlocker(this.requireRuntime().getSnapshot(), options)
  }

  async getSettings(forceModels = false) {
    return this.requireRuntime().getSettings(forceModels)
  }

  async saveSettings(update: WorkbenchSettingsUpdate) {
    this.assertRuntimeTransitionAllowed(this.requireRuntime(), { allowRecoverableError: true })
    const result = await this.requireRuntime().saveSettings(update)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  submitPrompt(prompt: string, attachments?: AgentAttachment[], capabilities?: AgentCapabilitySelection) {
    this.assertRuntimeReadyForRun()
    const runtime = this.requireRuntime()
    this.applyDesktopToolPolicy(runtime)
    const snapshot = runtime.getSnapshot()
    const paused = snapshot.runtime.status === 'paused'
    if (paused) runtime.stopConversation(snapshot.conversation.id)
    const startsNewRun = !['running', 'paused', 'awaiting-action'].includes(snapshot.runtime.status)
    const titleApplyGate = startsNewRun ? this.taskTitleApplyGates.begin(snapshot.conversation.id) : undefined
    let result: ReturnType<WorkbenchRuntime['submitPrompt']>
    try {
      result = runtime.submitPrompt(prompt, attachments, capabilities, { forceQueue: paused })
    } catch (error) {
      if (titleApplyGate) this.taskTitleApplyGates.release(snapshot.conversation.id, titleApplyGate)
      throw error
    }
    if (result.status !== 'started' && titleApplyGate) {
      this.taskTitleApplyGates.release(snapshot.conversation.id, titleApplyGate)
    }
    const promptCount = this.recordTaskPrompt(snapshot.conversation.id, prompt, snapshot)
    this.trackTaskRunPromptCount(snapshot.conversation.id, promptCount, result.status)
    this.scheduleTaskTitleUpdate(snapshot.conversation.id, promptCount, result.status === 'started' ? titleApplyGate : undefined)
    return result
  }

  async resendFromTurn(turnId: string, prompt: string) {
    this.assertRuntimeReadyForRun()
    const runtime = this.requireRuntime()
    this.applyDesktopToolPolicy(runtime)
    const snapshot = runtime.getSnapshot()
    const rewrite = projectHistoryRewrite(snapshot.conversation.turns, turnId, prompt)
    if (!rewrite) throw new Error('这条消息已经不在当前会话中')
    const conversationId = snapshot.conversation.id
    const titleApplyGate = this.taskTitleApplyGates.begin(conversationId)
    this.taskTitleRevisions.set(conversationId, (this.taskTitleRevisions.get(conversationId) || 0) + 1)
    this.historyRewriteConversations.add(conversationId)
    let result: Awaited<ReturnType<WorkbenchRuntime['resendFromTurn']>>
    try {
      result = await runtime.resendFromTurn(turnId, prompt)
    } catch (error) {
      this.taskTitleApplyGates.release(conversationId, titleApplyGate)
      throw error
    } finally {
      this.historyRewriteConversations.delete(conversationId)
    }
    const previousPromptCount = this.submittedPromptCounts.get(conversationId)
    const previousPrompts = this.taskPrompts.get(conversationId)
    this.submittedPromptCounts.set(conversationId, rewrite.promptCount)
    this.taskPrompts.set(conversationId, rewrite.prompts.slice(-6))
    this.taskRunPromptCounts.set(conversationId, [rewrite.promptCount])
    const managed = this.managedTaskTitles.get(conversationId)
    if (managed && managed.evaluatedPromptCount >= rewrite.promptCount) {
      this.managedTaskTitles.set(conversationId, {
        ...managed,
        evaluatedPromptCount: Math.max(0, rewrite.promptCount - 1),
      })
    }
    try {
      this.scheduleTaskTitleUpdate(conversationId, rewrite.promptCount, titleApplyGate)
    } catch (error) {
      if (previousPromptCount === undefined) this.submittedPromptCounts.delete(conversationId)
      else this.submittedPromptCounts.set(conversationId, previousPromptCount)
      if (previousPrompts === undefined) this.taskPrompts.delete(conversationId)
      else this.taskPrompts.set(conversationId, previousPrompts)
      throw error
    }
    return result
  }

  recordDraft(draft: WorkbenchDraftSnapshot | string) {
    return this.requireRuntime().recordDraft(draft)
  }

  listCommands() {
    return this.requireRuntime().listCommands()
  }

  async executeCommand(command: WorkbenchCommandId) {
    const result = await this.requireRuntime().executeCommand(command)
    return result.snapshot ? { ...result, snapshot: this.decorateSnapshot(result.snapshot) } : result
  }

  stop() {
    return this.requireRuntime().stop()
  }

  stopConversation(id: string) {
    return this.requireRuntime().stopConversation(id)
  }

  pause() {
    return this.requireRuntime().pause()
  }

  pauseConversation(id: string) {
    return this.requireRuntime().pauseConversation(id)
  }

  resumeConversation(id: string) {
    return this.requireRuntime().resumeConversation(id)
  }

  resume() {
    return this.requireRuntime().resume()
  }

  controlWorkStep(taskId: string, action: 'retry' | 'skip' | 'cancel' | 'resume') {
    const result = this.requireRuntime().controlWorkStep(taskId, action)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  resolveRequest(requestId: string, response: string) {
    return this.requireRuntime().resolveRequest(requestId, response)
  }

  setMode(mode: AgentMode) {
    return this.decorateSnapshot(this.requireRuntime().setMode(mode))
  }

  async newConversation() {
    const activeWorkspacePath = resolve(this.requireRuntime().getSnapshot().workspace.path)
    if (this.unscopedWorkspacePath && activeWorkspacePath !== this.unscopedWorkspacePath) {
      const snapshot = await this.setWorkspace(this.unscopedWorkspacePath)
      return { id: snapshot.conversation.id, snapshot }
    }
    const runtime = this.requireRuntime()
    const snapshot = runtime.getSnapshot()
    const reusable = reusableEmptyConversation(snapshot.conversations, snapshot.conversation.id)
    if (!reusable) {
      const result = await runtime.newConversation()
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    }
    if (reusable.id === snapshot.conversation.id) {
      this.applyDesktopToolPolicy(runtime)
      return { id: reusable.id, snapshot: this.decorateSnapshot(snapshot) }
    }
    const result = await runtime.switchConversation(reusable.id)
    this.applyDesktopToolPolicy(runtime)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async switchConversation(id: string) {
    const currentRuntime = this.requireRuntime()
    const target = currentRuntime.getSnapshot().conversationCatalog.find(conversation => conversation.id === id)
    if (!target) throw new Error(`Conversation not found: ${id}`)
    const currentWorkspacePath = resolve(currentRuntime.getSnapshot().workspace.path)
    const targetWorkspacePath = resolve(target.workspacePath)
    if (targetWorkspacePath === currentWorkspacePath) {
      const result = await currentRuntime.switchConversation(id)
      this.applyDesktopToolPolicy(currentRuntime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    }

    this.assertRuntimeTransitionAllowed()
    this.suppressRuntimeEvents = true
    try {
      await this.setWorkspace(targetWorkspacePath)
      const runtime = this.requireRuntime()
      const result = await runtime.switchConversation(id)
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    } finally {
      this.suppressRuntimeEvents = false
    }
  }

  deleteConversation(id: string) {
    return this.requireRuntime().deleteConversation(id)
  }

  async renameConversation(id: string, title: string) {
    const renamed = await this.requireRuntime().renameConversation(id, title)
    if (renamed) {
      this.managedTaskTitles.delete(id)
      await this.saveManagedTaskTitles()
    }
    return renamed
  }

  readSubAgent(taskId: string, offset?: number, limit?: number) {
    return this.requireRuntime().readSubAgent(taskId, offset, limit)
  }

  async stopSubAgent(taskId: string) {
    const result = await this.requireRuntime().stopSubAgent(taskId)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  retrySubAgent(taskId: string) {
    const result = this.requireRuntime().retrySubAgent(taskId)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async stageGit(paths: string[]) {
    const result = await this.requireRuntime().stageGit(paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async unstageGit(paths: string[]) {
    const result = await this.requireRuntime().unstageGit(paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async commitGit(message: string, paths?: string[]) {
    const result = await this.requireRuntime().commitGit(message, paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async createGitBranch(name: string, startPoint?: string) {
    const result = await this.requireRuntime().createGitBranch(name, startPoint)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async switchGitBranch(name: string) {
    const result = await this.requireRuntime().switchGitBranch(name)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async restoreGit(paths: string[], source?: string) {
    const result = await this.requireRuntime().restoreGit(paths, source)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async pushGit(remote?: string, branch?: string, setUpstream = false) {
    const result = await this.requireRuntime().pushGit(remote, branch, setUpstream)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  readGitDiff(path?: string, scope?: 'working' | 'staged' | 'all') {
    return this.requireRuntime().readGitDiff(path, scope)
  }

  listProjects() {
    return this.requireRuntime().listProjects()
  }

  addProject(path: string, name?: string) {
    return this.requireRuntime().addProject(path, name)
  }

  updateProject(id: string, patch: { name?: string; pinned?: boolean; tags?: string[] }) {
    return this.requireRuntime().updateProject(id, patch)
  }

  removeProject(id: string) {
    return this.requireRuntime().removeProject(id)
  }

  async openProject(id: string) {
    const project = this.requireRuntime().getProject(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    const snapshot = await this.setWorkspace(project.path)
    this.requireRuntime().projects.recordOpened(project.path, snapshot.conversation.id)
    return this.getSnapshot()
  }

  async newConversationInProject(id: string) {
    const project = this.requireRuntime().getProject(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    this.assertRuntimeTransitionAllowed()
    this.suppressRuntimeEvents = true
    try {
      await this.setWorkspace(project.path)
      const runtime = this.requireRuntime()
      const snapshot = runtime.getSnapshot()
      const reusable = reusableEmptyConversation(snapshot.conversations, snapshot.conversation.id)
      if (reusable?.id === snapshot.conversation.id) {
        return { id: reusable.id, snapshot: this.decorateSnapshot(snapshot) }
      }
      if (reusable) {
        const result = await runtime.switchConversation(reusable.id)
        return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
      }
      const result = await runtime.newConversation()
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    } finally {
      this.suppressRuntimeEvents = false
    }
  }

  listAutomations() {
    return this.requireRuntime().listAutomations()
  }

  createAutomation(input: {
    name: string
    prompt: string
    schedule: AutomationSchedule
    timezone?: string
    enabled?: boolean
    approvalPolicy?: ApprovalPolicy
    misfirePolicy?: 'run-once' | 'skip'
    overlapPolicy?: 'skip' | 'queue-one'
    retryPolicy?: { maxRetries?: number; backoffMinutes?: number }
    maxRuntimeMinutes?: number
  }) {
    return this.requireRuntime().createAutomation(input)
  }

  updateAutomation(id: string, patch: AutomationUpdateInput) {
    return this.requireRuntime().updateAutomation(id, patch)
  }

  removeAutomation(id: string) {
    return this.requireRuntime().removeAutomation(id)
  }

  duplicateAutomation(id: string) {
    return this.requireRuntime().duplicateAutomation(id)
  }

  runAutomation(id: string) {
    this.assertRuntimeReadyForRun()
    return this.requireRuntime().runAutomation(id)
  }

  retryAutomationRun(id: string, runId: string) {
    this.assertRuntimeReadyForRun()
    return this.requireRuntime().retryAutomationRun(id, runId)
  }

  cancelAutomationRun(id: string) {
    return this.requireRuntime().cancelAutomationRun(id)
  }

  listArtifacts() {
    return this.requireRuntime().listArtifacts()
  }

  async registerArtifact(path: string, source: ArtifactSource, options?: { name?: string; mime?: string; taskId?: string; conversationId?: string; metadata?: Record<string, string | number | boolean> }) {
    const [workspaceRoot, artifactPath] = await Promise.all([realpath(this.workspacePath), realpath(resolve(path))])
    const artifactRelativePath = relative(workspaceRoot, artifactPath)
    if (!artifactRelativePath || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${sep}`) || isAbsolute(artifactRelativePath)) {
      throw new Error(`Artifact is outside the active workspace: ${artifactPath}`)
    }
    return this.requireRuntime().registerArtifact(artifactPath, source, options)
  }

  async removeArtifact(id: string) {
    const runtime = this.requireRuntime()
    const artifact = runtime.getArtifact(id)
    if (!artifact) throw new Error(`Artifact not found: ${id}`)
    const managed = artifact.source === 'browser'
      || artifact.source === 'browser-download'
      || artifact.metadata?.visualSource === 'computer'
    if (managed && artifact.available) {
      const [workspaceRoot, artifactPath] = await Promise.all([realpath(this.workspacePath), realpath(artifact.path)])
      const artifactRelativePath = relative(workspaceRoot, artifactPath)
      if (!artifactRelativePath || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${sep}`) || isAbsolute(artifactRelativePath)) {
        throw new Error(`Managed artifact is outside the active workspace: ${artifactPath}`)
      }
      await unlink(artifactPath)
    }
    return runtime.removeArtifact(id)
  }

  getArtifact(id: string) {
    return this.requireRuntime().getArtifact(id)
  }

  private async previewImageDataUrl(filePath: string, mime: string, purpose: ImagePreviewPurpose): Promise<string> {
    if (purpose === 'full') {
      const data = await readFile(filePath)
      return `data:${mime};base64,${data.toString('base64')}`
    }
    const info = await stat(filePath)
    const cacheKey = `${filePath}:${info.size}:${info.mtimeMs}`
    const cached = this.imageThumbnailCache.get(cacheKey)
    if (cached) {
      this.imageThumbnailCache.delete(cacheKey)
      this.imageThumbnailCache.set(cacheKey, cached)
      return cached
    }
    let image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) throw new Error('Image could not be decoded')
    const size = image.getSize()
    const scale = Math.min(1, PREVIEW_THUMBNAIL_WIDTH / size.width, PREVIEW_THUMBNAIL_HEIGHT / size.height)
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      })
    }
    const dataUrl = image.toDataURL()
    this.imageThumbnailCache.set(cacheKey, dataUrl)
    while (this.imageThumbnailCache.size > PREVIEW_THUMBNAIL_CACHE_LIMIT) {
      const oldest = this.imageThumbnailCache.keys().next().value
      if (typeof oldest !== 'string') break
      this.imageThumbnailCache.delete(oldest)
    }
    return dataUrl
  }

  async previewArtifact(id: string, purpose: ImagePreviewPurpose = 'full') {
    const artifact = this.requireRuntime().getArtifact(id)
    if (!artifact?.available) throw new Error('Artifact is unavailable')
    if (artifact.kind === 'image' || artifact.kind === 'pdf') {
      if (artifact.size > 20 * 1024 * 1024) return { artifact, mode: 'external' as const, message: '文件较大，请使用系统应用打开。' }
      const dataUrl = artifact.kind === 'image'
        ? await this.previewImageDataUrl(artifact.path, artifact.mime, purpose)
        : `data:${artifact.mime};base64,${(await readFile(artifact.path)).toString('base64')}`
      return { artifact, mode: artifact.kind as 'image' | 'pdf', dataUrl }
    }
    if (artifact.kind === 'document' || artifact.kind === 'code' || artifact.kind === 'data' || artifact.kind === 'spreadsheet') {
      const extension = extname(artifact.path).toLowerCase()
      if (['.md', '.txt', '.rtf', '.json', '.yaml', '.yml', '.xml', '.sql', '.csv', '.tsv', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.swift', '.html', '.css'].includes(extension)) {
        const handle = await openFile(artifact.path, 'r')
        try {
          const buffer = Buffer.allocUnsafe(Math.min(500_001, Math.max(1, artifact.size)))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          const truncated = artifact.size > bytesRead
          return {
            artifact,
            mode: 'text' as const,
            text: buffer.subarray(0, Math.min(bytesRead, 500_000)).toString('utf8'),
            message: truncated ? '预览已截断到 500,000 字节。' : undefined,
          }
        } finally {
          await handle.close()
        }
      }
    }
    return { artifact, mode: 'external' as const, message: '此格式可使用系统应用打开，并支持定位或导出副本。' }
  }

  async resolveImageAttachment(filePath: string) {
    const attachmentRoot = await realpath(join(this.workspacePath, '.turboflux', 'attachments'))
    const attachmentPath = await realpath(resolve(filePath))
    const attachmentRelativePath = relative(attachmentRoot, attachmentPath)
    if (!attachmentRelativePath || attachmentRelativePath === '..' || attachmentRelativePath.startsWith('../') || isAbsolute(attachmentRelativePath)) {
      throw new Error('Image attachment is outside the TurboFlux attachment store')
    }
    const info = await stat(attachmentPath)
    const mime = mimeForPath(attachmentPath)
    if (!info.isFile() || !PREVIEW_IMAGE_MIMES.has(mime)) throw new Error('Unsupported image attachment')
    if (info.size === 0 || info.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error('Image attachment must be between 1 byte and 20 MB')
    return { path: attachmentPath, filename: basename(attachmentPath), mime, size: info.size }
  }

  async previewImageAttachment(filePath: string, purpose: ImagePreviewPurpose = 'full') {
    const attachment = await this.resolveImageAttachment(filePath)
    const dataUrl = await this.previewImageDataUrl(attachment.path, attachment.mime, purpose)
    return { ...attachment, mode: 'image' as const, dataUrl }
  }

  listPlugins() {
    return this.requireRuntime().listPlugins()
  }

  inspectPlugin(path: string) {
    return this.requireRuntime().inspectPlugin(path)
  }

  installPlugin(path: string, approvedPermissions: PluginPermission[]) {
    return this.requireRuntime().installPlugin(path, approvedPermissions)
  }

  installMarketplacePlugin(id: string) {
    return this.requireRuntime().installMarketplacePlugin(id)
  }

  setPluginEnabled(id: string, enabled: boolean) {
    return this.requireRuntime().setPluginEnabled(id, enabled)
  }

  uninstallPlugin(id: string) {
    return this.requireRuntime().uninstallPlugin(id)
  }

  retryPersistence() {
    return this.requireRuntime().retryPersistence()
  }

  exportRecoveryBundle(requestedPath?: string) {
    return this.requireRuntime().exportRecoveryBundle(requestedPath)
  }

  activateSkill(skillId: string) {
    return this.requireRuntime().activateSkill(skillId)
  }

  deactivateSkill() {
    return this.requireRuntime().deactivateSkill()
  }

  reloadSkills() {
    return this.requireRuntime().reloadSkills()
  }


  listSkillMarketplace() {
    const installed = this.requireRuntime().getSnapshot().skills.map(skill => skill.id)
    const installState = this.skillInstallManager.snapshot()
    return {
      entries: listSkillMarketplace(installed),
      sources: SKILL_MARKETPLACE_SOURCES.map(source => ({ ...source })),
      jobs: installState.jobs,
      recovery: installState.recovery,
    }
  }

  async installMarketplaceSkill(marketplaceId: string, allowOverwrite = false) {
    const catalogEntry = this.listSkillMarketplace().entries.find(entry => entry.id === marketplaceId)
    if (!catalogEntry) throw new Error(`Skill 市场中不存在该项目：${marketplaceId}`)
    const entry = await this.skillInstallManager.install(catalogEntry, allowOverwrite)
    const snapshot = this.requireRuntime().reloadSkills()
    return { entry, marketplace: this.listSkillMarketplace(), snapshot }
  }

  cancelMarketplaceSkillInstall(marketplaceId: string) {
    return this.skillInstallManager.cancel(marketplaceId)
  }

  async uninstallMarketplaceSkill(marketplaceId: string) {
    const entry = await uninstallMarketplaceSkill(marketplaceId)
    const snapshot = this.requireRuntime().reloadSkills()
    return { entry, marketplace: this.listSkillMarketplace(), snapshot }
  }

  listWorkPacks() {
    const runtime = this.requireRuntime()
    const skills = this.listSkillMarketplace()
    const plugins = runtime.listPlugins()
    return buildWorkPackCatalog({
      skillEntries: skills.entries,
      skillSources: skills.sources,
      skillJobs: skills.jobs,
      skillRecovery: skills.recovery,
      installedSkills: runtime.getSnapshot().skills,
      plugins,
    })
  }

  async installWorkPack(workPackId: string, allowOverwrite = false, approvedPermissions: PluginPermission[] = []) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry) throw new Error(`能力包不存在：${workPackId}`)
    if (entry.backend.type === 'skill') {
      await this.installMarketplaceSkill(entry.backend.marketplaceId, allowOverwrite)
      return this.listWorkPacks()
    }
    if (entry.backend.type === 'plugin') {
      const runtime = this.requireRuntime()
      const marketplaceId = entry.backend.marketplaceId
      const productPackage = await this.resolveWorkPackPackage(marketplaceId)
      if (!productPackage) throw new Error(`能力包不存在：${marketplaceId}`)
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'turboflux-product-work-pack-'))
      try {
        await writeFile(join(temporaryDirectory, 'plugin.json'), `${JSON.stringify(productPackage.manifest, null, 2)}\n`, { mode: 0o600 })
        for (const [path, content] of Object.entries(productPackage.promptFiles)) {
          const target = resolve(temporaryDirectory, path)
          const child = relative(temporaryDirectory, target)
          if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('能力包包含不安全的文件路径')
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, content, { mode: 0o600 })
        }
        await runtime.installPlugin(temporaryDirectory, approvedPermissions)
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
      await runtime.setPluginEnabled(entry.backend.pluginId, true)
      return this.listWorkPacks()
    }
    throw new Error('该能力包已安装，无需再次安装')
  }

  cancelWorkPackInstall(workPackId: string) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry || entry.backend.type !== 'skill') return undefined
    return this.cancelMarketplaceSkillInstall(entry.backend.marketplaceId)
  }

  async setWorkPackEnabled(workPackId: string, enabled: boolean) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry) throw new Error(`能力包不存在：${workPackId}`)
    if (entry.backend.type !== 'plugin' && entry.backend.type !== 'local-plugin') {
      if (!enabled) throw new Error('工作流能力包始终可用，不能停用')
      return this.listWorkPacks()
    }
    await this.requireRuntime().setPluginEnabled(entry.backend.pluginId, enabled)
    return this.listWorkPacks()
  }

  async uninstallWorkPack(workPackId: string) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry) throw new Error(`能力包不存在：${workPackId}`)
    if (entry.backend.type === 'skill') {
      await this.uninstallMarketplaceSkill(entry.backend.marketplaceId)
      return this.listWorkPacks()
    }
    if (entry.backend.type === 'plugin' || entry.backend.type === 'local-plugin') {
      await this.requireRuntime().uninstallPlugin(entry.backend.pluginId)
      return this.listWorkPacks()
    }
    throw new Error('本地工作流由文件系统管理，插件不会擅自删除')
  }

  reconnectMcp(name: string) {
    return this.requireRuntime().reconnectMcp(name)
  }

  acknowledgeNotification(notificationId: string) {
    return this.requireRuntime().acknowledgeNotification(notificationId)
  }

  listMemories(filters?: WorkbenchMemoryFilters, forceReload = false) {
    return this.requireRuntime().listMemories(filters, forceReload)
  }

  rememberMemory(input: WorkbenchMemoryCreateInput) {
    return this.requireRuntime().rememberMemory(input)
  }

  updateMemory(id: string, update: WorkbenchMemoryUpdateInput) {
    return this.requireRuntime().updateMemory(id, update)
  }

  forgetMemory(id: string, reason?: string) {
    return this.requireRuntime().forgetMemory(id, reason)
  }

  async importFiles(paths: string[]): Promise<WorkbenchFileReference[]> {
    const uniquePaths = [...new Set(paths.map(filePath => resolve(filePath)))].slice(0, 20)
    const targetDirectory = join(this.workspacePath, '.turboflux', 'attachments')
    await mkdir(targetDirectory, { recursive: true })
    const imported: WorkbenchFileReference[] = []
    for (const sourcePath of uniquePaths) {
      const info = await stat(sourcePath)
      if (!info.isFile()) continue
      if (info.size > MAX_IMPORTED_FILE_BYTES) throw new Error(`${basename(sourcePath)} exceeds the 50 MB attachment limit`)
      const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex').slice(0, 16)
      const filename = safeFilename(sourcePath)
      const targetPath = join(targetDirectory, `${digest}-${filename}`)
      await copyFile(sourcePath, targetPath)
      const mime = mimeForPath(targetPath)
      imported.push({
        id: `attachment-${digest}`,
        type: mime.startsWith('image/') ? 'image' : 'file',
        path: targetPath,
        mime,
        filename,
        size: info.size,
      })
      this.requireRuntime().registerArtifact(targetPath, 'import', { name: filename, mime })
    }
    return imported
  }

  async importClipboardImage(base64: string, mime: string, filename = 'clipboard.png'): Promise<WorkbenchFileReference> {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('Unsupported clipboard image type')
    const data = Buffer.from(base64, 'base64')
    if (data.length === 0 || data.length > 20 * 1024 * 1024) throw new Error('Clipboard image must be between 1 byte and 20 MB')
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 16)
    const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[mime]
    const displayFilename = `${safeFilename(filename).replace(/\.[^.]+$/, '')}${extension}`
    const targetDirectory = join(this.workspacePath, '.turboflux', 'attachments')
    await mkdir(targetDirectory, { recursive: true })
    const targetPath = join(targetDirectory, `${digest}-${displayFilename}`)
    await writeFile(targetPath, data, { mode: 0o600 })
    this.requireRuntime().registerArtifact(targetPath, 'import', { name: displayFilename, mime })
    return { id: `attachment-${digest}`, type: 'image', path: targetPath, mime, filename: displayFilename, size: data.length }
  }

  async importSkill(skillFilePath: string) {
    const sourcePath = resolve(skillFilePath)
    if (basename(sourcePath).toLowerCase() !== 'skill.md') throw new Error('Choose a SKILL.md file')
    const sourceDirectory = dirname(sourcePath)
    const targetRoot = join(this.workspacePath, '.turboflux', 'skills')
    await mkdir(targetRoot, { recursive: true })
    const baseName = safeFilename(basename(sourceDirectory))
    let targetDirectory = join(targetRoot, baseName)
    try {
      await stat(targetDirectory)
      targetDirectory = join(targetRoot, `${baseName}-${Date.now().toString(36)}`)
    } catch {}
    await cp(sourceDirectory, targetDirectory, { recursive: true, errorOnExist: false })
    return this.requireRuntime().reloadSkills()
  }

  async setWorkspace(workspacePath: string) {
    const nextPath = resolve(workspacePath)
    const info = await stat(nextPath)
    if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${nextPath}`)
    const activeWorkspacePath = resolve(this.requireRuntime().getSnapshot().workspace.path)
    if (nextPath !== activeWorkspacePath) {
      this.assertRuntimeTransitionAllowed()
      this.runtimeTransitioning = true
      try {
        await this.replaceRuntime(nextPath)
        this.workspacePath = nextPath
      } finally {
        this.runtimeTransitioning = false
      }
    } else {
      this.workspacePath = activeWorkspacePath
    }
    return this.getSnapshot()
  }

  private decorateSnapshot(snapshot: WorkbenchSnapshot): DesktopWorkbenchSnapshot {
    const specified = !this.unscopedWorkspacePath || resolve(snapshot.workspace.path) !== this.unscopedWorkspacePath
    const projects = this.unscopedWorkspacePath
      ? snapshot.projects.projects.filter(project => resolve(project.path) !== this.unscopedWorkspacePath)
      : snapshot.projects.projects
    return {
      ...snapshot,
      context: {
        ...snapshot.context,
        usage: recoverContextUsage(snapshot.context.usage, snapshot.conversation.turns),
      },
      workspace: {
        ...snapshot.workspace,
        name: specified ? snapshot.workspace.name : '未指定工作区',
        specified,
      },
      projects: {
        ...snapshot.projects,
        projects,
      },
    }
  }

  async destroy(): Promise<void> {
    this.taskTitleApplyGates.clear()
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = null
    const runtime = this.runtime
    this.runtime = null
    if (runtime) await runtime.destroy()
    this.listeners.clear()
  }

  private async replaceRuntime(workspacePath: string, options: { allowRecoverableError?: boolean } = {}): Promise<void> {
    const previousRuntime = this.runtime
    const localConfig = await loadConfig()
    const config: TurboFluxConfig = localConfig
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config,
      storagePath: this.storagePath,
      connectMcp: true,
      registerSystemPlugins: this.registerSystemPlugins,
      conversationPrefix: 'desktop',
      surfaceSystemPrompt: DESKTOP_EXPERIENCE_SYSTEM_PROMPT,
    })
    this.applyDesktopToolPolicy(runtime)
    try {
      await runtime.initializePlatform()
    } catch (error) {
      await runtime.destroy().catch(() => undefined)
      throw error
    }
    if (previousRuntime) {
      const blocker = runtimeTransitionBlocker(previousRuntime.getSnapshot(), options)
      if (blocker) {
        await runtime.destroy().catch(() => undefined)
        throw new Error(blocker)
      }
    }
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = null
    this.localConfig = localConfig
    this.runtimeConfig = config
    this.runtime = runtime
    this.runtimeEpoch += 1
    this.clearTransientTaskState()
    const runtimeEpoch = this.runtimeEpoch
    this.unsubscribeRuntime = runtime.subscribe(event => {
      if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
      const canonicalType = event.type === 'conversation-event' ? event.event.type : event.type
      if (process.env.TURBOFLUX_STREAM_TRACE === '1' && canonicalType === 'stream.started') {
        this.desktopStreamTraceActive = true
        this.desktopStreamListenerDurations.clear()
      }
      if (
        event.type === 'conversation-event'
        && ['stream.delta', 'stream.committed', 'tool.delta', 'tool.proposed'].includes(event.event.type)
      ) {
        this.taskTitleApplyGates.release(event.conversationId)
      }
      if (event.type === 'conversation-run') this.taskTitleApplyGates.release(event.conversationId)
      if (this.suppressRuntimeEvents) return
      if (event.type === 'conversation-run' && !this.historyRewriteConversations.has(event.conversationId)) {
        const queue = this.taskRunPromptCounts.get(event.conversationId)
        const promptCount = queue?.shift()
        if (queue && queue.length === 0) this.taskRunPromptCounts.delete(event.conversationId)
        if (promptCount) this.scheduleTaskTitleUpdate(event.conversationId, promptCount)
      }
      const desktopEvent = event.type === 'snapshot'
        ? { ...event, snapshot: this.decorateSnapshot(event.snapshot) }
        : event
      const listenersStartedAt = this.desktopStreamTraceActive ? performance.now() : 0
      for (const listener of this.listeners) listener(desktopEvent)
      if (this.desktopStreamTraceActive) {
        const samples = this.desktopStreamListenerDurations.get(canonicalType) || []
        samples.push(performance.now() - listenersStartedAt)
        this.desktopStreamListenerDurations.set(canonicalType, samples)
      }
      if (this.desktopStreamTraceActive && canonicalType === 'stream.ended') {
        console.error(`[TurboFlux stream trace] ${JSON.stringify({
          scope: 'desktop-runtime-host',
          at: Date.now(),
          listeners: Object.fromEntries(
            [...this.desktopStreamListenerDurations.entries()].map(([type, samples]) => [type, desktopTimingSummary(samples)]),
          ),
        })}`)
        this.desktopStreamTraceActive = false
      }
    })
    if (previousRuntime) await previousRuntime.destroy()
  }

  private applyDesktopToolPolicy(runtime: WorkbenchRuntime): void {
    runtime.runtime.engine.setDisabledTools(DESKTOP_REMOVED_TOOLS)
  }

  private recordTaskPrompt(conversationId: string, prompt: string, snapshot: ReturnType<WorkbenchRuntime['getSnapshot']>): number {
    const existingTurns = snapshot.conversation.id === conversationId
      ? snapshot.conversation.turns.filter(turn => turn.role === 'user' && turn.metadata?.internal !== true).map(turn => turn.content.trim()).filter(Boolean)
      : []
    const prompts = this.taskPrompts.get(conversationId) || existingTurns.slice(-5)
    if (prompts.at(-1) !== prompt.trim()) prompts.push(prompt.trim())
    this.taskPrompts.set(conversationId, prompts.filter(Boolean).slice(-6))
    const currentCount = this.submittedPromptCounts.get(conversationId) ?? existingTurns.length
    const nextCount = currentCount + 1
    this.submittedPromptCounts.set(conversationId, nextCount)
    return nextCount
  }

  private trackTaskRunPromptCount(conversationId: string, promptCount: number, status: 'started' | 'steering' | 'queued'): void {
    const queue = this.taskRunPromptCounts.get(conversationId) || []
    if (status === 'steering' && queue.length > 0) queue[0] = promptCount
    else queue.push(promptCount)
    this.taskRunPromptCounts.set(conversationId, queue)
  }

  private scheduleTaskTitleUpdate(
    conversationId: string,
    promptCount: number,
    applyGate?: TaskTitleApplyGate,
  ): void {
    const runtime = this.requireRuntime()
    const runtimeEpoch = this.runtimeEpoch
    const config = this.runtimeConfig
    const titleRevision = this.taskTitleRevisions.get(conversationId) || 0
    const previous = this.taskTitleUpdates.get(conversationId) || Promise.resolve()
    const update = previous
      .catch(() => undefined)
      .then(() => this.updateTaskTitle(runtime, runtimeEpoch, config, conversationId, promptCount, titleRevision, applyGate))
      .catch(() => undefined)
      .finally(() => {
        if (this.taskTitleUpdates.get(conversationId) === update) this.taskTitleUpdates.delete(conversationId)
      })
    this.taskTitleUpdates.set(conversationId, update)
  }

  private async updateTaskTitle(
    runtime: WorkbenchRuntime,
    runtimeEpoch: number,
    config: TurboFluxConfig | null,
    conversationId: string,
    promptCount: number,
    titleRevision: number,
    applyGate?: TaskTitleApplyGate,
  ): Promise<void> {
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
    if ((this.taskTitleRevisions.get(conversationId) || 0) !== titleRevision) return
    if (!config?.apiKey || !config.baseUrl || !config.model) return
    const snapshot = runtime.getSnapshot()
    const conversation = snapshot.conversations.find(item => item.id === conversationId)
    if (!conversation) return
    const managed = this.managedTaskTitles.get(conversationId)
    if (conversation.titleSource === 'custom' && !managed) return
    if (managed && managed.evaluatedPromptCount >= promptCount) return
    const prompts = this.taskPrompts.get(conversationId) || []
    if (prompts.length === 0) return
    const currentTitle = isPlaceholderTaskTitle(conversation.title) ? '新任务' : conversation.title.trim()
    let title = currentTitle
    try {
      title = await generateTaskTitle(config, { currentTitle, prompts })
    } catch {
      if (isPlaceholderTaskTitle(currentTitle)) title = fallbackTaskTitle(prompts[0])
    }
    title = title.trim().slice(0, 32)
    if (!title || isPlaceholderTaskTitle(title)) {
      title = isPlaceholderTaskTitle(currentTitle) ? fallbackTaskTitle(prompts[0]) : currentTitle
    }
    if (!title || isPlaceholderTaskTitle(title)) return
    if (applyGate) await applyGate.wait
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
    if ((this.taskTitleRevisions.get(conversationId) || 0) !== titleRevision) return
    const latestConversation = runtime.getSnapshot().conversations.find(item => item.id === conversationId)
    const latestManaged = this.managedTaskTitles.get(conversationId)
    if (!latestConversation || (latestConversation.titleSource === 'custom' && !latestManaged)) return
    if (latestConversation.title.trim() !== title) {
      const renamed = await runtime.renameConversation(conversationId, title, 'generated')
      if (!renamed) return
    }
    this.managedTaskTitles.set(conversationId, { title, evaluatedPromptCount: promptCount })
    await this.saveManagedTaskTitles()
  }

  private clearTransientTaskState(): void {
    this.taskPrompts.clear()
    this.submittedPromptCounts.clear()
    this.taskRunPromptCounts.clear()
    this.taskTitleUpdates.clear()
    this.taskTitleApplyGates.clear()
    this.taskTitleRevisions.clear()
    this.historyRewriteConversations.clear()
  }

  private assertRuntimeReadyForRun(): void {
    const externalBlocker = this.externalTransitionBlocker?.()
    if (externalBlocker) throw new Error(externalBlocker)
    if (this.runtimeTransitioning) throw new Error('正在更新工作环境，请稍后再试')
  }

  private assertRuntimeTransitionAllowed(
    runtime = this.requireRuntime(),
    options: { allowRecoverableError?: boolean } = {},
  ): void {
    const externalBlocker = this.externalTransitionBlocker?.()
    if (externalBlocker) throw new Error(externalBlocker)
    if (this.runtimeTransitioning) throw new Error('工作环境正在更新，请稍后再试')
    const blocker = runtimeTransitionBlocker(runtime.getSnapshot(), options)
    if (blocker) throw new Error(blocker)
  }

  private managedTaskTitlesPath(): string | null {
    return this.storagePath ? join(this.storagePath, 'managed-task-titles.json') : null
  }

  private async loadManagedTaskTitles(): Promise<void> {
    const path = this.managedTaskTitlesPath()
    if (!path) return
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { entries?: Record<string, ManagedTaskTitleState> }
      for (const [id, entry] of Object.entries(value.entries || {})) {
        if (typeof entry?.title !== 'string' || !Number.isSafeInteger(entry.evaluatedPromptCount)) continue
        this.managedTaskTitles.set(id, { title: entry.title, evaluatedPromptCount: Math.max(0, entry.evaluatedPromptCount) })
      }
    } catch {}
  }

  private async saveManagedTaskTitles(): Promise<void> {
    const path = this.managedTaskTitlesPath()
    if (!path) return
    const content = `${JSON.stringify({ version: 1, entries: Object.fromEntries(this.managedTaskTitles) }, null, 2)}\n`
    this.managedTaskTitleSave = this.managedTaskTitleSave.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${process.pid}.tmp`
      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, path)
    })
    await this.managedTaskTitleSave
  }

  private requireRuntime(): WorkbenchRuntime {
    if (!this.runtime) throw new Error('Desktop runtime is not ready')
    return this.runtime
  }

  private async resolveWorkPackPackage(marketplaceId: string): Promise<TurboFluxProductWorkPack | null> {
    const workPackRoot = join(dirname(fileURLToPath(import.meta.url)), 'workpacks')
    const packageDirectory = join(workPackRoot, marketplaceId)
    const manifestPath = join(packageDirectory, 'plugin.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TurboFluxProductWorkPack['manifest']
      const promptFiles: Record<string, string> = {}
      const promptRoot = join(packageDirectory, 'prompts')
      const entries = await readdir(promptRoot, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
      for (const entry of entries) {
        if (!entry.isFile()) continue
        promptFiles[entry.name] = await readFile(join(promptRoot, entry.name), 'utf8')
      }
      return {
        id: marketplaceId,
        publisher: manifest.publisher || 'community',
        trust: manifest.trust || 'install',
        description: manifest.description || '',
        manifest,
        promptFiles,
      }
    } catch {
      return null
    }
  }

}
