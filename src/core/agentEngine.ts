import type {
  AgentMode,
  AgentAttachment,
  AgentTool,
  AgentSession,
  AgentTurn,
  AgentConfig,
  ContextPolicyMode,
  ToolCall,
  ToolResult,
  TaskPriority,
  TaskStatus,
  TaskNode,
  TokenUsage,
  AgentRunState,
  AgentRunPhase,
  AgentRunInterruption,
  ChangeSummary,
} from '../shared/agentTypes'
import { generateSessionId, generateTurnId } from '../shared/agentTypes'
import { existsSync, statSync } from 'node:fs'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'
import { browserToolNeedsApproval, describeBrowserPermission, describeBrowserToolActivity, isBuiltInBrowserTool } from '../shared/browserToolPresentation'
import { computerToolApprovalLevel, describeComputerPermission, describeComputerToolActivity, isBuiltInComputerTool } from '../shared/computerToolPresentation'
import { buildSystemPrompt, invalidateStaticPromptCache } from './systemPrompt'
import { TaskManager, type TaskTreeNode } from './taskManager'
import { WorkExecutionTracker } from './workExecutionTracker'
import type { WorkExecutionSnapshot, WorkStepControlAction } from '../shared/workExecutionTypes'
import { CacheMonitor, type CacheBreakResult } from './cacheMonitor'
import { toolsToOpenAIFormat, toolsToAnthropicFormat, getToolByName, validateToolArgs } from './toolRegistry'
import { applyEdit, stripLineNumberPrefix } from './editHelpers'
import { applyPatchAdd, applyPatchHunks, parseApplyPatch, type ApplyPatchOperation } from './applyPatch'
import { canComputeDiff, computeHunks, summarizeHunks } from './diffCompute'
import { shouldAutoBackgroundCommand } from './commandExecutionPolicy'
import { ContextManager } from './contextManager'
import {
  buildContextHandoff,
  buildContinuationEvidence,
  buildContinuationSummaryPrompt,
  buildContinuationSummaryAnchors,
  buildDeterministicContinuationSummary,
  collectContinuationHandoffFacts,
  CONTINUATION_SUMMARY_SYSTEM_PROMPT,
  continuationSummaryTokenBudget,
  extractContinuationText,
  validateContinuationSummary,
  type ContinuationWorkspaceSnapshot,
} from './contextCompaction'
import { autoCompactThreshold, resolveContextPolicyProfile } from './contextPolicy'
import { countMessagesTokens, countTurnishTokens } from './tokenCounter'
import { resolveNativeReasoningRequest } from './modelRegistry'
import {
  downgradeReasoningEffort,
  extractUnsupportedRequestParam,
  isReasoningEffortValueError,
  removeAnthropicCompatibleRequestParam,
  removeOpenAICompatibleRequestParam,
  setOpenAIChatMaxTokens,
  shouldOmitSamplingTemperature,
} from './requestCompatibility'
import { TurnStrategyPlanner, type TurnStrategy } from './turnStrategy'
import { ToolExecutionLedger, toolCallSignature } from './toolExecutionLedger'
import { createDefaultPipeline, type PermissionPipeline } from './permissions'
import type { TerminalSessionInfo } from '../shared/terminalTypes'
import type { RuntimeTask, RuntimeTaskEvent, RuntimeTaskPresentation, RuntimeTaskPresentationKind } from '../shared/runtimeTaskTypes'
import { isMcpTool, parseMcpToolName, executeMcpTool, getMcpAgentTools, validateMcpToolArgs } from './mcp/toolBridge'
import type { McpClient } from './mcp/client'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { CodeMapNode, CodeSearchHit, CodeSymbolKind } from '../shared/codeIndexTypes'
import { resolvePath, toWorkspaceRelative } from './pathUtils'
import { normalizeBaseUrl } from './normalizeBaseUrl'
import { createTurboFluxRequestHeaders } from './clientIdentity'
import {
  ModelProtocolRequestError,
  buildModelProtocolUrl,
  formatProtocolAttempt,
  formatProtocolFailure,
  looksLikeResponsesPreferredModel,
  planModelProtocols,
  protocolLabel,
  shouldFallbackProtocol,
  toProtocolAttempt,
  toResponsesInput,
  toResponsesTools,
  type ModelProtocol,
  type ModelProtocolAttempt,
} from './modelProtocol'
import { resolveRequestMaxTokens } from './modelRequestBudget'
import { formatCodeMap } from './toolDispatcher'
import { dispatchTaskTool, type TaskSystemCreationEvent } from './taskToolDispatcher'
import { getSubAgentDefinition, runSubAgent, loadDynamicAgents, getAvailableAgentTypes } from './subAgent'
import type { ToolExecutor, WebFetchResponse, WebSearchResponse } from '../tools/executor'
import type { AgentStateProvider, APIConfig, APIModel, ContextCompactionState, ContextHandoff, ContextHandoffFacts, ContextReservoirEntry, ContextSegment, WorkspaceInfo } from '../state/types'
import type { TreeNode } from '../shared/types'
import type { EnhancedToolDef } from '../shared/toolTypes'
import { parseTextToolCalls, stripTextToolCallMarkup } from '../shared/toolCallMarkup'
import {
  detectGitRepo,
  fetchGitDiff,
  fetchGitLog,
  fetchGitShow,
  fetchGitSnapshot,
  formatGitSnapshotForPrompt,
  formatGitSnapshotForTool,
  gitCommit,
  gitCreateBranch,
  gitPush,
  gitRestorePaths,
  gitRevertCommit,
  gitStagePaths,
  gitUnstagePaths,
  gitStash,
  gitSwitchBranch,
  type GitDiffScope,
  type GitIntegrationState,
  type GitOperationResult,
} from './gitService'
import { hashText } from './fileIO'
import { RuntimeTaskManager } from './runtime/runtimeTaskManager'
import { SubAgentTaskManager, type SubAgentTaskSnapshot } from './runtime/subAgentTaskManager'
import { ApprovalCoordinator } from './runtime/approvalCoordinator'
import {
  AgentRunControl,
  createAgentRunInterruption,
  interruptionMetadata,
  resolveAgentRunInterruption,
  type AgentRunControlSnapshot,
} from './runtime/runControl'
import { ModelStreamControl } from './runtime/modelStreamControl'
import { emitStreamTimingTrace, streamTimingTraceEnabled, summarizeTimings } from './runtime/streamTimingTrace'
import { createInterruptedToolResult, ToolExecutionCoordinator } from './runtime/toolExecutionCoordinator'
import { hasCompleteToolPayloads, isOutputLimitFinishReason } from './modelStream'
import { appendRuntimeContextToLatestUserMessage, normalizeAnthropicToolMessages } from './modelMessages'
import {
  COMPUTER_ERROR_REDACTED,
  COMPUTER_RESULT_REDACTED,
  redactComputerContextSegments,
  redactComputerReservoir,
  redactComputerTurns,
} from '../shared/computerPrivacy'
import { AnthropicStreamParser } from './providers/anthropicStream'
import { OpenAIChatStreamParser } from './providers/openAIChatStream'
import { OpenAIResponsesStreamParser } from './providers/openAIResponsesStream'
import { runModelRequest } from './modelRequestOrchestrator'
import type { ToolCallBatch } from './toolCallOrchestrator'
import {
  planContextCompaction,
  projectTurnsForModelContext,
} from './contextCompactionBoundary'
import { presentRequestError } from './requestErrorPresentation'
import { normalizeBuiltInToolArguments } from './toolArgumentNormalization'
import { ModelSurface } from './modelSurface'
import type { ModelSurfaceState } from '../shared/modelSurfaceTypes'

export {
  extractResponsesReasoningEventDelta,
  extractResponsesReasoningSummary,
} from './modelStream'
export {
  appendRuntimeContextToLatestUserMessage,
  normalizeAnthropicToolMessages,
} from './modelMessages'
export { splitTurnsForCompaction } from './contextCompactionBoundary'

function describeSemanticToolActivity(
  name: string,
  args: Record<string, unknown>,
  status: 'running' | 'completed' | 'failed',
) {
  return describeComputerToolActivity(name, args, status)
    || describeBrowserToolActivity(name, args, status)
}

function describeSemanticToolPermission(name: string, args: Record<string, unknown>) {
  if (name === 'capabilities__request') {
    const capability = args.capability === 'computer' ? '电脑操控' : args.capability === 'browser' ? '内置浏览器' : '可选能力'
    const requestedReason = typeof args.reason === 'string'
      ? args.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
      : ''
    return {
      title: `启用${capability}`,
      question: `为当前任务启用${capability}吗？`,
      reason: requestedReason || `Agent 需要使用${capability}继续完成当前任务。`,
      runningDetail: `正在启用${capability}`,
    }
  }
  return describeComputerPermission(name, args)
    || describeBrowserPermission(name, args)
}

export function countTurnContextChars(turn: AgentTurn): number {
  let total = turn.content?.length ?? 0
  total += turn.metadata?.runtimeContext?.length ?? 0

  if (turn.toolCalls) {
    for (const toolCall of turn.toolCalls) {
      total += toolCall.name.length + 2
      try {
        total += JSON.stringify(toolCall.arguments).length
      } catch {}
    }
  }
  if (turn.toolResults) {
    for (const toolResult of turn.toolResults) {
      total += toolResult.output.length + 1
      const change = toolResult.changeSummary
      if (change) {
        total += change.path.length + change.operation.length
        total += change.preview?.length ?? 0
        total += change.oldPreview?.length ?? 0
        total += change.before?.length ?? 0
        total += change.after?.length ?? 0
      }
    }
  }

  const rawReasoning = turn.metadata?.rawReasoningPayload
  let rawReasoningChars = rawReasoning?.reasoningContent?.length ?? 0
  if (rawReasoning?.blocks) {
    for (const block of rawReasoning.blocks) {
      rawReasoningChars += block.thinking?.length ?? 0
      rawReasoningChars += block.signature?.length ?? 0
      rawReasoningChars += block.data?.length ?? 0
    }
  }
  total += rawReasoningChars > 0
    ? rawReasoningChars
    : (turn.metadata?.thinking?.content.length ?? 0)
  return total
}

const DEFAULT_MODEL_READ_LINES = 2_000
const MODEL_READ_MAX_LINES = 2_000
const MODEL_READ_MAX_BYTES = 48 * 1024
const MODEL_READ_FULL_MAX_BYTES = 80 * 1024
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000
const MAX_IDENTICAL_TOOL_FAILURES = 3
const DEFAULT_MAX_TOOL_ROUNDS_PER_RUN = 96
const CONTEXT_COMPACTION_REQUEST_TIMEOUT_MS = 45_000
const MODEL_TRANSIENT_RETRY_DELAYS_MS = [1_500, 5_000, 15_000]
const MODEL_TRANSIENT_RETRYABLE_STATUSES = new Set([408, 409, 425, 429])
const MAX_MODEL_TRANSIENT_RETRY_DELAY_MS = 120_000
const MODEL_TRANSIENT_RETRY_BUDGET_MS = 120_000
const MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS = 2_048

function streamToolArgumentPreview(value: string): string {
  if (value.length <= MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS) return value
  return value.slice(-MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS)
}

interface ToolDispatchResult {
  output: string
  attachments?: AgentAttachment[]
}

type ToolDispatchOutput = string | ToolDispatchResult

type PromptModuleSnapshot = {
  id: string
  label: string
  hash: string
  chars: number
  stable: boolean
}

interface WarmRequestPrefix {
  protocol: ModelProtocol
  body: Record<string, unknown>
}

export type AgentEventType =
  | { type: 'run:state'; state: AgentRunState }
  | { type: 'turn:start'; turn: AgentTurn }
  | { type: 'turn:complete'; turn: AgentTurn }
  | { type: 'tool:call'; toolCall: ToolCall }
  | { type: 'tool:result'; toolResult: ToolResult }
  | { type: 'task:update'; taskId: string; status: string; progress: number }
  | { type: 'work:execution'; snapshot: WorkExecutionSnapshot }
  | { type: 'mode:change'; from: AgentMode; to: AgentMode }
  | { type: 'session:complete'; session: AgentSession }
  | { type: 'error'; error: string }
  | { type: 'notification'; message: string; level: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'model:protocol'; phase: 'attempt' | 'fallback' | 'success'; protocol: ModelProtocol; url: string; message?: string }
  | { type: 'stream:delta'; text: string }
  | { type: 'stream:thinking_delta'; text: string }
  | { type: 'stream:tool_call_delta'; toolCallId: string; toolName: string; partialJson: string }
  | { type: 'stream:start' }
  | { type: 'stream:end'; interrupted?: boolean }
  | { type: 'stream:usage'; usage: TokenUsage }
  | { type: 'ask:user'; question: string; options?: string[]; reason?: string; command?: string; requestId?: string; toolName?: string; path?: string; queuedCount?: number }
  | { type: 'approval:state'; requestId: string; requestKind: 'permission' | 'input'; state: 'requested' | 'resolved' | 'cancelled'; decision?: string; question: string; toolName?: string; path?: string }
  | { type: 'input:state'; inputId: string; intent: 'steer'; state: 'accepted' | 'committed' | 'rejected'; text: string; reason?: string }
  | { type: 'active:task'; context: import('./taskManager').ActiveTaskContext | null }
  | { type: 'terminal:sessions'; sessions: TerminalSessionInfo[] }
  | { type: 'runtime-task:created'; task: RuntimeTask }
  | { type: 'runtime-task:updated'; task: RuntimeTask }
  | { type: 'runtime-task:finished'; task: RuntimeTask }
  | {
    type: 'task:system'
    context: import('./taskManager').ActiveTaskContext | null
    tree: TaskTreeNode[]
    creation?: TaskSystemCreationEvent | null
  }
  | { type: 'context:segment_created'; segment: ContextSegment }
  | { type: 'context:compaction_started'; state: ContextCompactionState }
  | { type: 'context:compaction_summarizing'; state: ContextCompactionState }
  | { type: 'context:compaction_fallback'; state: ContextCompactionState }
  | { type: 'context:compaction_committing'; state: ContextCompactionState }
  | { type: 'context:compaction_progress'; state: ContextCompactionState }
  | { type: 'context:compaction_completed'; state: ContextCompactionState }
  | { type: 'context:compaction_interrupted'; state: ContextCompactionState }
  | { type: 'context:compaction_failed'; state: ContextCompactionState }
  | { type: 'git:state'; state: GitIntegrationState }
  | { type: 'subagent:start'; agentId: string; agentType: string; label: string; objective: string }
  | { type: 'subagent:progress'; agentId: string; agentType: string; label: string; event: SubAgentEvent }
  | { type: 'subagent:end'; agentId: string; agentType: string; ok: boolean; elapsedMs: number }
  | { type: 'cache:diagnostic'; result: CacheBreakResult }
  | { type: 'cache:modules'; modules: PromptModuleSnapshot[] }

export type AgentEventListener = (event: AgentEventType) => void
export type AgentEventRecorder = (event: AgentEventType) => void

type AskUserEvent = Extract<AgentEventType, { type: 'ask:user' }>

interface EngineInteractiveRequest {
  id: string
  kind: 'permission' | 'input'
  event: AskUserEvent
}

interface PendingSteeringInput {
  id: string
  text: string
}

export { downgradeReasoningEffort } from './requestCompatibility'

function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) output[key] = normalize(record[key])
      return output
    }
    return input
  }
  const text = JSON.stringify(normalize(value))
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function normalizeLocalPreviewUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim())
    const hostname = parsed.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
    if (hostname === '0.0.0.0') parsed.hostname = 'localhost'
    else if (hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1' && !hostname.startsWith('127.')) return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

export class AgentEngine {
  private session: AgentSession
  private taskManager: TaskManager
  private workExecution: WorkExecutionTracker
  private listeners: Set<AgentEventListener> = new Set()
  private eventRecorder: AgentEventRecorder | null = null
  private streamTraceStartedAt = 0
  private streamTraceLastEventAt = 0
  private readonly streamTraceRecorderDurations = new Map<string, number[]>()
  private readonly streamTraceListenerDurations = new Map<string, number[]>()
  private readonly streamTraceEventIntervals = new Map<string, number[]>()
  private readonly runControl = new AgentRunControl()
  private get abortController(): AbortController | null {
    return this.runControl.getRunController()
  }
  private set abortController(controller: AbortController | null) {
    this.runControl.setRunController(controller)
  }
  private get operationAbortController(): AbortController | null {
    return this.runControl.getOperationController()
  }
  private set operationAbortController(controller: AbortController | null) {
    this.runControl.setOperationController(controller)
  }
  private readonly modelStreams = new ModelStreamControl()
  private unsubscribeTaskManager: (() => void) | null = null
  private contextManager: ContextManager = new ContextManager()
  private readonly interactiveRequests: ApprovalCoordinator<EngineInteractiveRequest, string>
  private readonly resolvedAskUserResponses = new Map<string, string>()
  private toolCallTaskMap: Map<string, string> = new Map()
  private fileBeforeSnapshots: Map<string, string | null> = new Map()
  // Registry of background PTY sessions the agent has spawned via
  // run_command(run_in_background=true). Tracks the command + start time so
  // list_terminals / read_terminal can label them. Foreground commands use
  // the legacy exec path and do not need a session.
  private agentBackgroundSessions: Map<string, { command: string; startedAt: number }> = new Map()
  private turnStrategyPlanner: TurnStrategyPlanner = new TurnStrategyPlanner()
  private currentTurnStrategy: TurnStrategy | null = null
  /**
   * Workspace skeleton — a stable per-workspace primer for subagents.
   * The skeleton is intentionally objective-agnostic:
   * top-level directory tree only, computed once per workspace, kept
   * deterministic so V4's cache prefix detector recognizes the same
   * unit across every subagent call. Once persisted, every later
   * invocation pays 1/10 input price for the skeleton portion.
   *
   * Cache is keyed by absolute workspace path. Invalidated when the
   * workspace changes (resetForNewSession / resetForNewRun handle this
   * by clearing the field). Not invalidated on file edits — directory
   * structure rarely shifts within a single session and a slightly
   * stale skeleton is strictly better than a cold cache.
   */
  private workspaceSkeleton: string | null = null
  private workspaceSkeletonPath: string | null = null
  private cachedGitStatus: string | null = null
  private gitDetected: boolean = false
  private gitGeneration = 0
  private gitState: GitIntegrationState = {
    enabled: false,
    phase: 'detecting',
    snapshot: null,
    updatedAt: Date.now(),
  }
  // Workspace long-term memory (M1: static loaders only).
  // Injection text is owned by the main process MemoryService — we just
  // cache the latest copy plus its fingerprint so we don't re-IPC every turn.
  // Re-fetched lazily when (workspacePath, fingerprint) changes; the main
  // process produces the fingerprint from on-disk mtimes so user edits to
  // CLAUDE.md / .cursorrules / etc. propagate without explicit invalidation.
  private workspaceMemoryText: string | null = null
  private workspaceMemoryWorkspace: string | null = null
  private workspaceMemoryBuiltAt: number = 0
  private cacheMonitor = new CacheMonitor()
  private modelSurface = new ModelSurface()
  private readonly warmRequestPrefixes = new Map<ModelProtocol, WarmRequestPrefix>()
  private permissions: PermissionPipeline = createDefaultPipeline()
  /** Files preserved from the last compaction so the model doesn't lose
   * working context. Injected once into the next user message, then cleared. */
  private preservedFiles: Array<{ path: string; content: string }> = []
  private compressionPreparedTurnCount: number = 0
  private currentRunToolNames: string[] = []
  private currentRunReadFiles: Set<string> = new Set()
  private currentRunSuccessfulReadFiles: Set<string> = new Set()
  private currentRunSearches: Set<string> = new Set()
  private currentRunSuccessfulSearches: Set<string> = new Set()
  private toolExecutionLedger = new ToolExecutionLedger()
  private readonly toolExecutionCoordinator: ToolExecutionCoordinator
  private conclusionGuardAttempts: number = 0
  private disabledToolNames: Set<string> = new Set()
  private pendingAssistantMessageId: string | null = null
  private currentRunPromise: Promise<AgentTurn[]> | null = null
  private pendingSteeringMessages: PendingSteeringInput[] = []
  private steeringOpen = false
  private runState: AgentRunState = { phase: 'idle', updatedAt: Date.now() }
  private pausedResumeState: AgentRunState | null = null
  private forceContextCompactionBeforeNextCall = false
  private contextLimitRetryInProgress = false
  private providerTransientRetryAttempt = 0
  private providerTransientRetryStartedAt = 0
  private currentModelRequestRound = 0
  private contextCompactionState: ContextCompactionState | null = null
  private contextCompactionPromise: Promise<boolean> | null = null
  private contextCompactionAbortController: AbortController | null = null
  private contextCompactionHeartbeat: ReturnType<typeof setInterval> | null = null

  private toolExecutor: ToolExecutor
  private stateProvider: AgentStateProvider
  private subAgentTaskManager: SubAgentTaskManager
  private mcpClient: McpClient | null = null
  private deferredMcpToolNames = new Set<string>()
  private activatedRunSkills = new Map<string, NonNullable<AgentConfig['enabledSkills']>[number]>()

  setMcpClient(client: McpClient): void {
    this.mcpClient = client
    this.deferredMcpToolNames.clear()
  }

  enableMcpServerTools(serverName: string): number {
    if (!this.mcpClient) return 0
    const connection = this.mcpClient.getConnection(serverName)
    if (!connection || connection.status !== 'connected') return 0
    for (const tool of connection.tools) this.deferredMcpToolNames.add(tool.name)
    return connection.tools.length
  }

  setEventRecorder(recorder: AgentEventRecorder | null): void {
    this.eventRecorder = recorder
  }

  constructor(
    private config: AgentConfig,
    toolExecutor: ToolExecutor,
    stateProvider: AgentStateProvider,
    subAgentTaskManager?: SubAgentTaskManager,
  ) {
    this.toolExecutor = toolExecutor
    this.stateProvider = stateProvider
    this.subAgentTaskManager = subAgentTaskManager || new SubAgentTaskManager({
      workspacePath: config.workspacePath || '',
      runtimeTaskManager: new RuntimeTaskManager({ defaultOwnerSessionId: config.conversationId }),
      ownerSessionId: config.conversationId,
      storageDir: false,
    })
    this.interactiveRequests = new ApprovalCoordinator(
      (request, queuedCount) => {
        const semanticPermission = request.event.toolName
          ? describeSemanticToolPermission(request.event.toolName, {})
          : null
        this.setRunStateAfterPause(request.kind === 'permission' ? 'awaiting_approval' : 'awaiting_input', {
          detail: request.kind === 'permission'
            ? semanticPermission ? `等待确认：${semanticPermission.title}` : `Reviewing ${request.event.toolName || 'tool'}`
            : 'Waiting for your answer',
          activeTool: request.event.toolName,
        })
        this.emit({ ...request.event, queuedCount })
      },
      ({ request, state, decision }) => {
        this.emit({
          type: 'approval:state',
          requestId: request.id,
          requestKind: request.kind,
          state,
          decision,
          question: request.event.question,
          toolName: request.event.toolName,
          path: request.event.path,
        })
      },
    )
    this.permissions.setApprovalPolicy(config.approvalPolicy || 'agent')
    const now = Date.now()
    const gitEnabled = config.gitEnabled !== false
    this.gitState = {
      enabled: gitEnabled,
      phase: gitEnabled ? 'detecting' : 'disabled',
      snapshot: null,
      updatedAt: now,
    }
    this.session = {
      id: config.conversationId || generateSessionId(),
      mode: config.mode,
      turns: [],
      currentTaskId: null,
      createdAt: now,
      updatedAt: now,
      workspacePath: config.workspacePath,
      workspaceName: config.workspaceName,
      totalTokens: { input: 0, output: 0 },
      modelSurface: this.modelSurface.getState(),
    }
    this.taskManager = new TaskManager()
    this.workExecution = new WorkExecutionTracker(this.session.id)
    this.toolExecutionCoordinator = new ToolExecutionCoordinator({
      resolveTool: name => this.resolveToolDefinition(name),
      isWrite: toolCall => this.isWriteToolCall(toolCall),
      isReadAfterWriteSensitive: toolCall => this.isReadAfterWriteSensitiveToolCall(toolCall),
      execute: (toolCall, signal) => this.executeSingleTool(toolCall, signal),
      onCallsStarted: toolCalls => {
        for (const toolCall of toolCalls) this.linkToolCallToActiveTask(toolCall)
        this.emitActiveTaskContext()
        for (const toolCall of toolCalls) this.emit({ type: 'tool:call', toolCall })
      },
      onResult: (toolCall, result) => {
        this.emit({ type: 'tool:result', toolResult: result })
        this.updateTaskToolCallStatus(toolCall.id, this.getTaskToolStatus(result), result.output, result.name)
      },
      onSettled: () => this.emitActiveTaskContext(),
    })

    // 加载动态代理定义（.turboflux/agents/*.md）
    if (config.workspacePath) {
      loadDynamicAgents(config.workspacePath)
    }
    this.unsubscribeTaskManager = this.taskManager.subscribe(event => {
      if (event.type === 'task:created' || event.type === 'task:updated') {
        this.emit({
          type: 'task:update',
          taskId: event.task.id,
          status: event.task.status,
          progress: event.task.progress,
        })
        this.emitActiveTaskContext()
        this.emitWorkExecution()
      }

      if (event.type === 'tasks:cleared') {
        this.emitActiveTaskContext()
        this.emitWorkExecution()
      }
    })
  }

  destroy(): void {
    this.unsubscribeTaskManager?.()
    this.runControl.stop()
    this.contextCompactionAbortController?.abort()
    if (this.contextCompactionHeartbeat) clearInterval(this.contextCompactionHeartbeat)
    this.contextCompactionHeartbeat = null
    this.interactiveRequests.cancelAll('deny')
    this.resolvedAskUserResponses.clear()
    this.pausedResumeState = null
    this.runControl.finish()
    this.contextCompactionAbortController = null
    this.modelStreams.clear()
    this.subAgentTaskManager.destroy()
    this.listeners.clear()
  }

  getMode(): AgentMode {
    return this.session.mode
  }

  setMode(mode: AgentMode): void {
    const oldMode = this.session.mode
    this.session.mode = mode
    this.config.mode = mode
    invalidateStaticPromptCache()
    this.emit({ type: 'mode:change', from: oldMode, to: mode })
  }

  setAppendSystemPrompt(appendSystemPrompt: string | undefined): void {
    this.config.appendSystemPrompt = appendSystemPrompt
  }

  setConversationId(conversationId: string): void {
    this.config.conversationId = conversationId
    this.session.id = conversationId
    this.stateProvider.setConversationId?.(conversationId)
    this.workExecution.setConversationId(conversationId)
  }

  getConversationId(): string | undefined {
    return this.config.conversationId
  }

  updateRuntimeConfiguration(update: Partial<Pick<AgentConfig,
    'approvalPolicy' | 'capabilityProfile' | 'gitEnabled' | 'contextWindow' | 'maxTokens' | 'profileSystemPrompt'
  >>): void {
    if (update.approvalPolicy !== undefined && update.approvalPolicy !== this.config.approvalPolicy) {
      this.setApprovalPolicy(update.approvalPolicy)
    }
    if (update.gitEnabled !== undefined && update.gitEnabled !== this.gitState.enabled) {
      this.setGitEnabled(update.gitEnabled)
    }
    if (update.capabilityProfile !== undefined) this.config.capabilityProfile = update.capabilityProfile
    if (update.contextWindow !== undefined) this.config.contextWindow = update.contextWindow
    if (update.maxTokens !== undefined) this.config.maxTokens = update.maxTokens
    if (update.profileSystemPrompt !== undefined && update.profileSystemPrompt !== this.config.profileSystemPrompt) {
      this.config.profileSystemPrompt = update.profileSystemPrompt
      this.invalidateStaticPromptCache()
    }
  }

  setEnabledSkills(skills: AgentConfig['enabledSkills']): void {
    this.config.enabledSkills = skills
  }

  /** 热重载动态代理定义 */
  reloadAgents(): void {
    if (this.config.workspacePath) {
      loadDynamicAgents(this.config.workspacePath)
    }
  }

  isRunning(): boolean {
    return Boolean(this.currentRunPromise)
  }

  getRunControlSnapshot(): AgentRunControlSnapshot {
    return this.runControl.getSnapshot()
  }

  isContextCompacting(): boolean {
    return this.contextCompactionPromise !== null
      || (this.contextCompactionState?.phase !== undefined
        && !['completed', 'interrupted', 'failed'].includes(this.contextCompactionState.phase))
  }

  setContextPolicy(mode: ContextPolicyMode): void {
    this.config.contextPolicy = mode
    this.compressionPreparedTurnCount = 0
  }

  setApprovalPolicy(policy: NonNullable<AgentConfig['approvalPolicy']>): void {
    this.config.approvalPolicy = policy
    this.permissions.setApprovalPolicy(policy)
  }

  getApprovalPolicy(): NonNullable<AgentConfig['approvalPolicy']> {
    return this.permissions.getApprovalPolicy()
  }

  getGitState(): GitIntegrationState {
    return {
      ...this.gitState,
      snapshot: this.gitState.snapshot
        ? { ...this.gitState.snapshot, files: [...this.gitState.snapshot.files], recentCommits: [...this.gitState.snapshot.recentCommits], branches: [...(this.gitState.snapshot.branches || [])] }
        : null,
      operation: this.gitState.operation ? { ...this.gitState.operation } : undefined,
    }
  }

  setGitEnabled(enabled: boolean): void {
    this.gitGeneration += 1
    this.config.gitEnabled = enabled
    if (!enabled) {
      this.cachedGitStatus = null
      this.updateGitState({ enabled: false, phase: 'disabled', snapshot: null, error: undefined, operation: undefined })
    } else {
      this.gitDetected = false
      this.updateGitState({ enabled: true, phase: 'detecting', snapshot: null, error: undefined })
      void this.initializeGit(true)
    }
    this.invalidateStaticPromptCache()
  }

  async initializeGit(force = false): Promise<boolean> {
    if (!this.gitState.enabled) return false
    const generation = this.gitGeneration
    if (!this.config.workspacePath) {
      this.cachedGitStatus = null
      this.updateGitState({ phase: 'unavailable', snapshot: null, error: undefined, operation: undefined })
      return false
    }
    if (this.gitDetected && !force) return this.gitState.phase === 'ready' || this.gitState.phase === 'syncing'
    this.updateGitState({ phase: 'detecting', error: undefined })
    this.gitDetected = true
    const isRepo = await detectGitRepo(this.config.workspacePath, this.toolExecutor)
    if (generation !== this.gitGeneration || !this.gitState.enabled) return false
    if (!isRepo) {
      this.cachedGitStatus = null
      this.updateGitState({ phase: 'unavailable', snapshot: null, error: undefined, operation: undefined })
      return false
    }
    await this.refreshGitStatus(generation)
    return this.gitState.phase === 'ready'
  }

  private invalidateStaticPromptCache(): void {
    invalidateStaticPromptCache()
  }

  async refreshGitStatus(expectedGeneration = this.gitGeneration): Promise<void> {
    if (!this.gitState.enabled || !this.config.workspacePath) return
    if (this.gitState.phase === 'unavailable' || this.gitState.phase === 'disabled') return
    const snapshot = await fetchGitSnapshot(this.config.workspacePath, this.toolExecutor).catch(() => null)
    if (expectedGeneration !== this.gitGeneration || !this.gitState.enabled) return
    this.cachedGitStatus = snapshot ? formatGitSnapshotForPrompt(snapshot) : null
    this.updateGitState({
      phase: snapshot ? 'ready' : 'error',
      snapshot,
      error: snapshot ? undefined : 'Unable to read Git repository state',
    })
    this.invalidateStaticPromptCache()
  }

  private updateGitState(patch: Partial<GitIntegrationState>): void {
    this.gitState = { ...this.gitState, ...patch, updatedAt: Date.now() }
    this.emit({ type: 'git:state', state: this.getGitState() })
  }

  private async runGitOperation(
    name: string,
    operation: () => Promise<GitOperationResult>,
  ): Promise<GitOperationResult> {
    if (!this.gitState.enabled || !this.config.workspacePath) {
      return { ok: false, error: 'Git integration is not active for this workspace' }
    }
    if (this.gitState.phase === 'syncing') {
      return { ok: false, error: 'Another Git operation is already running' }
    }
    if (this.gitState.phase !== 'ready' && !await this.initializeGit(true)) {
      return { ok: false, error: this.gitState.error || 'Git repository is not ready' }
    }
    this.updateGitState({
      phase: 'syncing',
      error: undefined,
      operation: { name, status: 'running', updatedAt: Date.now() },
    })
    let result: GitOperationResult
    const generation = this.gitGeneration
    try {
      result = await operation()
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const snapshot = await fetchGitSnapshot(this.config.workspacePath, this.toolExecutor).catch(() => null)
    if (generation !== this.gitGeneration || !this.gitState.enabled) return result
    this.cachedGitStatus = snapshot ? formatGitSnapshotForPrompt(snapshot) : null
    this.updateGitState({
      phase: result.ok ? 'ready' : 'error',
      snapshot,
      error: result.ok ? undefined : result.error || `${name} failed`,
      operation: {
        name,
        status: result.ok ? 'success' : 'error',
        message: result.ok ? result.output : result.error,
        hash: result.hash,
        updatedAt: Date.now(),
      },
    })
    this.invalidateStaticPromptCache()
    return result
  }

  async stageGitPaths(paths: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('stage', () => gitStagePaths(this.config.workspacePath!, paths, this.toolExecutor))
  }

  async unstageGitPaths(paths: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('unstage', () => gitUnstagePaths(this.config.workspacePath!, paths, this.toolExecutor))
  }

  async commitGit(message: string, paths?: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('commit', () => gitCommit(this.config.workspacePath!, message, this.toolExecutor, paths))
  }

  async createGitBranch(name: string, startPoint?: string): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('create-branch', () => gitCreateBranch(this.config.workspacePath!, name, this.toolExecutor, startPoint))
  }

  async switchGitBranch(name: string): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('switch-branch', () => gitSwitchBranch(this.config.workspacePath!, name, this.toolExecutor))
  }

  async restoreGitPaths(paths: string[], source = 'HEAD'): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('restore', () => gitRestorePaths(this.config.workspacePath!, paths, this.toolExecutor, source))
  }

  async pushGit(options: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('push', () => gitPush(this.config.workspacePath!, this.toolExecutor, options))
  }

  async readGitDiff(path?: string, scope: GitDiffScope = 'working'): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return fetchGitDiff(this.config.workspacePath, this.toolExecutor, scope, path)
  }

  async compactContext(): Promise<void> {
    await this.performContextCompaction('manual')
  }

  getTokenUsage(): { input: number; output: number } {
    return { ...this.session.totalTokens }
  }

  getContextUsage(): TokenUsage {
    return this.contextManager.getLastProviderUsage()
  }

  getModelSurfaceState(): ModelSurfaceState {
    this.modelSurface.syncTurns(this.session.turns)
    const state = this.modelSurface.getState()
    this.session.modelSurface = state
    return state
  }

  restoreModelSurfaceState(state: ModelSurfaceState | undefined, fallbackTurns: AgentTurn[] = this.session.turns): void {
    this.modelSurface.restore(state, fallbackTurns)
    this.session.modelSurface = this.modelSurface.getState()
    this.cacheMonitor.resetBaseline()
  }

  getContextSegments(): ContextSegment[] {
    return this.stateProvider.getContextSegments()
  }

  setContextSegments(segments: ContextSegment[]): void {
    this.stateProvider.setContextSegments(segments)
  }

  getContextReservoir(): ContextReservoirEntry[] {
    return this.stateProvider.getContextReservoir()
  }

  setContextReservoir(entries: ContextReservoirEntry[]): void {
    this.stateProvider.setContextReservoir(entries)
  }

  /**
   * Drop native Computer observations and action payloads once a run is over.
   * The persisted/UI projections already redact these values, but keeping the
   * raw screenshots, coordinates, AX values, and typed text in the live
   * session would make a later snapshot or recovery path unnecessarily risky.
   */
  expireComputerToolPayloads(): void {
    const reservoir = this.stateProvider.getContextReservoir()
    const reservoirTurns = reservoir.flatMap(entry => entry.turns)
    const allTurns = [...this.session.turns, ...reservoirTurns]
    this.stateProvider.setContextSegments(
      redactComputerContextSegments(this.stateProvider.getContextSegments(), allTurns),
    )
    this.stateProvider.setContextReservoir(redactComputerReservoir(reservoir))
    this.session.turns = redactComputerTurns(this.session.turns)
  }

  getContextCompactionState(): ContextCompactionState | null {
    const persisted = this.stateProvider.getContextCompactionState?.()
    const state = persisted ?? this.contextCompactionState
    return state ? { ...state } : null
  }

  setContextCompactionState(state: ContextCompactionState | null): void {
    this.contextCompactionState = state ? { ...state } : null
    this.stateProvider.setContextCompactionState?.(state ? { ...state } : null)
    this.forceContextCompactionBeforeNextCall = state?.phase === 'interrupted' && state.recoverable
  }

  getFullConversationTurns(): AgentTurn[] {
    const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
    const liveTurns = this.session.turns.filter(turn => turn.role !== 'system')
    const orderedIds: string[] = []
    const turnsById = new Map<string, AgentTurn>()
    const addTurn = (turn: AgentTurn) => {
      if (!turnsById.has(turn.id)) orderedIds.push(turn.id)
      turnsById.set(turn.id, turn)
    }
    this.stateProvider.getContextReservoir()
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .forEach(entry => entry.turns.forEach(addTurn))
    liveTurns.forEach(addTurn)
    return [...systemTurns, ...orderedIds.map(id => turnsById.get(id)!).filter(Boolean)]
  }

  resetSession(): void {
    const now = Date.now()
    this.restoreFromMessages([])
    this.stateProvider.setContextSegments([])
    this.stateProvider.setContextReservoir([])
    this.contextCompactionState = null
    this.stateProvider.setContextCompactionState?.(null)
    this.forceContextCompactionBeforeNextCall = false
    this.session.id = this.config.conversationId || generateSessionId()
    this.workExecution = new WorkExecutionTracker(this.session.id)
    this.session.currentTaskId = null
    this.session.createdAt = now
    this.session.updatedAt = now
    this.session.totalTokens = { input: 0, output: 0 }
    this.modelSurface.reset()
    this.session.modelSurface = this.modelSurface.getState()
    this.fileBeforeSnapshots.clear()
  }

  restoreFromTurns(turns: AgentTurn[], options?: { emitRunState?: boolean }): void {
    const resultByToolCallId = new Map<string, ToolResult>()
    for (const turn of turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        resultByToolCallId.set(result.toolCallId, result)
      }
    }

    this.restoreFromMessages(turns.map(turn => {
      const toolCalls = turn.toolCalls?.map(toolCall => {
        const result = resultByToolCallId.get(toolCall.id)
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          result: result?.output,
          isError: result?.isError,
          status: result ? (result.isError ? 'error' : 'completed') : undefined,
          changeSummary: result?.changeSummary,
        }
      })

      return {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        metadata: {
          ...(turn.metadata ?? {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        },
      }
    }))

    this.session.id = this.config.conversationId || generateSessionId()
    this.session.createdAt = turns[0]?.timestamp ?? Date.now()
    this.session.updatedAt = turns[turns.length - 1]?.timestamp ?? Date.now()
    this.session.totalTokens = turns.reduce((total, turn) => ({
      input: total.input + (turn.metadata?.tokens?.input ?? 0),
      output: total.output + (turn.metadata?.tokens?.output ?? 0),
    }), { input: 0, output: 0 })
    this.modelSurface.reset(this.session.turns)
    this.session.modelSurface = this.modelSurface.getState()
    if (options?.emitRunState === false) {
      this.runState = { phase: 'idle', updatedAt: Date.now() }
      this.workExecution.setPhase('idle')
    } else {
      this.setRunState('idle')
    }
  }

  setDisabledTools(toolNames: string[]): void {
    this.disabledToolNames = new Set(toolNames)
    this.config.disabledTools = toolNames
  }

  private modelDisabledToolNames(): string[] {
    return [...this.disabledToolNames]
  }

  attachPendingAssistantMessageId(messageId: string): void {
    this.pendingAssistantMessageId = messageId
  }

  getSession(): AgentSession {
    return this.session
  }

  getTaskManager(): TaskManager {
    return this.taskManager
  }

  getWorkExecutionSnapshot(): WorkExecutionSnapshot {
    return this.workExecution.getSnapshot(this.taskManager)
  }

  restoreWorkExecutionSnapshot(snapshot: WorkExecutionSnapshot | undefined): boolean {
    const restored = this.workExecution.restoreSnapshot(snapshot, this.taskManager)
    if (restored) this.emitWorkExecution()
    return restored
  }

  controlWorkStep(taskId: string, action: WorkStepControlAction): boolean {
    const updated = this.taskManager.controlTask(taskId, action)
    if (!updated) return false
    this.emitActiveTaskContext()
    this.emitWorkExecution()
    return true
  }

  /**
   * Restore session from persisted ChatMessage data.
   * Reconstructs toolCalls, toolResults, and metadata from the serialized format.
   */
  resetContextTracking(): void {
    this.contextManager.reset()
    this.cacheMonitor.reset()
    this.warmRequestPrefixes.clear()
  }

  restoreFromMessages(messages: Array<{
    id?: string
    role: string
    content: string
    timestamp?: number
    metadata?: {
      model?: string
      tokens?: number | TokenUsage
      duration?: number
      reasoningEnabled?: boolean
      reasoningEffort?: NonNullable<AgentTurn['metadata']>['reasoningEffort']
      thinking?: NonNullable<AgentTurn['metadata']>['thinking']
      rawReasoningPayload?: NonNullable<AgentTurn['metadata']>['rawReasoningPayload']
      attachments?: NonNullable<AgentTurn['metadata']>['attachments']
      capabilities?: NonNullable<AgentTurn['metadata']>['capabilities']
      runtimeContext?: string
      toolCalls?: Array<{
        id?: string
        name: string
        arguments: Record<string, unknown>
        result?: string
        isError?: boolean
        status?: string
        interruption?: AgentRunInterruption
        changeSummary?: {
          path: string
          operation: 'write' | 'edit' | 'delete'
          addedLines?: number
          removedLines?: number
          totalLines?: number
          preview?: string
          oldPreview?: string
          before?: string
          after?: string
        }
      }>
      detectedSkills?: string[]
      isStreaming?: boolean
      workRunId?: string
    }
  }>): void {
    this.contextManager.reset()
    this.cacheMonitor.reset()
    this.warmRequestPrefixes.clear()
    this.session.turns = this.session.turns.filter(t => t.role === 'system')
    this.taskManager.clear()
    this.toolCallTaskMap.clear()
    this.currentRunToolNames = []
    this.currentRunReadFiles.clear()
    this.currentRunSuccessfulReadFiles.clear()
    this.currentRunSearches.clear()
    this.currentRunSuccessfulSearches.clear()
    this.activatedRunSkills.clear()
    this.toolExecutionLedger.beginRun()
    this.conclusionGuardAttempts = 0
    this.compressionPreparedTurnCount = 0
    this.workspaceMemoryText = null
    this.workspaceMemoryWorkspace = null
    this.workspaceMemoryBuiltAt = 0
    this.pendingAssistantMessageId = null
    this.fileBeforeSnapshots.clear()

    let restoredTimestampFallback = Date.now()
    for (const msg of messages) {
      if (msg.role === 'system') continue

      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : restoredTimestampFallback++
      const meta = msg.metadata

      if (msg.role === 'user') {
        const userMetadata: AgentTurn['metadata'] = {}
        if (meta?.attachments?.length) {
          userMetadata.attachments = meta.attachments.map(attachment => ({ ...attachment }))
        }
        if (meta?.capabilities?.items.length) {
          userMetadata.capabilities = { items: meta.capabilities.items.map(item => ({ ...item })) }
        }
        if (typeof meta?.runtimeContext === 'string') {
          userMetadata.runtimeContext = meta.runtimeContext
        }
        if (typeof meta?.workRunId === 'string') userMetadata.workRunId = meta.workRunId
        this.session.turns.push({
          id: msg.id || generateTurnId(),
          role: 'user',
          content: msg.content,
          timestamp,
          metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
        })
      } else if (msg.role === 'assistant') {
        // Reconstruct toolCalls from ChatMessage.metadata.toolCalls (ToolCallInfo[])
        let toolCalls: ToolCall[] | undefined
        let toolResults: ToolResult[] | undefined

        if (meta?.toolCalls && meta.toolCalls.length > 0) {
          const restoredIds = meta.toolCalls.map((tc, idx) => tc.id || `restored_tc_${idx}_${timestamp}`)

          toolCalls = meta.toolCalls.map((tc, idx) => ({
            id: restoredIds[idx],
            name: tc.name,
            arguments: tc.arguments,
          }))

          // Reconstruct toolResults from ToolCallInfo.result.
          // Only completed/error/cancelled calls have meaningful results.
          const restoredResults: ToolResult[] = []
          meta.toolCalls.forEach((tc, idx) => {
            const hasResult = tc.result !== undefined
            const hasTerminalStatus = tc.status === 'completed' || tc.status === 'error' || tc.status === 'cancelled'
            if (!hasResult && !hasTerminalStatus) return

            const result: ToolResult = {
              toolCallId: restoredIds[idx],
              name: tc.name,
              output: tc.result ?? '',
              isError: tc.isError ?? (tc.status === 'error' || tc.status === 'cancelled'),
            }
            if (tc.interruption) {
              result.interruption = { ...tc.interruption }
              result.errorKind = 'abort'
            } else if (tc.status === 'cancelled') {
              result.interruption = /paused by user/i.test(result.output)
                ? interruptionMetadata('pause')
                : interruptionMetadata('stop')
              result.errorKind = 'abort'
            }
            if (tc.changeSummary) result.changeSummary = tc.changeSummary
            restoredResults.push(result)
          })
          if (restoredResults.length > 0) toolResults = restoredResults
        }

        // Reconstruct metadata
        const turnMetadata: AgentTurn['metadata'] = {}
        if (meta?.model) turnMetadata.model = meta.model
        if (typeof meta?.tokens === 'number') turnMetadata.tokens = { input: meta.tokens, output: 0 }
        else if (meta?.tokens) turnMetadata.tokens = meta.tokens
        if (meta?.duration) turnMetadata.duration = meta.duration
        if (typeof meta?.reasoningEnabled === 'boolean') turnMetadata.reasoningEnabled = meta.reasoningEnabled
        if (meta?.reasoningEffort) turnMetadata.reasoningEffort = meta.reasoningEffort
        if (meta?.thinking) turnMetadata.thinking = { ...meta.thinking, isStreaming: false }
        if (typeof meta?.workRunId === 'string') turnMetadata.workRunId = meta.workRunId
        if (meta?.rawReasoningPayload) {
          turnMetadata.rawReasoningPayload = {
            provider: meta.rawReasoningPayload.provider,
            blocks: meta.rawReasoningPayload.blocks.map(block => ({ ...block })),
            // Preserve reasoning_content when restoring from persisted history.
            // OpenAI-compatible providers (mimo, DeepSeek-R1) require this
            // string to be echoed back on every subsequent request — dropping
            // it here means a freshly restored conversation 400s on its first
            // follow-up turn.
            ...(meta.rawReasoningPayload.reasoningContent
              ? { reasoningContent: meta.rawReasoningPayload.reasoningContent }
              : {}),
          }
        }
        const assistantTurn: AgentTurn = {
          id: msg.id || generateTurnId(),
          role: 'assistant',
          content: msg.content,
          timestamp,
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          metadata: Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined,
        }

        this.session.turns.push(assistantTurn)

        if (toolResults && toolResults.length > 0) {
          this.session.turns.push({
            id: `${assistantTurn.id}:tool_results`,
            role: 'tool_result',
            content: toolResults.map(r => `${r.name}: ${r.isError ? 'error' : 'ok'} ${(r.output || '').slice(0, 500)}`).join('\n\n'),
            timestamp: timestamp + 1,
            toolResults,
          })
        }

        if (meta?.toolCalls && meta.toolCalls.length > 0) {
          this.taskManager.setCurrentWorkRunId(meta.workRunId || null)
          this.restoreTasksFromToolCalls(meta.toolCalls, timestamp)
        }
      }
    }

    // Re-establish a token baseline from the rewound turns so the context bar
    // shows the correct occupancy instead of falling back to rough char estimates.
    const baselineSystemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      shell: this.config.shell,
    })
    this.contextManager.restoreBaseline(this.session.turns, baselineSystemPrompt)
    this.workExecution.restoreFromTurns(this.session.turns, this.taskManager)
    this.modelSurface.reset(this.session.turns)
    this.session.modelSurface = this.modelSurface.getState()
    this.emitActiveTaskContext()
    this.emitWorkExecution()
  }

  private restoreTasksFromToolCalls(
    toolCalls: Array<{
      name: string
      arguments: Record<string, unknown>
      result?: string
      isError?: boolean
      status?: string
      changeSummary?: {
        path: string
        operation: 'write' | 'edit' | 'delete'
        addedLines?: number
        totalLines?: number
        preview?: string
        oldPreview?: string
        before?: string
        after?: string
      }
    }>,
    timestamp: number,
  ): void {
    for (const tc of toolCalls) {
      if (tc.name === 'create_task') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        let parsedResult: Record<string, unknown> | null = null

        if (tc.result) {
          try {
            parsedResult = JSON.parse(tc.result) as Record<string, unknown>
          } catch {
            parsedResult = null
          }
        }

        const restoredId = typeof parsedResult?.id === 'string'
          ? parsedResult.id
          : `restored-task-${timestamp}-${String(args.title || 'task')}`

        this.taskManager.restoreTask({
          id: restoredId,
          title: String(args.title || parsedResult?.title || 'Task'),
          description: String(args.description || ''),
          priority: ((args.priority as TaskPriority | undefined) || (parsedResult?.priority as TaskPriority | undefined) || 'medium'),
          status: (parsedResult?.status as TaskStatus | undefined) || 'pending',
          parentId: (args.parent_id as string | undefined) || null,
          progress: (parsedResult?.status as TaskStatus | undefined) === 'completed' ? 100 : 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        const deps = args.dependencies as string[] | undefined
        if (deps && deps.length > 0) {
          for (const depId of deps) {
            this.taskManager.addDependency(restoredId, depId)
          }
        }
      }

      if (tc.name === 'create_tasks') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        const items = args.tasks as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items)) continue

        // Try to recover ids from the parsed tool result so dependencies
        // line up. Fall back to deterministic synthetic ids if not present.
        let createdById: Record<string, unknown> | null = null
        if (tc.result) {
          try {
            const parsed = JSON.parse(tc.result) as { created?: Array<Record<string, unknown>> }
            if (parsed?.created) {
              createdById = {}
              parsed.created.forEach((c, idx) => {
                if (createdById && typeof c.id === 'string') {
                  createdById[String(idx)] = c
                  if (typeof c.ref === 'string') createdById[c.ref] = c
                }
              })
            }
          } catch { /* ignore */ }
        }

        const refToId = new Map<string, string>()
        items.forEach((raw, i) => {
          const recovered = createdById?.[String(i)] || (typeof raw.ref === 'string' ? createdById?.[raw.ref] : null)
          const restoredId = typeof (recovered as Record<string, unknown>)?.id === 'string'
            ? String((recovered as Record<string, unknown>).id)
            : `restored-task-${timestamp}-${i}-${String(raw.title || 'task')}`
          if (typeof raw.ref === 'string') refToId.set(raw.ref, restoredId)

          const resolveRef = (value: unknown): string | undefined => {
            if (typeof value !== 'string' || !value) return undefined
            return refToId.get(value) ?? value
          }

          this.taskManager.restoreTask({
            id: restoredId,
            title: String(raw.title || 'Task'),
            description: String(raw.description || ''),
            priority: ((raw.priority as TaskPriority | undefined) || 'medium'),
            status: 'pending',
            parentId: resolveRef(raw.parent_id) || null,
            progress: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })

          const deps = raw.dependencies as unknown[] | undefined
          if (Array.isArray(deps)) {
            for (const depRef of deps) {
              const depId = resolveRef(depRef)
              if (depId) this.taskManager.addDependency(restoredId, depId)
            }
          }
        })
      }

      if (tc.name === 'update_task') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        const taskId = args.task_id as string | undefined
        if (!taskId) continue

        this.taskManager.updateTask(taskId, {
          status: args.status as TaskStatus | undefined,
          progress: args.progress as number | undefined,
          error: args.error as string | undefined,
        })
      }
    }
  }

  private isRestorableTaskToolCall(toolCall: { name: string; result?: string; isError?: boolean; status?: string }): boolean {
    if (toolCall.isError) return false
    if (toolCall.status === 'error' || toolCall.status === 'cancelled' || toolCall.status === 'pending' || toolCall.status === 'running') return false
    if (toolCall.status === 'completed') return true
    if (!toolCall.result) return false
    if (/^(Cancelled|Aborted):/i.test(toolCall.result.trim())) return false
    return !this.isToolOutputFailure(toolCall.name, toolCall.result)
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRunState(): AgentRunState {
    return this.runState
  }

  private setRunState(phase: AgentRunPhase, options?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>): void {
    const previousPhase = this.runState.phase
    const startsNewRun = phase === 'thinking' && (previousPhase === 'idle' || previousPhase === 'completed' || previousPhase === 'recoverable_error')
    const startedAt = phase === 'idle'
      ? undefined
      : startsNewRun
        ? Date.now()
        : this.runState.startedAt ?? Date.now()
    this.runState = {
      phase,
      startedAt,
      updatedAt: Date.now(),
      ...options,
    }
    this.workExecution.setPhase(phase, options?.detail)
    this.emit({ type: 'run:state', state: this.runState })
    this.emitWorkExecution()
  }

  private setRunStateAfterPause(phase: AgentRunPhase, options?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>): void {
    if (this.runControl.getSnapshot().paused) {
      this.pausedResumeState = {
        phase,
        startedAt: this.runState.startedAt,
        updatedAt: Date.now(),
        ...options,
      }
      return
    }
    this.setRunState(phase, options)
  }

  submitSteeringMessage(message: string, inputId = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): boolean {
    const trimmed = message.trim()
    if (!trimmed || !this.currentRunPromise || !this.steeringOpen) return false
    const pending = { id: inputId, text: trimmed }
    this.pendingSteeringMessages.push(pending)
    try {
      this.emit({ type: 'input:state', inputId, intent: 'steer', state: 'accepted', text: trimmed })
    } catch (error) {
      const index = this.pendingSteeringMessages.indexOf(pending)
      if (index >= 0) this.pendingSteeringMessages.splice(index, 1)
      throw error
    }
    this.emit({ type: 'notification', message: 'Guidance added to the current run.', level: 'info' })
    return true
  }

  private consumeSteeringMessages(newTurns: AgentTurn[]): boolean {
    if (this.pendingSteeringMessages.length === 0) return false
    const messages = this.pendingSteeringMessages.splice(0)
    for (const message of messages) {
      const userTurn = this.createUserTurn(message.text, undefined, message.id)
      this.appendUserTurn(userTurn, newTurns)
      this.emit({ type: 'input:state', inputId: message.id, intent: 'steer', state: 'committed', text: message.text })
    }
    return true
  }

  private appendUserTurn(turn: AgentTurn, newTurns: AgentTurn[]): void {
    this.session.turns.push(turn)
    try {
      this.emit({ type: 'turn:start', turn })
    } catch (error) {
      const index = this.session.turns.lastIndexOf(turn)
      if (index >= 0) this.session.turns.splice(index, 1)
      throw error
    }
    newTurns.push(turn)
  }

  private rejectPendingSteeringMessages(reason: string): void {
    const pending = this.pendingSteeringMessages.splice(0)
    for (const message of pending) {
      this.emit({
        type: 'input:state',
        inputId: message.id,
        intent: 'steer',
        state: 'rejected',
        text: message.text,
        reason,
      })
    }
  }

  publishRuntimeTaskEvent(event: RuntimeTaskEvent): void {
    if (event.type === 'runtime-task:removed') return
    if (event.type === 'runtime-task:finished') {
      const sessionId = event.task.metadata?.sessionId
      if (event.task.kind === 'terminal' && typeof sessionId === 'string') {
        this.agentBackgroundSessions.delete(sessionId)
      }
    }
    this.emit(event)
  }

  publishRuntimeTaskFinished(task: RuntimeTask): void {
    this.publishRuntimeTaskEvent({ type: 'runtime-task:finished', task })
  }

  async stopSubAgentTask(taskId: string): Promise<RuntimeTask> {
    return this.subAgentTaskManager.stopTask(taskId, 'Subagent stopped from Desktop')
  }

  retrySubAgentTask(taskId: string): RuntimeTask {
    const previous = this.subAgentTaskManager.getTask(taskId)
    if (!previous) throw new Error(`Subagent task not found: ${taskId}`)
    if (!['completed', 'failed', 'stopped', 'interrupted', 'orphaned'].includes(previous.runtimeTask.status)) {
      throw new Error('Only a finished subagent can be retried')
    }
    const definition = getSubAgentDefinition(previous.agentType)
    if (!definition) throw new Error(`Subagent definition is no longer available: ${previous.agentType}`)
    return this.startSubAgentTask(definition, previous.objective, previous.objective, taskId)
  }

  abort(): void {
    if (this.currentRunPromise) this.setRunState('aborting', { detail: 'Stopping current run' })
    this.steeringOpen = false
    this.rejectPendingSteeringMessages('Current run was interrupted before guidance was committed')
    this.runControl.stop()
    this.pausedResumeState = null
    this.contextCompactionAbortController?.abort()
    void this.subAgentTaskManager.stopAll('Parent agent run cancelled')
    for (const sessionId of this.agentBackgroundSessions.keys()) {
      const stop = this.toolExecutor.ptyKill?.(sessionId)
      if (stop) void stop.catch(() => {})
    }
    this.agentBackgroundSessions.clear()
    // Per-conv stream abort: only cancel THIS engine's HTTP stream in the
    // main process, not every active stream across all conversations.
    this.modelStreams.abortActive(streamId => this.toolExecutor.streamAbort?.(streamId))
    // Keep the controller alive so subsequent signal.aborted checks
    // don't NPE; destroy() is the only path that nulls it.
    this.interactiveRequests.cancelAll('deny')
    this.resolvedAskUserResponses.clear()
  }

  submitAskUserResponse(response: string, requestId?: string): boolean {
    const targetId = requestId ?? this.interactiveRequests.getActiveRequest()?.id
    if (!targetId) return false
    return this.interactiveRequests.resolve(targetId, response)
  }

  getPendingInteractiveRequests(): { active: EngineInteractiveRequest | null; queued: EngineInteractiveRequest[]; pendingCount: number } {
    return this.interactiveRequests.getSnapshot()
  }

  pause(): boolean {
    const resumeState = { ...this.runState }
    const hasPendingInteractiveRequest = this.interactiveRequests.getSnapshot().pendingCount > 0
    if (!this.runControl.pause({ interruptOperation: !hasPendingInteractiveRequest })) return false
    this.pausedResumeState = resumeState
    this.setRunState('paused', { detail: 'Paused by user' })
    this.modelStreams.abortActive(streamId => this.toolExecutor.streamAbort?.(streamId))
    return true
  }

  resume(): boolean {
    if (!this.runControl.resume()) return false
    const resumeState = this.pausedResumeState
    this.pausedResumeState = null
    this.setRunState(resumeState?.phase === 'paused' ? 'thinking' : resumeState?.phase || 'thinking', {
      detail: resumeState?.detail || 'Resuming run',
      activeTool: resumeState?.activeTool,
      recoverable: resumeState?.recoverable,
    })
    return true
  }

  private isContextLimitError(message: string): boolean {
    return /context (?:window|length|limit)|maximum context|prompt is too long|input length .*max_tokens.*context limit|tokens?\s*>\s*\d+/i.test(message)
  }

  private async prepareContextWindow(): Promise<void> {
    if (this.forceContextCompactionBeforeNextCall) {
      this.forceContextCompactionBeforeNextCall = false
      await this.ensureContextWindow(true)
      this.compressionPreparedTurnCount = this.session.turns.length
      return
    }

    const currentTurnCount = this.session.turns.length
    if (currentTurnCount === this.compressionPreparedTurnCount) return
    if (this.shouldCompactFromProviderUsage() || this.shouldCompactFromLocalSize()) {
      await this.ensureContextWindow(true)
    }
    this.compressionPreparedTurnCount = this.session.turns.length
  }

  private currentContextWindowSettings(): { contextWindow: number; maxOutputTokens: number; model?: string; provider?: string } {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    return {
      contextWindow: activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000,
      maxOutputTokens: this.config.maxTokens || activeModel?.maxTokens || activeConfig?.maxTokens || 4096,
      model: activeModel?.id || activeConfig?.defaultModel,
      provider: activeModel?.provider || activeConfig?.provider,
    }
  }

  private providerContextTokens(): number {
    const usage = this.contextManager.getLastProviderUsage()
    if (usage.source !== 'provider' || typeof usage.input !== 'number' || usage.input <= 0) {
      return 0
    }
    return usage.input
  }

  private shouldCompactFromProviderUsage(): boolean {
    const providerTokens = this.currentContextTokensWithTokenizerTail()
    if (providerTokens <= 0 || !Number.isFinite(providerTokens)) return false
    const settings = this.currentContextWindowSettings()
    return providerTokens >= autoCompactThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private shouldCompactFromLocalSize(): boolean {
    const settings = this.currentContextWindowSettings()
    const estimatedTokens = this.session.turns.reduce((total, turn) => {
      if (total >= Number.MAX_SAFE_INTEGER) return total
      return total + Math.ceil(this.countTurnChars(turn) / 4)
    }, 0)
    return estimatedTokens >= autoCompactThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private currentContextTokensWithTokenizerTail(): number {
    const providerTokens = this.providerContextTokens()
    if (providerTokens <= 0) return 0
    const settings = this.currentContextWindowSettings()
    const lastUsageIndex = this.findLastProviderUsageTurnIndex()
    if (lastUsageIndex < 0 || lastUsageIndex >= this.session.turns.length - 1) {
      return providerTokens
    }
    const tailTurns = this.session.turns.slice(lastUsageIndex + 1)
    const tailCount = countTurnishTokens(tailTurns, {
      provider: settings.provider || 'custom',
      model: settings.model,
    })
    return tailCount.source === 'unavailable' ? providerTokens : providerTokens + tailCount.tokens
  }

  private findLastProviderUsageTurnIndex(): number {
    for (let index = this.session.turns.length - 1; index >= 0; index -= 1) {
      const tokens = this.session.turns[index]?.metadata?.tokens
      if (tokens?.source === 'provider' || typeof tokens?.input === 'number') {
        return index
      }
    }
    return -1
  }

  async waitUntilIdle(): Promise<void> {
    while (this.currentRunPromise || this.contextCompactionPromise) {
      const pending = [this.currentRunPromise, this.contextCompactionPromise]
        .filter(Boolean) as Promise<unknown>[]
      await Promise.allSettled(pending)
    }
  }

  private settleRunFailure(error: unknown, workRunStarted: boolean): void {
    const errAborted = (error as { aborted?: boolean })?.aborted === true
      || this.abortController?.signal.aborted === true
    const errorAlreadyReported = (error as { alreadyReported?: boolean })?.alreadyReported === true
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const phase: AgentRunPhase = errAborted ? 'completed' : 'recoverable_error'
    const detail = errAborted ? 'Run stopped' : errorMsg
    try {
      this.setRunState(phase, { detail, recoverable: errAborted ? undefined : true })
    } catch {
      const now = Date.now()
      this.runState = {
        phase,
        startedAt: this.runState.startedAt ?? now,
        updatedAt: now,
        detail,
        recoverable: errAborted ? undefined : true,
      }
      this.workExecution.setPhase(phase, detail)
    }
    if (!errAborted && !errorAlreadyReported) {
      try { this.emit({ type: 'error', error: errorMsg }) } catch {}
    }
    this.steeringOpen = false
    try {
      this.rejectPendingSteeringMessages(errAborted
        ? 'Current run was interrupted before guidance was committed'
        : 'Current run failed before guidance was committed')
    } catch {}
    try { this.expireComputerToolPayloads() } catch {}
    if (workRunStarted) {
      const runError = error instanceof Error ? error.message : String(error)
      try {
        this.workExecution.finishRun(
          errAborted ? 'cancelled' : 'failed',
          undefined,
          errAborted ? undefined : (error as { userFacing?: boolean })?.userFacing === true ? runError : presentRequestError(runError),
          errAborted ? undefined : this.taskManager,
        )
      } catch {}
    }
    this.session.updatedAt = Date.now()
    try { this.taskManager.setCurrentWorkRunId(null) } catch {}
    try { this.subAgentTaskManager.setExecutionContext(null) } catch {}
    try { this.emitWorkExecution() } catch {}
  }

  async run(userMessage: string, options?: { reuseLastUserTurn?: boolean; attachments?: NonNullable<AgentTurn['metadata']>['attachments']; capabilities?: NonNullable<AgentTurn['metadata']>['capabilities']; userTurnId?: string }): Promise<AgentTurn[]> {
    if (this.currentRunPromise) {
      throw new Error('AgentEngine.run() called while a previous run is still in flight')
    }
    const runPromise = (async () => {
    const runAbortController = new AbortController()
    const lastTurn = this.session.turns[this.session.turns.length - 1]
    const canReuseLastUserTurn = options?.reuseLastUserTurn === true
      && lastTurn?.role === 'user'
      && lastTurn.content === userMessage

    const workRunId = options?.userTurnId || (canReuseLastUserTurn ? lastTurn.id : generateTurnId())
    const newTurns: AgentTurn[] = []
    let workRunStarted = false
    try {
      this.runControl.start(runAbortController)
      this.permissions.clearRunGrants()
      this.rejectPendingSteeringMessages('Previous run ended before guidance was committed')
      this.steeringOpen = true
      this.currentRunToolNames = []
      this.currentRunReadFiles.clear()
      this.currentRunSuccessfulReadFiles.clear()
      this.currentRunSearches.clear()
      this.currentRunSuccessfulSearches.clear()
      this.toolExecutionLedger.beginRun()
      this.conclusionGuardAttempts = 0
      this.contextLimitRetryInProgress = false
      this.providerTransientRetryAttempt = 0
      this.providerTransientRetryStartedAt = 0
      this.currentModelRequestRound = 0
      this.workspaceMemoryText = null
      this.workspaceMemoryWorkspace = null
      this.workspaceMemoryBuiltAt = 0
      this.workExecution.startRun(workRunId, userMessage)
      workRunStarted = true
      this.taskManager.setCurrentWorkRunId(workRunId)
      this.taskManager.claimRetryTasks(workRunId)
      this.subAgentTaskManager.setExecutionContext({ runId: workRunId })
      this.setRunState('thinking', { detail: 'Preparing the next step' })
      // Replay tool-call evidence from any turns we just restored so the
      // evidence guard sees prior reads/searches on the first model turn.
      this.replayEvidenceFromExistingTurns()

      let consecutiveToolErrors = 0
      const MAX_CONSECUTIVE_ERRORS = 1
      const identicalToolFailures = new Map<string, number>()
      const maxToolRounds = Number.isFinite(this.config.maxToolRounds)
        ? Math.max(1, Math.min(512, Math.floor(this.config.maxToolRounds!)))
        : DEFAULT_MAX_TOOL_ROUNDS_PER_RUN
      let toolRounds = 0

      if (!canReuseLastUserTurn) {
        const userTurn = this.createUserTurn(userMessage, options?.attachments, workRunId, options?.capabilities)
        this.appendUserTurn(userTurn, newTurns)
      } else {
        this.emit({ type: 'turn:start', turn: lastTurn })
      }

      await this.runControl.raceWithStop(this.initializeGit(), runAbortController.signal)
      if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

      while (true) {
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

        if (toolRounds >= maxToolRounds) {
          const stoppedTurn = this.createAssistantTurn(
            `Stopped after ${maxToolRounds} tool rounds in one request to prevent a runaway loop. Send a follow-up message to continue from the saved state.`,
            undefined,
            { mode: this.config.mode, interrupted: true },
          )
          this.session.turns.push(stoppedTurn)
          newTurns.push(stoppedTurn)
          this.emit({ type: 'turn:complete', turn: stoppedTurn })
          break
        }

        await this.runControl.waitIfPaused()
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()
        this.consumeSteeringMessages(newTurns)
        await this.runControl.runAcrossPause(() => this.prepareContextWindow(), runAbortController.signal)
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

        this.setRunState('thinking', { detail: 'Planning the next step' })
        const assistantTurn = await this.callModel()

        if (assistantTurn.metadata?.interruption?.kind === 'pause') {
          if (assistantTurn.content.trim() || assistantTurn.metadata.thinking?.content.trim()) {
            this.session.turns.push(assistantTurn)
            newTurns.push(assistantTurn)
            this.emit({ type: 'turn:complete', turn: assistantTurn })
          }
          await this.runControl.waitIfPaused()
          if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()
          continue
        }

        if (assistantTurn.metadata?.internalKind === 'request_error' && assistantTurn.metadata.internalError) {
          const rawError = assistantTurn.metadata.internalError
          const visibleError = presentRequestError(rawError)
          if (assistantTurn.content.trim() || assistantTurn.metadata.thinking?.content.trim()) {
            this.session.turns.push(assistantTurn)
            newTurns.push(assistantTurn)
            this.emit({ type: 'turn:complete', turn: assistantTurn })
          }
          const reported = new Error(visibleError) as Error & { alreadyReported: boolean; userFacing: boolean }
          reported.alreadyReported = true
          reported.userFacing = true
          throw reported
        }

        if (assistantTurn.toolCalls?.length) {
          assistantTurn.toolCalls = this.toolCallsBeforeUserAnswer(assistantTurn.toolCalls)
        }

        this.session.turns.push(assistantTurn)
        newTurns.push(assistantTurn)
        this.emit({ type: 'turn:complete', turn: assistantTurn })

        if (!assistantTurn.toolCalls || assistantTurn.toolCalls.length === 0) {

          if (this.consumeSteeringMessages(newTurns)) continue

          break
        }

        const semanticActivities = assistantTurn.toolCalls
          .map(toolCall => describeSemanticToolActivity(toolCall.name, toolCall.arguments, 'running'))
        const allSemanticActivities = semanticActivities.every(Boolean)
        const semanticGroup = assistantTurn.toolCalls.every(toolCall => isBuiltInBrowserTool(toolCall.name))
          ? '网页'
          : assistantTurn.toolCalls.every(toolCall => isBuiltInComputerTool(toolCall.name))
            ? '电脑'
            : '操作'
        this.setRunState('tool_running', {
          detail: allSemanticActivities
            ? semanticActivities.length === 1
              ? semanticActivities[0]!.detail
              : `正在处理 ${semanticActivities.length} 个${semanticGroup}步骤`
            : `Running ${assistantTurn.toolCalls.length} tool${assistantTurn.toolCalls.length === 1 ? '' : 's'}`,
          activeTool: assistantTurn.toolCalls[0]?.name,
        })
        const askUserCalls = assistantTurn.toolCalls.filter(toolCall => toolCall.name === 'ask_user')
        let toolResults = await this.executeToolCalls(assistantTurn.toolCalls)

        const errorCount = toolResults.filter(result => result.isError && result.errorKind !== 'abort').length
        if (errorCount > 0) {
          consecutiveToolErrors++
          if (consecutiveToolErrors >= MAX_CONSECUTIVE_ERRORS) {
            const retryHint = this.buildToolRetryHint(assistantTurn.toolCalls!, toolResults)
            if (retryHint) {
              toolResults = this.attachToolRetryHint(toolResults, retryHint)
              consecutiveToolErrors = 0
            }
          }
        } else {
          consecutiveToolErrors = Math.max(0, consecutiveToolErrors - 1)
        }
        let repeatedFailure: { toolCall: ToolCall; result: ToolResult; count: number } | null = null
        for (const toolCall of assistantTurn.toolCalls) {
          const result = toolResults.find(item => item.toolCallId === toolCall.id)
          if (!result?.isError) continue
          const deterministicFailure = result.errorKind === 'validation'
            || /^\[reused: identical .* call already failed/i.test(result.output)
          if (!deterministicFailure) continue
          const signature = toolCallSignature(toolCall)
          const count = (identicalToolFailures.get(signature) || 0) + 1
          identicalToolFailures.set(signature, count)
          if (count >= MAX_IDENTICAL_TOOL_FAILURES) repeatedFailure = { toolCall, result, count }
        }
        const resultTurn = this.createToolResultTurn(toolResults)
        this.session.turns.push(resultTurn)
        newTurns.push(resultTurn)
        toolRounds += 1

        if (repeatedFailure) {
          const lastError = repeatedFailure.result.output
            .replace(/\s+/g, ' ')
            .slice(0, 300)
          const stoppedTurn = this.createAssistantTurn(
            `Stopped a repeated tool-call loop after ${repeatedFailure.count} identical failures of \`${repeatedFailure.toolCall.name}\`. Last error: ${lastError}`,
            undefined,
            { mode: this.config.mode, interrupted: true },
          )
          this.session.turns.push(stoppedTurn)
          newTurns.push(stoppedTurn)
          this.emit({ type: 'turn:complete', turn: stoppedTurn })
          break
        }

          if (askUserCalls.length > 0) {
            const responses: string[] = []
            for (const askUserCall of askUserCalls) {
              const resolved = this.resolvedAskUserResponses.get(askUserCall.id)
              if (resolved !== undefined) {
                this.resolvedAskUserResponses.delete(askUserCall.id)
                responses.push(resolved)
              } else if (this.interactiveRequests.has(askUserCall.id)) {
                responses.push(await this.interactiveRequests.wait(askUserCall.id))
              } else {
                const toolResult = toolResults.find(result => result.toolCallId === askUserCall.id)
                responses.push(toolResult?.output.replace(/^\[User response\]\s*/, '') || 'deny')
              }
          }
          const responseTurn = this.createUserTurn(responses.join('\n\n'))
          this.appendUserTurn(responseTurn, newTurns)
          continue
        }
      }

      this.steeringOpen = false
      this.rejectPendingSteeringMessages('Current turn finished before guidance was committed')
      this.session.updatedAt = Date.now()
      const lastAssistantTurn = [...newTurns].reverse().find(turn => turn.role === 'assistant')
      const internallyInterrupted = lastAssistantTurn?.metadata?.interrupted === true
      // A normal model conclusion is an explicit run-level success signal.
      // Settle open leaves then; loop guards and other interrupted conclusions
      // deliberately leave them open so the run remains partial and retryable.
      const finalized = internallyInterrupted ? [] : this.taskManager.finalizeOrphanedLeaves(workRunId)
      if (finalized.length > 0) {
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
      }
      await this.runControl.runAcrossPause(() => this.prepareContextWindow(), runAbortController.signal)
      if (runAbortController.signal.aborted && lastAssistantTurn?.metadata?.interrupted !== true) {
        throw this.runControl.createStopInterruption()
      }
      this.expireComputerToolPayloads()
      const tasks = this.taskManager.getTasksForWorkRun(workRunId)
      const cancelledTasks = tasks.filter(task => task.metadata?.workControlOutcome === 'cancel')
      const failedTasks = tasks.filter(task => task.status === 'failed' && task.metadata?.workControlOutcome !== 'cancel')
      const unfinishedTasks = tasks.filter(task => task.status === 'pending' || task.status === 'in_progress')
      const successfulTasks = tasks.filter(task => task.status === 'completed')
      const workStatus = cancelledTasks.length > 0
        ? successfulTasks.length > 0 ? 'partial' : 'cancelled'
        : failedTasks.length > 0
        ? successfulTasks.length > 0 ? 'partial' : 'failed'
        : internallyInterrupted || unfinishedTasks.length > 0 ? 'partial' : 'completed'
      this.workExecution.finishRun(workStatus, lastAssistantTurn?.content, failedTasks[0]?.error)
      this.taskManager.setCurrentWorkRunId(null)
      this.subAgentTaskManager.setExecutionContext(null)
      this.emitWorkExecution()
      this.emit({ type: 'session:complete', session: this.session })
      this.setRunState('completed', { detail: 'Run completed' })
      return redactComputerTurns(newTurns)
    } catch (error) {
      this.settleRunFailure(error, workRunStarted)
      throw error
    } finally {
      try { this.permissions.clearRunGrants() } catch {}
      this.steeringOpen = false
      try { this.rejectPendingSteeringMessages('Current run ended before guidance was committed') } catch {}
      try { this.taskManager.setCurrentWorkRunId(null) } catch {}
      try { this.subAgentTaskManager.setExecutionContext(null) } catch {}
    }
    })()
    this.currentRunPromise = runPromise
    // Always release the slot once the run settles, even on rejection.
    void runPromise.catch(() => { /* surfaced via emit + caller try/catch */ }).finally(() => {
      if (this.currentRunPromise === runPromise) {
        this.currentRunPromise = null
        this.pausedResumeState = null
        this.runControl.finish()
      }
    })
    return runPromise
  }

  /**
   * Check if the session is approaching the context window limit.
   * If so, generate a model-produced continuation summary and emit a
   * context:segment_created event so the store can persist it.
   *
   * The user never sees a conversation break — they can still scroll back,
   * edit old messages, and continue from compacted context.
   */
  private async ensureContextWindow(force = false): Promise<void> {
    const activeConfig = this.stateProvider.getActiveConfig()
    if (!force) return

    if (activeConfig?.apiKey && this.contextManager.getLastProviderUsage().source === 'provider') {
      this.emit({
        type: 'notification',
        message: 'Context usage is high; compacting older conversation before the next model call.',
        level: 'info',
      })
    }

    await this.performContextCompaction('compact')
  }

  private async performContextCompaction(source: ContextReservoirEntry['source']): Promise<boolean> {
    if (this.contextCompactionPromise) return this.contextCompactionPromise
    const promise = this.performContextCompactionInternal(
      source,
      Boolean(this.currentRunPromise) && this.runState.phase !== 'completed',
    )
    this.contextCompactionPromise = promise
    try {
      return await promise
    } finally {
      if (this.contextCompactionPromise === promise) this.contextCompactionPromise = null
    }
  }

  private async performContextCompactionInternal(
    source: ContextReservoirEntry['source'],
    partOfRun: boolean,
  ): Promise<boolean> {
    const keepRecent = resolveContextPolicyProfile(this.config.contextPolicy).keepRecentTurns
    const plan = planContextCompaction({
      turns: this.session.turns,
      keepRecent,
      segments: this.stateProvider.getContextSegments(),
      countTurnChars: turn => this.countTurnChars(turn),
    })
    if (!plan) return false
    const {
      oldTurns,
      recentTurns,
      startMessageId,
      endMessageId,
      originalCharCount,
      existingSegment,
    } = plan

    const compactionId = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    this.contextCompactionAbortController = new AbortController()
    const unlinkOperation = partOfRun
      ? this.runControl.linkOperation(this.contextCompactionAbortController)
      : () => undefined
    this.contextCompactionState = {
      id: compactionId,
      phase: 'started',
      source,
      startedAt,
      updatedAt: startedAt,
      elapsedMs: 0,
      startMessageId,
      endMessageId,
      oldTurnCount: oldTurns.length,
      originalCharCount,
      progress: 0,
      recoverable: true,
    }
    this.stateProvider.setContextCompactionState?.({ ...this.contextCompactionState })
    this.emit({ type: 'context:compaction_started', state: this.getContextCompactionState()! })
    this.startContextCompactionHeartbeat()
    if (partOfRun) this.setRunState('compacting', { detail: 'Preparing a durable context handoff' })

    const signal = this.contextCompactionAbortController.signal
    try {
      this.updateContextCompactionState('summarizing', {
        progress: 0.12,
        detail: existingSegment ? 'Restoring the previous handoff' : 'Summarizing older turns',
      }, 'context:compaction_summarizing')
      const previousHandoff = this.getLatestContextHandoff()
      const workspace = await this.collectContinuationWorkspaceSnapshot()
      if (signal.aborted) throw this.createContextCompactionAbortError()
      const facts = collectContinuationHandoffFacts(oldTurns, recentTurns, workspace, previousHandoff?.facts)
      const summaryResult = existingSegment
        ? { text: existingSegment.summary, source: 'reused' as const }
        : await this.generateContinuationSummary(oldTurns, recentTurns, workspace, previousHandoff, facts)
      if (signal.aborted) throw this.createContextCompactionAbortError()
      if (summaryResult.source === 'deterministic') {
        this.updateContextCompactionState('fallback', {
          progress: 0.58,
          summarySource: summaryResult.source,
          detail: 'Model summary unavailable; using deterministic handoff',
        }, 'context:compaction_fallback')
      }

      let nextSegment = existingSegment
      if (!existingSegment) {
        const handoff = buildContextHandoff({
          oldTurns,
          recentTurns,
          workspace,
          previous: previousHandoff,
          modelSummary: summaryResult.text,
          startMessageId,
          endMessageId,
          source,
          summarySource: summaryResult.source,
          facts,
        })
        nextSegment = {
          startMessageId,
          endMessageId,
          summary: summaryResult.text,
          isModelGenerated: summaryResult.source === 'model',
          kind: 'compact',
          originalCharCount,
          isValid: true,
          createdAt: Date.now(),
          coveredTurnIds: oldTurns.map(turn => turn.id),
          handoff,
        }
      } else if (!existingSegment.handoff) {
        const handoff = buildContextHandoff({
          oldTurns,
          recentTurns,
          workspace,
          previous: previousHandoff,
          modelSummary: existingSegment.summary,
          startMessageId,
          endMessageId,
          source,
          summarySource: 'reused',
          facts,
        })
        nextSegment = { ...existingSegment, handoff }
      }

      this.updateContextCompactionState('committing', {
        progress: 0.72,
        summarySource: summaryResult.source,
        detail: 'Writing the compacted context checkpoint',
      }, 'context:compaction_committing')
      if (signal.aborted) throw this.createContextCompactionAbortError()

      if (!existingSegment || !existingSegment.handoff) {
        this.stateProvider.setContextSegments(this.stateProvider.getContextSegments().map(segment =>
          segment.startMessageId === startMessageId && segment.endMessageId === endMessageId
            ? nextSegment!
            : segment
        ).concat(existingSegment ? [] : [nextSegment!]))
        this.emit({ type: 'context:segment_created', segment: nextSegment! })
      }

      this.addReservoirEntry(startMessageId, endMessageId, oldTurns, source, originalCharCount)
      this.preservedFiles = this.collectPreservedFiles(oldTurns)

      const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
      this.session.turns = [...systemTurns, ...recentTurns]
      this.modelSurface.replaceConversationTurns(this.session.turns, 'context_compaction')
      this.session.modelSurface = this.modelSurface.getState()
      this.contextManager.reset()
      this.cacheMonitor.resetBaseline()
      this.updateContextCompactionState('completed', {
        progress: 1,
        summarySource: summaryResult.source,
        detail: 'Context handoff committed; original turns remain in history',
        recoverable: false,
      }, 'context:compaction_completed')
      if (partOfRun) this.setRunState('thinking', { detail: 'Continuing after context compaction' })
      return true
    } catch (error) {
      const interrupted = signal.aborted || (error as { aborted?: boolean })?.aborted === true
      const paused = this.runControl.isPauseSignal(signal) || this.runControl.isPauseInterruption(error)
      const message = error instanceof Error ? error.message : String(error)
      this.updateContextCompactionState(interrupted ? 'interrupted' : 'failed', {
        detail: interrupted ? 'Compaction interrupted; original turns were preserved' : 'Compaction failed; retry is available',
        error: interrupted ? undefined : message.slice(0, 500),
        recoverable: true,
      }, interrupted ? 'context:compaction_interrupted' : 'context:compaction_failed')
      if (interrupted && partOfRun) {
        if (!paused) this.setRunState('aborting', { detail: 'Context compaction interrupted; original turns preserved' })
      }
      if (paused) throw signal.reason instanceof Error ? signal.reason : createAgentRunInterruption('pause')
      if (interrupted) throw this.createContextCompactionAbortError()
      throw error
    } finally {
      unlinkOperation()
      this.stopContextCompactionHeartbeat()
      this.contextCompactionAbortController = null
    }
  }

  private updateContextCompactionState(
    phase: ContextCompactionState['phase'],
    patch: Partial<ContextCompactionState>,
    eventType: Extract<AgentEventType, { type: `context:compaction_${string}` }>['type'],
  ): void {
    const current = this.contextCompactionState
    if (!current) return
    const updatedAt = Date.now()
    const next: ContextCompactionState = {
      ...current,
      ...patch,
      phase,
      updatedAt,
      elapsedMs: Math.max(0, updatedAt - current.startedAt),
    }
    this.contextCompactionState = next
    this.stateProvider.setContextCompactionState?.({ ...next })
    this.emit({ type: eventType, state: { ...next } } as AgentEventType)
  }

  private startContextCompactionHeartbeat(): void {
    this.stopContextCompactionHeartbeat()
    this.contextCompactionHeartbeat = setInterval(() => {
      const phase = this.contextCompactionState?.phase
      if (!phase || ['completed', 'interrupted', 'failed'].includes(phase)) return
      this.updateContextCompactionState(phase, {}, 'context:compaction_progress')
    }, 1500)
  }

  private stopContextCompactionHeartbeat(): void {
    if (this.contextCompactionHeartbeat) clearInterval(this.contextCompactionHeartbeat)
    this.contextCompactionHeartbeat = null
  }

  private createContextCompactionAbortError(): Error & { aborted: boolean } {
    const error = new Error('Context compaction aborted') as Error & { aborted: boolean }
    error.aborted = true
    return error
  }

  private createPausedAssistantTurn(
    textContent: string,
    reasoningContent: string,
    model: APIModel | null,
    startTime: number,
  ): AgentTurn {
    const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
      || this.createAssistantTurn('', undefined, {
        model: model?.name,
        duration: Date.now() - startTime,
        mode: this.config.mode,
        interrupted: true,
      })
    interruptedTurn.metadata = {
      ...interruptedTurn.metadata,
      interrupted: true,
      interruption: interruptionMetadata('pause'),
    }
    return interruptedTurn
  }

  /**
   * Ask the model to generate a continuation summary for the next context window.
   * This is a hidden API call — the user does not see it as a regular message.
   */
  private getLatestContextHandoff(): ContextHandoff | null {
    return this.stateProvider.getContextSegments()
      .filter(segment => segment.isValid && segment.handoff)
      .sort((a, b) => (b.handoff?.createdAt ?? b.createdAt ?? 0) - (a.handoff?.createdAt ?? a.createdAt ?? 0))[0]?.handoff ?? null
  }

  private async collectContinuationWorkspaceSnapshot(): Promise<ContinuationWorkspaceSnapshot> {
    const workspacePath = this.config.workspacePath || ''
    await Promise.all([
      workspacePath ? this.maybeBuildWorkspaceSkeleton(workspacePath) : Promise.resolve(),
      this.maybeRefreshWorkspaceMemory(),
      this.gitState.enabled ? this.refreshGitStatus() : Promise.resolve(),
    ])
    return {
      workspacePath,
      workspaceSkeleton: this.workspaceSkeleton,
      gitStatus: this.cachedGitStatus,
      workspaceMemory: this.workspaceMemoryText,
      taskTree: this.taskManager.getFullTree(),
      activeTask: this.taskManager.getActiveTaskContext(),
    }
  }

  private async generateContinuationSummary(
    oldTurns: AgentTurn[],
    recentTurns: AgentTurn[],
    workspace: ContinuationWorkspaceSnapshot,
    previousHandoff: ContextHandoff | null,
    facts: ContextHandoffFacts,
  ): Promise<{ text: string; source: 'model' | 'deterministic' }> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const deterministic = (): { text: string; source: 'deterministic' } => ({
      text: buildDeterministicContinuationSummary(facts, previousHandoff?.modelSummary),
      source: 'deterministic',
    })

    if (!activeConfig || !activeConfig.apiKey) return deterministic()

    const evidence = buildContinuationEvidence(oldTurns, recentTurns, workspace, previousHandoff)
    const anchors = buildContinuationSummaryAnchors(facts)
    const summaryMaxTokens = continuationSummaryTokenBudget(
      evidence.length,
      this.config.contextPolicy,
      this.config.contextPolicy === 'qualityFirst' ? 8_000 : 6_000,
    )

    try {
      const firstCandidate = await this.requestContinuationSummary(
        activeConfig,
        buildContinuationSummaryPrompt(evidence),
        summaryMaxTokens,
      )
      let validation = validateContinuationSummary(firstCandidate, anchors)
      if (!validation.valid) {
        const repaired = await this.requestContinuationSummary(
          activeConfig,
          buildContinuationSummaryPrompt(evidence, `${firstCandidate.slice(0, 20_000)}\nMissing requirements: ${validation.missing.join(', ')}`),
          summaryMaxTokens,
        )
        validation = validateContinuationSummary(repaired, anchors)
      }
      if (validation.valid) return { text: validation.text, source: 'model' }
    } catch (error) {
      if (this.contextCompactionAbortController?.signal.aborted || (error as { aborted?: boolean })?.aborted === true) {
        throw this.createContextCompactionAbortError()
      }
      return deterministic()
    }
    return deterministic()
  }

  private async requestContinuationSummary(config: APIConfig, prompt: string, maxTokens: number): Promise<string> {
    const protocols = planModelProtocols(config.provider, config.defaultModel, config.modelCapabilities?.supportedEndpoints)
    const attempts: ModelProtocolAttempt[] = []
    for (const protocol of protocols) {
      const url = buildModelProtocolUrl(config.baseUrl, protocol, config.provider)
      const headers = createTurboFluxRequestHeaders(protocol === 'anthropic_messages'
        ? {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            ...(config.provider === 'anthropic' ? {} : { Authorization: `Bearer ${config.apiKey}` }),
            ...config.customHeaders,
          }
        : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
            ...config.customHeaders,
          })
      if (config.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://turboflux.dev'
        headers['X-Title'] = 'Turboflux'
      }

      const coldBody = protocol === 'anthropic_messages'
        ? {
            model: config.defaultModel,
            system: CONTINUATION_SUMMARY_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
          }
        : protocol === 'openai_responses'
          ? {
              model: config.defaultModel,
              instructions: CONTINUATION_SUMMARY_SYSTEM_PROMPT,
              input: toResponsesInput([{ role: 'user', content: prompt }]),
              max_output_tokens: maxTokens,
              store: false,
            }
          : {
              model: config.defaultModel,
              messages: [
                { role: 'system', content: CONTINUATION_SUMMARY_SYSTEM_PROMPT },
                { role: 'user', content: prompt },
              ],
              max_tokens: maxTokens,
              stream: false,
            }
      const warmPrefix = this.warmRequestPrefixes.get(protocol)
      const body = warmPrefix
        ? this.buildWarmContinuationBody(warmPrefix.body, protocol, prompt, maxTokens, config)
        : coldBody

      if (protocol === 'openai_chat') {
        setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel)
      }

      const result = await this.toolExecutor.sendMessage(url, headers, JSON.stringify(body), {
        signal: this.contextCompactionAbortController?.signal || this.abortController?.signal,
        timeoutMs: CONTEXT_COMPACTION_REQUEST_TIMEOUT_MS,
      })
      if (result.success && result.data) {
        const text = extractContinuationText(protocol, result.data)
        if (text.trim()) return text
        const shapeError = new ModelProtocolRequestError('Continuation summary response omitted text content', {
          protocol,
          url,
          kind: 'response_shape',
        })
        attempts.push(toProtocolAttempt(shapeError))
        continue
      }

      const error = new ModelProtocolRequestError(result.error || 'Continuation summary request failed', {
        protocol,
        url,
        status: result.status,
        retryAfterMs: result.retryAfterMs,
      })
      attempts.push(toProtocolAttempt(error))
      if (!shouldFallbackProtocol(error)) break
    }
    throw new Error(formatProtocolFailure(attempts))
  }

  private buildWarmContinuationBody(
    prefix: Record<string, unknown>,
    protocol: ModelProtocol,
    prompt: string,
    maxTokens: number,
    config: APIConfig,
  ): Record<string, unknown> {
    const body = JSON.parse(JSON.stringify(prefix)) as Record<string, unknown>
    if (protocol === 'anthropic_messages') {
      body.messages = [...((body.messages as unknown[]) || []), { role: 'user', content: prompt }]
      body.max_tokens = maxTokens
    } else if (protocol === 'openai_responses') {
      body.input = [...((body.input as unknown[]) || []), ...toResponsesInput([{ role: 'user', content: prompt }])]
      body.max_output_tokens = maxTokens
      body.store = false
    } else {
      body.messages = [...((body.messages as unknown[]) || []), { role: 'user', content: prompt }]
      setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel)
      delete body.stream_options
    }
    body.stream = false
    return body
  }

  private rememberWarmRequestPrefix(protocol: ModelProtocol, body: Record<string, unknown>): void {
    this.warmRequestPrefixes.set(protocol, {
      protocol,
      body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
    })
  }

  private countTurnChars(turn: AgentTurn): number {
    return countTurnContextChars(turn)
  }

  private collectPreservedFiles(turns: AgentTurn[]): Array<{ path: string; content: string }> {
    const pathByToolCallId = new Map<string, string>()
    for (const turn of turns) {
      if (turn.role !== 'assistant' || !turn.toolCalls) continue
      for (const call of turn.toolCalls) {
        if ((call.name === 'read_file' || call.name === 'read_file_full') && typeof call.arguments.path === 'string') {
          pathByToolCallId.set(call.id, call.arguments.path)
        }
      }
    }

    const preserved: Array<{ path: string; content: string }> = []
    const seenPaths = new Set<string>()
    const maxFiles = 5
    const maxChars = 20_000
    for (let index = turns.length - 1; index >= 0 && preserved.length < maxFiles; index -= 1) {
      const turn = turns[index]
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        if (result.name !== 'read_file' && result.name !== 'read_file_full') continue
        const path = pathByToolCallId.get(result.toolCallId)
        if (!path || seenPaths.has(path)) continue
        seenPaths.add(path)
        const content = result.output.length > maxChars
          ? `${result.output.slice(0, maxChars)}\n<recent_file_truncated />`
          : result.output
        preserved.push({ path, content })
        if (preserved.length >= maxFiles) break
      }
    }
    return preserved.reverse()
  }

  private addReservoirEntry(
    startMessageId: string,
    endMessageId: string,
    turns: AgentTurn[],
    source: ContextReservoirEntry['source'],
    originalCharCount = turns.reduce((sum, turn) => sum + this.countTurnChars(turn), 0),
  ): void {
    if (turns.length === 0) return
    this.stateProvider.addContextReservoirEntry({
      id: `reservoir-${startMessageId}-${endMessageId}`,
      startMessageId,
      endMessageId,
      turns: turns.map(turn => ({ ...turn })),
      source,
      originalCharCount,
      createdAt: Date.now(),
    })
    this.pruneContextReservoir()
  }

  private pruneContextReservoir(): void {
    const MAX_ENTRIES = 24
    const MAX_CHARS = 2_500_000
    const entries = this.stateProvider.getContextReservoir()
      .slice()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const kept: ContextReservoirEntry[] = []
    let totalChars = 0
    for (const entry of entries) {
      const chars = entry.originalCharCount || entry.turns.reduce((sum, turn) => sum + this.countTurnChars(turn), 0)
      if (kept.length >= MAX_ENTRIES || totalChars + chars > MAX_CHARS) continue
      kept.push(entry)
      totalChars += chars
    }
    this.stateProvider.setContextReservoir(kept.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)))
  }

  private buildToolRetryHint(failedToolCalls: ToolCall[], toolResults: ToolResult[]): string | null {
    const errors = toolResults.filter(r => r.isError)
    if (errors.length === 0) return null

    const errorSummary = errors.map(e => `- ${e.name}: ${e.output.slice(0, 120)}`).join('\n')
    const toolNames = [...new Set(failedToolCalls.map(tc => tc.name))].join(', ')
    const editMatchFailed = errors.some(e =>
      (e.name === 'edit_file' || e.name === 'multi_edit')
      && /(old_string not found|found \d+ occurrences|Match must be exact|multi_edit is atomic)/i.test(e.output)
    )
    const editGuidance = editMatchFailed
      ? `
Exact edit matching failed. Do not retry another similar edit_file/multi_edit call against the same snippet.
Use one of these safer paths:
- For small changes: read the nearest surrounding lines, then use a longer unique old_string with stable context.
- For broad or fragile changes: use replace_file with the complete final file content.
`
      : ''
    const directoryGuidance = errors.some(error => error.name === 'list_directory')
      ? '\nFor list_directory, pass a directory path. Use {"path":"."} for the workspace root; never pass an empty path.\n'
      : ''
    const searchGuidance = errors.some(error => error.name === 'search_content')
      ? '\nFor search_content, path is a directory. To search one file, use {"path":".","file_pattern":"package.json","pattern":"..."}.\n'
      : ''
    return `<tool_retry_hint>
The last tool call(s) failed: ${toolNames}.
Errors:
${errorSummary}
${editGuidance}
${directoryGuidance}${searchGuidance}

Before retrying:
1. Identify the root cause of each failure (wrong path? missing file? syntax error?)
2. Propose a concrete alternative approach — do NOT repeat the same failing call
3. If a file path was wrong, use search_files or list_directory to find the correct path first
4. If the error is environmental (missing dependency, permission), report it to the user instead of retrying
5. After fixing the approach, re-attempt with corrected parameters
</tool_retry_hint>`
  }

  private attachToolRetryHint(toolResults: ToolResult[], retryHint: string): ToolResult[] {
    let targetIndex = -1
    for (let index = toolResults.length - 1; index >= 0; index -= 1) {
      if (!toolResults[index]?.isError) continue
      targetIndex = index
      break
    }
    if (targetIndex < 0) return toolResults
    return toolResults.map((result, index) => index === targetIndex
      ? { ...result, output: `${result.output}\n\n${retryHint}` }
      : result)
  }

  private async captureBeforeSnapshot(filePath: string): Promise<void> {
    if (this.fileBeforeSnapshots.has(filePath)) return
    try {
      const readResult = await this.toolExecutor.readFile(filePath)
      this.fileBeforeSnapshots.set(filePath, readResult.success ? (readResult.data ?? null) : null)
    } catch {
      this.fileBeforeSnapshots.set(filePath, null)
    }
  }

  private buildDiffSnapshot(before: string, after: string): Partial<ChangeSummary> {
    if (!canComputeDiff(before, after)) {
      return {
        diffStatus: 'snapshot-too-large',
        beforeBytes: before.length,
        afterBytes: after.length,
      }
    }
    const stats = summarizeHunks(computeHunks(before, after))
    return {
      diffStatus: 'complete',
      beforeBytes: before.length,
      afterBytes: after.length,
      addedLines: stats.added,
      removedLines: stats.removed,
      before,
      after,
    }
  }

  private shouldRetryModelTransient(error: ModelProtocolRequestError): boolean {
    if (error.receivedStreamData || error.kind === 'stream' || error.kind === 'response_shape') return false
    const retryStartedAt = this.providerTransientRetryStartedAt
    const withinBudget = retryStartedAt > 0 && Date.now() - retryStartedAt < MODEL_TRANSIENT_RETRY_BUDGET_MS
    if (!withinBudget) return false
    if (error.kind === 'network') {
      return this.providerTransientRetryAttempt < MODEL_TRANSIENT_RETRY_DELAYS_MS.length
    }
    const transientStatus = error.status !== undefined && (
      MODEL_TRANSIENT_RETRYABLE_STATUSES.has(error.status)
      || (error.status >= 500 && error.status <= 599)
    )
    return transientStatus && this.providerTransientRetryAttempt < MODEL_TRANSIENT_RETRY_DELAYS_MS.length
  }

  private async waitForModelTransientRetry(error: ModelProtocolRequestError): Promise<void> {
    const retryAttempt = this.providerTransientRetryAttempt + 1
    this.providerTransientRetryAttempt = retryAttempt
    const configuredDelay = MODEL_TRANSIENT_RETRY_DELAYS_MS[retryAttempt - 1]
      ?? MODEL_TRANSIENT_RETRY_DELAYS_MS.at(-1)
      ?? 1_000
    const delayMs = Math.min(
      MAX_MODEL_TRANSIENT_RETRY_DELAY_MS,
      Math.max(configuredDelay, error.retryAfterMs ?? 0),
    )
    const retryStartedAt = this.providerTransientRetryStartedAt || Date.now()
    const remainingBudgetMs = Math.max(0, MODEL_TRANSIENT_RETRY_BUDGET_MS - (Date.now() - retryStartedAt))
    const boundedDelayMs = Math.min(delayMs, Math.max(0, remainingBudgetMs - 1))
    const maxRetries = MODEL_TRANSIENT_RETRY_DELAYS_MS.length
    const signal = this.runControl.getOperationSignal()
    const protocol = protocolLabel(error.protocol)
    const reason = error.status !== undefined
      ? `HTTP ${error.status}`
      : error.kind === 'network' ? 'network interruption' : 'temporary provider failure'

    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      let notified = false
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = null
        signal?.removeEventListener('abort', onAbort)
      }
      const abort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(this.runControl.isPauseInterruption(signal?.reason) ? signal!.reason : this.runControl.createStopInterruption())
      }
      const onAbort = () => abort()
      const tick = () => {
        if (settled) return
        if (signal?.aborted) {
          abort()
          return
        }
        const remainingMs = Math.max(0, boundedDelayMs - (Date.now() - startedAt))
        if (remainingMs === 0) {
          settled = true
          cleanup()
          resolve()
          return
        }
        const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1_000))
        const detail = error.status === 429
          ? `Provider rate limited ${protocol}; retrying the same protocol in ${remainingSeconds}s (attempt ${retryAttempt}/${maxRetries}).`
          : `Provider returned ${reason} from ${protocol}; retrying the same protocol in ${remainingSeconds}s (attempt ${retryAttempt}/${maxRetries}).`
        this.setRunState('thinking', { detail })
        if (!notified) {
          notified = true
          this.emit({ type: 'notification', message: detail, level: 'warning' })
        }
        timer = setTimeout(tick, Math.min(1_000, remainingMs))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      tick()
    })
  }

  private async callModel(): Promise<AgentTurn> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()

    if (!activeConfig || !activeConfig.apiKey) {
      return this.createMockTurn()
    }

    this.ensureScheduledWorkStep()

    const turnStrategy = this.turnStrategyPlanner.plan(this.session, this.config.mode)
    this.currentTurnStrategy = turnStrategy
    const currentUserTurn = [...this.session.turns].reverse().find(turn => turn.role === 'user')
    const needsRuntimePreparation = typeof currentUserTurn?.metadata?.runtimeContext !== 'string'
    if (needsRuntimePreparation) {
      await Promise.all([
        this.maybeRefreshWorkspaceMemory(),
        this.refreshGitStatus(),
      ])
    }
    // Long-conversation persona drift reminder — empty string when below threshold.
    const voiceReminderContext: string | null = null
    const selectedCapabilities = currentUserTurn?.metadata?.capabilities?.items || []
    const capabilityContext = selectedCapabilities.length > 0
      ? this.wrapRuntimeContextSection('emphasized_capabilities', [
          'All installed Skills and connected plugins remain available. The user emphasized these capabilities for this turn, so prefer them when relevant without treating unlisted capabilities as unavailable:',
          ...selectedCapabilities.map(item => `- ${item.type === 'skill' ? 'Skill' : 'Plugin'}: ${item.name} (${item.id})`),
        ].join('\n'))
      : null
    const runtimeContextCandidate = [
      this.config.appendSystemPrompt,
      capabilityContext,
      voiceReminderContext,
      this.cachedGitStatus ? this.wrapRuntimeContextSection('git_status', this.cachedGitStatus) : null,
      this.workspaceMemoryText ? this.wrapRuntimeContextSection('workspace_memory', this.workspaceMemoryText) : null,
    ].filter(Boolean).join('\n\n') || undefined
    this.captureRuntimeContext(currentUserTurn, runtimeContextCandidate || '')

    const systemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      systemPromptOverride: this.config.systemPromptOverride,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      activatedSkills: [...this.activatedRunSkills.values()],
      provider: activeConfig.provider,
      modelId: activeConfig.defaultModel,
      shell: this.config.shell,
    })

    const startTime = Date.now()
    this.providerTransientRetryAttempt = 0
    this.providerTransientRetryStartedAt = startTime
    const protocolCandidates = planModelProtocols(
      activeConfig.provider,
      activeConfig.defaultModel,
      activeConfig.modelCapabilities?.supportedEndpoints,
    )
    const preservedFiles = this.preservedFiles.map(file => ({ ...file }))
    const requestSurfaceTurns = this.prepareModelSurfaceForRequest(activeConfig, activeModel, preservedFiles)
    const messagesByProvider = new Map<'openai' | 'anthropic', Array<Record<string, unknown>>>()
    const messagesFor = (provider: 'openai' | 'anthropic') => {
      const cached = messagesByProvider.get(provider)
      if (cached) return cached
      const messages = this.buildApiMessages(systemPrompt, provider, requestSurfaceTurns)
      messagesByProvider.set(provider, messages)
      return messages
    }
    if (preservedFiles.length > 0) {
      this.preservedFiles = []
      this.modelSurface.appendSnapshot('compaction_files', null)
      this.session.modelSurface = this.modelSurface.getState()
    }

    try {
      const turn = await runModelRequest({
        protocols: protocolCandidates,
        urlFor: protocol => buildModelProtocolUrl(activeConfig.baseUrl, protocol, activeConfig.provider),
        invoke: async protocol => {
          if (protocol === 'anthropic_messages') {
            const messages = messagesFor('anthropic')
            const effectiveSystemPrompt = messages.find(m => m.role === 'system' && typeof m.content === 'string')?.content as string | undefined
            return this.callAnthropicAPI(activeConfig, activeModel, effectiveSystemPrompt || systemPrompt, messages, startTime, turnStrategy)
          }
          if (protocol === 'openai_responses') {
            return this.callOpenAIResponsesAPI(activeConfig, activeModel, messagesFor('openai'), startTime, turnStrategy)
          }
          return this.callOpenAICompatibleAPI(activeConfig, activeModel, messagesFor('openai'), startTime, turnStrategy)
        },
        isAborted: error => (error as { aborted?: boolean })?.aborted === true
          || this.abortController?.signal.aborted === true
          || this.runControl.isPauseInterruption(error),
        shouldRetry: error => this.shouldRetryModelTransient(error),
        waitForRetry: error => this.waitForModelTransientRetry(error),
        onAttempt: (protocol, url) => {
          this.emit({ type: 'model:protocol', phase: 'attempt', protocol, url })
        },
        onSuccess: (protocol, url) => {
          this.emit({ type: 'model:protocol', phase: 'success', protocol, url })
          this.providerTransientRetryAttempt = 0
          this.providerTransientRetryStartedAt = 0
        },
        onFallback: ({ nextProtocol, nextUrl, message }) => {
          this.emit({ type: 'stream:end' })
          this.emit({
            type: 'model:protocol',
            phase: 'fallback',
            protocol: nextProtocol,
            url: nextUrl,
            message,
          })
        },
      })
      return turn
    } catch (error) {
      if (this.runControl.isPauseInterruption(error)) {
        return this.createPausedAssistantTurn('', '', activeModel, startTime)
      }
      const errAborted = (error as { aborted?: boolean })?.aborted === true
        || this.abortController?.signal.aborted === true
      if (errAborted) {
        throw error
      }
      const errorMsg = error instanceof Error ? error.message : 'API call failed'
      if (this.isContextLimitError(errorMsg) && !this.contextLimitRetryInProgress) {
        this.contextLimitRetryInProgress = true
        this.forceContextCompactionBeforeNextCall = true
        this.emit({
          type: 'notification',
          message: 'Provider reported context limit; compacting conversation and retrying once.',
          level: 'warning',
        })
        await this.prepareContextWindow()
        return this.callModel()
      }
      this.emit({ type: 'error', error: errorMsg })
      return this.createAssistantTurn(`**Request Error**\n\n${errorMsg}`, undefined, {
        internal: true,
        internalKind: 'request_error',
        internalError: errorMsg,
      })
    }
  }

  private nextModelRequestTraceHeaders(protocol: ModelProtocol): Record<string, string> {
    this.currentModelRequestRound += 1
    const conversationId = this.config.conversationId || this.stateProvider.getConversationId()
    const workRunId = this.workExecution.getCurrentRunId()
    return {
      ...(conversationId ? { 'x-turboflux-conversation-id': conversationId } : {}),
      ...(workRunId ? { 'x-turboflux-run-id': workRunId } : {}),
      'x-turboflux-round': String(this.currentModelRequestRound),
      'x-turboflux-protocol': protocol,
    }
  }

  private async callAnthropicAPI(
    config: APIConfig,
    model: APIModel | null,
    systemPrompt: string,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const url = buildModelProtocolUrl(config.baseUrl, 'anthropic_messages', config.provider)
    // Bug 3 fix: token-efficient-tools-2025-02-19 is a Claude 3.7 Sonnet
    // beta. Sonnet 3.5 / Sonnet 4 / Opus 4 / Haiku-3 reject the header on
    // some baseUrl proxies and the request 4xx's. Only opt in for models
    // that documented support, and let custom headers from the caller win
    // so power users can still force it on or off explicitly.
    const modelId = (config.defaultModel || '').toLowerCase()
    const supportsTokenEfficientTools = (
      modelId.includes('claude-3-7') || modelId.includes('claude-3.7')
    )
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...(config.provider === 'anthropic' ? {} : { 'Authorization': `Bearer ${config.apiKey}` }),
      ...(supportsTokenEfficientTools
        ? { 'anthropic-beta': 'token-efficient-tools-2025-02-19' }
        : {}),
      ...config.customHeaders,
      ...this.nextModelRequestTraceHeaders('anthropic_messages'),
    })

    // Tool visibility is mode and user-policy based. Runtime failures stay
    // recoverable and therefore never remove the terminal tool surface.
    const anthropicTools = toolsToAnthropicFormat(this.config.mode, {
      disabledTools: this.modelDisabledToolNames(),
    })

    // Inject MCP tools into Anthropic format
    if (this.mcpClient) {
      const mcpTools = getMcpAgentTools(this.mcpClient)
      for (const tool of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.config.mode === 'plan' && !tool.isReadOnly) continue
        anthropicTools.push({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema || {
            type: 'object',
            properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
            required: tool.parameters.filter(p => p.required).map(p => p.name),
          },
        })
      }
    }

    // CRITICAL FIX: Anthropic only honors the LAST 4 cache_control breakpoints
    // per request. Previously every tool got cache_control, which (a) burned
    // all 4 breakpoints on tools, leaving system + history uncached, and
    // (b) ignored markers on earlier tools. Mark only the LAST tool so the
    // entire (system) + (tools-as-one-block) prefix is one cache breakpoint.
    // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
    const cachedTools = anthropicTools.length > 0
      ? anthropicTools.map((t, i) => i === anthropicTools.length - 1
          ? { ...(t as object), cache_control: { type: 'ephemeral' } }
          : t)
      : anthropicTools

    const maxTokens = resolveRequestMaxTokens(
      this.config.maxTokens || config.maxTokens,
      model?.maxOutputTokens ?? config.maxOutputTokens,
    )
    const anthropicMaxTokens = maxTokens > 0 ? maxTokens : (model?.maxTokens || 8192)
    const temperature = this.config.temperature ?? config.temperature ?? 0.7
    const requestMessages = this.withAnthropicMessageCacheControl(
      normalizeAnthropicToolMessages(messages.filter(m => m.role !== 'system')),
    )
    const requestBody: Record<string, unknown> = {
      model: config.defaultModel,
      max_tokens: anthropicMaxTokens,
      temperature,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: requestMessages,
      stream: true,
    }
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    if (reasoningRequest?.thinking) {
      const thinking = { ...reasoningRequest.thinking }
      if (thinking.budget_tokens && thinking.budget_tokens >= anthropicMaxTokens) {
        thinking.budget_tokens = Math.max(1_024, anthropicMaxTokens - 1)
      }
      requestBody.thinking = thinking
    }
    if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
    if (reasoningRequest?.omitTemperature) delete requestBody.temperature
    if (cachedTools.length > 0) {
      requestBody.tools = cachedTools
      requestBody.tool_choice = { type: 'auto' }
    }
    this.emitPromptModuleSnapshot(systemPrompt, anthropicTools, requestMessages)
    let serializedBody = JSON.stringify(requestBody)

    // Record prompt state for cache-break detection.
    this.cacheMonitor.recordPromptState({
      systemPrompt,
      toolCount: anthropicTools.length,
      toolNames: anthropicTools.map(t => ('name' in t && typeof t.name === 'string' ? t.name : 'unknown')),
      toolSchemas: anthropicTools,
      model: config.defaultModel,
      provider: 'anthropic',
      strategy: turnStrategy?.intent,
      cacheControl: {
        system: true,
        tools: cachedTools.length > 0,
        messages: requestMessages.length > 0,
      },
      extraBodyParams: {
        max_tokens: anthropicMaxTokens,
        temperature,
        beta: headers['anthropic-beta'] ?? null,
        tool_choice: cachedTools.length > 0 ? 'auto' : null,
      },
      messages: requestMessages,
    })

    this.emit({ type: 'stream:start' })

    const streamParser = new AnthropicStreamParser({
      extractReasoningDelta: delta => this.extractStructuredReasoningDelta(delta, { allowTypedText: true }),
      onTextDelta: text => this.emit({ type: 'stream:delta', text }),
      onReasoningDelta: text => this.emit({ type: 'stream:thinking_delta', text }),
      onToolCallDelta: toolCall => this.emit({
        type: 'stream:tool_call_delta',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialJson: streamToolArgumentPreview(toolCall.argumentsJson),
      }),
      onUsage: usage => this.emit({ type: 'stream:usage', usage }),
    })
    // Mint the streamId BEFORE the request goes out so abort() (which
    // can fire from another tick the moment the user clicks "stop")
    // sees a non-null id that matches the one the main process will use.
    // Previously we generated this in two unrelated places (here and in
    // preload's streamMessage), so streamAbort sent a phantom id and the
    // SSE kept reading bytes + burning API quota until the upstream request
    // timeout. Pre-allocating threads the same id through both.
    const operationSignal = this.runControl.getOperationSignal()
    let receivedStreamData = false
    const result = await this.modelStreams.run(operationSignal, async streamId => {
      let currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
        streamId,
        signal: operationSignal,
        retry: false,
      })
      receivedStreamData = streamParser.hasReceivedData || currentResult.receivedStreamData === true
      for (let retry = 0; !currentResult.success && retry < 4; retry += 1) {
        if (operationSignal?.aborted || receivedStreamData) break
        if (currentResult.status !== 400 && currentResult.status !== 422) break
        if (isReasoningEffortValueError(currentResult.error)) {
          const fallback = downgradeReasoningEffort(requestBody)
          if (fallback) {
            this.emit({
              type: 'notification',
              level: 'warning',
              message: `Provider rejected reasoning effort ${fallback.from}; retrying with ${fallback.to}.`,
            })
            serializedBody = JSON.stringify(requestBody)
            currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
              streamId,
              signal: operationSignal,
              retry: false,
            })
            receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
            continue
          }
        }
        const unsupportedParam = extractUnsupportedRequestParam(currentResult.error)
        if (!unsupportedParam || !removeAnthropicCompatibleRequestParam(requestBody, headers, unsupportedParam)) break
        this.emit({
          type: 'notification',
          level: 'warning',
          message: `Messages endpoint rejected "${unsupportedParam}"; retrying without that optional feature.`,
        })
        serializedBody = JSON.stringify(requestBody)
        currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
          streamId,
          signal: operationSignal,
          retry: false,
        })
        receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
      }
      return currentResult
    })
    if (result.success) this.rememberWarmRequestPrefix('anthropic_messages', requestBody)
    const stream = streamParser.snapshot()
    let textContent = stream.text
    const reasoningContent = stream.reasoning
    const rawReasoningBlocks = stream.rawReasoningBlocks
    let toolCallBlocks = stream.toolCalls
    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = stream
    const sawTerminalEvent = stream.sawTerminalEvent
    const streamInterrupted = stream.interrupted
    if (!result.success) {
      if (this.runControl.isPauseSignal(operationSignal)) {
        return this.createPausedAssistantTurn(textContent, reasoningContent, model, startTime)
      }
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(
          textContent,
          reasoningContent,
          model,
          startTime,
          resolveAgentRunInterruption(operationSignal) || interruptionMetadata('stop'),
        )
        if (interruptedTurn) return interruptedTurn
        const err = new Error('aborted') as Error & { aborted?: boolean }
        err.aborted = true
        throw err
      }
      if (!sawTerminalEvent) {
        const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
        if (interruptedTurn) {
          interruptedTurn.metadata = { ...interruptedTurn.metadata, internalKind: 'request_error', internalError: result.error || 'Anthropic request failed' }
          return interruptedTurn
        }
        throw new ModelProtocolRequestError(result.error || 'Anthropic request failed', {
          protocol: 'anthropic_messages',
          url,
          status: result.status,
          retryAfterMs: result.retryAfterMs,
          kind: result.status ? 'http' : 'network',
          receivedStreamData,
        })
      }
    }
    if (!sawTerminalEvent) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads(
        toolCallBlocks.map(block => ({ name: block.name, argumentsJson: block.argumentsJson })),
      )
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Anthropic stream ended before a terminal event', {
          protocol: 'anthropic_messages',
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallBlocks = []
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    // Assemble final tool calls from accumulated data
    const toolCalls: ToolCall[] = []
    for (const block of toolCallBlocks) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(block.argumentsJson || '{}')
      } catch {
        parsedArgs = {}
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: parsedArgs,
      })
    }

    const contextInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens
    const tokens = { input: contextInputTokens, output: outputTokens, cached: cacheReadTokens, total: contextInputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output, cacheReadTokens)

    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: Math.max(0, inputTokens + cacheCreationTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
      })
    }

    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, cacheCreationTokens)
    if (cacheDiagnosis.broken) {
      this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    }

    this.emit(streamInterrupted ? { type: 'stream:end', interrupted: true } : { type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      ...(streamInterrupted ? { interrupted: true } : {}),
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      thinking: reasoningContent ? {
        content: reasoningContent,
        source: 'provider',
        status: streamInterrupted ? 'interrupted' : 'complete',
        durationMs: Date.now() - startTime,
        tokenCount: Math.max(1, Math.ceil(reasoningContent.length / 4)),
        effort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      } : undefined,
      rawReasoningPayload: rawReasoningBlocks.length > 0
        ? { provider: 'anthropic', blocks: rawReasoningBlocks }
        : undefined,
    })
  }

  private buildOpenAITools(config: APIConfig): object[] {
    const openaiTools = toolsToOpenAIFormat(this.config.mode, {
      disabledTools: this.modelDisabledToolNames(),
      strict: config.provider === 'openai',
    })

    if (this.mcpClient) {
      const mcpTools = getMcpAgentTools(this.mcpClient)
      for (const tool of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.config.mode === 'plan' && !tool.isReadOnly) continue
        openaiTools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || {
              type: 'object',
              properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
              required: tool.parameters.filter(p => p.required).map(p => p.name),
            },
          },
        })
      }
    }
    return openaiTools
  }

  private async callOpenAICompatibleAPI(
    config: APIConfig,
    model: APIModel | null,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const url = buildModelProtocolUrl(config.baseUrl, 'openai_chat', config.provider)
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
      ...this.nextModelRequestTraceHeaders('openai_chat'),
    })

    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://turboflux.dev'
      headers['X-Title'] = 'Turboflux'
    }

    // Tool visibility is mode/policy based. Turn strategy may influence
    // context hints, but never hides tools from the model. This keeps the
    // static system/tool prefix stable and avoids intent misclassification
    // turning an agentic request into a no-tool chat response.
    const openaiTools = this.buildOpenAITools(config)

    const requestMessages = config.provider === 'openrouter'
      ? this.withOpenRouterCacheControl(messages)
      : messages

    const maxTokens = resolveRequestMaxTokens(
      this.config.maxTokens || config.maxTokens,
      model?.maxOutputTokens ?? config.maxOutputTokens,
    )
    const body: Record<string, unknown> = {
      model: config.defaultModel,
      messages: requestMessages,
      stream: true,
    }
    if (!shouldOmitSamplingTemperature(config)) {
      body.temperature = this.config.temperature ?? config.temperature ?? 0.7
    }
    if (maxTokens > 0) setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel)
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    if (reasoningRequest?.thinking) body.thinking = reasoningRequest.thinking
    if (reasoningRequest?.reasoningEffort) body.reasoning_effort = reasoningRequest.reasoningEffort
    if (reasoningRequest?.outputConfig) body.output_config = reasoningRequest.outputConfig
    if (reasoningRequest?.omitTemperature) delete body.temperature
    // OpenAI streaming spec: usage is NOT sent unless we opt in via
    // stream_options.include_usage. Without this, mimo / Kimi / DeepSeek
    // / OpenRouter / Qwen all return zero token counts, the per-call
    // record gets dropped by tokenStatsStore's zero-value guard, and
    // the Settings → Usage panel stays empty no matter how much the
    // user spends. The OpenAI Cookbook explicitly recommends always
    // setting this when you stream and care about telemetry.
    // https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
    body.stream_options = { include_usage: true }
    if (openaiTools.length > 0) {
      body.tools = openaiTools
      body.tool_choice = 'auto'
      // Most OpenAI-compatible providers default this to true, but some
      // (older Azure deployments, certain proxies) require explicit opt-in
      // to emit multiple tool_calls in a single assistant turn. Without
      // parallel_tool_calls=true the model is silently forced into one
      // tool call per turn, which produces the "thinks→one search→thinks"
      // loop users see in chat.
      body.parallel_tool_calls = true
    }
    if (config.provider === 'openai' || config.provider === 'kimi' || looksLikeResponsesPreferredModel(config.defaultModel) || /(?:^|[/_.:-])(?:kimi|moonshot)(?:$|[/_.:-])/i.test(config.defaultModel)) {
      body.prompt_cache_key = this.buildPromptCacheKey(config.defaultModel, openaiTools)
      if (/gpt-5\.5/i.test(config.defaultModel)) {
        body.prompt_cache_retention = '24h'
      }
    }
    this.emitPromptModuleSnapshot((messages.find(m => m.role === 'system')?.content as string) || '', openaiTools, requestMessages)
    // Record prompt state for cache-break detection.
    this.cacheMonitor.recordPromptState({
      systemPrompt: (messages.find(m => m.role === 'system')?.content as string) || '',
      toolCount: openaiTools.length,
      toolNames: openaiTools.map(t => (t as { function?: { name?: string }; name?: string }).function?.name || (t as { name?: string }).name || 'unknown'),
      toolSchemas: openaiTools,
      model: config.defaultModel,
      provider: config.provider,
      strategy: turnStrategy?.intent,
      cacheControl: config.provider === 'openrouter' ? 'system+last-message' : 'auto-prefix',
      extraBodyParams: {
        max_tokens: body.max_tokens ?? null,
        max_completion_tokens: body.max_completion_tokens ?? null,
        temperature: body.temperature ?? null,
        stream_options: body.stream_options,
        tool_choice: body.tool_choice ?? null,
        parallel_tool_calls: body.parallel_tool_calls ?? null,
        prompt_cache_key: body.prompt_cache_key ?? null,
        prompt_cache_retention: body.prompt_cache_retention ?? null,
      },
      messages: requestMessages,
    })

    this.emit({ type: 'stream:start' })

    const streamParser = new OpenAIChatStreamParser({
      extractReasoningDelta: delta => this.extractStructuredReasoningDelta(delta),
      onTextDelta: text => this.emit({ type: 'stream:delta', text }),
      onReasoningDelta: text => this.emit({ type: 'stream:thinking_delta', text }),
      onToolCallDelta: toolCall => this.emit({
        type: 'stream:tool_call_delta',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialJson: streamToolArgumentPreview(toolCall.argumentsJson),
      }),
      onUsage: usage => this.emit({ type: 'stream:usage', usage }),
    })
    // Same pre-allocation pattern as the Anthropic path — the previous
    // `Date.now()` was a no-op for abort because preload re-rolled its
    // own id when sending the request. Now we own the id and forward it
    // through streamMessage so streamAbort hits the right controller.
    const operationSignal = this.runControl.getOperationSignal()
    let serializedBody = JSON.stringify(body)
    let receivedStreamData = false
    const result = await this.modelStreams.run(operationSignal, async streamId => {
      let currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
        streamId,
        signal: operationSignal,
        retry: false,
      })
      receivedStreamData = streamParser.hasReceivedData || currentResult.receivedStreamData === true
      for (let retry = 0; !currentResult.success && retry < 4; retry += 1) {
        if (operationSignal?.aborted) break
        if (currentResult.status !== 400) break
        if (isReasoningEffortValueError(currentResult.error)) {
          const fallback = downgradeReasoningEffort(body)
          if (fallback) {
            this.emit({
              type: 'notification',
              level: 'warning',
              message: `Provider rejected reasoning effort ${fallback.from}; retrying with ${fallback.to}.`,
            })
            serializedBody = JSON.stringify(body)
            currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
              streamId,
              signal: operationSignal,
              retry: false,
            })
            receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
            continue
          }
        }
        const unsupportedParam = extractUnsupportedRequestParam(currentResult.error)
        if (!unsupportedParam || !removeOpenAICompatibleRequestParam(body, unsupportedParam)) break
        this.emit({
          type: 'notification',
          level: 'warning',
          message: `Provider rejected "${unsupportedParam}"; retrying without that request parameter.`,
        })
        serializedBody = JSON.stringify(body)
        currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
          streamId,
          signal: operationSignal,
          retry: false,
        })
        receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
      }
      return currentResult
    })
    if (result.success) this.rememberWarmRequestPrefix('openai_chat', body)
    const stream = streamParser.snapshot()
    let textContent = stream.text
    const reasoningContent = stream.reasoning
    let toolCallEntries = stream.toolCalls
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheMissTokens } = stream
    const sawTerminalEvent = stream.sawTerminalEvent
    const streamInterrupted = stream.interrupted
    if (!result.success) {
      if (this.runControl.isPauseSignal(operationSignal)) {
        return this.createPausedAssistantTurn(textContent, reasoningContent, model, startTime)
      }
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(
          textContent,
          reasoningContent,
          model,
          startTime,
          resolveAgentRunInterruption(operationSignal) || interruptionMetadata('stop'),
        )
        if (interruptedTurn) return interruptedTurn
        const err = new Error('aborted') as Error & { aborted?: boolean }
        err.aborted = true
        throw err
      }
      if (!sawTerminalEvent) {
        const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
        if (interruptedTurn) {
          interruptedTurn.metadata = { ...interruptedTurn.metadata, internalKind: 'request_error', internalError: result.error || 'Model request failed' }
          return interruptedTurn
        }
        throw new ModelProtocolRequestError(result.error || 'Model request failed', {
          protocol: 'openai_chat',
          url,
          status: result.status,
          retryAfterMs: result.retryAfterMs,
          kind: result.status ? 'http' : 'network',
          receivedStreamData,
        })
      }
    }
    if (!sawTerminalEvent) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads(
        toolCallEntries.map(entry => ({ name: entry.name, argumentsJson: entry.argumentsJson })),
      )
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Model stream ended before a terminal event', {
          protocol: 'openai_chat',
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallEntries = []
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    // Assemble final tool calls
    const toolCalls: ToolCall[] = []
    for (const entry of toolCallEntries) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(entry.argumentsJson || '{}')
      } catch {
        parsedArgs = {}
      }
      toolCalls.push({
        id: entry.id,
        name: entry.name,
        arguments: parsedArgs,
      })
    }

    // Some OpenAI-compatible routes stream tool calls as text markup instead
    // of standard delta.tool_calls. Convert those into real tool calls and
    // keep the markup out of the assistant transcript.
    const textToolCalls = parseTextToolCalls(textContent)
    if (textToolCalls.containsToolMarkup) {
      textContent = textToolCalls.cleanedText
      if (toolCalls.length === 0 && textToolCalls.toolCalls.length > 0) {
        toolCalls.push(...textToolCalls.toolCalls)
      }
    }

    const tokens = { input: inputTokens, output: outputTokens, cached: cacheReadTokens, total: inputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output, cacheReadTokens)

    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: cacheMissTokens ?? Math.max(0, inputTokens - cacheReadTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens,
      })
    }

    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, 0)
    if (cacheDiagnosis.broken) {
      this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    }

    this.emit(streamInterrupted ? { type: 'stream:end', interrupted: true } : { type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      ...(streamInterrupted ? { interrupted: true } : {}),
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      thinking: reasoningContent ? {
        content: reasoningContent,
        source: 'provider',
        status: streamInterrupted ? 'interrupted' : 'complete',
        durationMs: Date.now() - startTime,
        tokenCount: reasoningTokens || Math.max(1, Math.ceil(reasoningContent.length / 4)),
        effort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      } : undefined,
      // Store reasoning_content so it can be passed back in subsequent turns.
      // OpenAI-compatible providers (e.g. mimo, DeepSeek-R1) require the
      // reasoning_content from the previous assistant message to be echoed
      // back verbatim, otherwise they return a 400 "Param Incorrect" error.
      rawReasoningPayload: reasoningContent
        ? { provider: 'openai-compatible', blocks: [], reasoningContent }
        : undefined,
    })
  }

  private async callOpenAIResponsesAPI(
    config: APIConfig,
    model: APIModel | null,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const protocol: ModelProtocol = 'openai_responses'
    const url = buildModelProtocolUrl(config.baseUrl, protocol, config.provider)
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
      ...this.nextModelRequestTraceHeaders('openai_responses'),
    })
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://turboflux.dev'
      headers['X-Title'] = 'Turboflux'
    }

    const chatTools = this.buildOpenAITools(config)
    const responseTools = toResponsesTools(chatTools)
    const instructions = messages
      .filter(message => message.role === 'system' || message.role === 'developer')
      .map(message => typeof message.content === 'string' ? message.content : '')
      .filter(Boolean)
      .join('\n\n')
    const input = toResponsesInput(messages)
    const maxTokens = resolveRequestMaxTokens(
      this.config.maxTokens || config.maxTokens,
      model?.maxOutputTokens ?? config.maxOutputTokens,
    )
    const body: Record<string, unknown> = {
      model: config.defaultModel,
      instructions,
      input,
      stream: true,
      store: false,
    }
    if (looksLikeResponsesPreferredModel(config.defaultModel)) {
      body.text = { verbosity: 'low' }
    }
    if (!shouldOmitSamplingTemperature(config)) {
      body.temperature = this.config.temperature ?? config.temperature ?? 0.7
    }
    if (maxTokens > 0) body.max_output_tokens = maxTokens
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    const reasoningEffort = reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort, summary: 'detailed' }
    if (reasoningRequest?.omitTemperature) delete body.temperature
    if (responseTools.length > 0) {
      body.tools = responseTools
      body.tool_choice = 'auto'
      body.parallel_tool_calls = true
    }
    if (config.provider === 'openai' || config.provider === 'kimi' || looksLikeResponsesPreferredModel(config.defaultModel) || /(?:^|[/_.:-])(?:kimi|moonshot)(?:$|[/_.:-])/i.test(config.defaultModel)) {
      body.prompt_cache_key = this.buildPromptCacheKey(config.defaultModel, responseTools)
      if (/gpt-5\.5/i.test(config.defaultModel)) body.prompt_cache_retention = '24h'
    }

    this.emitPromptModuleSnapshot(instructions, responseTools, input)
    this.cacheMonitor.recordPromptState({
      systemPrompt: instructions,
      toolCount: responseTools.length,
      toolNames: responseTools.map(tool => typeof tool.name === 'string' ? tool.name : 'unknown'),
      toolSchemas: responseTools,
      model: config.defaultModel,
      provider: config.provider,
      strategy: turnStrategy?.intent,
      cacheControl: 'responses-auto-prefix',
      extraBodyParams: {
        protocol,
        max_output_tokens: body.max_output_tokens ?? null,
        temperature: body.temperature ?? null,
        text: body.text ?? null,
        reasoning: body.reasoning ?? null,
        tool_choice: body.tool_choice ?? null,
        parallel_tool_calls: body.parallel_tool_calls ?? null,
        prompt_cache_key: body.prompt_cache_key ?? null,
        prompt_cache_retention: body.prompt_cache_retention ?? null,
      },
      messages: input,
    })

    this.emit({ type: 'stream:start' })
    const streamParser = new OpenAIResponsesStreamParser({
      onTextDelta: text => this.emit({ type: 'stream:delta', text }),
      onReasoningDelta: text => this.emit({ type: 'stream:thinking_delta', text }),
      onToolCallDelta: toolCall => this.emit({
        type: 'stream:tool_call_delta',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialJson: streamToolArgumentPreview(toolCall.argumentsJson),
      }),
      onUsage: usage => this.emit({ type: 'stream:usage', usage }),
    })
    const operationSignal = this.runControl.getOperationSignal()

    let serializedBody = JSON.stringify(body)
    let receivedStreamData = false
    const result = await this.modelStreams.run(operationSignal, async streamId => {
      let currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
        streamId,
        signal: operationSignal,
        retry: false,
      })
      receivedStreamData = streamParser.hasReceivedData || currentResult.receivedStreamData === true
      for (let retry = 0; !currentResult.success && retry < 4; retry += 1) {
        if (operationSignal?.aborted || currentResult.status !== 400 || receivedStreamData) break
        if (isReasoningEffortValueError(currentResult.error)) {
          const fallback = downgradeReasoningEffort(body)
          if (fallback) {
            this.emit({
              type: 'notification',
              level: 'warning',
              message: `Responses endpoint rejected reasoning effort ${fallback.from}; retrying with ${fallback.to}.`,
            })
            serializedBody = JSON.stringify(body)
            currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
              streamId,
              signal: operationSignal,
              retry: false,
            })
            receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
            continue
          }
        }
        const unsupportedParam = extractUnsupportedRequestParam(currentResult.error)
        if (!unsupportedParam || !removeOpenAICompatibleRequestParam(body, unsupportedParam)) break
        this.emit({
          type: 'notification',
          level: 'warning',
          message: `Responses endpoint rejected "${unsupportedParam}"; retrying without that request parameter.`,
        })
        serializedBody = JSON.stringify(body)
        currentResult = await this.toolExecutor.streamMessage(url, headers, serializedBody, line => streamParser.handleLine(line), {
          streamId,
          signal: operationSignal,
          retry: false,
        })
        receivedStreamData = receivedStreamData || streamParser.hasReceivedData || currentResult.receivedStreamData === true
      }
      return currentResult
    })
    if (result.success) this.rememberWarmRequestPrefix(protocol, body)
    const stream = streamParser.snapshot()
    let textContent = stream.text
    const reasoningContent = stream.reasoning
    let toolCallEntries = stream.toolCalls
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens } = stream
    const sawTerminalEvent = stream.sawTerminalEvent
    const streamFailure = stream.streamFailure
    if (!result.success) {
      if (this.runControl.isPauseSignal(operationSignal)) {
        return this.createPausedAssistantTurn(textContent, reasoningContent, model, startTime)
      }
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(
          textContent,
          reasoningContent,
          model,
          startTime,
          resolveAgentRunInterruption(operationSignal) || interruptionMetadata('stop'),
        )
        if (interruptedTurn) return interruptedTurn
        const aborted = new Error('aborted') as Error & { aborted?: boolean }
        aborted.aborted = true
        throw aborted
      }
      if (!sawTerminalEvent) {
        const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
        if (interruptedTurn) {
          interruptedTurn.metadata = { ...interruptedTurn.metadata, internalKind: 'request_error', internalError: result.error || 'Responses request failed' }
          return interruptedTurn
        }
        throw new ModelProtocolRequestError(result.error || 'Responses request failed', {
          protocol,
          url,
          status: result.status,
          retryAfterMs: result.retryAfterMs,
          kind: result.status ? 'http' : 'network',
          receivedStreamData,
        })
      }
    }
    if (streamFailure) {
      const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
      if (interruptedTurn) {
        if (isOutputLimitFinishReason(streamFailure)) return interruptedTurn
        interruptedTurn.metadata = { ...interruptedTurn.metadata, internalKind: 'request_error', internalError: streamFailure }
        return interruptedTurn
      }
      throw new ModelProtocolRequestError(streamFailure, {
        protocol,
        url,
        kind: 'stream',
        receivedStreamData,
      })
    }
    if (!sawTerminalEvent) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads(toolCallEntries.map(entry => ({
        name: entry.name,
        argumentsJson: entry.argumentsJson,
      })))
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Responses stream ended before a terminal event', {
          protocol,
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallEntries = []
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    const toolCalls: ToolCall[] = []
    for (const entry of toolCallEntries) {
      let parsedArguments: Record<string, unknown> = {}
      try {
        parsedArguments = JSON.parse(entry.argumentsJson || '{}')
      } catch {
        parsedArguments = {}
      }
      toolCalls.push({ id: entry.id, name: entry.name, arguments: parsedArguments })
    }
    const textToolCalls = parseTextToolCalls(textContent)
    if (textToolCalls.containsToolMarkup) {
      textContent = textToolCalls.cleanedText
      if (toolCalls.length === 0 && textToolCalls.toolCalls.length > 0) toolCalls.push(...textToolCalls.toolCalls)
    }

    const tokens = { input: inputTokens, output: outputTokens, cached: cacheReadTokens, total: inputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output, cacheReadTokens)
    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: Math.max(0, inputTokens - cacheReadTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens,
      })
    }
    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, 0)
    if (cacheDiagnosis.broken) this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    this.emit({ type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort,
      thinking: reasoningContent ? {
        content: reasoningContent,
        source: 'provider',
        status: 'complete',
        durationMs: Date.now() - startTime,
        tokenCount: reasoningTokens || Math.max(1, Math.ceil(reasoningContent.length / 4)),
        effort: reasoningEffort,
      } : undefined,
      rawReasoningPayload: reasoningContent
        ? { provider: 'openai-compatible', blocks: [], reasoningContent }
        : undefined,
    })
  }

  private wrapRuntimeContextSection(tag: string, content: string): string {
    const trimmed = content.trim()
    return trimmed ? `<${tag}>\n${trimmed}\n</${tag}>` : ''
  }

  private captureRuntimeContext(turn: AgentTurn | undefined, candidate: string): void {
    if (!turn || typeof turn.metadata?.runtimeContext === 'string') return
    const runtimeContext = candidate.trim()
      ? [
          '<runtime_context>',
          'Internal execution context for this turn. Do not acknowledge, quote, translate, or roleplay this block.',
          candidate,
          '</runtime_context>',
        ].join('\n')
      : ''
    turn.metadata = { ...turn.metadata, runtimeContext }
  }

  private buildPromptCacheKey(model: string, tools: unknown[]): string {
    const workspace = this.config.workspacePath || ''
    const workspaceKey = workspace.toLowerCase().replace(/[^a-z0-9._/-]+/gi, '_').slice(-96)
    const conversationId = this.config.conversationId || this.stateProvider.getConversationId() || this.session.id
    const conversationKey = stableHash(conversationId)
    const toolHash = stableHash(tools)
    const mode = this.config.mode || 'vibe'
    return `tf:${model}:${mode}:${conversationKey}:${workspaceKey}:${toolHash}`.slice(0, 240)
  }

  private emitPromptModuleSnapshot(systemPrompt: string, tools: unknown[], messages: Array<Record<string, unknown>>): void {
    const contextChars = this.stateProvider.getContextSegments().reduce((sum, segment) => sum + segment.summary.length, 0)
    const moduleText = (value: unknown) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        return ''
      }
    }
    const modules: PromptModuleSnapshot[] = [
      {
        id: 'system',
        label: 'System',
        hash: stableHash(systemPrompt),
        chars: systemPrompt.length,
        stable: true,
      },
      {
        id: 'tools',
        label: 'Tools',
        hash: stableHash(tools),
        chars: moduleText(tools).length,
        stable: true,
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hash: stableHash({
          workspace: this.config.workspacePath,
          skeleton: this.workspaceSkeleton,
          memory: this.workspaceMemoryText,
        }),
        chars: (this.workspaceSkeleton?.length || 0) + (this.workspaceMemoryText?.length || 0),
        stable: true,
      },
      {
        id: 'context',
        label: 'Context',
        hash: stableHash(this.stateProvider.getContextSegments().map(segment => ({
          start: segment.startMessageId,
          end: segment.endMessageId,
          summary: segment.summary,
        }))),
        chars: contextChars,
        stable: false,
      },
      {
        id: 'tail',
        label: 'Tail',
        hash: stableHash(messages.slice(-4)),
        chars: moduleText(messages.slice(-4)).length,
        stable: false,
      },
    ]
    this.emit({ type: 'cache:modules', modules })
  }

  private ensureScheduledWorkStep(): void {
    const runId = this.workExecution.getCurrentRunId()
    if (!runId) return
    const running = this.taskManager.getActiveTaskContexts().some(task => this.taskManager.getTask(task.taskId)?.metadata?.workRunId === runId)
    if (running) return
    const next = this.taskManager.getFirstPendingLeafTask(runId)
    if (next) this.taskManager.updateTask(next.id, { status: 'in_progress' })
  }

  private buildWorkExecutionContext(): string {
    const runId = this.workExecution.getCurrentRunId()
    if (!runId) return ''
    const tasks = this.taskManager.getTasksForWorkRun(runId)
    if (tasks.length === 0) return ''
    const activeIds = new Set(this.taskManager.getActiveTaskContexts().map(task => task.taskId))
    const lines = [
      '<work_execution>',
      `run_id: ${runId}`,
      'The runtime owns dependency scheduling. Work only on running steps or explicitly start another ready step when genuine parallelism is useful.',
      'A failed tool call is an attempt, not a failed step. Retry or choose another method, then set the final step outcome explicitly.',
    ]
    for (const task of tasks.sort((left, right) => left.order - right.order)) {
      const dependencyState = task.dependencies.length > 0 ? ` deps=[${task.dependencies.join(',')}]` : ''
      lines.push(`- ${task.id} [${activeIds.has(task.id) ? 'running' : task.status}] ${task.title}${dependencyState}`)
    }
    const blocked = this.taskManager.getBlockedTasks(runId)
    if (blocked.length > 0) lines.push(`blocked: ${blocked.map(task => task.id).join(', ')}`)
    lines.push('</work_execution>')
    return lines.join('\n')
  }

  private buildPreservedFilesContext(sourceFiles: Array<{ path: string; content: string }>): string {
    const recentReadPaths = new Set<string>()
    for (const turn of this.session.turns) {
      for (const toolCall of turn.toolCalls ?? []) {
        if ((toolCall.name === 'read_file' || toolCall.name === 'read_file_full') && typeof toolCall.arguments.path === 'string') {
          recentReadPaths.add(toolCall.arguments.path)
        }
      }
    }
    const filesToInclude = sourceFiles.filter(file => !recentReadPaths.has(file.path))
    if (filesToInclude.length === 0) return ''
    const parts: string[] = [
      '<recent_files>',
      'These files were recently accessed before context compression and remain relevant:',
    ]
    for (const file of filesToInclude) parts.push(`<file path="${file.path}">\n${file.content}\n</file>`)
    parts.push('</recent_files>')
    return parts.join('\n\n')
  }

  private prepareModelSurfaceForRequest(
    activeConfig: APIConfig,
    activeModel: APIModel | null,
    preservedFiles: Array<{ path: string; content: string }>,
  ): AgentTurn[] {
    const maxOutputTokens = this.config.maxTokens || activeModel?.maxTokens || 4096
    const contextWindow = activeModel?.contextWindow || activeConfig.contextWindow || this.config.contextWindow || 200_000
    this.modelSurface.syncTurns(this.buildContextCandidateTurns(contextWindow, maxOutputTokens))
    this.modelSurface.appendSnapshot('work_execution', this.buildWorkExecutionContext())
    if (preservedFiles.length > 0) {
      this.modelSurface.appendSnapshot('compaction_files', this.buildPreservedFilesContext(preservedFiles))
    }
    this.modelSurface.pruneStaleToolResults(this.workExecution.getCurrentRunId() || undefined)
    if (activeConfig.modelCapabilities?.vision ?? activeModel?.supportsVision ?? true) {
      this.modelSurface.enforceImageBudget()
    }
    this.session.modelSurface = this.modelSurface.getState()
    return this.modelSurface.projectTurns()
  }

  private buildApiMessages(
    systemPrompt: string,
    provider: 'openai' | 'anthropic',
    surfaceTurns: readonly AgentTurn[] = this.modelSurface.projectTurns(),
  ): Array<Record<string, unknown>> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    const maxOutputTokens = this.config.maxTokens || activeModel?.maxTokens || 4096
    const contextWindow = activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000
    const policyProfile = resolveContextPolicyProfile(this.config.contextPolicy)
    const candidateTurns = projectTurnsForModelContext(surfaceTurns)

    // Fetch valid context segments from the current conversation
    let contextSegments: ContextSegment[] | undefined
    const convId = this.config.conversationId || this.stateProvider.getConversationId()
    if (convId) {
      contextSegments = this.stateProvider.getContextSegments()
    }

    return this.contextManager.buildMessages(
      candidateTurns,
      systemPrompt,
      contextWindow,
      provider,
      maxOutputTokens,
      contextSegments,
      policyProfile,
      activeModel?.id || activeConfig?.defaultModel,
      activeConfig?.modelCapabilities?.vision ?? activeModel?.supportsVision ?? true,
    )
  }

  private buildContextCandidateTurns(_contextWindow: number, _maxOutputTokens: number): AgentTurn[] {
    return this.session.turns
  }

  private withAnthropicMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return this.withRecentMessageCacheControl(messages, 2)
  }

  private withOpenRouterCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const withSystemCache = messages.map((message, index) => {
      if (index !== 0 || message.role !== 'system' || typeof message.content !== 'string') {
        return message
      }
      return {
        ...message,
        content: [{
          type: 'text',
          text: message.content,
          cache_control: { type: 'ephemeral' },
        }],
      }
    })
    return this.withLastMessageCacheControl(withSystemCache)
  }

  private withLastMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return this.withRecentMessageCacheControl(messages, 1)
  }

  private withRecentMessageCacheControl(
    messages: Array<Record<string, unknown>>,
    maxMessages: number,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = messages.map(message => ({
      ...message,
      content: Array.isArray(message.content) ? [...message.content] : message.content,
    }))

    let marked = 0
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'system') continue
      result[i] = this.addCacheControlToMessage(result[i])
      marked += 1
      if (marked >= maxMessages) break
    }

    return result
  }

  private addCacheControlToMessage(message: Record<string, unknown>): Record<string, unknown> {
    const cacheControl = { type: 'ephemeral' }
    const content = message.content

    if (typeof content === 'string') {
      return {
        ...message,
        content: [{
          type: 'text',
          text: content,
          cache_control: cacheControl,
        }],
      }
    }

    if (Array.isArray(content)) {
      const blocks = content.map(block => (
        block && typeof block === 'object'
          ? { ...(block as Record<string, unknown>) }
          : block
      ))

      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (!block || typeof block !== 'object') continue
        const type = (block as Record<string, unknown>).type
        if (message.role === 'assistant' && (type === 'thinking' || type === 'redacted_thinking')) {
          continue
        }
        blocks[i] = {
          ...(block as Record<string, unknown>),
          cache_control: cacheControl,
        }
        return {
          ...message,
          content: blocks,
        }
      }
    }

    return message
  }

  private extractStructuredReasoningDelta(delta: unknown, options?: { allowTypedText?: boolean }): string {
    if (!delta || typeof delta !== 'object') return ''
    const value = delta as Record<string, unknown>
    const candidates = [
      value.reasoning_content,
      value.reasoning,
      value.reasoning_text,
      value.thinking,
      value.thought,
    ]

    if (options?.allowTypedText && typeof value.type === 'string' && /reason|think|thought|analysis/i.test(value.type)) {
      candidates.push(value.text)
    }

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate
      }
    }
    return ''
  }

  /**
   * Build a STABLE workspace skeleton primer for subagent calls.
   *
   * Used by project-defined agents to seed a deterministic
   * cache prefix unit that DeepSeek V4 can persist (see SubAgentInvocation.codemap).
   *
   * Stability is the whole point — this primer must be IDENTICAL across
   * every subagent call in the same workspace, otherwise V4's prefix
   * cache detection misses and we eat full input price every time. So:
   * - Cached by absolute workspace path; computed at most once per
   *   workspace per session.
   * - Never includes the user's query, timestamps, or anything random.
   * - Falls back to null on error (caller treats null as "no primer";
   *   the runner skips the codemap-priming pair entirely in that case).
   *
   * Source: `workspace:list-tree` (cheap, sync, no LLM, no index dependency).
   * We trim to top 2 levels of folders + a handful of marker files at root,
   * which is plenty for the model to pick which path to grep first while
   * staying small enough that the primer doesn't dominate the prompt.
   */
  private async maybeBuildWorkspaceSkeleton(workspacePath: string): Promise<string | undefined> {
    if (!workspacePath) return undefined
    if (this.workspaceSkeleton && this.workspaceSkeletonPath === workspacePath) {
      return this.workspaceSkeleton
    }
    // Different workspace from the cached one ⇒ invalidate.
    if (this.workspaceSkeletonPath !== workspacePath) {
      this.workspaceSkeleton = null
      this.workspaceSkeletonPath = workspacePath
    }
    try {
      const tree = await this.toolExecutor.listTree(workspacePath, {
        maxDepth: 2,
        maxEntriesPerDirectory: 32,
        maxNodes: 400,
      })
      if (!tree.success || !tree.data) return undefined

      // Filter out noise (deps, build outputs, .git) so the skeleton stays
      // signal-dense. Keep this list deterministic — same input ⇒ same
      // output, which is critical for cache locality.
      const SKIP_DIR_NAMES = new Set([
        'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
        'vendor', 'release', '.next', '.turbo', '.cache', '.parcel-cache',
        '.vscode', '.idea', '.kiro', '.claude', '.turboflux', '.turboforge',
        '__pycache__', 'target', '.gradle', '.mvn',
      ])
      const SKIP_FILE_NAMES = new Set([
        'package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml',
        'Cargo.lock', 'poetry.lock', 'Pipfile.lock', '.DS_Store',
      ])

      // Surface a few "marker" root files (package.json, tsconfig, etc.)
      // upfront so the model knows the project type at a glance.
      const MARKER_FILES = new Set([
        'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
        'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
        'requirements.txt', 'README.md', 'BLUEPRINT.md', 'AGENTS.md',
        '.gitignore', 'vite.config.ts', 'webpack.config.js', 'Dockerfile',
      ])

      type Node = { name: string; type: 'folder' | 'file'; children?: Node[] }
      const root = tree.data as Node
      const lines: string[] = []
      lines.push(`workspace_root: ${root.name}`)

      // Root-level markers first.
      const rootChildren = (root.children || []).slice().sort((a, b) => a.name.localeCompare(b.name))
      const rootMarkers = rootChildren.filter(n => n.type === 'file' && MARKER_FILES.has(n.name))
      if (rootMarkers.length > 0) {
        lines.push('markers:')
        for (const m of rootMarkers) lines.push(`  - ${m.name}`)
      }

      // Top-level folders + their immediate children. Two levels is enough
      // structure to navigate from; deeper trees blow the primer past
      // useful budget.
      const rootFolders = rootChildren.filter(n => n.type === 'folder' && !SKIP_DIR_NAMES.has(n.name))
      const MAX_TOP_FOLDERS = 24
      const MAX_CHILDREN_PER_FOLDER = 14
      lines.push('top_level:')
      for (const folder of rootFolders.slice(0, MAX_TOP_FOLDERS)) {
        const visibleChildren = (folder.children || [])
          .filter(c => {
            if (c.type === 'folder') return !SKIP_DIR_NAMES.has(c.name)
            return !SKIP_FILE_NAMES.has(c.name)
          })
          .sort((a, b) => {
            // Folders before files, then alphabetical — deterministic.
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          .slice(0, MAX_CHILDREN_PER_FOLDER)
        const childList = visibleChildren
          .map(c => c.type === 'folder' ? `${c.name}/` : c.name)
          .join(', ')
        lines.push(`  ${folder.name}/${childList ? ` — ${childList}` : ''}`)
      }
      if (rootFolders.length > MAX_TOP_FOLDERS) {
        lines.push(`  (… ${rootFolders.length - MAX_TOP_FOLDERS} more top-level folder(s) omitted)`)
      }

      const skeleton = lines.join('\n')
      // Hard cap so a sprawling monorepo can't bloat the primer past
      // the cache-friendly sweet spot. ~3 KB ≈ 750 tokens, well within
      // V4's prefix unit threshold.
      this.workspaceSkeleton = skeleton.slice(0, 3000)
      return this.workspaceSkeleton
    } catch {
      // Tree fetch failed — return undefined so the runner skips the
      // primer pair entirely instead of seeding a half-broken one.
      return undefined
    }
  }

  /**
   * Pull the latest workspace memory snapshot from the main process.
   *
   * Caching strategy: the main MemoryService keys its own cache by file
   * mtimes, so calling memoryList every turn is cheap when nothing changed
   * (one stat per known rule file, no parsing). We additionally short-
   * circuit on `builtAt` to avoid even the IPC round-trip on back-to-back
   * turns within ~10s of each other; if the user was actively editing a
   * rule file we want the new content fast, so the TTL is intentionally
   * short.
   *
   * Failure mode: any IPC error leaves the previous text intact rather
   * than nulling it out. Stale-but-present is strictly better than
   * losing the user's project rules just because a stat call hiccupped.
   */
  private async maybeRefreshWorkspaceMemory(): Promise<void> {
    const workspace = this.stateProvider.getWorkspace()
    const wsPath = workspace?.path || ''
    if (!wsPath) {
      this.workspaceMemoryText = null
      this.workspaceMemoryWorkspace = null
      this.workspaceMemoryBuiltAt = 0
      return
    }

    const now = Date.now()
    const sameWorkspace = this.workspaceMemoryWorkspace === wsPath
    const fresh = sameWorkspace && (now - this.workspaceMemoryBuiltAt) < 10_000
    if (fresh) return

    // Query-aware path: if we have a recent user message, ask the main
    // process to rank rules by relevance and trim to a tighter budget.
    // Falls back to full snapshot on any error or when no message yet.
    const latestUserMessage = (() => {
      for (let i = this.session.turns.length - 1; i >= 0; i--) {
        const t = this.session.turns[i]
        if (t.role === 'user' && t.content.trim()) return t.content
      }
      return ''
    })()

    if (latestUserMessage && typeof this.toolExecutor.memoryGetRelevantInjection === 'function') {
      try {
        const resp = await this.toolExecutor.memoryGetRelevantInjection({
          workspacePath: wsPath,
          query: latestUserMessage,
        })
        const injectedText = resp?.data?.text
        if (resp?.success && typeof injectedText === 'string') {
          this.workspaceMemoryText = injectedText.trim() || null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
          return
        }
      } catch {
        // fall through to full snapshot
      }
    }

    try {
      const response = await this.toolExecutor.memoryList(wsPath)
      if (!response?.success || !response.data?.snapshot) {
        if (!sameWorkspace) {
          this.workspaceMemoryText = null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
        }
        return
      }
      const text = response.data.snapshot.injectionText.trim()
      this.workspaceMemoryText = text.length > 0 ? text : null
      this.workspaceMemoryWorkspace = wsPath
      this.workspaceMemoryBuiltAt = now
    } catch {
      // Keep prior text on transient IPC failure.
    }
  }

  private buildEvidenceGuardHint(): string | null {
    // If the model already performed any read operations (read_file,
    // list_directory, search_*, get_codemap), it has gathered evidence.
    // Don't force a retry — trust the model's judgment on when to conclude.
    if (this.currentRunReadFiles.size > 0) return null
    if (this.currentRunSuccessfulSearches.size > 0) return null
    if (this.currentRunToolNames.some(n => n === 'list_directory' || n === 'get_codemap')) return null
    return this.buildEvidencePolicyContext(this.currentTurnStrategy, 'retry')
  }

  private buildEvidencePolicyContext(strategy?: TurnStrategy | null, phase: 'pre' | 'retry' = 'pre'): string | null {
    if (!strategy?.requiresEvidence) return null
    const maxAttempts = 1
    if (phase === 'retry' && this.conclusionGuardAttempts >= maxAttempts) return null

    const hasSearchEvidence = this.currentRunSuccessfulSearches.size > 0
    const hasDirectRead = this.currentRunSuccessfulReadFiles.size > 0
    if (hasSearchEvidence && hasDirectRead) return null

    const tag = phase === 'retry' ? 'evidence_guard' : 'evidence_policy'
    if (phase === 'retry') {
      return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
You already searched. NO more search tools this turn. Use read_file on the most relevant prior hits (or read_file_full only if exact whole-file contents are required), then answer with file anchors.
</${tag}>`
    }
    return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
Before high-confidence claims: locate authoritative code via search_symbols/search_content/get_codemap, then read_file at least one high-signal source. Use read_file_full only for exact whole-file needs. Answer with verified anchors; state residual uncertainty plainly.
</${tag}>`
  }

  private recordToolUsage(name: string, args: Record<string, unknown>): void {
    this.currentRunToolNames.push(name)
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunReadFiles.add(args.path)
    }
    if (name.startsWith('search_') || name === 'get_codemap') {
      const query = (args.query || args.pattern || '') as string
      this.currentRunSearches.add(`${name}:${query}`)
    }
  }

  private recordSuccessfulToolUsage(name: string, args: Record<string, unknown>, output: string): void {
    if (this.isToolOutputFailure(name, output)) return
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunSuccessfulReadFiles.add(args.path)
    }
    // Bug 1 fix: search_files was excluded here while recordToolUsage()
    // already adds it to currentRunSearches via the name.startsWith('search_')
    // branch. The asymmetry meant evidence_guard's hasSearchEvidence
    // (currentRunSuccessfulSearches.size > 0) could never be satisfied by a
    // pure search_files-driven run, so the model was forced to retry even
    // after a successful filename scan. Treat search_files exactly like the
    // other search_* tools and gate "no hits" output the same way.
    if (
      name === 'search_files'
      || name === 'search_content'
      || name === 'search_symbols'
      || name === 'get_codemap'
    ) {
      if (/^(No matches found|No matching files found|No codemap found)$/i.test(output.trim())) return
      const query = (args.query || args.pattern || '') as string
      this.currentRunSuccessfulSearches.add(`${name}:${query}`)
    }
  }

  private isToolOutputFailure(name: string, output: string): boolean {
    const trimmed = output.trim()
    if ((name === 'read_file' || name === 'read_file_full') && !/^Error(?:\s|\(|:)/.test(trimmed)) return false
    return /^Error(?:\s|\(|:)/.test(trimmed)
      || /^Tool execution error:/i.test(trimmed)
      || /^Unknown tool:/i.test(trimmed)
  }

  private getTaskToolStatus(result: ToolResult): 'completed' | 'error' | 'cancelled' {
    if (result.interruption) return 'cancelled'
    const trimmed = result.output.trim()
    if (/^(Cancelled|Aborted):/i.test(trimmed)) return 'cancelled'
    return result.isError ? 'error' : 'completed'
  }

  /**
   * Walk the existing session.turns and re-record each historical tool call
   * + result into currentRun* sets so the evidence guard treats restored
   * reads/searches as valid evidence in the new run (Bug #19).
   */
  private replayEvidenceFromExistingTurns(): void {
    const resultsByCallId = new Map<string, ToolResult>()
    for (const turn of this.session.turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        resultsByCallId.set(result.toolCallId, result)
      }
    }

    for (const turn of this.session.turns) {
      if (turn.role !== 'assistant' || !turn.toolCalls || turn.toolCalls.length === 0) continue
      for (const tc of turn.toolCalls) {
        this.recordToolUsage(tc.name, tc.arguments)
        const result = resultsByCallId.get(tc.id)
        if (result && !result.isError) {
          this.recordSuccessfulToolUsage(tc.name, tc.arguments, result.output || '')
        }
      }
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return []
    const operationSignal = this.runControl.getOperationSignal()

    for (const toolCall of toolCalls) {
      toolCall.arguments = normalizeBuiltInToolArguments(toolCall.name, toolCall.arguments, {
        workspacePath: this.stateProvider.getWorkspace()?.path || this.config.workspacePath || '',
        resolvePath: (basePath, path) => this.resolvePath(basePath, path),
        isFile: path => {
          try {
            return existsSync(path) && statSync(path).isFile()
          } catch {
            return false
          }
        },
      })
    }

    const allResults = await this.toolExecutionCoordinator.execute(toolCalls, operationSignal)

    this.fileBeforeSnapshots.clear()

    return allResults
  }

  private toolCallsBeforeUserAnswer(toolCalls: ToolCall[]): ToolCall[] {
    const askUserCall = toolCalls.find(toolCall => toolCall.name === 'ask_user')
    return askUserCall ? [askUserCall] : toolCalls
  }

  private linkToolCallToActiveTask(toolCall: ToolCall): void {
    const path = this.extractToolCallPath(toolCall)
    const linkedTaskId = this.taskManager.addToolCallToActiveTask({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: 'running',
      path,
    })
    if (linkedTaskId) {
      this.toolCallTaskMap.set(toolCall.id, linkedTaskId)
    }
    this.workExecution.startTool(toolCall, linkedTaskId || undefined, path)
    this.emitWorkExecution()
  }

  private updateTaskToolCallStatus(
    toolCallId: string,
    status: 'completed' | 'error' | 'cancelled',
    result?: string,
    toolName?: string,
  ): void {
    const safeResult = result !== undefined && toolName && isBuiltInComputerTool(toolName)
      ? status === 'completed' ? COMPUTER_RESULT_REDACTED : COMPUTER_ERROR_REDACTED
      : result
    const taskId = this.toolCallTaskMap.get(toolCallId)
    if (taskId) {
      this.taskManager.updateToolCallStatus(taskId, toolCallId, status, safeResult)
    } else {
      const activeCtx = this.taskManager.getActiveTaskContext()
      if (activeCtx) this.taskManager.updateToolCallStatus(activeCtx.taskId, toolCallId, status, safeResult)
    }
    this.workExecution.finishTool({ toolCallId, name: toolName || '', output: safeResult || '', isError: status !== 'completed', errorKind: status === 'cancelled' ? 'abort' : undefined })
    this.emitWorkExecution()
  }

  private emitActiveTaskContext(): void {
    const ctx = this.taskManager.getActiveTaskContext()
    this.emit({ type: 'active:task', context: ctx })
    this.emitTaskSystem()
  }

  private emitWorkExecution(): void {
    this.emit({ type: 'work:execution', snapshot: this.workExecution.getSnapshot(this.taskManager) })
  }

  private async emitTerminalSessions(): Promise<void> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) {
      this.emit({ type: 'terminal:sessions', sessions: [] })
      return
    }
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
    this.emit({ type: 'terminal:sessions', sessions })
  }

  private async getTerminalSession(sessionId: string): Promise<TerminalSessionInfo | undefined> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) return undefined
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    return rawSessions.find(s => s.id === sessionId)
  }

  private emitTaskSystem(creation?: TaskSystemCreationEvent | null): void {
    this.emit({
      type: 'task:system',
      context: this.taskManager.getActiveTaskContext(),
      tree: this.taskManager.getFullTree(),
      creation,
    })
  }

  private extractToolCallPath(toolCall: ToolCall): string | undefined {
    const args = toolCall.arguments
    return args.path as string | undefined
      || args.cwd as string | undefined
      || args.directory as string | undefined
      || args.file_path as string | undefined
  }

  private isWriteToolCall(toolCall: ToolCall): boolean {
    return this.resolveToolDefinition(toolCall.name)?.isReadOnly === false
  }

  private resolveToolDefinition(name: string): AgentTool | undefined {
    return getToolByName(name) || (this.mcpClient ? getMcpAgentTools(this.mcpClient).find(tool => tool.name === name) : undefined)
  }

  private isReadAfterWriteSensitiveToolCall(toolCall: ToolCall): boolean {
    return ['read_file', 'read_file_full', 'list_directory', 'search_files', 'search_content', 'search_symbols', 'get_codemap', 'web_search', 'web_fetch'].includes(toolCall.name)
  }

  private partitionToolCalls(toolCalls: ToolCall[]): ToolCallBatch[] {
    return this.toolExecutionCoordinator.partition(toolCalls)
  }

  private async executeSingleTool(toolCall: ToolCall, operationSignal = this.runControl.getOperationSignal()): Promise<ToolResult> {
    const tool = this.resolveToolDefinition(toolCall.name)

    if (!tool) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: unknown tool "${toolCall.name}"`,
        isError: true,
        errorKind: 'validation',
      }
    }

    return this.toolExecutionLedger.execute(toolCall, async () => {
      const result = await this.executeSingleToolUncached(toolCall, tool, operationSignal)
      if (!result.isError && !tool.isReadOnly) this.toolExecutionLedger.invalidateReadResults()
      return result
    })
  }

  private async executeSingleToolUncached(toolCall: ToolCall, tool: AgentTool, operationSignal?: AbortSignal): Promise<ToolResult> {

    if (this.config.mode === 'plan' && !tool.isReadOnly) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: plan mode is read-only; switch to vibe mode before using "${toolCall.name}".`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (this.disabledToolNames.has(toolCall.name)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is disabled for this request by the user's instruction.`,
        isError: true,
      }
    }

    if (tool.requiredMode && !tool.requiredMode.includes(this.config.mode)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is not available in ${this.config.mode} mode. Switch to ${tool.requiredMode.join(' or ')} mode.`,
        isError: true,
      }
    }

    // Validate tool arguments
    const validation = isMcpTool(toolCall.name) && tool.inputSchema
      ? validateMcpToolArgs(tool.inputSchema, toolCall.arguments)
      : validateToolArgs(toolCall.name, toolCall.arguments)
    if (!validation.valid) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: ${validation.error}`,
        isError: true,
        errorKind: 'validation',
      }
    }

    const permissionError = await this.checkToolPermission(toolCall, operationSignal)
    if (permissionError) return permissionError
    if (operationSignal?.aborted) {
      throw operationSignal.reason instanceof Error ? operationSignal.reason : this.runControl.createStopInterruption()
    }
    if (this.runControl.getSnapshot().paused) await this.runControl.waitIfPaused()
    if (this.runControl.getRunSignal()?.aborted) throw this.runControl.createStopInterruption()
    operationSignal = this.runControl.getOperationSignal()

    this.recordToolUsage(toolCall.name, toolCall.arguments)

    try {
      const executionArgs = toolCall.name === 'run_command'
        ? { ...toolCall.arguments, approved: true }
        : toolCall.arguments
      const dispatchResult = await this.dispatchTool(toolCall.name, executionArgs, toolCall.id, operationSignal)
      if (operationSignal?.aborted) throw operationSignal.reason instanceof Error ? operationSignal.reason : this.runControl.createStopInterruption()
      if (this.runControl.getSnapshot().paused) await this.runControl.waitIfPaused()
      if (this.runControl.getRunSignal()?.aborted) throw this.runControl.createStopInterruption()
      operationSignal = this.runControl.getOperationSignal()
      const output = typeof dispatchResult === 'string' ? dispatchResult : dispatchResult.output
      const attachments = typeof dispatchResult === 'string' ? undefined : dispatchResult.attachments

      const configuredResultLimit = (tool as EnhancedToolDef).maxResultSizeChars
      const maxResultChars = Number.isFinite(configuredResultLimit)
        ? Math.max(2_000, Number(configuredResultLimit))
        : DEFAULT_TOOL_RESULT_MAX_CHARS
      const truncationNotice = `\n… <output truncated: ${output.length} chars total; model result budget is ${maxResultChars} chars. Use a narrower query or read_file with offset/limit.>`
      const previewChars = Math.max(1, maxResultChars - truncationNotice.length)
      const truncatedOutput = output.length > maxResultChars
        ? `${output.slice(0, previewChars)}${truncationNotice}`
        : output

      const isOutputFailure = this.isToolOutputFailure(toolCall.name, truncatedOutput)
      const result: ToolResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: truncatedOutput,
        isError: isOutputFailure,
        ...(attachments?.length ? { attachments: attachments.map(attachment => ({ ...attachment })) } : {}),
        ...(isOutputFailure ? { errorKind: this.classifyToolErrorKind(truncatedOutput) } : {}),
      }
      if (!isOutputFailure) {
        this.recordSuccessfulToolUsage(toolCall.name, toolCall.arguments, truncatedOutput)
      }

      // Build change summary for file write/edit/delete operations.
      // Attach size-capped before/after snapshots so the UI can render
      // real unified diffs lazily (folded card = zero diff work).
      const workspacePath = this.stateProvider.getWorkspace()?.path || ''
      const resolvedPath = (toolCall.arguments.path as string)
        ? this.resolvePath(workspacePath, toolCall.arguments.path as string)
        : ''

      if (toolCall.name === 'write_file' && !isOutputFailure) {
        const content = (toolCall.arguments.content as string) || ''
        const lines = content.split('\n')
        const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
        const after = content
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'write',
          totalLines: lines.length,
          preview: lines.slice(0, 20).join('\n'),
          ...this.buildDiffSnapshot(before, after),
        }
      }

      if (toolCall.name === 'replace_file' && !isOutputFailure) {
        const content = (toolCall.arguments.content as string) || ''
        const lines = content.split('\n')
        const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
        const after = content
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines: lines.length,
          preview: lines.slice(0, 20).join('\n'),
          ...this.buildDiffSnapshot(before, after),
        }
      }

      if (toolCall.name === 'edit_file' && !isOutputFailure) {
        const oldContent = (toolCall.arguments.old_content as string) || ''
        const newContent = (toolCall.arguments.new_content as string) || ''
        const oldLines = oldContent.split('\n').length
        const newLines = newContent.split('\n').length
        let totalLines = newLines
        let afterFileContent = ''
        let hasAfterSnapshot = false
        try {
          const editedPath = this.resolvePath(
            this.stateProvider.getWorkspace()?.path || '',
            (toolCall.arguments.path as string) || '',
          )
          const reread = await this.toolExecutor.readFile(editedPath)
          if (reread.success && typeof reread.data === 'string') {
            totalLines = reread.data.split('\n').length
            afterFileContent = reread.data
            hasAfterSnapshot = true
          }
        } catch {
        }
        const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
        const after = afterFileContent
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines,
          oldPreview: oldContent.split('\n').slice(0, 5).join('\n'),
          preview: newContent.split('\n').slice(0, 5).join('\n'),
          ...(hasAfterSnapshot
            ? this.buildDiffSnapshot(before, after)
            : { diffStatus: 'postimage-unavailable' as const, beforeBytes: before.length }),
        }
      }

      if (toolCall.name === 'multi_edit' && !isOutputFailure) {
        const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
        let after = ''
        let hasAfterSnapshot = false
        try {
          const reread = await this.toolExecutor.readFile(resolvedPath)
          if (reread.success && typeof reread.data === 'string') {
            after = reread.data
            hasAfterSnapshot = true
          }
        } catch {
        }
        const afterLines = hasAfterSnapshot ? after.split('\n').length : undefined
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines: afterLines,
          ...(hasAfterSnapshot
            ? this.buildDiffSnapshot(before, after)
            : { diffStatus: 'postimage-unavailable' as const, beforeBytes: before.length }),
        }
      }

      if (toolCall.name === 'delete_file' && !isOutputFailure) {
        const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'delete',
          ...this.buildDiffSnapshot(before, ''),
        }
      }

      return result
    } catch (error) {
      const interruption = resolveAgentRunInterruption(operationSignal, error)
      if (interruption) return createInterruptedToolResult(toolCall, interruption)
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        errorKind: 'execution',
      }
    }
  }

  private classifyToolErrorKind(output: string): ToolResult['errorKind'] {
    if (/timed out|timeout/i.test(output)) return 'timeout'
    if (/permission|denied|blocked by .*policy|requires an explicit permission/i.test(output)) return 'permission'
    if (/required|invalid|unexpected parameter|unknown tool|not available in .* mode|patch (?:must|contains|exceeds)|patch line|hunk|context is ambiguous/i.test(output)) return 'validation'
    return 'execution'
  }

  private async checkToolPermission(toolCall: ToolCall, operationSignal = this.runControl.getOperationSignal()): Promise<ToolResult | null> {
    const computerApprovalLevel = computerToolApprovalLevel(toolCall.name, toolCall.arguments)
    if (browserToolNeedsApproval(toolCall.name) === false || computerApprovalLevel === 'none') return null
    const permissionArgs = toolCall.name === 'run_command'
      ? { ...toolCall.arguments, approved: false }
      : toolCall.arguments
    const result = this.permissions.check(toolCall.name, permissionArgs)

    if (result.verdict === 'allow') return null

    if (result.verdict === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: Blocked by permission policy [${result.decisionId || 'unknown'}]. ${result.reason || 'Operation not permitted'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    const command = typeof toolCall.arguments.command === 'string'
      ? toolCall.arguments.command
      : undefined
    const semanticPermission = describeSemanticToolPermission(toolCall.name, toolCall.arguments)
    const isComputerAction = isBuiltInComputerTool(toolCall.name)
    const response = await this.interactiveRequests.request({
      id: toolCall.id,
      kind: 'permission',
      event: {
        type: 'ask:user',
        requestId: toolCall.id,
        toolName: toolCall.name,
        path: this.extractToolCallPath(toolCall),
        question: semanticPermission?.question || (command
          ? `允许执行这个命令吗？`
          : `允许执行 ${toolCall.name} 吗？`),
        options: isComputerAction || computerApprovalLevel === 'always'
          ? ['allow-once', 'deny']
          : ['allow-once', 'allow-run', 'allow-session', 'deny'],
        reason: semanticPermission?.reason || result.reason || 'Operation requires approval',
        command,
      },
    }, { signal: operationSignal, cancelDecision: 'deny' })
    if (this.runControl.getSnapshot().paused) await this.runControl.waitIfPaused()
    if (this.runControl.getRunSignal()?.aborted) throw this.runControl.createStopInterruption()
    const decision = this.parsePermissionDecision(response)
    if (isComputerAction && decision !== 'allow-once' && decision !== 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: 'Error: Computer actions can only be approved for this single action.',
        isError: true,
        errorKind: 'permission',
      }
    }
    if (decision === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: User denied permission. ${result.reason || 'Operation requires approval'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (decision === 'allow-run') {
      this.permissions.grantRun(toolCall.name, toolCall.arguments)
    } else if (decision === 'allow-session') {
      this.permissions.grantSession(toolCall.name, toolCall.arguments)
    }

    if (this.interactiveRequests.getSnapshot().pendingCount === 0) {
      const semanticActivity = describeSemanticToolActivity(toolCall.name, toolCall.arguments, 'running')
      this.setRunState('tool_running', {
        detail: semanticActivity?.detail || `Running ${toolCall.name}`,
        activeTool: toolCall.name,
      })
    }

    return null
  }

  private parsePermissionDecision(response: string): 'allow-once' | 'allow-run' | 'allow-session' | 'deny' {
    const normalized = response.trim().toLowerCase()
    if (['allow-run', 'run', 'this-run', '本轮允许', '本次任务允许', '2'].includes(normalized)) {
      return 'allow-run'
    }
    if (['allow-session', 'always', 'all', 'a', 'session', '一直允许', '本次会话允许'].includes(normalized)) {
      return 'allow-session'
    }
    if (['deny', 'no', 'n', 'false', '拒绝', '不允许', '否'].includes(normalized)) {
      return 'deny'
    }
    if (['allow-once', 'yes', 'y', '1', 'once', '本次允许'].includes(normalized)) return 'allow-once'
    return 'deny'
  }

  private emitSubAgentProgress(agentId: string, agentType: string, label: string, event: SubAgentEvent): void {
    this.emit({ type: 'subagent:progress', agentId, agentType, label, event })
  }

  private formatSubAgentTask(task: SubAgentTaskSnapshot): string {
    const runtime = task.runtimeTask
    const lines = [
      `Agent ID: ${task.id}`,
      `Type: ${task.agentType}`,
      `Status: ${runtime.status}`,
      `Objective: ${task.objective}`,
      `Started: ${new Date(task.startedAt).toISOString()}`,
    ]
    if (runtime.endedAt) lines.push(`Ended: ${new Date(runtime.endedAt).toISOString()}`)
    if (runtime.error) lines.push(`Error: ${runtime.error}`)
    if (task.transcriptPath) lines.push(`Transcript: ${task.transcriptPath}`)

    if (task.result) {
      const result = task.result as {
        ok?: boolean
        turns?: number
        elapsedMs?: number
        finalText?: string
        evidence?: SubAgentEvidence[]
        error?: string
      }
      lines.push('', `<subagent_report type="${task.agentType}" turns="${result.turns || 0}" elapsed_ms="${result.elapsedMs || 0}">`)
      lines.push('', 'final_report:', result.finalText || result.error || '(empty)', '')
      const evidence = result.evidence || []
      if (evidence.length > 0) {
        lines.push('evidence (top 12):')
        for (const item of evidence.slice(0, 12)) {
          const preview = item.preview.split('\n').slice(0, 3).map(line => `    ${line.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n')
          lines.push(`  - ${item.path}:L${item.startLine}-${item.endLine} · ${item.reason}`)
          if (preview) lines.push(preview)
        }
        if (evidence.length > 12) lines.push(`  (... ${evidence.length - 12} more evidence range(s))`)
      }
      lines.push('', '</subagent_report>')
    }
    return lines.join('\n')
  }

  private async dispatchTool(name: string, args: Record<string, unknown>, toolCallId: string, operationSignal = this.runControl.getOperationSignal()): Promise<ToolDispatchOutput> {
    const workspace = this.stateProvider.getWorkspace()
    const basePath = workspace?.path || ''

    const taskResult = dispatchTaskTool(name, args, {
      taskManager: this.taskManager,
      emitTaskSystem: creation => this.emitTaskSystem(creation),
      emitActiveTask: () => this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() }),
    })
    if (taskResult !== undefined) return taskResult

    switch (name) {
      case 'read_file':
      case 'read_file_full': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const isFullRead = name === 'read_file_full'
        const offset = isFullRead ? 1 : args.offset as number | undefined
        const requestedLimit = isFullRead ? undefined : args.limit as number | undefined
        const limit = Math.max(1, Math.min(MODEL_READ_MAX_LINES, Math.floor(requestedLimit ?? DEFAULT_MODEL_READ_LINES)))
        const maxBytes = isFullRead ? MODEL_READ_FULL_MAX_BYTES : MODEL_READ_MAX_BYTES
        // with_line_numbers defaults true: cat -n style output makes
        // edit_file / multi_edit far more reliable because the model can
        // see exact line positions when planning targeted edits.
        const withLineNumbers = isFullRead
          ? args.with_line_numbers === true
          : args.with_line_numbers !== false

        const startLine = offset || 1
        const start = Math.max(0, startLine - 1)
        let slice: string[]
        let truncated = false
        let partialLine = false
        let totalLines: number | undefined
        if (this.toolExecutor.readFileRange) {
          const result = await this.toolExecutor.readFileRange(filePath, start, limit, maxBytes)
          if (!result.success) {
            const relPath = this.toWorkspaceRelative(basePath, filePath)
            throw new Error(`${result.error || 'Unable to read file'} — resolved path: ${relPath}. Use search_files or list_directory to verify the correct path.`)
          }
          const rangeContent = result.data?.content ?? ''
          slice = rangeContent ? rangeContent.split('\n') : []
          truncated = result.data?.truncated === true
          partialLine = result.data?.partialLine === true
        } else {
          const result = await this.toolExecutor.readFile(filePath)
          if (!result.success) {
            const relPath = this.toWorkspaceRelative(basePath, filePath)
            throw new Error(`${result.error || 'Unable to read file'} — resolved path: ${relPath}. Use search_files or list_directory to verify the correct path.`)
          }
          const allLines = (result.data ?? '').split('\n')
          totalLines = allLines.length
          const selectedLines = allLines.slice(start, start + limit)
          slice = []
          let bytes = 0
          for (const line of selectedLines) {
            const remaining = maxBytes - bytes
            if (remaining <= 0) {
              truncated = true
              break
            }
            const buffer = Buffer.from(line, 'utf8')
            if (buffer.length > remaining && slice.length > 0) {
              truncated = true
              break
            }
            const bounded = buffer.length > remaining
              ? buffer.subarray(0, remaining).toString('utf8').replace(/�$/, '')
              : line
            bytes += Buffer.byteLength(bounded, 'utf8') + 1
            slice.push(bounded)
            if (buffer.length > remaining) {
              truncated = true
              partialLine = true
              break
            }
          }
          truncated ||= start + slice.length < totalLines
        }
        const returnedLines = slice.length

        // Render with line numbers in cat -n format
        const formatLine = (lineText: string, idx: number) =>
          `${String(start + idx + 1).padStart(6, ' ')}→${lineText}`
        const content = withLineNumbers
          ? slice.map(formatLine).join('\n')
          : slice.join('\n')

        // Moderate files should fit in one model round. Very large files retain
        // an explicit continuation hint so callers can jump to a searched range.
        if (truncated) {
          if (partialLine) {
            return `[line ${startLine} exceeds the ${Math.floor(maxBytes / 1024)} KiB model read budget; showing a bounded preview only. Line-based continuation cannot resume inside this line. Use search_content for a precise anchor or a structured log/task reader for JSONL records.]\n${content}`
          }
          const nextOffset = startLine + returnedLines
          const knownTotal = totalLines ? ` of ${totalLines}` : ''
          return `[lines ${startLine}-${startLine - 1 + returnedLines}${knownTotal}; bounded to ${limit} lines / ${Math.floor(maxBytes / 1024)} KiB; call read_file with offset=${nextOffset}, limit=${Math.min(limit, 400)} to continue, or search for a precise range]\n${content}`
        }
        return content
      }

      case 'write_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI write_file',
        })
        return result.success ? `File written: ${args.path}` : `Error: ${result.error}`
      }

      case 'replace_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) {
          return `Error: replace_file requires an existing file - ${existing.error || 'file not found'}`
        }
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI replace_file',
          expectedHash: hashText(existing.data || ''),
        })
        return result.success ? `File replaced: ${args.path}` : `Error: ${result.error}`
      }

      case 'edit_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.captureBeforeSnapshot(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return `Error: unable to read file - ${readResult.error}`

        let content = readResult.data!
        const oldContent = stripLineNumberPrefix(args.old_content as string)
        const newContent = stripLineNumberPrefix(args.new_content as string)
        const replaceAll = args.replace_all === true

        const editResult = applyEdit(content, oldContent, newContent, replaceAll, args.path as string)
        if ('error' in editResult) return `Error: ${editResult.error}`
        content = editResult.content

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI edit_file',
          expectedHash: hashText(readResult.data || ''),
        })
        return writeResult.success
          ? `File edited: ${args.path}${replaceAll ? ` (${editResult.replacements} replacements)` : ''}`
          : `Error: ${writeResult.error}`
      }

      case 'multi_edit': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const rawEdits = args.edits
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return `Error: edits must be a non-empty array`
        }
        await this.captureBeforeSnapshot(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return `Error: unable to read file - ${readResult.error}`

        let content = readResult.data!
        const summary: string[] = []
        for (let i = 0; i < rawEdits.length; i += 1) {
          const edit = rawEdits[i] as Record<string, unknown>
          if (!edit || typeof edit !== 'object') {
            return `Error: edit #${i + 1} is not an object`
          }
          const oldContent = stripLineNumberPrefix(edit.old_string as string)
          const newContent = stripLineNumberPrefix(edit.new_string as string)
          const replaceAll = edit.replace_all === true
          if (typeof oldContent !== 'string' || typeof newContent !== 'string') {
            return `Error: edit #${i + 1} is missing old_string or new_string`
          }
          const stepResult = applyEdit(content, oldContent, newContent, replaceAll, `${args.path} (edit #${i + 1})`)
          if ('error' in stepResult) {
            return `Error: ${stepResult.error}. No edits applied (multi_edit is atomic).`
          }
          content = stepResult.content
          summary.push(`#${i + 1}${replaceAll ? ` ×${stepResult.replacements}` : ''}`)
        }

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI multi_edit',
          expectedHash: hashText(readResult.data || ''),
        })
        return writeResult.success
          ? `File edited: ${args.path} (${rawEdits.length} edits applied: ${summary.join(', ')})`
          : `Error: ${writeResult.error}`
      }

      case 'apply_patch': {
        let operations: ApplyPatchOperation[]
        try {
          operations = parseApplyPatch(args.patch as string)
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }

        type PreparedPatch = {
          operation: ApplyPatchOperation
          sourcePath: string
          sourceRelativePath: string
          sourceContent: string | null
          sourceHash?: string
          targetPath?: string
          targetRelativePath?: string
          targetHash?: string
          nextContent?: string
        }

        const prepared: PreparedPatch[] = []
        const touchedPaths = new Set<string>()
        const readExisting = async (filePath: string, label: string): Promise<{ content: string | null; hash?: string; error?: string }> => {
          const result = await this.toolExecutor.readFile(filePath)
          if (result.success) {
            const content = result.data ?? ''
            return { content, hash: hashText(content) }
          }
          const error = result.error || 'file not found'
          if (/not found|no such file|does not exist/i.test(error)) return { content: null }
          return { content: null, error: `${label}: ${error}` }
        }

        for (const operation of operations) {
          const sourcePath = this.resolvePath(basePath, operation.path)
          const sourceRelativePath = this.toWorkspaceRelative(basePath, sourcePath)
          const sourceKey = sourcePath.toLowerCase()
          if (touchedPaths.has(sourceKey)) return `Error: patch touches the same file more than once: ${operation.path}`
          touchedPaths.add(sourceKey)
          const source = await readExisting(sourcePath, `Unable to inspect ${operation.path}`)
          if (source.error) return `Error: ${source.error}`

          if (operation.kind === 'add') {
            prepared.push({
              operation,
              sourcePath,
              sourceRelativePath,
              sourceContent: source.content,
              sourceHash: source.hash,
              nextContent: applyPatchAdd(operation.content),
            })
            continue
          }

          if (source.content === null) return `Error: ${operation.kind} requires an existing file: ${operation.path}`
          if (operation.kind === 'delete') {
            prepared.push({ operation, sourcePath, sourceRelativePath, sourceContent: source.content, sourceHash: source.hash })
            continue
          }

          let nextContent: string
          try {
            nextContent = applyPatchHunks(source.content, operation.hunks, operation.path)
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }

          if (!operation.moveTo) {
            prepared.push({ operation, sourcePath, sourceRelativePath, sourceContent: source.content, sourceHash: source.hash, nextContent })
            continue
          }

          const targetPath = this.resolvePath(basePath, operation.moveTo)
          const targetRelativePath = this.toWorkspaceRelative(basePath, targetPath)
          const targetKey = targetPath.toLowerCase()
          if (targetKey === sourceKey) return `Error: move destination must differ from source: ${operation.moveTo}`
          if (touchedPaths.has(targetKey)) return `Error: patch touches the same file more than once: ${operation.moveTo}`
          touchedPaths.add(targetKey)
          const target = await readExisting(targetPath, `Unable to inspect ${operation.moveTo}`)
          if (target.error) return `Error: ${target.error}`
          prepared.push({
            operation,
            sourcePath,
            sourceRelativePath,
            sourceContent: source.content,
            sourceHash: source.hash,
            targetPath,
            targetRelativePath,
            targetHash: target.hash,
            nextContent,
          })
        }

        for (const item of prepared) {
          await this.captureBeforeSnapshot(item.sourcePath)
          if (item.targetPath) await this.captureBeforeSnapshot(item.targetPath)
        }

        const summaries: string[] = []
        for (const item of prepared) {
          const operation = item.operation
          if (operation.kind === 'add') {
            const writeResult = await this.toolExecutor.writeFile(item.sourcePath, item.nextContent || '', {
              source: 'ai',
              label: 'AI apply_patch add',
              ...(item.sourceHash ? { expectedHash: item.sourceHash } : { expectNotExists: true }),
            })
            if (!writeResult.success) return `Error: ${writeResult.error}`
            summaries.push(`A ${item.sourceRelativePath}`)
            continue
          }

          if (operation.kind === 'delete') {
            const deleteResult = await this.toolExecutor.deleteFile(item.sourcePath, { expectedHash: item.sourceHash })
            if (!deleteResult.success) return `Error: ${deleteResult.error}`
            summaries.push(`D ${item.sourceRelativePath}`)
            continue
          }

          if (item.targetPath) {
            if (item.nextContent === item.sourceContent && this.toolExecutor.moveFile) {
              const moveResult = await this.toolExecutor.moveFile(item.sourcePath, item.targetPath, {
                expectedHash: item.sourceHash,
                ...(item.targetHash ? { expectedDestinationHash: item.targetHash } : {}),
              })
              if (!moveResult.success) return `Error: ${moveResult.error}`
              summaries.push(`M ${item.targetRelativePath}`)
              continue
            }
            const writeTarget = await this.toolExecutor.writeFile(item.targetPath, item.nextContent || '', {
              source: 'ai',
              label: 'AI apply_patch move',
              ...(item.targetHash ? { expectedHash: item.targetHash } : { expectNotExists: true }),
            })
            if (!writeTarget.success) return `Error: ${writeTarget.error}`
            const deleteSource = await this.toolExecutor.deleteFile(item.sourcePath, { expectedHash: item.sourceHash })
            if (!deleteSource.success) return `Error: move completed at ${item.targetRelativePath}, but source cleanup failed: ${deleteSource.error}`
            summaries.push(`M ${item.targetRelativePath}`)
            continue
          }

          const writeResult = await this.toolExecutor.writeFile(item.sourcePath, item.nextContent || '', {
            source: 'ai',
            label: 'AI apply_patch update',
            expectedHash: item.sourceHash,
          })
          if (!writeResult.success) return `Error: ${writeResult.error}`
          summaries.push(`M ${item.sourceRelativePath}`)
        }

        return `Patch applied. Updated files:\n${summaries.join('\n')}`
      }

      case 'list_directory': {
        const dirPath = this.resolvePath(basePath, args.path as string)
        const result = await this.toolExecutor.listTree(dirPath)
        if (!result.success) return `Error: ${result.error}`

        const formatTree = (node: TreeNode, depth = 0): string => {
          const indent = '  '.repeat(depth)
          const lines = [`${indent}[${node.type === 'file' ? 'FILE' : 'DIR'}] ${node.name}`]
          if (node.children && (args.recursive || depth === 0)) {
            for (const child of node.children) {
              lines.push(formatTree(child, depth + 1))
            }
          }
          return lines.join('\n')
        }

        return result.data ? formatTree(result.data) : 'Empty directory'
      }

      case 'search_files': {
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const result = await this.toolExecutor.searchFiles(args.pattern as string, dirPath)
        if (!result.success) return `Error: ${result.error}`
        const matches = (result.data?.matches || []).map(p => this.toWorkspaceRelative(basePath, p))
        const lines = matches.slice(0, 80)
        if (result.data?.truncated && matches.length > 0) {
          lines.push('... more matches truncated')
        }
        return matches.length > 0 ? lines.join('\n') : 'No matching files found'
      }

      case 'search_content': {
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const filePattern = (args.file_pattern || args.glob) as string | undefined
        // Default to case-insensitive (grep -i ergonomics). Models can opt back
        // into case sensitivity when needed.
        const caseSensitive = args.case_sensitive === true
        const result = this.toolExecutor.searchContentPage
          ? await this.toolExecutor.searchContentPage(args.pattern as string, dirPath, filePattern, !caseSensitive, {
              offset: args.offset as number | undefined,
              limit: args.head_limit as number | undefined,
              contextBefore: args.context_before as number | undefined,
              contextAfter: args.context_after as number | undefined,
              multiline: args.multiline === true,
              fileType: args.file_type as string | undefined,
            })
          : await this.toolExecutor.searchContent(args.pattern as string, dirPath, filePattern, !caseSensitive)
        if (!result.success) return `Error: ${result.error}`
        const page = this.toolExecutor.searchContentPage
          ? result.data as { hits?: import('../tools/executor').SearchContentHit[]; truncated?: boolean; offset?: number; limit?: number; totalMatches?: number }
          : { hits: Array.isArray(result.data) ? result.data : [], truncated: false, offset: 0, limit: 50, totalMatches: Array.isArray(result.data) ? result.data.length : 0 }
        if (!page.hits?.length) return 'No matches found'
        const formatted = this.formatContentSearchResults(page.hits)
        return page.truncated
          ? `${formatted}\n\nMore matches available; continue with offset=${Number(page.offset || 0) + page.hits.length}.`
          : formatted
      }

      case 'search_symbols': {
        if (!basePath) return `Error: no workspace selected`
        const kind = args.symbol_kind as CodeSymbolKind | undefined
        const response = await this.toolExecutor.searchCodeSymbols({
          workspacePath: basePath,
          query: args.query as string,
          path: args.path as string | undefined,
          kinds: kind ? [kind] : undefined,
          limit: 20,
        })
        if (!response.success) return `Error: ${response.error || 'symbol search failed'}`
        return this.formatCodeSearchHits(response.data || [])
      }

      case 'get_codemap': {
        if (!basePath) return `Error: no workspace selected`
        const response = await this.toolExecutor.getCodeMap({
          workspacePath: basePath,
          query: args.query as string,
          targetPaths: typeof args.path === 'string' ? [args.path] : undefined,
          path: args.path as string | undefined,
          maxPaths: 8,
          maxChildrenPerPath: 5,
        })
        if (!response.success) return `Error: ${response.error || 'codemap search failed'}`
        const map = response.data?.map
        if (!map || (Array.isArray(map) && map.length === 0)) return 'No codemap found'
        const nodes = Array.isArray(map) ? map : [map]
        const related = response.data?.relatedPaths?.length ? `\n\nRelated paths:\n${response.data.relatedPaths.map((p: string) => `- ${p}`).join('\n')}` : ''
        return `${nodes.map(node => this.formatCodeMap(node)).join('\n')}${related}`
      }

      case 'web_search': {
        if (typeof this.toolExecutor.webSearch !== 'function') {
          return 'Error: web_search is not available in this runtime'
        }
        const query = String(args.query || '').trim()
        if (!query) return 'Error: query is required'
        const response = await this.toolExecutor.webSearch({
          query,
          additional_queries: args.additional_queries,
          limit: args.limit,
          region: args.region,
          freshness: args.freshness,
          domains: args.domains,
          exclude_domains: args.exclude_domains,
          depth: args.depth,
        })
        if (!response.success) return `Error: ${response.error || 'web search failed'}`
        const data = response.data
        if (!data?.results?.length) return `No web results found for "${query}"`
        return this.formatWebSearchResults(data)
      }

      case 'web_fetch': {
        if (typeof this.toolExecutor.webFetch !== 'function') {
          return 'Error: web_fetch is not available in this runtime'
        }
        const urls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean) : []
        if (urls.length === 0) return 'Error: urls is required'
        const response = await this.toolExecutor.webFetch({ urls, max_chars: args.max_chars })
        if (!response.success) return `Error: ${response.error || 'web page fetch failed'}`
        if (!response.data) return 'Error: web page fetch returned no data'
        return this.formatWebFetchResults(response.data)
      }

      case 'tool_search': {
        if (!this.mcpClient) return 'No MCP tools are connected.'
        const query = String(args.query || '').trim()
        if (!query) return 'Error: query is required'
        const limit = typeof args.limit === 'number' ? args.limit : 8
        const matches = this.mcpClient.searchTools(query, limit)
        for (const match of matches) this.deferredMcpToolNames.add(match.name)
        if (matches.length === 0) return `No MCP tools matched "${query}".`
        return JSON.stringify({
          tools: matches.map(tool => ({
            name: tool.name,
            server: tool.serverName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })
      }

      case 'list_memories': {
        if (!basePath) return 'Error: no workspace selected'
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const response = await this.toolExecutor.memoryQuery({
          workspacePath: basePath,
          query: typeof args.query === 'string' ? args.query : undefined,
          kind: typeof args.kind === 'string'
            ? (args.kind as MemoryKind)
            : undefined,
          scope: typeof args.scope === 'string'
            ? (args.scope as MemoryScope)
            : undefined,
          limit,
        })
        if (!response.success) return `Error: ${response.error || 'memory query failed'}`
        const items = response.data?.items || []
        if (items.length === 0) return 'No memories matched the filter.'
        const lines = items.map((item: { id: string; kind: string; confidence: string | number; text: string; source: string; tags?: string[] }) => {
          const tagBits = item.tags?.length ? ` [${item.tags.slice(0, 3).join(', ')}]` : ''
          return `- ${item.id} (${item.kind}, ${item.confidence}) ${item.text}\n  source: ${item.source}${tagBits}`
        })
        return `Found ${items.length} memor${items.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`
      }

      case 'remember': {
        if (!basePath) return 'Error: no workspace selected'
        const text = args.text as string
        if (!text || typeof text !== 'string') return 'Error: text parameter is required'
        // Handle tags: accept array or comma-separated string
        let tags: string[] | undefined
        if (Array.isArray(args.tags)) {
          tags = args.tags.filter((t: unknown) => typeof t === 'string')
        } else if (typeof args.tags === 'string') {
          tags = args.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        }
        const result = await this.toolExecutor.memoryRemember({
          workspacePath: basePath,
          text,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          tags,
          confidence: typeof args.confidence === 'string' ? args.confidence : undefined,
          conversationId: this.config.conversationId || this.stateProvider.getConversationId() || undefined,
        })
        if (!result.success) return `Error: ${result.error || 'remember failed'}`
        if (result.data?.deduplicated) return `Memory updated (deduplicated with existing entry): ${result.data.id}`
        return `Memory stored: ${result.data?.id}`
      }

      case 'forget': {
        if (!basePath) return 'Error: no workspace selected'
        const id = args.id as string
        if (!id || typeof id !== 'string') return 'Error: id parameter is required'
        const reason = typeof args.reason === 'string' ? args.reason : undefined
        const result = await this.toolExecutor.memoryForget({
          workspacePath: basePath,
          id,
          reason,
        })
        if (!result.success) return `Error: ${result.error || 'forget failed'}`
        return `Memory forgotten: ${id}`
      }

      case 'git_status': {
        if (!basePath) return 'Error: no workspace selected'
        const ready = await this.initializeGit(true)
        if (!ready || !this.gitState.snapshot) {
          return `Error: ${this.gitState.error || 'workspace is not a readable Git repository'}`
        }
        return formatGitSnapshotForTool(this.gitState.snapshot)
      }

      case 'git_diff': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await fetchGitDiff(
          basePath,
          this.toolExecutor,
          (args.scope as GitDiffScope | undefined) || 'working',
          args.path as string | undefined,
          args.context_lines as number | undefined,
        )
        return result.ok ? result.output || 'No tracked changes.' : `Error: ${result.error}`
      }

      case 'git_log': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await fetchGitLog(basePath, this.toolExecutor, args.limit as number | undefined, args.path as string | undefined)
        return result.ok ? result.output || 'No commits found.' : `Error: ${result.error}`
      }

      case 'git_show': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await fetchGitShow(basePath, this.toolExecutor, args.revision as string, args.path as string | undefined)
        return result.ok ? result.output || 'No output.' : `Error: ${result.error}`
      }

      case 'git_stage': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('stage', () => gitStagePaths(basePath, args.paths as string[], this.toolExecutor))
        return result.ok ? result.output || 'Paths staged.' : `Error: ${result.error}`
      }

      case 'git_commit': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('commit', () => gitCommit(basePath, args.message as string, this.toolExecutor, args.paths as string[] | undefined))
        if (!result.ok) return `Error: ${result.error}`
        if (result.nothingToCommit) return 'Nothing to commit.'
        return `${result.hash ? `Commit ${result.hash}` : 'Commit created'}${result.output ? `\n${result.output}` : ''}`
      }

      case 'git_create_branch': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('create-branch', () => gitCreateBranch(basePath, args.name as string, this.toolExecutor, args.start_point as string | undefined))
        return result.ok ? result.output || 'Branch created.' : `Error: ${result.error}`
      }

      case 'git_switch_branch': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('switch-branch', () => gitSwitchBranch(basePath, args.name as string, this.toolExecutor))
        return result.ok ? result.output || 'Branch switched.' : `Error: ${result.error}`
      }

      case 'git_stash': {
        if (!basePath) return 'Error: no workspace selected'
        const action = args.action as 'list' | 'push' | 'apply' | 'pop'
        const operation = () => gitStash(basePath, action, this.toolExecutor, {
          message: args.message as string | undefined,
          includeUntracked: args.include_untracked === true,
          stash: args.stash as string | undefined,
        })
        const result = action === 'list' ? await operation() : await this.runGitOperation(`stash-${action}`, operation)
        return result.ok ? result.output || 'Stash operation completed.' : `Error: ${result.error}`
      }

      case 'git_push': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('push', () => gitPush(basePath, this.toolExecutor, {
          remote: args.remote as string | undefined,
          branch: args.branch as string | undefined,
          setUpstream: args.set_upstream === true,
        }))
        return result.ok ? result.output || 'Push completed.' : `Error: ${result.error}`
      }

      case 'git_restore': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('restore', () => gitRestorePaths(
          basePath,
          args.paths as string[],
          this.toolExecutor,
          args.source as string | undefined,
        ))
        return result.ok ? result.output || 'Paths restored.' : `Error: ${result.error}`
      }

      case 'git_revert': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.runGitOperation('revert', () => gitRevertCommit(basePath, args.revision as string, this.toolExecutor))
        if (!result.ok) return `Error: ${result.error}`
        return `${result.hash ? `Revert commit ${result.hash}` : 'Revert commit created'}${result.output ? `\n${result.output}` : ''}`
      }

      case 'run_command': {
        const cwd = args.cwd ? this.resolvePath(basePath, args.cwd as string) : basePath
        const env = args.env as Record<string, string> | undefined
        const timeout = args.timeout as number | undefined
        const approved = args.approved === true
        const runInBackground = args.run_in_background === true
        const foregroundCommand = args.command as string
        const foregroundWasExplicit = Object.prototype.hasOwnProperty.call(args, 'run_in_background')
          && args.run_in_background === false
        const autoBackground = !runInBackground
          && !foregroundWasExplicit
          && shouldAutoBackgroundCommand(foregroundCommand)
        const useBackground = runInBackground || autoBackground
        const displayTitle = typeof args.display_title === 'string' ? args.display_title.trim() : ''
        const displayKind = args.display_kind as RuntimeTaskPresentationKind | undefined
        const displayDetail = typeof args.display_detail === 'string' ? args.display_detail.trim() : undefined
        const previewUrl = typeof args.preview_url === 'string' ? normalizeLocalPreviewUrl(args.preview_url) : undefined
        if (!displayTitle || !displayKind) {
          return 'Error: run_command requires display_kind and display_title so the user can understand the work in progress.'
        }
        if (args.preview_url && !previewUrl) {
          return 'Error: preview_url must be an http(s) localhost URL.'
        }
        const presentation: RuntimeTaskPresentation = {
          kind: displayKind,
          title: displayTitle,
          detail: displayDetail,
          previewUrl,
        }

        if (useBackground) {
          const command = foregroundCommand
          const validation = await this.toolExecutor.validateCommand?.(command, cwd)
          if (validation && !validation.success) {
            return `Error: ${validation.error || 'command validation failed'}`
          }

          const directResult = this.toolExecutor.startBackgroundCommand
            ? await this.toolExecutor.startBackgroundCommand(command, cwd, env, approved, presentation)
            : undefined
          const ptyResult = directResult || await this.toolExecutor.ptyCreate?.({ cwd, env, presentation })
          const sessionId = ptyResult?.data?.sessionId
          if (!sessionId) {
            return `Error: failed to spawn agent terminal${ptyResult?.error ? ` — ${ptyResult.error}` : ''}`
          }
          const terminalLogPath = ptyResult.data?.session?.logPath
          if (!directResult) {
            const writeResult = await this.toolExecutor.ptyWrite?.(sessionId, `${command}\n`)
            if (!writeResult?.success) {
              await this.toolExecutor.ptyKill?.(sessionId)
              await this.emitTerminalSessions()
              return `Error: failed to start background command — ${writeResult?.error || 'unknown error'}`
            }
          }
          this.agentBackgroundSessions.set(sessionId, { command, startedAt: Date.now() })
          await this.emitTerminalSessions()
          const prefix = autoBackground
            ? 'Long-running command automatically moved to the background.'
            : 'Background command started.'
          const waitHint = autoBackground
            ? '\nWait for an exited session with code 0 before running dependent commands.'
            : ''
          return `${prefix} Agent terminal: ${sessionId}\nCommand: ${command}${terminalLogPath ? `\nLog: ${terminalLogPath}` : ''}\nUse read_terminal(session_id="${sessionId}") to view output, write_terminal to send stdin, or kill_terminal to stop.${waitHint}`
        }

        // Foreground: exec-based path for one-shot commands
        try {
          const result = await this.toolExecutor.runCommand(foregroundCommand, cwd, env, timeout, approved, operationSignal)
          const commandOutput = result.data
          const outputSections: string[] = []
          if (commandOutput?.stdout) outputSections.push(`stdout:\n${commandOutput.stdout}`)
          if (commandOutput?.stderr) outputSections.push(`stderr:\n${commandOutput.stderr}`)
          if (commandOutput?.truncated) outputSections.push('[command output truncated]')
          if (commandOutput?.logPath) outputSections.push(`log: ${commandOutput.logPath}`)
          const formattedOutput = outputSections.join('\n\n') || 'No output'
          const statusDetails = [
            `code ${commandOutput?.exitCode ?? 'unknown'}`,
            commandOutput?.timedOut ? 'timed out' : '',
            commandOutput?.aborted ? 'aborted' : '',
          ].filter(Boolean).join(', ')
          if (!result.success) {
            return `Error (${statusDetails})${result.error ? `: ${result.error}` : ''}\n${formattedOutput}`
          }
          const exitStatus = typeof commandOutput?.exitCode === 'number'
            ? `Process exited with code ${commandOutput.exitCode}`
            : 'Process finished without an exit code'
          return `${exitStatus}\n${formattedOutput}`
        } catch (e) {
          return `Error executing command: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      case 'read_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return `Error: session_id is required`
        const tail = typeof args.tail_lines === 'number' ? args.tail_lines : 200
        const sinceSeq = typeof args.since_seq === 'number' ? args.since_seq : 0
        const result = await this.toolExecutor.ptyGetBuffer?.(sessionId, sinceSeq)
        if (!result?.success) return `Error: ${result?.error || 'failed to read terminal buffer'}`
        await this.emitTerminalSessions()
        const session = result.session as { status: string; exitCode?: number; cwd: string; logPath?: string } | undefined
        const chunks = (result.chunks || []) as Array<{ seq: number; data: string }>
        const combined = chunks.map((c: { data: string }) => c.data).join('')
        // Strip ANSI escapes for model readability — terminal UI keeps them.
        // eslint-disable-next-line no-control-regex
        const stripped = combined.replace(/\u001B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
        const lines = stripped.split('\n')
        const tailed = tail > 0 ? lines.slice(-tail) : lines
        const truncatedNotice = tail > 0 && lines.length > tail
          ? `[showing last ${tailed.length} of ${lines.length} lines]\n`
          : ''
        const lastSeq = typeof result.lastSeq === 'number'
          ? result.lastSeq
          : chunks.length > 0 ? chunks[chunks.length - 1].seq : sinceSeq
        const sinceNotice = sinceSeq > 0
          ? ` • since_seq=${sinceSeq} • new_chunks=${chunks.length}`
          : ''
        const statusLine = session
          ? `[session ${sessionId} • status=${session.status}${typeof session.exitCode === 'number' ? ` • exit=${session.exitCode}` : ''} • cwd=${session.cwd}${session.logPath ? ` • log=${session.logPath}` : ''} • last_seq=${lastSeq}${sinceNotice}]`
          : `[session ${sessionId} • last_seq=${lastSeq}${sinceNotice}]`
        const omittedNotice = (result.omittedBytes || 0) > 0
          ? `[${result.omittedBytes} earlier output byte(s) omitted from memory; full output remains in the session log]\n`
          : ''
        const body = chunks.length === 0 && sinceSeq > 0
          ? '[no new output since last read]'
          : `${omittedNotice}${truncatedNotice}${tailed.join('\n')}`
        return `${statusLine}\n${body}`
      }

      case 'write_terminal': {
        const sessionId = args.session_id as string
        const data = args.data as string
        if (!sessionId) return `Error: session_id is required`
        if (typeof data !== 'string' || data.length === 0) return `Error: data is required`
        const result = await this.toolExecutor.ptyWrite?.(sessionId, data)
        if (!result?.success) return `Error: ${result?.error || 'failed to write terminal stdin'}`
        await this.emitTerminalSessions()
        return `Wrote ${Buffer.byteLength(data)} byte(s) to terminal ${sessionId}.`
      }

      case 'kill_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return `Error: session_id is required`
        // Try interrupting the current command first (Ctrl+C semantics);
        // fall back to killing the session entirely if the model passes
        // hard=true (or interrupt fails).
        const hard = args.hard === true
        if (!hard) {
          const interrupt = await this.toolExecutor.ptyInterruptCommand?.(sessionId)
          if (interrupt && interrupt.success) {
            await new Promise(resolve => setTimeout(resolve, 750))
            const session = await this.getTerminalSession(sessionId)
            if (!session || session.status !== 'running') {
              this.agentBackgroundSessions.delete(sessionId)
              await this.emitTerminalSessions()
              return `Terminal ${sessionId} interrupted and exited.`
            }
            // A plain stdin Ctrl+C is not reliable without a real PTY, so
            // fall through to process-tree termination when the shell is
            // still alive after the graceful attempt.
            await this.emitTerminalSessions()
          }
        }
        const killed = await this.toolExecutor.ptyKill?.(sessionId)
        if (killed && killed.success) {
          this.agentBackgroundSessions.delete(sessionId)
          await this.emitTerminalSessions()
          return `Terminal ${sessionId} terminated.`
        }
        return `Error: failed to kill terminal ${sessionId} — ${killed?.error || 'unknown error'}`
      }

      case 'list_terminals': {
        const result = await this.toolExecutor.ptyList?.()
        if (!result?.success) return `Error: ${result?.error || 'failed to list terminals'}`
        const rawSessions = (result.sessions || []) as Array<{ isAgentSession?: boolean; id: string; status: string; exitCode?: number; cwd: string; logPath?: string; command?: string; title?: string }>
        const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
        await this.emitTerminalSessions()
        if (sessions.length === 0) return 'No agent terminal sessions active.'
        const lines = sessions.map(s => {
          const meta = this.agentBackgroundSessions.get(s.id)
          const command = meta?.command || s.command || s.title
          const cmd = command ? ` • command: ${command}` : ''
          const exit = typeof s.exitCode === 'number' ? ` • exit=${s.exitCode}` : ''
          const log = s.logPath ? ` • log=${s.logPath}` : ''
          return `- ${s.id} • ${s.status}${exit} • cwd=${s.cwd}${log}${cmd}`
        })
        return `${sessions.length} agent terminal session(s):\n${lines.join('\n')}`
      }

      case 'delete_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) return `Error: unable to read file before deletion - ${existing.error}`
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.deleteFile(filePath, {
          source: 'ai',
          label: 'AI delete_file',
          expectedHash: hashText(existing.data || ''),
        })
        return result.success ? `File deleted: ${args.path}` : `Error: ${result.error}`
      }

      case 'ask_user': {
        const response = await this.interactiveRequests.request({
          id: toolCallId,
          kind: 'input',
          event: {
            type: 'ask:user',
            requestId: toolCallId,
            question: args.question as string,
            options: args.options as string[] | undefined,
            reason: args.reason as string | undefined,
            command: args.command as string | undefined,
          },
        }, { signal: operationSignal, cancelDecision: 'deny' })
        this.resolvedAskUserResponses.set(toolCallId, response)
        return `[User response] ${response}`
      }

      case 'notify_user': {
        this.emit({ type: 'notification', message: args.message as string, level: (args.type as 'info' | 'success' | 'warning' | 'error') || 'info' })
        return `Notification sent`
      }

      case 'list_agents': {
        const tasks = this.subAgentTaskManager.listTasks()
        if (tasks.length === 0) return 'No subagent tasks found.'
        return tasks.map(task => {
          const elapsedMs = (task.runtimeTask.endedAt || Date.now()) - task.startedAt
          return `[${task.runtimeTask.status}] ${task.id} · ${task.agentType} · ${elapsedMs}ms\n  ${task.objective}`
        }).join('\n')
      }

      case 'read_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return 'Error: agent_id is required'
        const task = this.subAgentTaskManager.getTask(agentId)
        if (!task) return `Error: unknown agent_id "${agentId}".`
        const transcript = this.subAgentTaskManager.readTranscript(agentId, {
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        const lines = [this.formatSubAgentTask(task)]
        if (transcript.records.length > 0) {
          lines.push('', `Transcript records ${transcript.offset}-${transcript.nextOffset - 1} of ${transcript.total}:`)
          transcript.records.forEach((record, index) => {
            let detail: string
            if (record.type === 'start') detail = `${record.task.agentType} started`
            else if (record.type === 'event') {
              try { detail = JSON.stringify(record.event).slice(0, 1200) } catch { detail = '[unserializable event]' }
            } else if (record.type === 'result') detail = `result ${record.status}${record.error ? `: ${record.error}` : ''}`
            else detail = `${record.status}${record.error ? `: ${record.error}` : ''}`
            lines.push(`${transcript.offset + index}: ${record.type} · ${detail}`)
          })
          if (transcript.nextOffset < transcript.total) lines.push(`Next offset: ${transcript.nextOffset}`)
        }
        return lines.join('\n')
      }

      case 'cancel_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return 'Error: agent_id is required'
        try {
          const task = await this.subAgentTaskManager.stopTask(agentId)
          return `Subagent ${agentId} is ${task.status}.`
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      case 'spawn_agent': {
        const agentType = String(args.agent_type || '').trim()
        const objective = String(args.objective || '').trim()
        const extraContext = typeof args.context === 'string' ? args.context.trim() : ''
        if (!agentType) return 'Error: agent_type is required'
        if (!objective) return 'Error: objective is required'
        const def = getSubAgentDefinition(agentType)
        if (!def) return `Error: unknown agent_type "${agentType}". Available: ${getAvailableAgentTypes().join(', ')}.`
        if (!this.config.workspacePath) {
          return 'Error: no workspace open; cannot spawn subagent.'
        }
        const enrichedObjective = extraContext ? `${objective}\n\nAdditional context from parent agent:\n${extraContext}` : objective
        const task = this.startSubAgentTask(def, objective, enrichedObjective)
        return `Subagent ${def.label} started in the background. Agent ID: ${task.id}. Use read_agent to inspect progress/results, list_agents to list tasks, or cancel_agent to stop it.`
      }

      case 'use_skill': {
        const skillId = String(args.skill_id || '').trim()
        const reason = args.reason as string | undefined
        if (!skillId) return 'Error: skill_id is required'
        const skill = this.config.enabledSkills?.find(candidate => candidate.id === skillId || candidate.name === skillId || candidate.command === skillId)
        if (!skill) return `Error: skill "${skillId}" is not enabled for this session`
        const alreadyActive = this.activatedRunSkills.has(skill.id)
        this.activatedRunSkills.set(skill.id, skill)
        if (alreadyActive) return `Skill already active for this task: ${skill.name || skill.id}`
        return reason ? `Skill activated for this task: ${skill.name || skill.id} (${reason})` : `Skill activated for this task: ${skill.name || skill.id}`
      }

      default:
        if (this.mcpClient && isMcpTool(name)) {
          const signal = operationSignal
          const result = signal
            ? await executeMcpTool(this.mcpClient, name, args, { signal })
            : await executeMcpTool(this.mcpClient, name, args)
          if (result.isError) throw new Error(result.output)
          return {
            output: result.output,
            attachments: result.attachments,
          }
        }
        return `Unknown tool: ${name}`
    }
  }

  private startSubAgentTask(
    definition: SubAgentDefinition,
    objective: string,
    enrichedObjective: string,
    retryOf?: string,
  ): RuntimeTask {
    if (!this.config.workspacePath) throw new Error('No workspace open; cannot spawn subagent')
    const startedAt = Date.now()
    const started = this.subAgentTaskManager.startTask<Awaited<ReturnType<typeof runSubAgent>>>({
      kind: 'agent',
      agentType: definition.id,
      label: definition.label,
      objective,
      workspacePath: this.config.workspacePath,
      ownerSessionId: this.config.conversationId,
      retryOf,
      workRunId: this.workExecution.getCurrentRunId() || undefined,
      stepId: this.taskManager.getActiveTaskContext()?.taskId,
      run: async ({ signal, recordEvent, taskId }) => {
        const onSubEvent = (event: SubAgentEvent) => {
          recordEvent(event)
          this.emitSubAgentProgress(taskId, definition.id, definition.label, event)
        }
        const skeleton = await this.maybeBuildWorkspaceSkeleton(this.config.workspacePath!)
        const activeConfig = this.stateProvider.getActiveConfig()
        const activeModel = this.stateProvider.getActiveModel()
        return runSubAgent({
          definition,
          objective: enrichedObjective,
          workspacePath: this.config.workspacePath!,
          toolExecutor: this.toolExecutor,
          apiKey: activeConfig?.apiKey || '',
          baseUrl: activeConfig?.baseUrl || 'https://api.deepseek.com',
          provider: activeConfig?.provider,
          customHeaders: activeConfig?.customHeaders,
          modelCapabilities: activeConfig?.modelCapabilities,
          model: activeModel?.id || activeConfig?.defaultModel,
          codemap: skeleton,
          abortSignal: signal,
          onEvent: onSubEvent,
        })
      },
      isSuccess: result => result.ok,
      getError: result => result.error || 'Subagent failed',
    })
    this.emit({
      type: 'subagent:start',
      agentId: started.task.id,
      agentType: definition.id,
      label: definition.label,
      objective,
    })
    void started.promise.then(
      result => this.emit({
        type: 'subagent:end',
        agentId: started.task.id,
        agentType: definition.id,
        ok: result.ok,
        elapsedMs: Date.now() - startedAt,
      }),
      () => this.emit({
        type: 'subagent:end',
        agentId: started.task.id,
        agentType: definition.id,
        ok: false,
        elapsedMs: Date.now() - startedAt,
      }),
    )
    return started.task
  }

  private formatContentSearchResults(results: Array<{ file: string; line: number; text: string; startLine?: number; endLine?: number; snippet?: string; content?: string }>): string {
    const MAX_HITS = 40
    const hits = results.slice(0, MAX_HITS)
    const basePath = this.stateProvider.getWorkspace()?.path || ''
    const lines = hits.flatMap(r => {
      const startLine = r.startLine ?? r.line
      const endLine = r.endLine ?? r.line
      const body = r.snippet || r.content || r.text || ''
      return [
        `@@ ${this.toWorkspaceRelative(basePath, r.file)}:${startLine}-${endLine} (match ${r.line})`,
        body,
      ]
    })
    if (results.length > MAX_HITS) {
      lines.push(`... ${results.length - MAX_HITS} more matches truncated`)
    }
    return lines.join('\n')
  }

  private formatCodeSearchHits(hits: CodeSearchHit[]): string {
    if (hits.length === 0) return 'No matches found'
    return hits.flatMap(hit => [
      `@@ ${hit.path}:${hit.startLine}-${hit.endLine} (match ${hit.line})`,
      hit.preview || `${hit.title} · ${hit.subtitle}`,
    ]).join('\n')
  }

  private formatCodeMap(node: CodeMapNode, depth = 0): string {
    return formatCodeMap(node, depth)
  }

  private formatWebSearchResults(response: WebSearchResponse): string {
    const attr = (value: string): string => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    const clean = (value: string | undefined): string => String(value || '').replace(/\s+/g, ' ').trim()

    const lines = [
      `<web_search_results query="${attr(response.query)}" provider="${attr(response.provider)}" count="${response.results.length}" retrieved_at="${attr(response.retrievedAt)}" partial="${response.partial}">`,
    ]
    if (response.queries.length > 1) lines.push(`queries: ${response.queries.map(clean).join(' | ')}`)
    response.warnings.forEach(warning => lines.push(`warning: ${clean(warning)}`))
    response.results.forEach((result, index) => {
      const title = clean(result.title) || '(untitled)'
      const snippet = clean(result.snippet)
      lines.push(`${result.id || `S${index + 1}`}. ${title}`)
      lines.push(`   url: ${result.url}`)
      if (result.domain) lines.push(`   domain: ${result.domain}`)
      if (snippet) lines.push(`   snippet: ${snippet}`)
      if (result.source) lines.push(`   source: ${clean(result.source)}`)
      if (result.publishedDate) lines.push(`   published: ${clean(result.publishedDate)}`)
      if (typeof result.score === 'number') lines.push(`   relevance: ${result.score}`)
    })
    lines.push('</web_search_results>')
    return lines.join('\n')
  }

  private formatWebFetchResults(response: WebFetchResponse): string {
    const attr = (value: string): string => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    const lines = [`<web_sources count="${response.pages.length}" retrieved_at="${attr(response.retrievedAt)}" partial="${response.partial}" untrusted="true">`]
    response.warnings.forEach(warning => lines.push(`warning: ${warning.replace(/\s+/g, ' ').trim()}`))
    response.pages.forEach((page, index) => {
      lines.push(`<source id="W${index + 1}" title="${attr(page.title)}" url="${attr(page.finalUrl)}" domain="${attr(page.domain)}" retrieved_at="${attr(page.retrievedAt)}" truncated="${page.truncated}">`)
      if (page.publishedDate) lines.push(`published: ${page.publishedDate}`)
      lines.push(page.text)
      lines.push('</source>')
    })
    response.failures.forEach(failure => lines.push(`failed: ${failure.url} · ${failure.error}`))
    lines.push('</web_sources>')
    return lines.join('\n')
  }

  private resolvePath(basePath: string, relativePath: string): string {
    return resolvePath(basePath, relativePath)
  }

  /**
   * 将绝对路径转为 workspace 相对路径。
   * 返回给 AI 的路径统一用相对路径，避免 AI 在绝对/相对路径之间混淆。
   */
  private toWorkspaceRelative(basePath: string, filePath: string): string {
    return toWorkspaceRelative(basePath, filePath)
  }

  private createUserTurn(
    content: string,
    attachments?: NonNullable<AgentTurn['metadata']>['attachments'],
    id = generateTurnId(),
    capabilities?: NonNullable<AgentTurn['metadata']>['capabilities'],
  ): AgentTurn {
    const metadata: AgentTurn['metadata'] = {}
    if (attachments?.length) metadata.attachments = attachments.map(attachment => ({ ...attachment }))
    if (capabilities?.items.length) metadata.capabilities = { items: capabilities.items.map(item => ({ ...item })) }
    const workRunId = this.workExecution.getCurrentRunId()
    if (workRunId) metadata.workRunId = workRunId
    return {
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
  }

  private createAssistantTurn(
    content: string,
    toolCalls?: ToolCall[],
    metadata?: AgentTurn['metadata']
  ): AgentTurn {
    const finalMetadata: AgentTurn['metadata'] = { ...metadata }
    const workRunId = this.workExecution.getCurrentRunId()
    if (workRunId) finalMetadata.workRunId = workRunId
    let turnId = generateTurnId()
    if (this.pendingAssistantMessageId) {
      turnId = this.pendingAssistantMessageId
      this.pendingAssistantMessageId = null
    }

    return {
      id: turnId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      toolCalls,
      metadata: finalMetadata,
    }
  }

  private finishInterruptedStream(
    textContent: string,
    reasoningContent: string,
    model: APIModel | null,
    startTime: number,
    interruption?: AgentRunInterruption,
  ): AgentTurn | null {
    const visibleText = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
    this.emit({ type: 'stream:end', interrupted: true })
    if (!visibleText && !reasoningContent.trim()) return null
    return this.createAssistantTurn(visibleText, undefined, {
      model: model?.name,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      interrupted: true,
      ...(interruption ? { interruption } : {}),
      thinking: reasoningContent ? {
        content: reasoningContent,
        source: 'provider',
        status: 'interrupted',
        durationMs: Date.now() - startTime,
        tokenCount: Math.max(1, Math.ceil(reasoningContent.length / 4)),
      } : undefined,
    })
  }

  private createToolResultTurn(results: ToolResult[]): AgentTurn {
    const workRunId = this.workExecution.getCurrentRunId()
    return {
      id: generateTurnId(),
      role: 'tool_result',
      content: results.map(r => `${r.name}: ${r.isError ? '[failed]' : '[ok]'} ${(r.output || '').slice(0, 500)}`).join('\n\n'),
      timestamp: Date.now(),
      toolResults: results,
      metadata: workRunId ? { workRunId } : undefined,
    }
  }

  private createMockTurn(): AgentTurn {
    return this.createAssistantTurn(
      `**Mock Response** (No API key configured)\n\nPlease configure your API key in the bottom-left corner to enable AI features.`,
      undefined,
      { mode: this.config.mode }
    )
  }

  private emit(event: AgentEventType): void {
    const traceEnabled = streamTimingTraceEnabled()
    const emitStartedAt = traceEnabled ? performance.now() : 0
    if (traceEnabled && event.type === 'stream:start') {
      this.streamTraceStartedAt = emitStartedAt
      this.streamTraceLastEventAt = emitStartedAt
      this.streamTraceRecorderDurations.clear()
      this.streamTraceListenerDurations.clear()
      this.streamTraceEventIntervals.clear()
    }
    const recorderStartedAt = traceEnabled ? performance.now() : 0
    this.eventRecorder?.(event)
    const listenerStartedAt = traceEnabled ? performance.now() : 0
    for (const listener of this.listeners) {
      listener(event)
    }
    if (!traceEnabled || this.streamTraceStartedAt === 0) return
    const completedAt = performance.now()
    const appendSample = (target: Map<string, number[]>, value: number): void => {
      const samples = target.get(event.type) || []
      samples.push(value)
      target.set(event.type, samples)
    }
    appendSample(this.streamTraceRecorderDurations, listenerStartedAt - recorderStartedAt)
    appendSample(this.streamTraceListenerDurations, completedAt - listenerStartedAt)
    appendSample(this.streamTraceEventIntervals, emitStartedAt - this.streamTraceLastEventAt)
    this.streamTraceLastEventAt = emitStartedAt
    if (event.type !== 'stream:end') return
    const summarizeMap = (source: Map<string, number[]>): Record<string, ReturnType<typeof summarizeTimings>> => Object.fromEntries(
      [...source.entries()].map(([type, samples]) => [type, summarizeTimings(samples)]),
    )
    emitStreamTimingTrace('agent-engine', {
      totalMs: Number((completedAt - this.streamTraceStartedAt).toFixed(3)),
      recorder: summarizeMap(this.streamTraceRecorderDurations),
      listeners: summarizeMap(this.streamTraceListenerDurations),
      intervals: summarizeMap(this.streamTraceEventIntervals),
    })
    this.streamTraceStartedAt = 0
  }

}
