import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AgentEventType } from '../../core/agentEngine'
import {
  createApiConfigProfile,
  createEmptyConfig,
  getApiConfigProfiles,
  PROVIDER_PRESETS,
  saveConfig,
  switchActiveApiConfig,
  TURBOFLUX_PROVIDERS,
  type TurboFluxApiConfigProfile,
  type TurboFluxConfig,
} from '../../core/config'
import { discoverModelPresets } from '../../core/modelDiscovery'
import { getModelReasoningCapabilities } from '../../core/modelRegistry'
import type { GitDiffScope } from '../../core/gitService'
import { loadProfile, PERSONA_DEFINITIONS, saveProfile } from '../../core/profile'
import { loadMcpSettings, saveProjectMcpSettings } from '../../core/mcp/settings'
import type { McpClient } from '../../core/mcp/client'
import type { McpServerConfig, McpSettings } from '../../core/mcp/types'
import { createAgentRuntime, type AgentRuntime } from '../../core/runtime/agentRuntime'
import { emitStreamTimingTrace, streamTimingTraceEnabled, summarizeTimings } from '../../core/runtime/streamTimingTrace'
import type { SubAgentTaskSnapshot, SubAgentTranscriptRecord } from '../../core/runtime/subAgentTaskManager'
import type { SubAgentResult } from '../../core/subAgent'
import type { SubAgentEvent, SubAgentEvidence } from '../../shared/subAgentTypes'
import {
  normalizeApprovalPolicy,
  resolveCapabilityProfileForApproval,
  type AgentAttachment,
  type AgentCapabilitySelection,
  type AgentMode,
  type AgentTurn,
  type ApprovalPolicy,
} from '../../shared/agentTypes'
import { ConversationManager, type ConversationQueuedInput } from '../conversations/index'
import { deleteConversationAsync, listConversations, loadConversationAsync, sameWorkspacePath, saveConversation } from '../conversations/store'
import { WorkSession } from '../work/index'
import { ProjectService } from '../projects/projectService'
import {
  AutomationService,
  type AutomationClaim,
  type AutomationSchedule,
  type AutomationUpdateInput,
} from '../automations/automationService'
import { ArtifactService, type ArtifactSource } from '../artifacts/artifactService'
import { PluginService } from '../plugins/pluginService'
import {
  redactComputerActiveTask,
  redactComputerAgentEvent,
  redactComputerContextSegments,
  redactComputerTurns,
} from '../privacy/computerPrivacy'
import { listWorkbenchCommands } from './commands'
import type {
  WorkbenchCommandDefinition,
  WorkbenchCommandId,
  WorkbenchCommandResult,
  WorkbenchConversationResult,
  WorkbenchDraftSnapshot,
  WorkbenchEvent,
  WorkbenchGitActionResult,
  WorkbenchGitDiffResult,
  WorkbenchInteractiveRequest,
  WorkbenchMemoryCreateInput,
  WorkbenchMemoryFilters,
  WorkbenchMemorySnapshot,
  WorkbenchMemoryUpdateInput,
  WorkbenchMcpServerSummary,
  WorkbenchSettingsSaveResult,
  WorkbenchSettingsSnapshot,
  WorkbenchSettingsUpdate,
  WorkbenchSnapshot,
  WorkbenchSubAgentActionResult,
  WorkbenchSubAgentDetail,
  WorkbenchSubAgentEvidence,
  WorkbenchSubAgentSummary,
  WorkbenchSubmitResult,
} from './types'

export interface CreateWorkbenchRuntimeOptions {
  workspacePath: string
  config: TurboFluxConfig
  storagePath?: string
  runtimeStoragePath?: string
  connectMcp?: boolean
  registerSystemPlugins?: (client: McpClient, context: { conversationId: string }) => void
  conversationPrefix?: string
  surfaceSystemPrompt?: string
}

export type WorkbenchEventListener = (event: WorkbenchEvent) => void

interface WorkbenchConversationRuntime {
  id: string
  runtime: AgentRuntime
  conversations: ConversationManager
  work: WorkSession
  activeRun: Promise<void> | null
  historyRewrite: Promise<WorkbenchSubmitResult> | null
  destroying: boolean
  activeRunCapabilities?: AgentCapabilitySelection
  activeAutomationRun: { automationId: string; runId: string } | null
  currentRecovery?: WorkbenchSnapshot['conversation']['recovery']
  updatedAt: number
  unsubscribeEngine: () => void
  unsubscribeSession: () => void
}

const MAX_CONCURRENT_AUTOMATIONS = 2
const MAX_TIMER_DELAY_MS = 2_147_000_000
const HISTORY_REWRITE_STOP_TIMEOUT_MS = 10_000
const CONVERSATION_SHUTDOWN_TIMEOUT_MS = 8_000
const RESOURCE_SHUTDOWN_TIMEOUT_MS = 5_000

function waitForSettlement<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(timeoutMessage)), timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      error => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}

function createInputId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function cloneCapabilitySelection(selection?: AgentCapabilitySelection): AgentCapabilitySelection | undefined {
  return selection?.items.length
    ? { items: selection.items.map(item => ({ ...item })) }
    : undefined
}

function sameCapabilitySelection(left?: AgentCapabilitySelection, right?: AgentCapabilitySelection): boolean {
  const leftKeys = (left?.items || []).map(item => `${item.type}:${item.id}`).sort()
  const rightKeys = (right?.items || []).map(item => `${item.type}:${item.id}`).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

function summarizeAutomationResult(turns: AgentTurn[]): string | undefined {
  const assistant = [...turns].reverse().find(turn => turn.role === 'assistant' && turn.content.trim())
  if (!assistant) return undefined
  return assistant.content.replace(/\s+/g, ' ').trim().slice(0, 4_000) || undefined
}

function toInteractiveRequest(request: ReturnType<AgentRuntime['engine']['getPendingInteractiveRequests']>['active']): WorkbenchInteractiveRequest | null {
  if (!request) return null
  return {
    id: request.id,
    kind: request.kind,
    question: request.event.question,
    options: request.event.options,
    reason: request.event.reason,
    command: request.event.command,
    toolName: request.event.toolName,
    path: request.event.path,
  }
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function cloneMcpConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...config,
    args: config.args ? [...config.args] : undefined,
    env: config.env ? { ...config.env } : undefined,
    httpHeaders: config.httpHeaders ? { ...config.httpHeaders } : undefined,
    enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
    disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
  }
}

const FINISHED_SUBAGENT_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'orphaned'])

function compactText(value: unknown, limit = 240): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : ''
}

function projectSubAgentEvidence(value: SubAgentEvidence): WorkbenchSubAgentEvidence {
  return {
    path: compactText(value.path, 500),
    startLine: Math.max(1, Math.floor(value.startLine || 1)),
    endLine: Math.max(1, Math.floor(value.endLine || value.startLine || 1)),
    preview: compactText(value.preview, 1_200),
    reason: compactText(value.reason, 500),
    kind: value.kind,
    confidence: value.confidence,
    symbol: compactText(value.symbol, 200) || undefined,
  }
}

function projectSubAgentResult(value: unknown): WorkbenchSubAgentDetail['result'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result = value as Partial<SubAgentResult>
  if (typeof result.ok !== 'boolean') return undefined
  return {
    ok: result.ok,
    finalText: compactText(result.finalText, 20_000),
    turns: Math.max(0, Math.floor(result.turns || 0)),
    elapsedMs: Math.max(0, Math.floor(result.elapsedMs || 0)),
    truncated: result.truncated === true,
    error: compactText(result.error, 1_000) || undefined,
    evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 50).map(projectSubAgentEvidence) : [],
  }
}

function describeSubAgentEvent(event: unknown): { title: string; detail?: string; progress?: number; evidence?: WorkbenchSubAgentEvidence } {
  if (!event || typeof event !== 'object') return { title: '记录了一项进展' }
  const value = event as SubAgentEvent
  switch (value.type) {
    case 'turn_start':
      return { title: `开始第 ${value.turn} 轮`, detail: `最多 ${value.maxTurns} 轮`, progress: value.maxTurns > 0 ? Math.min(95, Math.round(((value.turn - 1) / value.maxTurns) * 100)) : 0 }
    case 'model_wait': return { title: '正在思考', detail: `第 ${value.turn} 轮` }
    case 'model_retry': return { title: '正在调整并重试', detail: compactText(value.reason, 320) }
    case 'model_response': return { title: '已形成下一步', detail: value.returnedTools.length ? `准备使用 ${value.returnedTools.join('、')}` : `第 ${value.turn} 轮完成` }
    case 'turn_complete': return { title: `第 ${value.turn} 轮完成`, detail: value.calls ? `完成 ${value.calls} 项操作` : '已完成分析', progress: Math.min(95, Math.max(5, value.turn * 12)) }
    case 'tool_call': return { title: `正在使用 ${compactText(value.tool, 80)}`, detail: `第 ${value.turn} 轮` }
    case 'tool_result': return { title: value.ok ? `${compactText(value.tool, 80)} 已完成` : `${compactText(value.tool, 80)} 未完成`, detail: compactText(value.summary, 500) }
    case 'evidence': return { title: '找到关键证据', detail: compactText(value.evidence.reason, 500), evidence: projectSubAgentEvidence(value.evidence) }
    case 'final': return { title: '已整理结果', detail: compactText(value.text, 900), progress: 100 }
    case 'error': return { title: '执行遇到问题', detail: compactText(value.message, 900) }
  }
}

function summarizeSubAgentTask(
  task: SubAgentTaskSnapshot,
  records: SubAgentTranscriptRecord[] = [],
  transcriptCount = 0,
): WorkbenchSubAgentSummary {
  const result = projectSubAgentResult(task.result)
  const finished = FINISHED_SUBAGENT_STATUSES.has(task.runtimeTask.status)
  let progress = finished ? 100 : task.runtimeTask.status === 'starting' ? 3 : 15
  let lastEvent: string | undefined
  for (const record of records) {
    if (record.type !== 'event') continue
    const presentation = describeSubAgentEvent(record.event)
    if (typeof presentation.progress === 'number') progress = Math.max(progress, presentation.progress)
    lastEvent = presentation.detail ? `${presentation.title} · ${presentation.detail}` : presentation.title
  }
  return {
    id: task.id,
    agentType: task.agentType,
    label: task.label,
    objective: task.objective,
    startedAt: task.startedAt,
    endedAt: task.runtimeTask.endedAt,
    updatedAt: task.runtimeTask.updatedAt,
    status: task.runtimeTask.status,
    error: task.runtimeTask.error,
    progress,
    transcriptCount,
    lastEvent,
    resultSummary: result ? compactText(result.finalText || result.error, 320) || undefined : undefined,
    retryOf: task.retryOf,
    retryable: finished,
  }
}

function projectSubAgentTimelineRecord(record: SubAgentTranscriptRecord, index: number) {
  if (record.type === 'start') {
    return { id: `start-${index}`, timestamp: record.timestamp, type: 'start' as const, title: '并行任务已启动', detail: record.task.objective }
  }
  if (record.type === 'event') {
    const presentation = describeSubAgentEvent(record.event)
    return { id: `event-${index}`, timestamp: record.timestamp, type: presentation.evidence ? 'evidence' as const : 'progress' as const, ...presentation }
  }
  if (record.type === 'result') {
    const result = projectSubAgentResult(record.result)
    return {
      id: `result-${index}`,
      timestamp: record.timestamp,
      type: 'result' as const,
      title: record.status === 'completed' ? '并行任务已完成' : record.status === 'stopped' ? '并行任务已停止' : '并行任务失败',
      detail: compactText(result?.finalText || record.error, 900) || undefined,
      status: record.status,
    }
  }
  return {
    id: `state-${index}`,
    timestamp: record.timestamp,
    type: 'state' as const,
    title: record.status === 'completed' ? '状态已完成' : record.status === 'failed' ? '状态失败' : record.status === 'stopped' ? '状态已停止' : '状态已更新',
    detail: compactText(record.error, 900) || undefined,
    status: record.status,
  }
}

function validateApiProfile(
  input: WorkbenchSettingsUpdate['apiProfiles'][number],
  existing?: TurboFluxApiConfigProfile,
): TurboFluxApiConfigProfile {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!id) throw new Error('Every API configuration needs an id')
  if (!name) throw new Error('Every API configuration needs a name')
  if (!TURBOFLUX_PROVIDERS.includes(input.provider)) throw new Error(`Unsupported provider: ${String(input.provider)}`)
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (baseUrl) {
    try {
      new URL(baseUrl)
    } catch {
      throw new Error(`${name} has an invalid API URL`)
    }
  }
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim()
    ? input.apiKey.trim()
    : existing?.apiKey || ''
  return createApiConfigProfile({
    ...existing,
    ...input,
    id,
    name,
    apiKey,
    baseUrl,
    model: typeof input.model === 'string' ? input.model.trim() : '',
    contextWindow: requirePositiveInteger(input.contextWindow, `${name} context window`),
    maxTokens: requirePositiveInteger(input.maxTokens, `${name} max tokens`),
    maxOutputTokens: input.maxOutputTokens === undefined
      ? undefined
      : requirePositiveInteger(input.maxOutputTokens, `${name} max output tokens`),
  })
}

export class WorkbenchRuntime {
  readonly projects: ProjectService
  readonly automations: AutomationService
  readonly artifacts: ArtifactService
  readonly plugins: PluginService

  private readonly listeners = new Set<WorkbenchEventListener>()
  private workbenchStreamTraceActive = false
  private readonly workbenchStreamTraceStages = new Map<string, number[]>()
  private readonly conversationRuntimes = new Map<string, WorkbenchConversationRuntime>()
  private activeConversationId = ''
  private platformInitialized = false
  private readonly automationRuns = new Map<string, { automationId: string; runId: string }>()
  private readonly automationRunTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly automationTimedOutRuns = new Set<string>()
  private automationTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(private readonly options: CreateWorkbenchRuntimeOptions) {
    const workspaceName = basename(options.workspacePath) || 'workspace'
    const storagePath = options.storagePath || join(options.workspacePath, '.turboflux', 'desktop-state')
    this.projects = new ProjectService(join(storagePath, 'projects.json'))
    this.automations = new AutomationService(join(storagePath, 'automations.json'))
    this.artifacts = new ArtifactService(join(storagePath, 'artifacts.json'))
    this.plugins = new PluginService(join(storagePath, 'plugins.json'), join(storagePath, 'plugins'), options.workspacePath, () => this.emitSnapshot())
    this.projects.recordOpened(options.workspacePath)
    const initial = this.createConversationRuntime(undefined, workspaceName)
    this.conversationRuntimes.set(initial.id, initial)
    this.activeConversationId = initial.id
  }

  subscribe(listener: WorkbenchEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  registerSystemPlugins(registrar: NonNullable<CreateWorkbenchRuntimeOptions['registerSystemPlugins']>): void {
    for (const slot of this.conversationRuntimes.values()) {
      registrar(slot.runtime.mcpClient, { conversationId: slot.id })
    }
  }

  get runtime(): AgentRuntime {
    return this.activeConversationRuntime.runtime
  }

  get conversations(): ConversationManager {
    return this.activeConversationRuntime.conversations
  }

  private get activeConversationRuntime(): WorkbenchConversationRuntime {
    const runtime = this.conversationRuntimes.get(this.activeConversationId)
    if (!runtime) throw new Error('Active conversation runtime is unavailable')
    return runtime
  }

  private get activeRun(): Promise<void> | null {
    return this.activeConversationRuntime.activeRun
  }

  private set activeRun(value: Promise<void> | null) {
    this.activeConversationRuntime.activeRun = value
  }

  private get activeRunCapabilities(): AgentCapabilitySelection | undefined {
    return this.activeConversationRuntime.activeRunCapabilities
  }

  private set activeRunCapabilities(value: AgentCapabilitySelection | undefined) {
    this.activeConversationRuntime.activeRunCapabilities = value
  }

  private get currentRecovery(): WorkbenchSnapshot['conversation']['recovery'] {
    return this.activeConversationRuntime.currentRecovery
  }

  private set currentRecovery(value: WorkbenchSnapshot['conversation']['recovery']) {
    this.activeConversationRuntime.currentRecovery = value
  }

  getSnapshot(): WorkbenchSnapshot {
    const pending = this.runtime.engine.getPendingInteractiveRequests()
    const pendingRequests = [pending.active, ...pending.queued]
      .map(toInteractiveRequest)
      .filter((request): request is WorkbenchInteractiveRequest => request !== null)
    const runState = this.runtime.engine.getRunState()
    const status = this.runtimeStatus(this.activeConversationRuntime)
    const interactionState = this.conversations.getInteractionState()
    const activeSkillId = this.runtime.skillRuntime.getActiveSkillId()
    const ownerSessionId = this.runtime.sessionRegistry.getCurrentId()
    const fullConversationTurns = this.runtime.engine.getFullConversationTurns()
    const currentConversationId = this.conversations.getCurrentId()
    const conversationCatalog = this.conversations.listAll()
    const conversations = conversationCatalog.filter(conversation => sameWorkspacePath(conversation.workspacePath, this.options.workspacePath))
    for (const slot of this.conversationRuntimes.values()) {
      if (conversations.some(conversation => conversation.id === slot.id)) continue
      const turns = slot.runtime.engine.getFullConversationTurns()
      const meta = {
        id: slot.id,
        title: turns.find(turn => turn.role === 'user')?.content.trim().slice(0, 72) || '未命名任务',
        workspacePath: this.options.workspacePath,
        createdAt: turns[0]?.timestamp || slot.updatedAt,
        updatedAt: slot.updatedAt,
        mode: slot.runtime.engine.getMode(),
        model: this.options.config.model,
        provider: this.options.config.provider,
        turnCount: turns.length,
      }
      conversations.push(meta)
      if (!conversationCatalog.some(conversation => conversation.id === slot.id)) conversationCatalog.push(meta)
    }
    conversations.sort((left, right) => right.updatedAt - left.updatedAt)
    conversationCatalog.sort((left, right) => right.updatedAt - left.updatedAt)
    const artifacts = this.artifacts.list(this.options.workspacePath)
    const persistence = this.conversations.getPersistenceHealth()
    const runtimeSummary: WorkbenchSnapshot['runtime'] = {
      status,
      configured: Boolean(this.options.config.apiKey && this.options.config.baseUrl && this.options.config.model),
      provider: this.options.config.provider,
      model: this.options.config.model,
      reasoning: this.options.config.reasoning ? { ...this.options.config.reasoning } : undefined,
      mode: this.runtime.engine.getMode(),
      approvalPolicy: this.runtime.engine.getApprovalPolicy(),
      capabilityProfile: this.options.config.capabilityProfile,
      runState,
      pendingRequests,
    }
    const runtimeTasks = this.runtime.runtimeTaskManager.listTasks({ ownerSessionId })
    const subagents = this.runtime.subAgentTaskManager.listTasks().map(task => {
      const transcript = this.runtime.subAgentTaskManager.readTranscript(task.id, { limit: 40 })
      return summarizeSubAgentTask(task, transcript.records, transcript.total)
    })
    const execution = this.runtime.engine.getWorkExecutionSnapshot()
    const currentExecution = execution.currentRunId
      ? execution.runs.find(run => run.id === execution.currentRunId)
      : execution.runs.at(-1)
    if (currentExecution) {
      for (const task of runtimeTasks) {
        const taskRunId = typeof task.metadata?.runId === 'string' ? task.metadata.runId : undefined
        const workRunId = typeof task.metadata?.workRunId === 'string' ? task.metadata.workRunId : taskRunId
        if (workRunId ? workRunId !== currentExecution.id : task.startedAt < currentExecution.startedAt - 1_000) continue
        const status = task.status === 'failed' || task.status === 'orphaned'
          ? 'failed'
          : ['completed', 'stopped', 'interrupted'].includes(task.status)
            ? task.status === 'completed' ? 'completed' : 'cancelled'
            : 'running'
        currentExecution.activities[`runtime-${task.id}`] = {
          id: `runtime-${task.id}`,
          runId: currentExecution.id,
          stepId: typeof task.metadata?.stepId === 'string' ? task.metadata.stepId : undefined,
          kind: task.presentation?.previewUrl ? 'browser' : 'service',
          title: task.presentation?.title || task.kind,
          detail: task.presentation?.detail,
          status,
          attempt: 1,
          startedAt: task.startedAt,
          updatedAt: task.updatedAt,
          completedAt: task.endedAt,
          metadata: { runtimeTaskId: task.id },
        }
      }
      for (const agent of subagents) {
        if (agent.startedAt < currentExecution.startedAt - 1_000) continue
        currentExecution.activities[`subagent-${agent.id}`] = {
          id: `subagent-${agent.id}`,
          runId: currentExecution.id,
          kind: 'subagent',
          title: agent.label || agent.agentType,
          detail: agent.lastEvent || agent.objective,
          status: agent.status === 'failed' || agent.status === 'orphaned'
            ? 'failed'
            : agent.status === 'completed'
              ? 'completed'
              : ['stopped', 'interrupted'].includes(agent.status) ? 'cancelled' : 'running',
          attempt: agent.retryOf ? 2 : 1,
          startedAt: agent.startedAt,
          updatedAt: agent.updatedAt,
          completedAt: agent.endedAt,
          error: agent.error,
          result: agent.resultSummary,
          metadata: { subagentId: agent.id, retryOf: agent.retryOf },
        }
        currentExecution.presentation = 'work'
      }
    }
    const activity: WorkbenchSnapshot['activity'] = {
      execution,
      activeTask: redactComputerActiveTask(this.runtime.engine.getTaskManager().getActiveTaskContext()),
      taskTree: this.runtime.engine.getTaskManager().getFullTree(),
      runtimeTasks,
      subagents,
    }

    return {
      schemaVersion: 1,
      product: 'TurboFlux Workbench',
      platform: process.platform,
      workspace: {
        path: this.options.workspacePath,
        name: basename(this.options.workspacePath) || 'workspace',
      },
      runtime: runtimeSummary,
      conversation: {
        id: currentConversationId,
        turns: redactComputerTurns(fullConversationTurns),
        recovery: this.currentRecovery,
      },
      conversations,
      conversationCatalog,
      conversationRuntimes: [...this.conversationRuntimes.values()].map(runtime => ({
        conversationId: runtime.id,
        status: this.runtimeStatus(runtime),
        runState: runtime.runtime.engine.getRunState(),
        updatedAt: runtime.updatedAt,
      })),
      work: this.activeConversationRuntime.work.getSnapshot(),
      skills: this.runtime.skillRuntime.getAll().map(skill => ({
        id: skill.id,
        name: skill.name,
        command: skill.command,
        description: skill.description,
          category: skill.category,
          icon: skill.icon,
          filePath: skill.filePath,
          active: skill.id === activeSkillId,
        })),
      context: {
        usage: this.runtime.engine.getContextUsage(),
        contextWindow: this.options.config.contextWindow,
        segments: redactComputerContextSegments(this.runtime.engine.getContextSegments(), fullConversationTurns),
        compaction: this.runtime.engine.getContextCompactionState(),
      },
      git: this.runtime.engine.getGitState(),
      activity,
      projects: this.projects.list(),
      automations: this.automations.list(this.options.workspacePath),
      artifacts,
      plugins: this.plugins.list(),
      draft: {
        text: interactionState.draft.text,
        attachments: interactionState.draft.attachments?.map(attachment => ({ ...attachment })) || [],
        files: interactionState.draft.files?.map(file => ({ ...file })) || [],
        pendingPastes: interactionState.draft.pendingPastes?.map(paste => ({ ...paste })) || [],
        capabilities: interactionState.draft.capabilities
          ? { items: interactionState.draft.capabilities.items.map(item => ({ ...item })) }
          : { items: [] },
      },
      persistence,
    }
  }

  readSubAgent(taskId: string, offset?: number, limit?: number): WorkbenchSubAgentDetail {
    this.assertAvailable()
    const task = this.runtime.subAgentTaskManager.getTask(taskId)
    if (!task) throw new Error(`Subagent task not found: ${taskId}`)
    const transcript = this.runtime.subAgentTaskManager.readTranscript(taskId, {
      offset,
      limit: limit === undefined ? 80 : Math.max(1, Math.min(200, Math.floor(limit))),
    })
    return {
      task: summarizeSubAgentTask(task, transcript.records, transcript.total),
      timeline: transcript.records.map((record, index) => projectSubAgentTimelineRecord(record, transcript.offset + index)),
      offset: transcript.offset,
      nextOffset: transcript.nextOffset,
      total: transcript.total,
      result: projectSubAgentResult(task.result),
    }
  }

  async stopSubAgent(taskId: string): Promise<WorkbenchSubAgentActionResult> {
    this.assertAvailable()
    const task = await this.runtime.engine.stopSubAgentTask(taskId)
    this.emitSnapshot()
    return { taskId: task.id, snapshot: this.getSnapshot() }
  }

  retrySubAgent(taskId: string): WorkbenchSubAgentActionResult {
    this.assertAvailable()
    const task = this.runtime.engine.retrySubAgentTask(taskId)
    this.emitSnapshot()
    return { taskId: task.id, snapshot: this.getSnapshot() }
  }

  submitPrompt(
    prompt: string,
    attachments?: AgentAttachment[],
    capabilities?: AgentCapabilitySelection,
    runOptions: {
      approvalPolicy?: ApprovalPolicy
      automationId?: string
      automationRunId?: string
      forceQueue?: boolean
      slot?: WorkbenchConversationRuntime
    } = {},
  ): WorkbenchSubmitResult {
    this.assertAvailable()
    const slot = runOptions.slot ?? this.activeConversationRuntime
    if (slot.destroying) throw new Error('Conversation runtime is shutting down')
    if (slot.historyRewrite) throw new Error('Conversation history is being updated; wait for the edited message to restart')
    const text = prompt.trim()
    if (!text) throw new Error('Prompt cannot be empty')
    if (!this.options.config.apiKey) throw new Error('No API key is configured. Run `tf st` to configure a provider.')
    if (!this.options.config.model) throw new Error('No model is configured. Run `tf st` to choose a model.')
    if (!slot.conversations.isPersistenceHealthy()) {
      throw new Error('会话暂时无法保存，请先重试保存；如仍失败，可导出诊断数据。')
    }
    const requestedCapabilities = capabilities ?? slot.conversations.getInteractionState().draft.capabilities
    const selectedCapabilities = this.resolveCapabilitySelection(requestedCapabilities, slot)

    const inputId = createInputId('desktop-input')
    if (runOptions.automationId && runOptions.automationRunId) {
      this.automationRuns.set(inputId, { automationId: runOptions.automationId, runId: runOptions.automationRunId })
    }
    const hasActiveWork = Boolean(
      slot.activeRun
      || slot.runtime.engine.isRunning()
      || slot.runtime.engine.isContextCompacting(),
    )
    const hasQueuedInputs = this.getQueuedInputs(slot).length > 0
    if (hasActiveWork || hasQueuedInputs) {
      const canSteerWithCurrentCapabilities = sameCapabilitySelection(selectedCapabilities, slot.activeRunCapabilities)
      if (hasActiveWork && !runOptions.forceQueue && slot === this.activeConversationRuntime && canSteerWithCurrentCapabilities && (!attachments || attachments.length === 0) && slot.runtime.engine.submitSteeringMessage(text, inputId)) {
        return { status: 'steering', inputId }
      }
      const queuedInput: ConversationQueuedInput = {
        id: inputId,
        prompt: text,
        attachments,
        capabilities: selectedCapabilities,
        approvalPolicy: runOptions.approvalPolicy,
        automationId: runOptions.automationId,
        automationRunId: runOptions.automationRunId,
      }
      this.enqueueInputDurably(slot, queuedInput)
      if (!hasActiveWork) this.startNextQueuedPromptIfIdle(slot)
      return { status: 'queued', inputId }
    }

    this.startPrompt(text, attachments, selectedCapabilities, inputId, runOptions.approvalPolicy, slot)
    return { status: 'started', inputId }
  }

  async resendFromTurn(turnId: string, prompt: string): Promise<WorkbenchSubmitResult> {
    this.assertAvailable()
    const slot = this.activeConversationRuntime
    if (slot.destroying) throw new Error('Conversation runtime is shutting down')
    if (slot.historyRewrite) throw new Error('Another edited message is already being applied')
    const text = prompt.trim()
    if (!text) throw new Error('Prompt cannot be empty')
    if (!this.options.config.apiKey) throw new Error('No API key is configured. Run `tf st` to configure a provider.')
    if (!this.options.config.model) throw new Error('No model is configured. Run `tf st` to choose a model.')
    if (!slot.conversations.isPersistenceHealthy()) {
      throw new Error('会话暂时无法保存，请先重试保存；如仍失败，可导出诊断数据。')
    }
    if (this.getQueuedInputs(slot).length > 0) throw new Error('Cannot edit a message while another input is queued')

    const turns = slot.runtime.engine.getFullConversationTurns()
    const turnIndex = turns.findIndex(turn => turn.id === turnId && turn.role === 'user')
    if (turnIndex < 0) throw new Error('The message is no longer available to edit')
    const original = turns[turnIndex]!
    const retainedTurns = turns.slice(0, turnIndex)
    const attachments = original.metadata?.attachments?.map(attachment => ({ ...attachment }))
    const capabilities = this.resolveCapabilitySelection(original.metadata?.capabilities)
    const editedTurn: AgentTurn = {
      ...original,
      content: text,
      timestamp: Date.now(),
      metadata: {
        ...original.metadata,
        ...(attachments ? { attachments } : {}),
        ...(capabilities ? { capabilities } : {}),
        workRunId: turnId,
      },
    }
    const rewrittenTurns = [...retainedTurns, editedTurn]
    const previousContextSegments = slot.runtime.engine.getContextSegments()
    const previousContextReservoir = slot.runtime.engine.getContextReservoir()
    const previousContextCompaction = slot.runtime.engine.getContextCompactionState()
    const previousRecovery = slot.currentRecovery

    const rewrite = Promise.resolve().then(async (): Promise<WorkbenchSubmitResult> => {
      if (slot.activeRun || slot.runtime.engine.isRunning() || slot.runtime.engine.isContextCompacting()) {
        await this.stopConversationRun(slot, '停止当前任务超时，原消息尚未改写；请重试停止任务后再编辑。')
      }
      if (this.destroyed || slot.destroying) throw new Error('Conversation runtime is shutting down')

      let rewritePersisted = false
      try {
        slot.work.replaceFromTurns(rewrittenTurns)
        slot.conversations.replaceCanonicalEvents(slot.work.log.getEvents())
        slot.runtime.engine.restoreFromTurns(rewrittenTurns, { emitRunState: false })
        slot.runtime.engine.setContextSegments([])
        slot.runtime.engine.setContextReservoir([])
        slot.runtime.engine.setContextCompactionState(null)
        slot.currentRecovery = undefined
        slot.conversations.rewriteCurrentSnapshot()
        rewritePersisted = true
        slot.updatedAt = Date.now()
        this.emitSnapshot()
        this.startPrompt(text, attachments, capabilities, turnId, undefined, slot, false, true)
        return { status: 'started', inputId: turnId }
      } catch (error) {
        if (slot.activeRun || slot.runtime.engine.isRunning() || slot.runtime.engine.isContextCompacting()) {
          try {
            await this.stopConversationRun(slot, '停止编辑后的任务超时，无法安全回滚消息。')
          } catch (stopError) {
            throw new AggregateError([error, stopError], 'Edited message could not be rolled back safely')
          }
        }
        if (this.destroyed || slot.destroying) throw error
        slot.work.replaceFromTurns(turns)
        slot.conversations.replaceCanonicalEvents(slot.work.log.getEvents())
        slot.runtime.engine.restoreFromTurns(turns, { emitRunState: false })
        slot.runtime.engine.setContextSegments(previousContextSegments)
        slot.runtime.engine.setContextReservoir(previousContextReservoir)
        slot.runtime.engine.setContextCompactionState(previousContextCompaction)
        slot.currentRecovery = previousRecovery
        if (rewritePersisted) slot.conversations.rewriteCurrentSnapshot()
        slot.updatedAt = Date.now()
        this.emitSnapshot()
        throw error
      }
    })
    slot.historyRewrite = rewrite
    this.emitSnapshot()
    try {
      return await rewrite
    } finally {
      if (slot.historyRewrite === rewrite) slot.historyRewrite = null
      this.emitSnapshot()
    }
  }

  stop(): boolean {
    if (!this.runtime.engine.isRunning() && !this.runtime.engine.isContextCompacting()) return false
    this.runtime.engine.abort()
    return true
  }

  stopConversation(id: string): boolean {
    const slot = this.conversationRuntimes.get(id)
    if (!slot || (!slot.runtime.engine.isRunning() && !slot.runtime.engine.isContextCompacting())) return false
    slot.runtime.engine.abort()
    return true
  }

  pause(): boolean {
    return this.runtime.engine.pause()
  }

  pauseConversation(id: string): boolean {
    const slot = this.conversationRuntimes.get(id)
    return slot?.runtime.engine.pause() ?? false
  }

  resumeConversation(id: string): boolean {
    const slot = this.conversationRuntimes.get(id)
    return slot?.runtime.engine.resume() ?? false
  }

  resume(): boolean {
    return this.runtime.engine.resume()
  }

  controlWorkStep(taskId: string, action: import('../../shared/workExecutionTypes').WorkStepControlAction) {
    this.assertAvailable()
    const task = this.runtime.engine.getTaskManager().getTask(taskId)
    if (!this.runtime.engine.controlWorkStep(taskId, action)) throw new Error(`Work step not found: ${taskId}`)
    if (action === 'retry' && task) {
      this.submitPrompt(`重试并完成工作步骤「${task.title}」。先检查上次失败的证据，修正原因后重新验收；不要把单次工具失败当作步骤最终失败。`)
    }
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return { taskId, action, snapshot }
  }

  resolveRequest(requestId: string, response: string): boolean {
    this.assertAvailable()
    return this.runtime.engine.submitAskUserResponse(response, requestId)
  }

  setMode(mode: AgentMode): WorkbenchSnapshot {
    this.assertIdle('change mode')
    this.runtime.engine.setMode(mode)
    return this.getSnapshot()
  }

  async getSettings(forceModels = false): Promise<WorkbenchSettingsSnapshot> {
    this.assertAvailable()
    const config = this.options.config
    const discovery = await discoverModelPresets(config, forceModels ? { force: true } : { cacheOnly: true })
    return {
      schemaVersion: 1,
      activeApiConfigId: config.activeApiConfigId,
      approvalPolicy: config.approvalPolicy,
      capabilityProfile: config.capabilityProfile ?? 'workspace-write',
      gitEnabled: config.gitEnabled !== false,
      apiProfiles: getApiConfigProfiles(config).map(({ apiKey, ...profile }) => ({
        ...profile,
        hasApiKey: Boolean(apiKey),
      })),
      providerPresets: PROVIDER_PRESETS.map(preset => ({ ...preset })),
      models: discovery.models.map(model => ({
        ...model,
        reasoningCapabilities: getModelReasoningCapabilities(
          model.model,
          model.provider,
          model.capabilities,
        ),
      })),
      modelDiscovery: {
        source: discovery.source,
        stale: discovery.stale,
        fetchedAt: discovery.fetchedAt,
        error: discovery.error,
      },
      profile: loadProfile(),
      personas: PERSONA_DEFINITIONS.map(persona => ({ ...persona })),
      skills: this.getSnapshot().skills,
      mcpServers: this.getMcpServerSummaries(),
      plugins: this.plugins.list(),
    }
  }

  async initializePlatform(): Promise<void> {
    await Promise.all([...this.conversationRuntimes.values()].map(runtime => this.initializeConversationRuntime(runtime)))
    this.platformInitialized = true
    for (const slot of this.conversationRuntimes.values()) this.startNextQueuedPromptIfIdle(slot)
    this.scheduleAutomationWake(100)
    this.emitSnapshot()
  }

  listPlugins() {
    return this.plugins.list()
  }

  inspectPlugin(path: string) {
    return this.plugins.inspectDirectory(path)
  }

  async installPlugin(path: string, approvedPermissions: import('../../shared/pluginTypes').PluginPermission[]) {
    const snapshot = await this.plugins.installFromDirectory(path, approvedPermissions)
    this.emitSnapshot()
    return snapshot
  }

  async installMarketplacePlugin(id: string, approvedPermissions: import('../../shared/pluginTypes').PluginPermission[] = []) {
    const snapshot = await this.plugins.installMarketplace(id, approvedPermissions)
    this.emitSnapshot()
    return snapshot
  }

  async setPluginEnabled(id: string, enabled: boolean) {
    const snapshot = await this.plugins.setEnabled(id, enabled)
    for (const slot of this.conversationRuntimes.values()) {
      slot.runtime.skillRuntime.reload()
      this.syncSkills(slot)
    }
    this.emitSnapshot()
    return snapshot
  }

  async uninstallPlugin(id: string) {
    const snapshot = await this.plugins.uninstall(id)
    for (const slot of this.conversationRuntimes.values()) {
      slot.runtime.skillRuntime.reload()
      this.syncSkills(slot)
    }
    this.emitSnapshot()
    return snapshot
  }

  async saveSettings(update: WorkbenchSettingsUpdate): Promise<WorkbenchSettingsSaveResult> {
    this.assertAvailable()
    if (!update || typeof update !== 'object' || !Array.isArray(update.apiProfiles)) {
      throw new Error('Invalid settings payload')
    }
    if (update.apiProfiles.length > 32) throw new Error('Too many API configurations')

    const currentProfiles = new Map(getApiConfigProfiles(this.options.config).map(profile => [profile.id, profile]))
    const ids = new Set<string>()
    const profiles = update.apiProfiles.map(input => {
      const profile = validateApiProfile(input, currentProfiles.get(input.id))
      if (ids.has(profile.id)) throw new Error(`Duplicate API configuration id: ${profile.id}`)
      ids.add(profile.id)
      return profile
    })
    const approvalPolicy = normalizeApprovalPolicy(update.approvalPolicy, this.options.config.approvalPolicy)
    const capabilityProfile = resolveCapabilityProfileForApproval(
      approvalPolicy,
      update.capabilityProfile,
      this.options.config.capabilityProfile,
    )
    let nextConfig: TurboFluxConfig
    if (profiles.length === 0) {
      nextConfig = createEmptyConfig()
    } else {
      const activeApiConfigId = ids.has(update.activeApiConfigId || '')
        ? update.activeApiConfigId!
        : profiles[0].id
      nextConfig = switchActiveApiConfig({
        ...this.options.config,
        apiConfigs: profiles,
        activeApiConfigId,
      }, activeApiConfigId)
    }
    const savedConfig = saveConfig({
      ...nextConfig,
      approvalPolicy,
      capabilityProfile,
      gitEnabled: update.gitEnabled !== false,
    })
    const savedProfile = saveProfile(update.profile || {})
    if (update.mcpServers) {
      const nextMcpSettings = this.validateMcpSettings(update.mcpServers)
      saveProjectMcpSettings(this.options.workspacePath, nextMcpSettings)
      await this.applyMcpSettings(nextMcpSettings)
    }
    this.options.config = savedConfig
    for (const slot of this.conversationRuntimes.values()) {
      slot.runtime.applyConfiguration(savedConfig, {
        profile: savedProfile,
        approvalPolicy,
        capabilityProfile,
      })
      slot.conversations.updateConfig(savedConfig)
    }
    for (const slot of this.conversationRuntimes.values()) this.startNextQueuedPromptIfIdle(slot)
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return {
      settings: await this.getSettings(false),
      snapshot,
    }
  }

  async newConversation(): Promise<WorkbenchConversationResult> {
    this.assertAvailable()
    this.conversations.persist(true)
    const runtime = this.createConversationRuntime(undefined, undefined, this.runtime.engine.getMode())
    this.conversationRuntimes.set(runtime.id, runtime)
    if (this.platformInitialized) await this.initializeConversationRuntime(runtime)
    this.activeConversationId = runtime.id
    const id = runtime.id
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return { id, snapshot }
  }

  async switchConversation(id: string): Promise<WorkbenchConversationResult> {
    this.assertAvailable()
    const existing = this.conversationRuntimes.get(id)
    if (existing) {
      this.activeConversationId = id
      this.startNextQueuedPromptIfIdle(existing)
      const snapshot = this.getSnapshot()
      this.emit({ type: 'snapshot', snapshot })
      return { id, snapshot }
    }
    const runtime = this.createConversationRuntime(id)
    const conversation = await runtime.conversations.loadCurrentAsync()
    if (!conversation) {
      await this.destroyConversationRuntime(runtime)
      throw new Error(`Conversation not found in this workspace: ${id}`)
    }
    runtime.currentRecovery = conversation.recovery ? { ...conversation.recovery } : undefined
    if (conversation.canonicalEvents?.length) runtime.work.replaceFromEvents(conversation.canonicalEvents)
    else {
      runtime.work.replaceFromTurns(conversation.turns)
      runtime.conversations.replaceCanonicalEvents(runtime.work.log.getEvents())
    }
    this.restorePersistedQueue(runtime)
    this.conversationRuntimes.set(id, runtime)
    if (this.platformInitialized) await this.initializeConversationRuntime(runtime)
    this.activeConversationId = id
    this.startNextQueuedPromptIfIdle(runtime)
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return { id: conversation.id, snapshot }
  }

  async deleteConversation(id: string): Promise<boolean> {
    this.assertAvailable()
    const target = this.conversationRuntimes.get(id)
    if (target && this.runtimeStatus(target) !== 'ready' && this.runtimeStatus(target) !== 'error') {
      throw new Error(id === this.activeConversationId
        ? 'Cannot delete the active conversation while the agent is running'
        : 'Cannot delete a conversation while its agent is running')
    }
    if (target) {
      this.conversationRuntimes.delete(id)
      if (this.activeConversationId === id) {
        const next = [...this.conversationRuntimes.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]
          || this.createConversationRuntime()
        if (!this.conversationRuntimes.has(next.id)) {
          this.conversationRuntimes.set(next.id, next)
          if (this.platformInitialized) await this.initializeConversationRuntime(next)
        }
        this.activeConversationId = next.id
      }
      await this.destroyConversationRuntime(target)
    }
    const indexed = listConversations().find(conversation => conversation.id === id)
    const deleted = indexed && !sameWorkspacePath(indexed.workspacePath, this.options.workspacePath)
      ? await deleteConversationAsync(id)
      : await this.conversations.deleteAsync(id)
    if (deleted) this.emitSnapshot()
    return deleted
  }

  async renameConversation(id: string, title: string, source: 'custom' | 'generated' = 'custom'): Promise<boolean> {
    this.assertAvailable()
    const indexed = listConversations().find(conversation => conversation.id === id)
    let renamed = false
    if (indexed && !sameWorkspacePath(indexed.workspacePath, this.options.workspacePath)) {
      const requestedTitle = title.trim().replace(/\s+/g, ' ').slice(0, 80)
      const conversation = requestedTitle ? await loadConversationAsync(id) : null
      if (conversation) {
        conversation.title = requestedTitle
        conversation.titleSource = source
        conversation.updatedAt = Date.now()
        saveConversation(conversation, { compact: true })
        renamed = true
      }
    } else {
      renamed = await this.conversations.renameAsync(id, title, source)
    }
    if (renamed) this.emitSnapshot()
    return renamed
  }

  recordDraft(draft: WorkbenchDraftSnapshot | string): boolean {
    const next = typeof draft === 'string'
      ? { text: draft, attachments: [], files: [], pendingPastes: [], capabilities: { items: [] } }
      : draft
    return this.conversations.recordDraftState({
      text: next.text,
      attachments: next.attachments.map(attachment => ({ ...attachment })),
      files: next.files.map(file => ({ ...file })),
      pendingPastes: next.pendingPastes.map(paste => ({ ...paste })),
      capabilities: { items: (next.capabilities?.items || []).map(item => ({ ...item })) },
    })
  }

  listCommands(): WorkbenchCommandDefinition[] {
    return [
      ...listWorkbenchCommands(),
      ...this.plugins.listCommands().map(command => ({
        id: `plugin:${command.pluginId}:${command.id}` as WorkbenchCommandId,
        title: command.title,
        detail: command.detail,
        group: '工具' as const,
        keywords: ['plugin', command.pluginId, command.id, command.title],
      })),
    ]
  }

  async executeCommand(command: WorkbenchCommandId): Promise<WorkbenchCommandResult> {
    if (command.startsWith('plugin:')) {
      const [, pluginId, ...commandParts] = command.split(':')
      if (!pluginId || commandParts.length === 0) throw new Error('Invalid plugin command')
      const result = await this.plugins.executeCommand(pluginId, commandParts.join(':'))
      return { message: typeof result === 'string' ? result : JSON.stringify(result) }
    }
    switch (command) {
      case 'mode.vibe': return { snapshot: this.setMode('vibe'), message: '已切换到 Vibe' }
      case 'mode.plan': return { snapshot: this.setMode('plan'), message: '已切换到 Plan' }
      case 'run.pause': return { message: this.pause() ? '任务已暂停' : '当前没有可暂停的任务', snapshot: this.getSnapshot() }
      case 'run.resume': return { message: this.resume() ? '任务已继续' : '当前任务未暂停', snapshot: this.getSnapshot() }
      case 'run.stop': return { message: this.stop() ? '正在停止任务' : '当前没有运行中的任务', snapshot: this.getSnapshot() }
      case 'context.open': return { open: 'context' }
      case 'context.compact':
        await this.compactContext()
        return { message: '上下文压缩完成', open: 'context', snapshot: this.getSnapshot() }
      case 'git.open': return { open: 'git' }
      case 'git.refresh':
        await this.refreshGit()
        return { message: 'Git 状态已刷新', open: 'git', snapshot: this.getSnapshot() }
      case 'activity.open': return { open: 'activity' }
      case 'mcp.open': return { open: 'mcp' }
      case 'skills.open': return { open: 'skills' }
      case 'conversation.new': {
        const result = await this.newConversation()
        return { message: '已新建任务', snapshot: result.snapshot }
      }
      case 'flow.retry': {
        const health = this.retryPersistence()
        return { message: health.status === 'healthy' ? '会话存储已恢复' : health.error || '会话存储仍不可用', snapshot: this.getSnapshot() }
      }
      case 'flow.export': return { message: this.exportRecoveryBundle() }
      default: throw new Error(`Unsupported workbench command: ${String(command)}`)
    }
  }

  async compactContext(): Promise<void> {
    this.assertIdle('compact context')
    const slot = this.activeConversationRuntime
    try {
      await slot.runtime.engine.compactContext()
    } finally {
      this.startNextQueuedPromptIfIdle(slot)
      this.emitSnapshot()
    }
  }

  async refreshGit(): Promise<void> {
    this.assertAvailable()
    await this.runtime.engine.initializeGit(true)
    this.emitSnapshot()
  }

  async stageGit(paths: string[]): Promise<WorkbenchGitActionResult> {
    this.assertIdle('stage Git paths')
    const result = await this.runtime.engine.stageGitPaths(paths)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async unstageGit(paths: string[]): Promise<WorkbenchGitActionResult> {
    this.assertIdle('unstage Git paths')
    const result = await this.runtime.engine.unstageGitPaths(paths)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async commitGit(message: string, paths?: string[]): Promise<WorkbenchGitActionResult> {
    this.assertIdle('create a Git commit')
    const result = await this.runtime.engine.commitGit(message, paths)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async createGitBranch(name: string, startPoint?: string): Promise<WorkbenchGitActionResult> {
    this.assertIdle('create a Git branch')
    const result = await this.runtime.engine.createGitBranch(name, startPoint)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async switchGitBranch(name: string): Promise<WorkbenchGitActionResult> {
    this.assertIdle('switch Git branch')
    const result = await this.runtime.engine.switchGitBranch(name)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async restoreGit(paths: string[], source = 'HEAD'): Promise<WorkbenchGitActionResult> {
    this.assertIdle('restore Git paths')
    const result = await this.runtime.engine.restoreGitPaths(paths, source)
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async pushGit(remote?: string, branch?: string, setUpstream = false): Promise<WorkbenchGitActionResult> {
    this.assertIdle('push Git changes')
    const result = await this.runtime.engine.pushGit({ remote, branch, setUpstream })
    this.emitSnapshot()
    return { result, snapshot: this.getSnapshot() }
  }

  async readGitDiff(path?: string, scope: GitDiffScope = 'working'): Promise<WorkbenchGitDiffResult> {
    this.assertAvailable()
    const result = await this.runtime.engine.readGitDiff(path, scope)
    return { path, scope, result }
  }

  listProjects() {
    return this.projects.list()
  }

  addProject(path: string, name?: string) {
    const snapshot = this.projects.add(path, { name, conversationId: this.conversations.getCurrentId() })
    this.emitSnapshot()
    return snapshot
  }

  updateProject(id: string, patch: { name?: string; pinned?: boolean; tags?: string[] }) {
    const snapshot = this.projects.update(id, patch)
    this.emitSnapshot()
    return snapshot
  }

  removeProject(id: string) {
    const snapshot = this.projects.remove(id)
    this.emitSnapshot()
    return snapshot
  }

  getProject(id: string) {
    return this.projects.get(id)
  }

  listAutomations() {
    return this.automations.list(this.options.workspacePath)
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
    const snapshot = this.automations.create({ ...input, workspacePath: this.options.workspacePath })
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return snapshot
  }

  updateAutomation(id: string, patch: AutomationUpdateInput) {
    const snapshot = this.automations.update(id, patch)
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return snapshot
  }

  removeAutomation(id: string) {
    const snapshot = this.automations.remove(id)
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return snapshot
  }

  duplicateAutomation(id: string) {
    const snapshot = this.automations.duplicate(id)
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return snapshot
  }

  async runAutomation(id: string) {
    const automation = this.automations.get(id)
    if (!automation) throw new Error(`Automation not found: ${id}`)
    if (automation.workspacePath !== resolve(this.options.workspacePath)) throw new Error('Automation belongs to another workspace')
    const claim = this.automations.claimManual(id)
    try {
      return await this.startAutomationClaim(claim)
    } catch (error) {
      this.automations.markRunStatus(id, claim.run.id, 'failed', { error: error instanceof Error ? error.message : String(error) })
      this.scheduleAutomationWake()
      this.emitSnapshot()
      throw error
    }
  }

  async retryAutomationRun(id: string, runId: string) {
    const claim = this.automations.retryNow(id, runId)
    try {
      return await this.startAutomationClaim(claim)
    } catch (error) {
      this.automations.markRunStatus(id, claim.run.id, 'failed', { error: error instanceof Error ? error.message : String(error) })
      this.scheduleAutomationWake()
      this.emitSnapshot()
      throw error
    }
  }

  async cancelAutomationRun(id: string) {
    const automation = this.automations.get(id)
    if (!automation?.activeRunId) return this.automations.list(this.options.workspacePath)
    const run = this.automations.getRun(id, automation.activeRunId)
    const slot = run?.conversationId ? this.conversationRuntimes.get(run.conversationId) : undefined
    this.automations.cancelActiveRun(id)
    const timer = this.automationRunTimers.get(automation.activeRunId)
    if (timer) clearTimeout(timer)
    this.automationRunTimers.delete(automation.activeRunId)
    slot?.runtime.engine.abort()
    if (slot) await slot.runtime.engine.waitUntilIdle().catch(() => undefined)
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return this.automations.list(this.options.workspacePath)
  }

  listArtifacts() {
    return this.artifacts.list(this.options.workspacePath)
  }

  registerArtifact(path: string, source: ArtifactSource, options: { name?: string; mime?: string; taskId?: string; conversationId?: string; metadata?: Record<string, string | number | boolean> } = {}) {
    const { conversationId, ...artifactOptions } = options
    const artifact = this.artifacts.register({
      path,
      workspacePath: this.options.workspacePath,
      source,
      conversationId: conversationId || this.conversations.getCurrentId(),
      ...artifactOptions,
    })
    this.emitSnapshot()
    return artifact
  }

  removeArtifact(id: string) {
    this.artifacts.remove(id)
    this.emitSnapshot()
    return this.artifacts.list(this.options.workspacePath)
  }

  getArtifact(id: string) {
    return this.artifacts.get(id)
  }

  async listMemories(filters: WorkbenchMemoryFilters = {}, forceReload = false): Promise<WorkbenchMemorySnapshot> {
    this.assertAvailable()
    const result = await this.runtime.toolExecutor.memoryList(this.options.workspacePath, forceReload, filters.includeInactive === true)
    if (!result.success || !result.data?.snapshot) throw new Error(result.error || 'Unable to load memories')
    const snapshot = result.data.snapshot
    const query = filters.query?.trim().toLowerCase() || ''
    const items = snapshot.groups
      .flatMap(group => group.items)
      .filter(item => filters.includeInactive || item.status === 'active')
      .filter(item => !filters.scope || item.scope === filters.scope)
      .filter(item => !filters.kind || item.kind === filters.kind)
      .filter(item => !filters.status || item.status === filters.status)
      .filter(item => filters.pinned === undefined || item.pinned === filters.pinned)
      .filter(item => !query || `${item.text} ${item.tags.join(' ')} ${item.source}`.toLowerCase().includes(query))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)
      .map(item => ({ ...item, tags: [...item.tags], evidence: item.evidence.map(evidence => ({ ...evidence })) }))
    return {
      schemaVersion: 1,
      workspacePath: snapshot.workspacePath,
      totalCount: snapshot.totalCount,
      injectionTokens: snapshot.injectionTokens,
      warnings: [...snapshot.warnings],
      builtAt: snapshot.builtAt,
      items,
    }
  }

  async rememberMemory(input: WorkbenchMemoryCreateInput): Promise<WorkbenchMemorySnapshot> {
    this.assertAvailable()
    const result = await this.runtime.toolExecutor.memoryRemember({
      workspacePath: this.options.workspacePath,
      text: input.text,
      scope: input.scope,
      kind: input.kind,
      confidence: input.confidence,
      tags: input.tags,
      conversationId: this.conversations.getCurrentId(),
    })
    if (!result.success || !result.data?.id) throw new Error(result.error || 'Unable to create memory')
    const reviewed = await this.runtime.toolExecutor.memoryUpdate({
      workspacePath: this.options.workspacePath,
      id: result.data.id,
      pinned: input.pinned,
      reviewState: 'user_approved',
    })
    if (!reviewed.success) throw new Error(reviewed.error || 'Unable to approve memory')
    return this.listMemories({ includeInactive: true }, true)
  }

  async updateMemory(id: string, update: WorkbenchMemoryUpdateInput): Promise<WorkbenchMemorySnapshot> {
    this.assertAvailable()
    const result = await this.runtime.toolExecutor.memoryUpdate({
      workspacePath: this.options.workspacePath,
      id,
      ...update,
      reviewState: update.reviewState || 'user_edited',
    })
    if (!result.success) throw new Error(result.error || 'Unable to update memory')
    return this.listMemories({ includeInactive: true }, true)
  }

  async forgetMemory(id: string, reason?: string): Promise<WorkbenchMemorySnapshot> {
    this.assertAvailable()
    const result = await this.runtime.toolExecutor.memoryForget({ workspacePath: this.options.workspacePath, id, reason })
    if (!result.success) throw new Error(result.error || 'Unable to forget memory')
    return this.listMemories({ includeInactive: true }, true)
  }

  retryPersistence() {
    const health = this.conversations.retryPersistence()
    if (health.status === 'healthy') this.startNextQueuedPromptIfIdle(this.activeConversationRuntime)
    this.emit({ type: 'persistence', health })
    this.emitSnapshot()
    return health
  }

  exportRecoveryBundle(requestedPath?: string): string {
    return this.conversations.exportRecoveryBundle(requestedPath)
  }

  reloadSkills(): WorkbenchSnapshot {
    this.assertIdle('reload skills')
    for (const slot of this.conversationRuntimes.values()) {
      const activeSkillId = slot.runtime.skillRuntime.getActiveSkillId()
      slot.runtime.skillRuntime.reload()
      this.syncSkills(slot)
      if (activeSkillId && slot.runtime.skillRuntime.getById(activeSkillId)) {
        slot.runtime.skillRuntime.activate(activeSkillId, slot.runtime.engine)
      } else {
        slot.runtime.skillRuntime.deactivate(slot.runtime.engine)
      }
    }
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return snapshot
  }

  activateSkill(skillId: string): WorkbenchSnapshot {
    this.assertIdle('activate a skill')
    if (!this.runtime.skillRuntime.activate(skillId, this.runtime.engine)) throw new Error(`Skill not found: ${skillId}`)
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return snapshot
  }

  deactivateSkill(): WorkbenchSnapshot {
    this.assertIdle('deactivate skills')
    this.runtime.skillRuntime.deactivate(this.runtime.engine)
    const snapshot = this.getSnapshot()
    this.emit({ type: 'snapshot', snapshot })
    return snapshot
  }

  async reconnectMcp(name: string): Promise<WorkbenchSettingsSnapshot> {
    this.assertAvailable()
    const settings = loadMcpSettings(this.options.workspacePath)
    const config = settings.mcpServers[name]
    if (!config) throw new Error(`MCP server not found: ${name}`)
    if (!config.enabled) throw new Error(`MCP server is disabled: ${name}`)
    await Promise.all([...this.conversationRuntimes.values()].map(slot => slot.runtime.mcpClient.connect(name, config)))
    this.emitSnapshot()
    return this.getSettings(false)
  }

  acknowledgeNotification(notificationId: string): boolean {
    return this.activeConversationRuntime.work.acknowledgeNotification(notificationId).length > 0
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    if (this.automationTimer) clearTimeout(this.automationTimer)
    this.automationTimer = null
    for (const timer of this.automationRunTimers.values()) clearTimeout(timer)
    this.automationRunTimers.clear()
    this.listeners.clear()
    await waitForSettlement(
      this.plugins.destroy(),
      RESOURCE_SHUTDOWN_TIMEOUT_MS,
      'Plugin shutdown timed out',
    ).catch(() => undefined)
    await Promise.all([...this.conversationRuntimes.values()].map(runtime => this.destroyConversationRuntime(runtime)))
    this.conversationRuntimes.clear()
  }

  private startPrompt(
    prompt: string,
    attachments: AgentAttachment[] | undefined,
    capabilities: AgentCapabilitySelection | undefined,
    inputId: string,
    approvalPolicy?: ApprovalPolicy,
    slot = this.activeConversationRuntime,
    fromQueue = false,
    reuseLastUserTurn = false,
  ): void {
    if (this.destroyed || slot.destroying) throw new Error('Conversation runtime is shutting down')
    if (slot.activeRun) throw new Error('Conversation runtime already owns a foreground run')
    const automationRun = this.automationRuns.get(inputId)
    if (automationRun) {
      slot.activeAutomationRun = automationRun
      this.automations.markRunStatus(automationRun.automationId, automationRun.runId, 'running', {
        inputId,
        conversationId: slot.id,
      })
      const automation = this.automations.get(automationRun.automationId)
      if (automation) {
        const timer = setTimeout(() => {
          this.automationRunTimers.delete(automationRun.runId)
          this.automationTimedOutRuns.add(automationRun.runId)
          slot.runtime.engine.abort()
        }, automation.maxRuntimeMinutes * 60_000)
        this.automationRunTimers.set(automationRun.runId, timer)
      }
    }
    if (approvalPolicy) slot.runtime.engine.setApprovalPolicy(approvalPolicy)
    slot.activeRunCapabilities = cloneCapabilitySelection(capabilities)
    const running = this.runPrompt(slot, prompt, attachments, capabilities, inputId, reuseLastUserTurn)
    slot.activeRun = running
    void this.settlePromptRun(slot, running, inputId, fromQueue).catch(() => undefined)
  }

  private async settlePromptRun(slot: WorkbenchConversationRuntime, running: Promise<void>, inputId: string, fromQueue: boolean): Promise<void> {
    let settlementError: unknown
    try {
      await running
      await slot.runtime.engine.waitUntilIdle()
    } catch (error) {
      settlementError = error
    }
    if (slot.activeRun !== running) return
    slot.activeRun = null
    slot.activeRunCapabilities = undefined
    slot.activeAutomationRun = null
    slot.runtime.engine.setApprovalPolicy(this.options.config.approvalPolicy || 'ask')
    if (settlementError) {
      this.emit({
        type: 'runtime-error',
        message: settlementError instanceof Error ? settlementError.message : String(settlementError),
        conversationId: slot.id,
      })
    }
    if (this.destroyed || slot.destroying) return
    const queuedInputDidNotCommit = fromQueue && this.getQueuedInputs(slot)[0]?.id === inputId
    if (!queuedInputDidNotCommit) {
      try {
        this.startNextQueuedPromptIfIdle(slot)
      } catch (error) {
        this.emit({
          type: 'runtime-error',
          message: error instanceof Error ? error.message : String(error),
          conversationId: slot.id,
        })
      }
    }
    this.emitSnapshot()
  }

  private async runPrompt(slot: WorkbenchConversationRuntime, prompt: string, attachments: AgentAttachment[] | undefined, capabilities: AgentCapabilitySelection | undefined, inputId: string, reuseLastUserTurn = false): Promise<void> {
    this.publishConversationEvents(slot, slot.work.startRun({ runId: inputId, objective: prompt }))
    let outcome: 'succeeded' | 'failed' | 'interrupted' = 'failed'
    let errorMessage: string | undefined
    let resultSummary: string | undefined
    try {
      const turns = await slot.runtime.engine.run(prompt, { attachments, capabilities, userTurnId: inputId, reuseLastUserTurn })
      resultSummary = summarizeAutomationResult(turns)
      outcome = 'succeeded'
    } catch (error) {
      const aborted = (error as { aborted?: boolean })?.aborted === true
        || /aborted/i.test(error instanceof Error ? error.message : String(error))
      outcome = aborted ? 'interrupted' : 'failed'
      errorMessage = aborted ? undefined : error instanceof Error ? error.message : String(error)
      if (errorMessage) this.emit({ type: 'runtime-error', message: errorMessage, conversationId: slot.id })
    } finally {
      this.publishConversationEvents(slot, slot.work.finishRun({
        outcome: outcome === 'succeeded' ? 'completed' : outcome,
        error: errorMessage,
      }))
      this.emit({
        type: 'conversation-run',
        conversationId: slot.id,
        status: outcome === 'succeeded' ? 'completed' : outcome,
      })
      const automationRun = this.automationRuns.get(inputId)
      if (automationRun) {
        const timer = this.automationRunTimers.get(automationRun.runId)
        if (timer) clearTimeout(timer)
        this.automationRunTimers.delete(automationRun.runId)
        const timedOut = this.automationTimedOutRuns.delete(automationRun.runId)
        const currentRun = this.automations.getRun(automationRun.automationId, automationRun.runId)
        if (currentRun && currentRun.status !== 'canceled') {
          const status = timedOut ? 'failed' : outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed'
          const automation = this.automations.get(automationRun.automationId)
          this.automations.markRunStatus(automationRun.automationId, automationRun.runId, status, {
            inputId,
            conversationId: slot.id,
            error: timedOut ? `Exceeded the ${automation?.maxRuntimeMinutes || 1} minute runtime limit.` : errorMessage,
            resultSummary,
          })
        }
        this.automationRuns.delete(inputId)
        this.scheduleAutomationWake()
      }
      if (outcome !== 'succeeded') slot.conversations.persist(true)
      slot.updatedAt = Date.now()
      this.emitSnapshot()
    }
  }

  private handleAgentEvent(slotOrEvent: WorkbenchConversationRuntime | AgentEventType, receivedEvent?: AgentEventType): void {
    const slot = receivedEvent ? slotOrEvent as WorkbenchConversationRuntime : this.activeConversationRuntime
    const event = receivedEvent || slotOrEvent as AgentEventType
    if (streamTimingTraceEnabled() && event.type === 'stream:start') {
      this.workbenchStreamTraceActive = true
      this.workbenchStreamTraceStages.clear()
    }
    const eventStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
    slot.updatedAt = Date.now()
    if (event.type === 'approval:state' && slot.activeAutomationRun) {
      if (event.state === 'requested') {
        this.automations.markRunStatus(slot.activeAutomationRun.automationId, slot.activeAutomationRun.runId, 'waiting_for_approval')
      } else if (event.state === 'resolved') {
        this.automations.markRunStatus(slot.activeAutomationRun.automationId, slot.activeAutomationRun.runId, 'running')
      }
    }
    if (event.type === 'tool:result') {
      const artifactSource: ArtifactSource = slot.activeAutomationRun ? 'automation' : 'agent'
      const change = event.toolResult.changeSummary
      if (change && change.operation !== 'delete') {
        const path = resolve(this.options.workspacePath, change.path)
        if (existsSync(path)) {
          try { this.registerArtifact(path, artifactSource, { taskId: event.toolResult.toolCallId, conversationId: slot.id }) } catch {}
        }
      }
      for (const attachment of event.toolResult.attachments || []) {
        if (!existsSync(attachment.path)) continue
        try { this.registerArtifact(attachment.path, artifactSource, { name: attachment.filename, mime: attachment.mime, taskId: event.toolResult.toolCallId, conversationId: slot.id }) } catch {}
      }
    }
    const redactionStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
    const projectedEvent = redactComputerAgentEvent(event, slot.runtime.engine.getFullConversationTurns())
    this.recordWorkbenchStreamTrace('privacy-redaction', redactionStartedAt)
    const projectionStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
    const canonicalEvents = slot.work.appendAgent(projectedEvent)
    this.recordWorkbenchStreamTrace('normalize-project', projectionStartedAt)
    const publishStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
    this.publishConversationEvents(slot, canonicalEvents)
    this.recordWorkbenchStreamTrace('publish-total', publishStartedAt)
    if (projectedEvent.type === 'turn:start' && projectedEvent.turn.role === 'user') {
      this.commitQueuedInput(slot, projectedEvent.turn.id)
    }
    if (
      event.type === 'session:complete'
      || event.type === 'error'
      || event.type === 'run:state'
      || event.type === 'approval:state'
      || event.type === 'mode:change'
    ) {
      this.emitSnapshot()
    }
    this.recordWorkbenchStreamTrace('handle-total', eventStartedAt)
    if (this.workbenchStreamTraceActive && event.type === 'stream:end') {
      emitStreamTimingTrace('workbench-runtime', {
        stages: Object.fromEntries(
          [...this.workbenchStreamTraceStages.entries()].map(([stage, samples]) => [stage, summarizeTimings(samples)]),
        ),
      })
      this.workbenchStreamTraceActive = false
    }
  }

  private publishConversationEvents(slot: WorkbenchConversationRuntime, events: readonly import('../events/index').AnyConversationEvent[]): void {
    for (const event of events) {
      const persistenceStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
      slot.conversations.recordCanonicalEvent(event)
      this.recordWorkbenchStreamTrace('canonical-persistence', persistenceStartedAt)
      const listenerStartedAt = this.workbenchStreamTraceActive ? performance.now() : 0
      this.emit({ type: 'conversation-event', conversationId: slot.id, event })
      this.recordWorkbenchStreamTrace('desktop-listener', listenerStartedAt)
    }
  }

  private recordWorkbenchStreamTrace(stage: string, startedAt: number): void {
    if (!this.workbenchStreamTraceActive || startedAt === 0) return
    const samples = this.workbenchStreamTraceStages.get(stage) || []
    samples.push(performance.now() - startedAt)
    this.workbenchStreamTraceStages.set(stage, samples)
  }

  private async runDueAutomations(): Promise<void> {
    if (this.destroyed) return
    const activeRuns = this.automations.list(this.options.workspacePath).automations.filter(item => item.activeRunId).length
    const capacity = Math.max(0, MAX_CONCURRENT_AUTOMATIONS - activeRuns)
    this.automations.recordSchedulerHealth({ status: 'running', lastTickAt: Date.now(), activeRuns })
    this.automations.markInactiveDueWaiting(this.options.workspacePath)
    let error: string | undefined
    if (capacity > 0) {
      const claims = this.automations.claimDue(this.options.workspacePath, { limit: capacity })
      const results = await Promise.allSettled(claims.map(async claim => {
        try {
          return await this.startAutomationClaim(claim)
        } catch (claimError) {
          this.automations.markRunStatus(claim.automation.id, claim.run.id, 'failed', {
            error: claimError instanceof Error ? claimError.message : String(claimError),
          })
          throw claimError
        }
      }))
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected) error = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason)
    }
    this.scheduleAutomationWake(undefined, error)
    this.emitSnapshot()
  }

  private scheduleAutomationWake(delayMs?: number, healthError?: string): void {
    if (this.automationTimer) clearTimeout(this.automationTimer)
    this.automationTimer = null
    if (this.destroyed) return
    const now = Date.now()
    const snapshot = this.automations.list(this.options.workspacePath)
    const activeRuns = snapshot.automations.filter(item => item.activeRunId).length
    const nextWakeAt = delayMs === undefined
      ? this.automations.nextWakeAt(this.options.workspacePath, now)
      : now + Math.max(0, delayMs)
    this.automations.recordSchedulerHealth({
      status: healthError ? 'degraded' : activeRuns > 0 ? 'running' : nextWakeAt === undefined ? 'idle' : 'watching',
      activeRuns,
      nextWakeAt,
      error: healthError,
    })
    if (!this.platformInitialized || nextWakeAt === undefined) return
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, nextWakeAt - now))
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null
      void this.runDueAutomations().catch(error => {
        this.scheduleAutomationWake(5_000, error instanceof Error ? error.message : String(error))
        this.emitSnapshot()
      })
    }, delay)
  }

  private async ensureAutomationConversation(claim: AutomationClaim): Promise<WorkbenchConversationRuntime> {
    const existingId = claim.automation.conversationId
    if (existingId) {
      const existing = this.conversationRuntimes.get(existingId)
      if (existing) return existing
      const restored = this.createConversationRuntime(existingId)
      const conversation = await restored.conversations.loadCurrentAsync()
      if (conversation) {
        restored.currentRecovery = conversation.recovery ? { ...conversation.recovery } : undefined
        if (conversation.canonicalEvents?.length) restored.work.replaceFromEvents(conversation.canonicalEvents)
        else {
          restored.work.replaceFromTurns(conversation.turns)
          restored.conversations.replaceCanonicalEvents(restored.work.log.getEvents())
        }
        this.restorePersistedQueue(restored)
        this.conversationRuntimes.set(restored.id, restored)
        if (this.platformInitialized) await this.initializeConversationRuntime(restored)
        this.startNextQueuedPromptIfIdle(restored)
        return restored
      }
      await this.destroyConversationRuntime(restored)
    }
    const created = this.createConversationRuntime(undefined, `${claim.automation.name} · 自动化`, 'vibe')
    this.conversationRuntimes.set(created.id, created)
    if (this.platformInitialized) await this.initializeConversationRuntime(created)
    this.automations.attachConversation(claim.automation.id, created.id)
    return created
  }

  private async startAutomationClaim(claim: AutomationClaim): Promise<WorkbenchSubmitResult & {
    automationId: string
    automationRunId: string
    conversationId: string
    snapshot: WorkbenchSnapshot
  }> {
    const slot = await this.ensureAutomationConversation(claim)
    if (slot.activeRun || slot.runtime.engine.isRunning() || slot.runtime.engine.isContextCompacting()) {
      throw new Error('The automation conversation is still busy')
    }
    const result = this.submitPrompt(claim.automation.prompt, undefined, undefined, {
      approvalPolicy: claim.automation.approvalPolicy,
      automationId: claim.automation.id,
      automationRunId: claim.run.id,
      forceQueue: true,
      slot,
    })
    if (result.status === 'queued') {
      this.automations.markRunStatus(claim.automation.id, claim.run.id, 'queued', {
        inputId: result.inputId,
        conversationId: slot.id,
      })
    }
    this.scheduleAutomationWake()
    this.emitSnapshot()
    return {
      ...result,
      automationId: claim.automation.id,
      automationRunId: claim.run.id,
      conversationId: slot.id,
      snapshot: this.getSnapshot(),
    }
  }

  private enqueueInputDurably(slot: WorkbenchConversationRuntime, input: ConversationQueuedInput): void {
    const queuedInputs = [...this.getQueuedInputs(slot), input]
    if (!slot.conversations.recordQueueState(queuedInputs)) {
      throw new Error('消息未能可靠保存，因此没有加入队列；请重试。')
    }
    this.publishConversationEvents(slot, slot.work.recordInputState({
      inputId: input.id,
      intent: 'queued-turn',
      state: 'queued',
      text: input.prompt,
      attachments: input.attachments,
      capabilities: input.capabilities,
      approvalPolicy: input.approvalPolicy,
      automationId: input.automationId,
      automationRunId: input.automationRunId,
    }))
  }

  private persistQueue(slot = this.activeConversationRuntime): boolean {
    return slot.conversations.recordQueueState(this.getQueuedInputs(slot))
  }

  private restorePersistedQueue(slot: WorkbenchConversationRuntime): void {
    const committedTurnIds = new Set(slot.runtime.engine.getFullConversationTurns().map(turn => turn.id))
    const persisted = slot.conversations.getInteractionState().queuedInputs
    const queuedInputs = persisted.filter(input => !committedTurnIds.has(input.id))
    if (queuedInputs.length !== persisted.length) slot.conversations.recordQueueState(queuedInputs)
    for (const input of queuedInputs) {
      this.publishConversationEvents(slot, slot.work.recordInputState({
        inputId: input.id,
        intent: 'queued-turn',
        state: 'queued',
        text: input.prompt,
        attachments: input.attachments,
        capabilities: input.capabilities,
        approvalPolicy: input.approvalPolicy,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
        provenance: 'restored',
      }))
    }
  }

  private startNextQueuedPromptIfIdle(slot: WorkbenchConversationRuntime): boolean {
    if (
      this.destroyed
      || slot.destroying
      || slot.historyRewrite
      || slot.activeRun
      || slot.runtime.engine.isRunning()
      || slot.runtime.engine.isContextCompacting()
      || !slot.conversations.isPersistenceHealthy()
      || !this.options.config.apiKey
      || !this.options.config.model
    ) return false
    const next = this.getQueuedInputs(slot)[0]
    if (!next) return false
    if (next.automationId && next.automationRunId) {
      this.automationRuns.set(next.id, { automationId: next.automationId, runId: next.automationRunId })
    }
    this.startPrompt(next.prompt, next.attachments, next.capabilities, next.id, next.approvalPolicy, slot, true)
    return true
  }

  private getQueuedInputs(slot = this.activeConversationRuntime): ConversationQueuedInput[] {
    return slot.conversations.getInteractionState().queuedInputs.map(input => ({
      ...input,
      attachments: input.attachments?.map(attachment => ({ ...attachment })),
      capabilities: input.capabilities ? { items: input.capabilities.items.map(item => ({ ...item })) } : undefined,
    }))
  }

  private commitQueuedInput(slot: WorkbenchConversationRuntime, inputId: string): void {
    const queuedInputs = this.getQueuedInputs(slot)
    if (queuedInputs[0]?.id !== inputId) return
    const remaining = queuedInputs.slice(1)
    if (!slot.conversations.recordQueueState(remaining)) return
    this.publishConversationEvents(slot, slot.work.recordInputState({
      inputId,
      intent: 'queued-turn',
      state: 'committed',
      turnId: inputId,
      runId: inputId,
    }))
  }

  private async stopConversationRun(slot: WorkbenchConversationRuntime, timeoutMessage: string): Promise<void> {
    slot.runtime.engine.abort()
    const pending = [slot.activeRun, slot.runtime.engine.waitUntilIdle()]
      .filter(Boolean) as Promise<unknown>[]
    await waitForSettlement(
      Promise.allSettled(pending).then(() => undefined),
      HISTORY_REWRITE_STOP_TIMEOUT_MS,
      timeoutMessage,
    )
  }

  private syncSkills(slot = this.activeConversationRuntime): void {
    slot.runtime.engine.setEnabledSkills(slot.runtime.skillRuntime.getAll().map(skill => ({
      id: skill.id,
      name: skill.name,
      command: skill.command,
      description: skill.description,
      systemPrompt: skill.systemPrompt,
      capabilities: (skill as unknown as { capabilities?: { can?: string[]; cannot?: string[] } }).capabilities,
      principles: (skill as unknown as { principles?: string[] }).principles,
    })))
  }

  private resolveCapabilitySelection(selection?: AgentCapabilitySelection, slot = this.activeConversationRuntime): AgentCapabilitySelection | undefined {
    if (!selection?.items.length) return undefined
    const skills = new Map(slot.runtime.skillRuntime.getAll().map(skill => [skill.id, skill]))
    const mcpServers = new Map(this.getMcpServerSummaries(slot).map(server => [server.name, server]))
    const items: AgentCapabilitySelection['items'] = []
    let selectedSkill = false
    const seen = new Set<string>()
    for (const item of selection.items) {
      const key = `${item.type}:${item.id}`
      if (seen.has(key)) continue
      if (item.type === 'skill') {
        const skill = skills.get(item.id)
        if (!skill || selectedSkill) continue
        selectedSkill = true
        seen.add(key)
        items.push({ type: 'skill', id: skill.id, name: skill.name })
        continue
      }
      const server = mcpServers.get(item.id)
      if (!server) throw new Error(`${item.name || item.id} 已不在当前工作区，请从输入框重新选择`)
      if (!server.enabled || server.status !== 'connected') {
        const detail = server.error ? `：${server.error}` : ''
        throw new Error(`${server.displayName || server.name} 当前不可用${detail}`)
      }
      seen.add(key)
      items.push({ type: 'mcp', id: server.name, name: server.displayName || server.name })
    }
    return items.length > 0 ? { items } : undefined
  }

  private getMcpServerSummaries(slot = this.activeConversationRuntime): WorkbenchMcpServerSummary[] {
    const settings = loadMcpSettings(this.options.workspacePath)
    const connections = new Map(slot.runtime.mcpClient.getAllConnections().map(connection => [connection.name, connection]))
    const systemNames = new Set([...connections.values()].filter(connection => connection.system).map(connection => connection.name))
    const summaries: WorkbenchMcpServerSummary[] = Object.entries(settings.mcpServers)
      .filter(([name]) => !systemNames.has(name))
      .map(([name, config]) => {
        const connection = connections.get(name)
        return {
          name,
          enabled: config.enabled,
          command: config.command,
          args: config.args ? [...config.args] : undefined,
          url: config.url,
          cwd: config.cwd,
          startupTimeoutMs: config.startupTimeoutMs,
          toolTimeoutMs: config.toolTimeoutMs,
          enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
          disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
          envKeys: Object.keys(config.env || {}),
          headerKeys: Object.keys(config.httpHeaders || {}),
          status: config.enabled
            ? (connection?.status || 'disconnected') as 'disconnected' | 'connecting' | 'connected' | 'error' | 'closed'
            : 'disabled' as const,
          error: connection?.error,
          tools: (connection?.tools || []).map(tool => ({
            name: tool.name,
            description: tool.description,
            serverName: tool.serverName,
            annotations: tool.annotations ? { ...tool.annotations } : undefined,
          })),
        }
      })
    for (const connection of slot.runtime.mcpClient.getAllConnections()) {
      if (!connection.system || summaries.some(summary => summary.name === connection.name)) continue
      summaries.unshift({
        name: connection.name,
        displayName: connection.name === 'browser' ? '内置浏览器' : connection.name === 'computer' ? '电脑操控' : this.plugins.getByServerName(connection.name)?.manifest.name || connection.name,
        description: connection.name === 'browser'
          ? '安全浏览网页、检索资料并完成在线任务'
          : connection.name === 'computer'
            ? '在你授权后操作原生应用，并在每一步重新观察和验收'
            : this.plugins.getByServerName(connection.name)?.manifest.description || connection.instructions,
        system: true,
        enabled: true,
        envKeys: [],
        headerKeys: [],
        status: connection.status,
        error: connection.error,
        tools: connection.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          serverName: tool.serverName,
          annotations: tool.annotations ? { ...tool.annotations } : undefined,
        })),
      })
    }
    return summaries
  }

  private validateMcpSettings(inputs: NonNullable<WorkbenchSettingsUpdate['mcpServers']>): McpSettings {
    if (inputs.length > 32) throw new Error('Too many MCP servers')
    const existing = loadMcpSettings(this.options.workspacePath).mcpServers
    const names = new Set<string>()
    const mcpServers: Record<string, McpServerConfig> = {}
    for (const input of inputs) {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (!name || name.length > 80 || !/^[\w.-]+$/.test(name)) throw new Error(`Invalid MCP server name: ${name || 'empty'}`)
      if (names.has(name)) throw new Error(`Duplicate MCP server: ${name}`)
      names.add(name)
      const command = typeof input.command === 'string' ? input.command.trim() : undefined
      const url = typeof input.url === 'string' ? input.url.trim() : undefined
      if (!command && !url) throw new Error(`${name} needs a command or URL`)
      if (url) {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${name} has an unsupported MCP URL`)
      }
      const current = existing[name]
      mcpServers[name] = cloneMcpConfig({
        command,
        url,
        args: Array.isArray(input.args) ? input.args.map(value => String(value)) : undefined,
        cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
        env: input.preserveEnv && current?.env ? { ...current.env } : input.env ? { ...input.env } : undefined,
        httpHeaders: input.preserveHttpHeaders && current?.httpHeaders ? { ...current.httpHeaders } : input.httpHeaders ? { ...input.httpHeaders } : undefined,
        startupTimeoutMs: input.startupTimeoutMs,
        toolTimeoutMs: input.toolTimeoutMs,
        enabledTools: input.enabledTools,
        disabledTools: input.disabledTools,
        enabled: input.enabled !== false,
      })
    }
    return { mcpServers }
  }

  private async applyMcpSettings(settings: McpSettings): Promise<void> {
    await Promise.all([...this.conversationRuntimes.values()].map(async slot => {
      await slot.runtime.mcpClient.disconnectAll({ preserveSystem: true })
      await Promise.all(Object.entries(settings.mcpServers)
        .filter(([, config]) => config.enabled)
        .map(([name, config]) => slot.runtime.mcpClient.connect(name, config)))
    }))
  }

  private createConversationRuntime(
    conversationId?: string,
    workspaceName = basename(this.options.workspacePath) || 'workspace',
    mode?: AgentMode,
  ): WorkbenchConversationRuntime {
    const runtime = createAgentRuntime({
      workspacePath: this.options.workspacePath,
      workspaceName,
      config: this.options.config,
      runtimeStoragePath: this.options.runtimeStoragePath,
      conversationId,
      conversationPrefix: this.options.conversationPrefix || 'workbench',
      mode,
      approvalPolicy: this.options.config.approvalPolicy,
      capabilityProfile: this.options.config.capabilityProfile,
      connectMcp: this.options.connectMcp === true,
      mcpServers: this.options.connectMcp === true ? ['all'] : undefined,
      surfaceSystemPrompt: this.options.surfaceSystemPrompt,
    })
    this.options.registerSystemPlugins?.(runtime.mcpClient, { conversationId: runtime.sessionRegistry.getCurrentId() })
    const work = new WorkSession(runtime.sessionRegistry.getCurrentId())
    let slot!: WorkbenchConversationRuntime
    const conversations = new ConversationManager(
      runtime.engine,
      this.options.config,
      this.options.workspacePath,
      error => {
        if (slot && slot.id === this.activeConversationId) {
          this.emit({ type: 'persistence', health: conversations.getPersistenceHealth() })
        }
      },
      runtime.sessionRegistry,
      { batchJournalStreaming: true },
    )
    slot = {
      id: runtime.sessionRegistry.getCurrentId(),
      runtime,
      conversations,
      work,
      activeRun: null,
      historyRewrite: null,
      destroying: false,
      activeAutomationRun: null,
      updatedAt: Date.now(),
      unsubscribeEngine: () => undefined,
      unsubscribeSession: () => undefined,
    }
    runtime.engine.setEventRecorder(null)
    slot.unsubscribeEngine = runtime.engine.subscribe(event => this.handleAgentEvent(slot, event))
    slot.unsubscribeSession = runtime.sessionRegistry.subscribe(({ currentId }) => {
      slot.work.activate(currentId, currentId, runtime.engine.getFullConversationTurns())
    })
    return slot
  }

  private async initializeConversationRuntime(slot: WorkbenchConversationRuntime): Promise<void> {
    await Promise.all([
      this.plugins.initialize(slot.runtime.mcpClient),
      slot.runtime.engine.initializeGit(),
    ])
    slot.runtime.skillRuntime.reload()
    this.syncSkills(slot)
  }

  private runtimeStatus(slot: WorkbenchConversationRuntime): WorkbenchSnapshot['runtime']['status'] {
    const runState = slot.runtime.engine.getRunState()
    const runControl = slot.runtime.engine.getRunControlSnapshot()
    if (runControl.paused) return 'paused'
    if (runState.phase === 'awaiting_approval' || runState.phase === 'awaiting_input') return 'awaiting-action'
    if (runState.phase === 'recoverable_error') return 'error'
    if (slot.historyRewrite || slot.activeRun || runControl.active || slot.runtime.engine.isRunning() || slot.runtime.engine.isContextCompacting()) return 'running'
    return 'ready'
  }

  private async destroyConversationRuntime(slot: WorkbenchConversationRuntime): Promise<void> {
    if (slot.destroying) return
    slot.destroying = true
    slot.runtime.engine.abort()
    const pending = [slot.activeRun, slot.historyRewrite, slot.runtime.engine.waitUntilIdle()]
      .filter(Boolean) as Promise<unknown>[]
    await waitForSettlement(
      Promise.allSettled(pending).then(() => undefined),
      CONVERSATION_SHUTDOWN_TIMEOUT_MS,
      'Conversation shutdown timed out',
    ).catch(() => undefined)
    slot.unsubscribeSession()
    slot.unsubscribeEngine()
    slot.runtime.engine.setEventRecorder(null)
    slot.conversations.destroy()
    await waitForSettlement(
      slot.runtime.destroy(),
      RESOURCE_SHUTDOWN_TIMEOUT_MS,
      'Agent runtime shutdown timed out',
    ).catch(() => undefined)
  }

  private emitSnapshot(): void {
    if (!this.destroyed) this.emit({ type: 'snapshot', snapshot: this.getSnapshot() })
  }

  private emit(event: WorkbenchEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {}
    }
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new Error('Workbench runtime has been destroyed')
  }

  private assertIdle(action: string): void {
    this.assertAvailable()
    const slot = this.activeConversationRuntime
    if (slot.historyRewrite || slot.activeRun || slot.runtime.engine.isRunning() || slot.runtime.engine.isContextCompacting()) {
      throw new Error(`Cannot ${action} while the agent is running`)
    }
  }
}
