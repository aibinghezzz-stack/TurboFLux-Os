import type {
  ModelPreset,
  ProviderPreset,
  TurboFluxApiConfigProfile,
  TurboFluxConfig,
} from '../../core/config'
import type { ModelReasoningCapabilities } from '../../core/modelRegistry'
import type { PersonaDefinition, TurboFluxProfile } from '../../core/profile'
import type { GitDiffScope, GitIntegrationState, GitOperationResult } from '../../core/gitService'
import type { ActiveTaskContext, TaskTreeNode } from '../../core/taskManager'
import type { McpServerConfig, McpToolInfo } from '../../core/mcp/types'
import type { SkillMarketplaceEntry, SkillMarketplaceSource } from '../../core/skills/marketplace'
import type {
  SkillMarketplaceInstallJob,
  SkillMarketplaceInstallManagerSnapshot,
} from '../../core/skills/marketplaceInstallManager'
import type { ContextCompactionState, ContextSegment } from '../../state/types'
import type { RuntimeTask } from '../../shared/runtimeTaskTypes'
import type { WorkExecutionSnapshot, WorkStepControlAction } from '../../shared/workExecutionTypes'
import type { Memory, MemoryConfidence, MemoryKind, MemoryScope } from '../../shared/memoryTypes'
import type {
  AgentAttachment,
  AgentCapabilitySelection,
  ApprovalPolicy,
  AgentMode,
  AgentRunState,
  CapabilityProfile,
  AgentTurn,
  NativeReasoningConfig,
  TokenUsage,
} from '../../shared/agentTypes'
import type { ConversationMeta, ConversationPersistenceHealth } from '../conversations/index'
import type { AnyConversationEvent } from '../events/index'
import type { ProjectSnapshot } from '../projects/projectService'
import type { AutomationSnapshot } from '../automations/automationService'
import type { ArtifactRecord, ArtifactSnapshot } from '../artifacts/artifactService'
import type { PluginSnapshot } from '../plugins/pluginService'
import type { WorkPackCatalogSnapshot } from '../workPacks/workPackCatalog'
import type { WorkSessionSnapshot } from '../work/index'

export interface WorkbenchSkillSummary {
  id: string
  name: string
  command: string
  description: string
  category: string
  icon?: string
  filePath: string
  active: boolean
}

export interface WorkbenchSkillMarketplaceSnapshot {
  entries: SkillMarketplaceEntry[]
  sources: SkillMarketplaceSource[]
  jobs: SkillMarketplaceInstallJob[]
  recovery?: SkillMarketplaceInstallManagerSnapshot['recovery']
}

export interface WorkbenchSkillMarketplaceInstallResult {
  entry: SkillMarketplaceEntry
  marketplace: WorkbenchSkillMarketplaceSnapshot
  snapshot: WorkbenchSnapshot
}

export type WorkbenchWorkPackSnapshot = WorkPackCatalogSnapshot

export interface WorkbenchSubAgentSummary {
  id: string
  agentType: string
  label: string
  objective: string
  startedAt: number
  endedAt?: number
  updatedAt: number
  status: RuntimeTask['status']
  error?: string
  progress: number
  transcriptCount: number
  lastEvent?: string
  resultSummary?: string
  retryOf?: string
  retryable: boolean
}

export interface WorkbenchSubAgentEvidence {
  path: string
  startLine: number
  endLine: number
  preview: string
  reason: string
  kind?: string
  confidence?: string
  symbol?: string
}

export interface WorkbenchSubAgentTimelineItem {
  id: string
  timestamp: number
  type: 'start' | 'progress' | 'evidence' | 'result' | 'state'
  title: string
  detail?: string
  status?: string
  evidence?: WorkbenchSubAgentEvidence
}

export interface WorkbenchSubAgentDetail {
  task: WorkbenchSubAgentSummary
  timeline: WorkbenchSubAgentTimelineItem[]
  offset: number
  nextOffset: number
  total: number
  result?: {
    ok: boolean
    finalText: string
    turns: number
    elapsedMs: number
    truncated: boolean
    error?: string
    evidence: WorkbenchSubAgentEvidence[]
  }
}

export interface WorkbenchSubAgentActionResult {
  taskId: string
  snapshot: WorkbenchSnapshot
}

export interface WorkbenchActivitySummary {
  execution: WorkExecutionSnapshot
  activeTask: ActiveTaskContext | null
  taskTree: TaskTreeNode[]
  runtimeTasks: RuntimeTask[]
  subagents: WorkbenchSubAgentSummary[]
}

export interface WorkbenchWorkStepActionResult {
  taskId: string
  action: WorkStepControlAction
  snapshot: WorkbenchSnapshot
}

export interface WorkbenchContextSummary {
  usage: TokenUsage
  contextWindow: number
  segments: ContextSegment[]
  compaction: ContextCompactionState | null
}

export interface WorkbenchGitActionResult {
  result: GitOperationResult
  snapshot: WorkbenchSnapshot
}

export interface WorkbenchGitDiffResult {
  path?: string
  scope: GitDiffScope
  result: GitOperationResult
}

export interface WorkbenchArtifactPreview {
  artifact: ArtifactRecord
  mode: 'image' | 'pdf' | 'text' | 'external'
  dataUrl?: string
  text?: string
  message?: string
}

export interface WorkbenchMemoryFilters {
  query?: string
  scope?: MemoryScope
  kind?: MemoryKind
  status?: Memory['status']
  pinned?: boolean
  includeInactive?: boolean
}

export interface WorkbenchMemorySnapshot {
  schemaVersion: 1
  workspacePath: string
  totalCount: number
  injectionTokens: number
  warnings: string[]
  builtAt: number
  items: Memory[]
}

export interface WorkbenchMemoryCreateInput {
  text: string
  scope?: MemoryScope
  kind?: MemoryKind
  confidence?: MemoryConfidence
  tags?: string[]
  pinned?: boolean
}

export interface WorkbenchMemoryUpdateInput {
  text?: string
  scope?: MemoryScope
  kind?: MemoryKind
  confidence?: MemoryConfidence
  tags?: string[]
  pinned?: boolean
  reviewState?: Memory['reviewState']
  status?: Memory['status']
}

export interface WorkbenchMcpToolSummary extends Pick<McpToolInfo, 'name' | 'description' | 'serverName' | 'annotations'> {}

export interface WorkbenchMcpServerSummary {
  name: string
  displayName?: string
  description?: string
  system?: boolean
  enabled: boolean
  command?: string
  args?: string[]
  url?: string
  cwd?: string
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabledTools?: string[]
  disabledTools?: string[]
  envKeys: string[]
  headerKeys: string[]
  status: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error' | 'closed'
  error?: string
  tools: WorkbenchMcpToolSummary[]
}

export interface WorkbenchMcpServerInput extends Omit<McpServerConfig, 'env' | 'httpHeaders'> {
  name: string
  env?: Record<string, string>
  httpHeaders?: Record<string, string>
  preserveEnv?: boolean
  preserveHttpHeaders?: boolean
}

export interface WorkbenchFileReference {
  id: string
  type: 'image' | 'file'
  path: string
  mime: string
  filename: string
  size: number
}

export interface WorkbenchPendingPaste {
  placeholder: string
  text: string
}

export interface WorkbenchDraftSnapshot {
  text: string
  attachments: AgentAttachment[]
  files: WorkbenchFileReference[]
  pendingPastes: WorkbenchPendingPaste[]
  capabilities: AgentCapabilitySelection
}

export type WorkbenchCommandId =
  | 'mode.vibe' | 'mode.plan'
  | 'run.pause' | 'run.resume' | 'run.stop'
  | 'context.open' | 'context.compact'
  | 'git.open' | 'git.refresh'
  | 'activity.open' | 'mcp.open' | 'skills.open'
  | 'conversation.new' | 'flow.retry' | 'flow.export'
  | `plugin:${string}:${string}`

export interface WorkbenchCommandDefinition {
  id: WorkbenchCommandId
  slash?: string
  title: string
  detail: string
  group: '运行' | '工作区' | '能力' | '工具' | '会话'
  keywords: string[]
  shortcut?: string
}

export interface WorkbenchCommandResult {
  message?: string
  snapshot?: WorkbenchSnapshot
  open?: 'activity' | 'context' | 'git' | 'mcp' | 'skills'
}

export interface WorkbenchInteractiveRequest {
  id: string
  kind: 'permission' | 'input'
  question: string
  options?: string[]
  reason?: string
  command?: string
  toolName?: string
  path?: string
}

export interface WorkbenchRuntimeSummary {
  status: 'ready' | 'running' | 'paused' | 'awaiting-action' | 'error'
  configured: boolean
  provider: TurboFluxConfig['provider']
  model: string
  reasoning?: NativeReasoningConfig
  mode: AgentMode
  approvalPolicy: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  runState: AgentRunState
  pendingRequests: WorkbenchInteractiveRequest[]
}

export interface WorkbenchConversationRuntimeSummary {
  conversationId: string
  status: WorkbenchRuntimeSummary['status']
  runState: AgentRunState
  updatedAt: number
}

export interface WorkbenchSnapshot {
  schemaVersion: 1
  product: 'TurboFlux Workbench'
  platform: NodeJS.Platform
  workspace: {
    path: string
    name: string
  }
  runtime: WorkbenchRuntimeSummary
  conversation: {
    id: string
    turns: AgentTurn[]
    recovery?: {
      interrupted: boolean
      truncatedJournal: boolean
      unresolvedToolCalls: number
    }
  }
  conversations: ConversationMeta[]
  conversationCatalog: ConversationMeta[]
  conversationRuntimes: WorkbenchConversationRuntimeSummary[]
  work: WorkSessionSnapshot
  skills: WorkbenchSkillSummary[]
  context: WorkbenchContextSummary
  git: GitIntegrationState
  activity: WorkbenchActivitySummary
  projects: ProjectSnapshot
  automations: AutomationSnapshot
  artifacts: ArtifactSnapshot
  plugins: PluginSnapshot
  draft: WorkbenchDraftSnapshot
  persistence: ConversationPersistenceHealth
}

export type WorkbenchEvent =
  | { type: 'conversation-event'; conversationId: string; event: AnyConversationEvent }
  | { type: 'snapshot'; snapshot: WorkbenchSnapshot }
  | { type: 'persistence'; health: ConversationPersistenceHealth }
  | { type: 'skill-marketplace-install'; job: SkillMarketplaceInstallJob }
  | { type: 'runtime-error'; message: string; conversationId?: string }
  | { type: 'conversation-run'; conversationId: string; status: 'completed' | 'failed' | 'interrupted' }

export interface WorkbenchSubmitResult {
  status: 'started' | 'steering' | 'queued'
  inputId: string
}

export interface WorkbenchConversationResult {
  id: string
  snapshot: WorkbenchSnapshot
}

export interface WorkbenchApiConfigSummary extends Omit<TurboFluxApiConfigProfile, 'apiKey'> {
  hasApiKey: boolean
}

export interface WorkbenchModelOption extends ModelPreset {
  reasoningCapabilities: ModelReasoningCapabilities | null
}

export interface WorkbenchSettingsSnapshot {
  schemaVersion: 1
  activeApiConfigId?: string
  approvalPolicy: ApprovalPolicy
  capabilityProfile: CapabilityProfile
  gitEnabled: boolean
  apiProfiles: WorkbenchApiConfigSummary[]
  providerPresets: ProviderPreset[]
  models: WorkbenchModelOption[]
  modelDiscovery: {
    source: 'network' | 'cache' | 'fallback'
    stale: boolean
    fetchedAt: number
    error?: string
  }
  profile: TurboFluxProfile
  personas: PersonaDefinition[]
  skills: WorkbenchSkillSummary[]
  mcpServers: WorkbenchMcpServerSummary[]
  plugins: PluginSnapshot
}

export interface WorkbenchApiConfigInput {
  id: string
  name: string
  provider: TurboFluxConfig['provider']
  apiKey?: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  reasoning?: NativeReasoningConfig
}

export interface WorkbenchSettingsUpdate {
  activeApiConfigId?: string
  approvalPolicy: ApprovalPolicy
  capabilityProfile: CapabilityProfile
  gitEnabled: boolean
  mcpServers?: WorkbenchMcpServerInput[]
  apiProfiles: WorkbenchApiConfigInput[]
  profile: Partial<TurboFluxProfile>
}

export interface WorkbenchSettingsSaveResult {
  settings: WorkbenchSettingsSnapshot
  snapshot: WorkbenchSnapshot
}
