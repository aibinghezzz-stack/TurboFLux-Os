import {
  isBuiltInBrowserTool,
  isBuiltInComputerTool,
  stripTextToolCallMarkup,
  type ThinkingTrace,
} from '@turboflux/agent-core/renderer'
import type {
  AgentAttachment,
  AgentCapabilityReference,
  AgentCapabilitySelection,
  AgentTurn,
  AnyConversationEvent,
  ApprovalPolicy,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  ChangeSummary,
  ToolCall,
  ToolResult,
  WorkbenchArtifactPreview,
  WorkbenchCommandResult,
  WorkbenchFileReference,
  WorkbenchPendingPaste,
  WorkbenchSnapshot,
  WorkStepControlAction,
} from '@turboflux/agent-core/workbench'
import type { DesktopWorkbenchEvent as WorkbenchEvent, DesktopWorkbenchSnapshot } from '../desktopTypes'
import { projectHistoryRewrite } from '../historyRewrite'
import {
  createThinkingBlock,
  createToolActivity,
  isInternalRuntimeTool,
  renderDiffPreview,
  renderMarkdown,
} from './richContent'
import { describeRuntimeTask } from './runtimeTaskPresentation'
import { createSettingsCenter, createSettingsUpdate } from './settingsCenter'
import { reasoningEffortLabel, reasoningTone } from './reasoningPresentation'
import { createCommandPalette } from './commandPalette'
import { createComputerControls } from './computerControls'
import { formatCreditMultiplier, modelProviderMark, normalizedModelProvider } from './modelPresentation'
import { createImageLightbox, type ImageLightbox, type ImageLightboxItem } from './imageLightbox'
import { renderVisualEvidence, visualEvidenceItems } from './visualEvidence'
import {
  conversationRenderSignature,
  hasRenderableTurnPayload,
  isHistoryRewriteUserTurn,
  isLegacyRecoveryPlaceholder,
  isInternalRequestErrorTurn,
  latestUserTurnId,
  latestConversationFailure,
  requestStatusTerminalFenceApplies,
  shouldIgnoreSnapshotAfterRequestTerminal,
  type RequestStatusTerminalFence,
} from './conversationRendering'
import {
  executionOutcomeFromWorkRunStatus,
} from './executionPresentation'
import { presentWorkRun, selectProjectedWorkRun, selectWorkRun } from './workExecutionPresentation'
import {
  applyTaskFlowEvent,
  createTaskFlowProjection,
  latestTaskFlowNodeId,
  projectTaskFlowSnapshot,
  taskFlowNodeIdForTool,
  taskFlowNodeIdForTurn,
  type TaskFlowNodeKind,
  type TaskFlowProjectionState,
} from './taskFlowProjection'
import { NEW_TASK_TITLE, taskDisplayTitle, visibleTaskConversations } from '../conversationPolicy'
import { contextUsageTokenCount } from '../contextUsageRecovery'
import {
  INSPECTOR_MINIMUM_WIDTH,
  clampInspectorWidth as clampInspectorWidthValue,
  defaultInspectorWidth as defaultInspectorWidthValue,
  inspectorDismissTriggerX,
  inspectorWidthFromKey,
  maximumInspectorWidth as maximumInspectorWidthValue,
  shouldDismissInspectorAtPointer,
} from './inspectorResize'
import {
  renderActivityPanel,
  renderContextPanel,
  renderGitPanel,
} from './workbenchPanels'
import { presentTaskCompanion, type TaskCompanionItemKind } from './taskCompanion'
import {
  createTranscriptFollowState,
  forceTranscriptFollow,
  historyRewriteLeadingSpace,
  historyRewriteTailSpace,
  suspendTranscriptFollow,
  transcriptDistanceFromBottom,
  updateTranscriptFollowFromScroll,
} from './transcriptFollow'
import {
  createFallbackLinearMessage,
  createLinearTaskFlowRenderer,
} from './linearTaskFlow'
import { createWorkPlanDockRenderer } from './workPlanPresentation'
import { SerializedAsyncQueue, SingleFlightGuard } from './interactionConcurrency'
import { projectWorkspaceConversationGroups } from './workspaceConversationProjection'

type InspectorTab = 'overview' | 'activity' | 'outputs' | 'browser' | 'context' | 'git'
type BrowserDisplayMode = 'workspace' | 'inspector' | null
type ProductTitlePhase = 'typing' | 'holding' | 'deleting' | 'switching'

const productTitleVariants = [
  { word: 'Work', className: 'is-work' },
  { word: 'Code', className: 'is-code' },
] as const
const PRODUCT_TITLE_TYPE_DELAY = 120
const PRODUCT_TITLE_DELETE_DELAY = 78
const PRODUCT_TITLE_HOLD_DELAY = 1550
const PRODUCT_TITLE_SWITCH_DELAY = 260

const icon = (name: string) => {
  const icons: Record<string, string> = {
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4H7.5A2.5 2.5 0 0 1 5 12.5z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M4 7v5h5"/><path d="M5.5 17.5A8 8 0 1 0 4 12"/><path d="M12 8v4l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24"><path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.2-8.2"/></svg>',
    plug: '<svg viewBox="0 0 24 24"><path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-3 0h6"/></svg>',
    computer: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/><circle cx="8" cy="10.5" r="1.25"/><path d="M12 9h5M12 12h3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.2 13.6 1.2.9-1.8 3.1-1.4-.6a7.6 7.6 0 0 1-1.7 1l-.2 1.5h-3.6l-.2-1.5a7.6 7.6 0 0 1-1.7-1l-1.4.6-1.8-3.1 1.2-.9a7.7 7.7 0 0 1 0-2l-1.2-.9 1.8-3.1 1.4.6a7.6 7.6 0 0 1 1.7-1l.2-1.5h3.6l.2 1.5a7.6 7.6 0 0 1 1.7 1l1.4-.6 1.8 3.1-1.2.9a7.7 7.7 0 0 1 0 2Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M21 3 10.6 13.4"/><path d="m21 3-6.7 18-3.7-7.6L3 9.7Z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    command: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m9 9 2.5 3L9 15m4.5 0H16"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M15 4v16"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12M10 10v6m4-6v6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>',
  }
  return `<span class="icon icon-${name}">${icons[name] || icons.grid}</span>`
}

export function mountWorkbench(app: HTMLDivElement): void {
  const platform = navigator.platform || navigator.userAgent
  document.documentElement.classList.toggle('platform-macos', /Mac/i.test(platform))
  app.innerHTML = `
    <div class="desktop-shell">
      <aside class="sidebar">
        <button class="new-task" id="new-task">${icon('plus')}<span>新建任务</span></button>

        <nav class="sidebar-nav" aria-label="工作区导航">
          <button class="sidebar-nav-item active" data-view="workbench">${icon('grid')}<span>工作台</span></button>
          <button class="sidebar-nav-item" data-view="projects">${icon('folder')}<span>项目</span></button>
          <button class="sidebar-nav-item" data-view="automations">${icon('command')}<span>自动化</span></button>
          <button class="sidebar-nav-item work-packs-entry" data-view="skills">${icon('plug')}<span>插件</span></button>
        </nav>

        <div class="sidebar-section sidebar-history">
          <div class="workspace-task-header">
            <span>工作区</span>
            <span class="workspace-task-actions">
              <button class="tiny-button" id="workspace-task-search-toggle" title="搜索任务" aria-label="搜索任务">${icon('search')}</button>
              <button class="tiny-button" id="workspace-task-manage" title="管理工作区" aria-label="管理工作区">${icon('settings')}</button>
              <button class="tiny-button" id="workspace-task-add" title="添加工作区" aria-label="添加工作区">${icon('plus')}</button>
            </span>
          </div>
          <div class="workspace-task-search" id="workspace-task-search" role="search" hidden>
            ${icon('search')}
            <input id="workspace-task-search-input" type="search" aria-label="搜索工作区或任务" placeholder="搜索工作区或任务" autocomplete="off" />
            <button id="workspace-task-search-close" type="button" title="关闭搜索" aria-label="关闭搜索">${icon('close')}</button>
          </div>
          <div id="conversation-list"></div>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-utilities">
            <button class="sidebar-nav-item sidebar-settings" id="settings-button" title="设置">${icon('settings')}<span>设置</span></button>
          </div>
        </div>
      </aside>

      <main class="main-panel" id="main-panel">
        <header class="topbar">
          <div class="breadcrumb"><strong id="breadcrumb-title">工作台</strong></div>
          <section class="task-companion" id="task-companion" aria-live="polite" aria-hidden="true"></section>
          <div class="topbar-actions">
            <button class="icon-button" id="inspector-toggle" title="打开工作侧栏">${icon('panel')}</button>
          </div>
        </header>

        <section class="work-plan-dock" id="work-plan-dock" aria-live="polite" hidden></section>

        <div class="main-scroll" id="main-scroll">
          <section class="recovery-banner" id="recovery-banner"></section>
          <section class="welcome-block" id="welcome-block">
            <h1 class="workbench-prompt-title" aria-label="TurboFlux Work 与 TurboFlux Code"><span class="workbench-title-brand">TurboFlux</span><span class="workbench-title-product is-work" id="workbench-title-product" aria-hidden="true"><span id="workbench-title-text"></span><span class="workbench-title-caret" id="workbench-title-caret"></span></span></h1>
          </section>
          <section class="transcript" id="transcript" aria-live="polite"></section>

          <div class="composer-stack">
            <section class="composer-card" id="composer-card">
              <div class="draft-tray" id="draft-tray"></div>
              <div class="composer-capability-tray" id="composer-capability-tray"></div>
              <textarea id="task-input" placeholder="交代一项工作，或粘贴需要处理的内容" rows="2"></textarea>
              <div class="composer-bottom">
                <div class="composer-tools"><button class="composer-add-button" id="composer-add" title="添加文件" aria-haspopup="menu" aria-expanded="false">${icon('plus')}</button><button class="composer-slant-tab capability-tab" id="capability-tab" title="选择能力包" aria-haspopup="menu" aria-expanded="false">${icon('plug')}<span id="capability-name">能力包</span><b id="capability-count" aria-hidden="true"></b><span class="chevron-down">⌄</span></button><button class="approval-pill" id="approval-pill" aria-haspopup="menu" aria-expanded="false"><span class="approval-status-dot"></span><span id="approval-name">审批策略</span><span class="chevron-down">⌄</span></button></div>
                <div class="composer-submit"><button class="composer-context" id="composer-context" type="button" aria-label="查看上下文使用情况"><span class="composer-context-ring" aria-hidden="true"></span></button><button class="composer-slant-tab reasoning-tab" id="reasoning-tab" data-reasoning-tone="none" title="选择推理强度" aria-haspopup="menu" aria-expanded="false"><span>推理</span><strong id="reasoning-name">加载中</strong><span class="chevron-down">⌄</span></button><button class="model-pill" id="model-pill" aria-haspopup="menu" aria-expanded="false"><span class="model-pill-icon" id="model-icon" aria-hidden="true"></span><span id="model-name">加载中</span><span class="model-pill-multiplier" id="model-multiplier"></span><span class="chevron-down">⌄</span></button><button class="run-button" id="run-button" title="发送">${icon('arrow')}</button></div>
              </div>
            </section>
            <div class="composer-start-context" id="composer-start-context" aria-hidden="false">
              <span class="composer-start-runtime">${icon('computer')}<span>本机执行</span></span>
              <button class="composer-start-workspace" id="composer-start-workspace" title="选择工作区">${icon('folder')}<span id="composer-start-workspace-name">选择工作区</span><small id="composer-start-workspace-action">选择</small>${icon('chevron')}</button>
            </div>
            <div class="composer-menu" id="composer-menu" aria-hidden="true"></div>
            <div class="capability-menu" id="capability-menu" aria-hidden="true"></div>
            <div class="approval-menu" id="approval-menu" aria-hidden="true"></div>
          </div>

        </div>

        <section class="product-view" id="product-view" aria-hidden="true"></section>

        <section class="browser-workspace" id="browser-workspace" aria-hidden="true">
          <div class="browser-tabbar">
            <div class="browser-tabs" id="browser-tabs"></div>
            <button class="browser-tab-action" id="browser-new-tab" title="新建标签页">${icon('plus')}</button>
            <span class="browser-activity-pill" id="browser-activity" hidden>${icon('spark')}<span>浏览器工作中</span></span>
            <button class="browser-tab-action" id="browser-close" title="关闭浏览器">${icon('close')}</button>
          </div>
          <div class="browser-toolbar">
            <div class="browser-nav-actions">
              <button id="browser-back" title="后退">${icon('back')}</button>
              <button id="browser-forward" title="前进">${icon('forward')}</button>
              <button id="browser-reload" title="刷新">${icon('reload')}</button>
            </div>
            <form class="browser-address-form" id="browser-address-form">
              ${icon('globe')}
              <input id="browser-address" aria-label="浏览器地址" autocomplete="off" spellcheck="false" placeholder="搜索或输入网址">
              <span class="browser-security-label">隔离浏览</span>
            </form>
            <button class="browser-toolbar-action" id="browser-open-external" title="在默认浏览器中打开">${icon('external')}</button>
          </div>
          <div class="browser-native-surface" id="browser-native-surface"><div><span>${icon('globe')}</span><p>浏览器正在准备</p></div></div>
        </section>

      </main>

      <button class="inspector-scrim" id="inspector-scrim" aria-label="关闭侧栏"></button>
      <aside class="inspector" id="inspector-panel">
        <button class="inspector-resize-handle" id="inspector-resize-handle" type="button" role="separator" aria-orientation="vertical" aria-label="调整验收视图宽度" aria-describedby="inspector-resize-help" aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home" title="拖动调整宽度；方向键微调；Shift 加速；Home 或双击恢复默认"></button>
        <span class="visually-hidden" id="inspector-resize-help">拖动调整宽度；方向键微调；按住 Shift 加速；按 Home 或双击恢复默认。</span>
        <div class="inspector-header"><div class="inspector-heading"><button class="inspector-heading-back" id="inspector-overview-back" title="返回工作概览">${icon('back')}</button><h2 id="inspector-title">工作</h2></div><button class="icon-button" id="inspector-close">${icon('close')}</button></div>
        <div class="inspector-content" id="inspector-content"></div>
        <div class="inspector-bottom"><div class="security-badge"><span>⌁</span><div><strong>本机执行</strong><small id="runtime-policy">正在准备</small></div></div></div>
      </aside>
    </div>
    <div class="toast" id="toast" role="status"></div>
  `

  const bridge = window.turbofluxDesktop
  const shell = app.querySelector<HTMLDivElement>('.desktop-shell')!
  const mainScroll = app.querySelector<HTMLDivElement>('#main-scroll')!
  const productView = app.querySelector<HTMLElement>('#product-view')!
  const taskInput = app.querySelector<HTMLTextAreaElement>('#task-input')!
  const transcript = app.querySelector<HTMLElement>('#transcript')!
  const workPlanDock = app.querySelector<HTMLElement>('#work-plan-dock')!
  const toast = app.querySelector<HTMLDivElement>('#toast')!
  const runButton = app.querySelector<HTMLButtonElement>('#run-button')!
  const recoveryBanner = app.querySelector<HTMLElement>('#recovery-banner')!
  const draftTray = app.querySelector<HTMLElement>('#draft-tray')!
  const capabilityTray = app.querySelector<HTMLElement>('#composer-capability-tray')!
  const composerCard = app.querySelector<HTMLElement>('#composer-card')!
  const composerAddButton = app.querySelector<HTMLButtonElement>('#composer-add')!
  const capabilityTab = app.querySelector<HTMLButtonElement>('#capability-tab')!
  const capabilityMenu = app.querySelector<HTMLElement>('#capability-menu')!
  const reasoningTab = app.querySelector<HTMLButtonElement>('#reasoning-tab')!
  const approvalPill = app.querySelector<HTMLButtonElement>('#approval-pill')!
  const composerMenu = app.querySelector<HTMLElement>('#composer-menu')!
  const approvalMenu = app.querySelector<HTMLElement>('#approval-menu')!
  const inspectorPanel = app.querySelector<HTMLElement>('#inspector-panel')!
  const inspectorResizeHandle = app.querySelector<HTMLButtonElement>('#inspector-resize-handle')!
  const inspectorContent = app.querySelector<HTMLDivElement>('#inspector-content')!
  const browserWorkspace = app.querySelector<HTMLElement>('#browser-workspace')!
  const browserSurface = app.querySelector<HTMLElement>('#browser-native-surface')!
  const browserTabs = app.querySelector<HTMLElement>('#browser-tabs')!
  const browserAddress = app.querySelector<HTMLInputElement>('#browser-address')!
  const browserBack = app.querySelector<HTMLButtonElement>('#browser-back')!
  const browserForward = app.querySelector<HTMLButtonElement>('#browser-forward')!
  const browserReload = app.querySelector<HTMLButtonElement>('#browser-reload')!
  const browserActivity = app.querySelector<HTMLElement>('#browser-activity')!
  const browserToggle = app.querySelector<HTMLButtonElement>('#browser-toggle')
  const taskCompanion = app.querySelector<HTMLElement>('#task-companion')!
  const productTitle = app.querySelector<HTMLElement>('#workbench-title-product')!
  const productTitleText = app.querySelector<HTMLElement>('#workbench-title-text')!
  const productTitleCaret = app.querySelector<HTMLElement>('#workbench-title-caret')!
  const composerActionGuard = new SingleFlightGuard()
  const draftRecordQueue = new SerializedAsyncQueue()
  const conversationNavigationGuard = new SingleFlightGuard()
  let currentSnapshot: WorkbenchSnapshot | null = null
  let currentMainView: 'workbench' | 'projects' | 'automations' = 'workbench'
  let currentInspectorTab: InspectorTab = 'overview'
  let selectedChange: ChangeSummary | null = null
  let selectedArtifactId: string | null = null
  let selectedWorkRunId: string | null = null
  const artifactPreviewCache = new Map<string, WorkbenchArtifactPreview>()
  const artifactThumbnailCache = new Map<string, Promise<WorkbenchArtifactPreview>>()
  const attachmentPreviewCache = new Map<string, Promise<{ mode: 'image'; dataUrl: string }>>()
  const attachmentThumbnailCache = new Map<string, Promise<{ mode: 'image'; dataUrl: string }>>()
  const pendingAttachmentThumbnails = new WeakMap<HTMLElement, { image: HTMLImageElement; path: string }>()
  const attachmentThumbnailObserver = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const host = entry.target as HTMLElement
          const pending = pendingAttachmentThumbnails.get(host)
          attachmentThumbnailObserver?.unobserve(host)
          pendingAttachmentThumbnails.delete(host)
          if (pending) void loadAttachmentThumbnailNow(host, pending.image, pending.path)
        }
      }, { root: transcript, rootMargin: '240px 0px' })
  let artifactPreviewLoading = false
  let imageLightbox: ImageLightbox | null = null
  let canonicalTaskFlowFrame: number | null = null
  let canonicalTaskFlowForce = false
  let submissionPending = false
  let submissionStopRequested = false
  let requestStatusTerminalFence: RequestStatusTerminalFence | null = null
  let requestStatusAttemptTurnId = ''
  let activeTaskStartedAt = 0
  let activeTurnIsTask = false
  let activeWorkRunId = ''
  let projectedWorkRunId = ''
  let taskFlowProjection: TaskFlowProjectionState | null = null
  const liveTurnCache = new Map<string, AgentTurn>()
  const workPlanDockRenderer = createWorkPlanDockRenderer(workPlanDock)

  function renderProjectedWorkPlan() {
    const execution = currentSnapshot?.activity.execution
    workPlanDockRenderer.render(execution ? selectProjectedWorkRun(execution, projectedWorkRunId) : undefined)
  }
  const linearTaskFlowRenderer = createLinearTaskFlowRenderer(transcript, {
    createInput: node => {
      const turn = (node.turnId ? liveTurnCache.get(node.turnId) : undefined)
        || currentSnapshot?.conversation.turns.find(candidate => candidate.id === node.turnId)
      return turn
        ? createMessageElement(turn, collectToolResults(currentSnapshot?.conversation.turns || []), false, true, false, false)
          || createFallbackLinearMessage(node, 'user')
        : createFallbackLinearMessage(node, 'user')
    },
    createAnswer: (node, presentation) => {
      const turn = (node.turnId ? liveTurnCache.get(node.turnId) : undefined)
        || currentSnapshot?.conversation.turns.find(candidate => candidate.id === node.turnId)
      return turn
        ? createMessageElement(
            turn,
            collectToolResults(currentSnapshot?.conversation.turns || []),
            false,
            presentation.finalDelivery,
            false,
            false,
            presentation.finalDelivery,
          )
          || createFallbackLinearMessage(node, 'assistant')
        : createFallbackLinearMessage(node, 'assistant')
    },
    resolveTool: node => {
      const turns = [...(currentSnapshot?.conversation.turns || []), ...liveTurnCache.values()]
      const call = turns
        .flatMap(turn => turn.toolCalls || [])
        .find(candidate => candidate.id === node.callId)
        || liveToolCalls.get(node.callId || '')
        || {
          id: node.callId || node.id.replace(/^tool:/, ''),
          name: node.toolName || node.content || 'tool',
          arguments: typeof node.detail === 'string' && node.detail.trim().startsWith('{')
            ? (() => { try { return JSON.parse(node.detail) as Record<string, unknown> } catch { return {} } })()
            : {},
        }
      const result = collectToolResults(turns).get(call.id) || liveToolResults.get(call.id)
      return {
        call,
        result,
        onPreviewDiff: change => {
          selectedChange = change
          openInspector('outputs')
        },
      }
    },
    resolveRun: runId => currentSnapshot?.activity.execution.runs.find(run => run.id === runId),
    nodeVersion: node => {
      if ((node.kind === 'input' || node.kind === 'answer') && node.turnId) {
        const turn = liveTurnCache.get(node.turnId)
        if (!turn) return ''
        return [
          turn.timestamp,
          turn.content.length,
          turn.metadata?.attachments?.length || 0,
          turn.metadata?.capabilities?.items.length || 0,
          turn.metadata?.duration || 0,
        ].join(':')
      }
      if (node.kind !== 'tool' || !node.callId) return ''
      const call = liveToolCalls.get(node.callId)
      const result = collectToolResults([
        ...(currentSnapshot?.conversation.turns || []),
        ...liveTurnCache.values(),
      ]).get(node.callId) || liveToolResults.get(node.callId)
      return [
        call ? JSON.stringify(call.arguments).length : 0,
        result ? result.isError ? 1 : 0 : '',
        result?.output.length || 0,
        result?.attachments?.length || 0,
      ].join(':')
    },
  })
  let draftTimer: number | null = null
  let draftAttachments: AgentAttachment[] = []
  let draftFiles: WorkbenchFileReference[] = []
  let pendingPastes: WorkbenchPendingPaste[] = []
  let draftCapabilities: AgentCapabilityReference[] = []
  let snapshotRefreshTimer: number | null = null
  let snapshotRefreshInFlight = false
  let snapshotRefreshPending = false
  let renderedConversationSignature = ''
  let renderedConversationListSignature = ''
  let workspaceTaskQuery = ''
  let expandedWorkspaceTaskGroups = new Set<string>()
  const workspaceGroupExpansionStorageKey = 'turboflux.workspace-groups.expansion'
  let workspaceGroupExpansion: Record<string, boolean> = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(workspaceGroupExpansionStorageKey) || '{}')
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, boolean> : {}
    } catch {
      return {}
    }
  })()
  let renderedTaskCompanionSignature = ''
  let browserSnapshot: BrowserSystemSnapshot | null = null
  let browserDisplayMode: BrowserDisplayMode = null
  let browserModeBeforeFullScreen: BrowserDisplayMode = null
  let fullScreenSurfaceDepth = 0
  let browserBoundsFrame: number | null = null
  let reasoningMaxTimer: number | null = null
  const liveToolCalls = new Map<string, ToolCall>()
  const liveToolResults = new Map<string, ToolResult>()
  let pendingOptimisticUserElement: HTMLElement | null = null
  let pendingOptimisticUserPrompt = ''
  let pendingOptimisticInputId = ''
  let editingTurnId = ''
  let pendingConversationRender = false
  let resendingTurnId = ''
  let historyRewriteOptimisticTurn: AgentTurn | null = null
  let pendingConversationNavigationId = ''
  let workbenchDialogSequence = 0
  let activeWorkbenchDialog: { focus(): void } | null = null
  let historyRewriteAnchorTurnId = ''
  let historyRewriteLeadingSpacer: HTMLElement | null = null
  let historyRewriteSpacer: HTMLElement | null = null
  let automationEditorId: string | null = null
  let inspectorFastCloseTimer: number | null = null
  let transcriptFollowState = createTranscriptFollowState(transcript)
  let transcriptScrollFrame: number | null = null
  let transcriptPointerScrolling = false
  let transcriptWheelScrolling = false
  let transcriptWheelTimer: number | null = null
  const inspectorWidthStorageKey = 'turboflux.inspector.width'

  function startProductTitleTypewriter() {
    let variantIndex = 0
    let visibleText = ''
    let phase: ProductTitlePhase = 'typing'

    const render = () => {
      const variant = productTitleVariants[variantIndex]
      productTitleText.textContent = visibleText
      productTitle.classList.toggle('is-work', variant.className === 'is-work')
      productTitle.classList.toggle('is-code', variant.className === 'is-code')
      productTitleCaret.classList.toggle('is-holding', phase === 'holding')
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      visibleText = productTitleVariants[variantIndex].word
      phase = 'holding'
      render()
      return
    }

    const schedule = () => {
      const variant = productTitleVariants[variantIndex]
      let delay = PRODUCT_TITLE_TYPE_DELAY
      if (phase === 'holding') delay = PRODUCT_TITLE_HOLD_DELAY
      if (phase === 'deleting') delay = PRODUCT_TITLE_DELETE_DELAY
      if (phase === 'switching') delay = PRODUCT_TITLE_SWITCH_DELAY

      window.setTimeout(() => {
        if (phase === 'typing') {
          visibleText = variant.word.slice(0, visibleText.length + 1)
          if (visibleText === variant.word) phase = 'holding'
        } else if (phase === 'holding') {
          phase = 'deleting'
        } else if (phase === 'deleting') {
          visibleText = visibleText.slice(0, -1)
          if (!visibleText) phase = 'switching'
        } else {
          variantIndex = (variantIndex + 1) % productTitleVariants.length
          phase = 'typing'
        }
        render()
        schedule()
      }, delay)
    }

    render()
    schedule()
  }

  startProductTitleTypewriter()

  function maximumInspectorWidth(): number {
    return maximumInspectorWidthValue(window.innerWidth)
  }

  function defaultInspectorWidth(): number {
    return defaultInspectorWidthValue(window.innerWidth)
  }

  function clampInspectorWidth(value: number): number {
    return clampInspectorWidthValue(value, window.innerWidth)
  }

  function setInspectorWidth(value: number, persist = false) {
    const width = clampInspectorWidth(value)
    shell.style.setProperty('--work-panel-width', `${width}px`)
    inspectorResizeHandle.setAttribute('aria-valuemin', String(INSPECTOR_MINIMUM_WIDTH))
    inspectorResizeHandle.setAttribute('aria-valuemax', String(Math.round(maximumInspectorWidth())))
    inspectorResizeHandle.setAttribute('aria-valuenow', String(width))
    inspectorResizeHandle.setAttribute('aria-valuetext', `${width} 像素`)
    if (persist) {
      try { window.localStorage.setItem(inspectorWidthStorageKey, String(width)) } catch { /* storage may be unavailable */ }
    }
    scheduleBrowserBoundsSync()
  }

  try {
    const storedInspectorWidth = Number(window.localStorage.getItem(inspectorWidthStorageKey))
    setInspectorWidth(Number.isFinite(storedInspectorWidth) && storedInspectorWidth > 0 ? storedInspectorWidth : defaultInspectorWidth())
  } catch {
    setInspectorWidth(defaultInspectorWidth())
  }

  function showToast(message: string) {
    toast.textContent = message
    toast.classList.add('visible')
    window.setTimeout(() => toast.classList.remove('visible'), 2400)
  }

  function cachedValue<K, V>(cache: Map<K, V>, key: K): V | undefined {
    const value = cache.get(key)
    if (value === undefined) return undefined
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  function cacheValue<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value as K | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return value
  }

  async function loadArtifactPreview(artifactId: string, purpose: 'thumbnail' | 'full' = 'full'): Promise<WorkbenchArtifactPreview> {
    if (purpose === 'thumbnail') {
      const cached = cachedValue(artifactThumbnailCache, artifactId)
      if (cached) return cached
      if (!bridge) throw new Error('桌面核心未连接')
      const request = bridge.previewArtifact(artifactId, 'thumbnail')
      cacheValue(artifactThumbnailCache, artifactId, request, 48)
      request.catch(() => artifactThumbnailCache.delete(artifactId))
      return request
    }
    const cached = cachedValue(artifactPreviewCache, artifactId)
    if (cached) return cached
    if (!bridge) throw new Error('桌面核心未连接')
    return cacheValue(artifactPreviewCache, artifactId, await bridge.previewArtifact(artifactId, 'full'), 3)
  }

  function loadAttachmentPreview(path: string, purpose: 'thumbnail' | 'full' = 'full'): Promise<{ mode: 'image'; dataUrl: string }> {
    const cache = purpose === 'thumbnail' ? attachmentThumbnailCache : attachmentPreviewCache
    const cached = cachedValue(cache, path)
    if (cached) return cached
    if (!bridge) return Promise.reject(new Error('桌面核心未连接'))
    const preview = bridge.previewImageAttachment(path, purpose)
    cacheValue(cache, path, preview, purpose === 'thumbnail' ? 48 : 3)
    preview.catch(() => cache.delete(path))
    return preview
  }

  function attachmentLightboxItems(attachments: AgentAttachment[]): ImageLightboxItem[] {
    return attachments.filter(attachment => attachment.type === 'image').map(attachment => ({
      id: attachment.id,
      title: attachment.filename,
      detail: '用户添加的图片',
      source: { kind: 'attachment', path: attachment.path },
    }))
  }

  function evidenceLightboxItems(items: ReturnType<typeof visualEvidenceItems>): ImageLightboxItem[] {
    return items.map(item => ({
      id: item.artifactId,
      title: item.title,
      detail: item.detail || (item.source === 'browser' ? '网页截图' : '电脑操作'),
      source: { kind: 'artifact', artifactId: item.artifactId },
    }))
  }

  async function loadAttachmentThumbnailNow(host: HTMLElement, image: HTMLImageElement, path: string): Promise<void> {
    try {
      const preview = await loadAttachmentPreview(path, 'thumbnail')
      if (!host.isConnected || host.dataset.attachmentPath !== path) return
      image.src = preview.dataUrl
      if (typeof image.decode === 'function') await image.decode()
      if (!host.isConnected || host.dataset.attachmentPath !== path) return
      host.classList.remove('loading', 'failed')
    } catch {
      if (host.dataset.attachmentPath === path) host.classList.add('failed')
    }
  }

  function hydrateAttachmentThumbnail(host: HTMLElement, image: HTMLImageElement, path: string, eager = false) {
    host.classList.add('loading')
    host.dataset.attachmentPath = path
    if (eager || !attachmentThumbnailObserver) {
      void loadAttachmentThumbnailNow(host, image, path)
      return
    }
    pendingAttachmentThumbnails.set(host, { image, path })
    attachmentThumbnailObserver.observe(host)
  }

  imageLightbox = createImageLightbox({
    loadPreview: item => item.source.kind === 'artifact'
      ? loadArtifactPreview(item.source.artifactId)
      : loadAttachmentPreview(item.source.path),
    exportImage: item => item.source.kind === 'artifact'
      ? bridge?.exportArtifact(item.source.artifactId) || Promise.resolve(null)
      : bridge?.exportImageAttachment(item.source.path) || Promise.resolve(null),
    notify: showToast,
  })

  function formatCompactValue(value: number): string {
    if (!Number.isFinite(value)) return '0'
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
    return Math.round(value).toLocaleString('zh-CN')
  }

  function renderComposerContext(snapshot: WorkbenchSnapshot) {
    const button = app.querySelector<HTMLButtonElement>('#composer-context')
    if (!button) return
    const usage = snapshot.context.usage
    const used = contextUsageTokenCount(usage)
    const contextWindow = Math.max(1, snapshot.context.contextWindow || 1)
    const ratio = Math.max(0, Math.min(1, used / contextWindow))
    const remaining = Math.max(0, contextWindow - used)
    const detail = `上下文 ${Math.round(ratio * 100)}% · 已用 ${formatCompactValue(used)} / ${formatCompactValue(contextWindow)} · 剩余 ${formatCompactValue(remaining)}`
    button.style.setProperty('--context-progress', `${ratio * 360}deg`)
    button.dataset.tooltip = detail
    button.setAttribute('aria-label', `${detail}，点击查看详情`)
  }

  function renderComposerModelIdentity() {
    const modelId = currentSnapshot?.runtime.model || ''
    const provider = currentSnapshot?.runtime.provider || ''
    const iconElement = app.querySelector<HTMLElement>('#model-icon')
    const multiplierElement = app.querySelector<HTMLElement>('#model-multiplier')
    if (iconElement) {
      iconElement.innerHTML = modelProviderMark(provider, modelId)
      iconElement.dataset.provider = normalizedModelProvider(provider, modelId)
    }
    if (multiplierElement) {
      multiplierElement.textContent = ''
      multiplierElement.hidden = true
    }
  }



  function activeBrowserTab() {
    return browserSnapshot?.tabs.find(tab => tab.id === browserSnapshot?.activeTabId) || null
  }

  function browserActivityText(snapshot: BrowserSystemSnapshot): string {
    if (!snapshot.activity) return ''
    return ({
      opening: '正在打开页面',
      navigating: '正在浏览页面',
      observing: '正在检查页面',
      acting: '正在操作页面',
      capturing: '正在记录页面',
      recovering: '正在恢复页面',
    } as const)[snapshot.activity.phase]
  }

  function updateBrowserActivity(element: HTMLElement, snapshot: BrowserSystemSnapshot) {
    const label = browserActivityText(snapshot)
    element.hidden = !label
    element.classList.toggle('active', Boolean(label))
    const copy = element.querySelector<HTMLElement>('span:last-child')
    if (copy) copy.textContent = label
  }

  function renderBrowserTabs(container: HTMLElement, compact = false) {
    container.replaceChildren()
    container.classList.toggle('compact', compact)
    for (const tab of browserSnapshot?.tabs || []) {
      const button = document.createElement('button')
      button.className = `browser-tab${tab.id === browserSnapshot?.activeTabId ? ' active' : ''}${tab.crashed ? ' crashed' : ''}`
      button.title = tab.url || tab.title
      const status = document.createElement('span')
      status.className = `browser-tab-status${tab.loading ? ' loading' : ''}`
      const label = document.createElement('strong')
      label.textContent = tab.crashed ? '页面已停止' : tab.title || '新标签页'
      const close = document.createElement('span')
      close.className = 'browser-tab-close'
      close.innerHTML = icon('close')
      close.addEventListener('click', event => {
        event.stopPropagation()
        void bridge?.browserCloseTab(tab.id).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      button.append(status, label, close)
      button.addEventListener('click', () => void bridge?.browserActivateTab(tab.id).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
      container.append(button)
    }
  }

  function navigateBrowserAddress(value: string, tabId?: string) {
    const address = value.trim()
    if (!address) return
    void bridge?.browserNavigate(address, tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  }

  function scheduleBrowserBoundsSync() {
    if (!bridge || !browserSnapshot?.visible) return
    if (browserBoundsFrame !== null) cancelAnimationFrame(browserBoundsFrame)
    browserBoundsFrame = requestAnimationFrame(() => {
      browserBoundsFrame = null
      const surface = browserDisplayMode === 'workspace'
        ? browserSurface
        : browserDisplayMode === 'inspector' && currentInspectorTab === 'browser' && shell.classList.contains('inspector-open')
          ? inspectorContent.querySelector<HTMLElement>('.inspector-browser-surface')
          : null
      const rect = surface?.getBoundingClientRect()
      if (!rect || rect.width < 2 || rect.height < 2) return
      void bridge.browserSetBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(error => showToast(errorMessage(error)))
    })
  }

  function updateInspectorBrowser(snapshot: BrowserSystemSnapshot): boolean {
    if (!shell.classList.contains('inspector-open') || currentInspectorTab !== 'browser') return false
    const panel = inspectorContent.querySelector<HTMLElement>('.inspector-browser')
    const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId)
    if (!panel || !snapshot.visible || !active) return false
    const tabs = panel.querySelector<HTMLElement>('.inspector-browser-tabs')
    const activity = panel.querySelector<HTMLElement>('.browser-activity-pill')
    const back = panel.querySelector<HTMLButtonElement>('[data-browser-command="back"]')
    const forward = panel.querySelector<HTMLButtonElement>('[data-browser-command="forward"]')
    const reload = panel.querySelector<HTMLButtonElement>('[data-browser-command="reload"]')
    const address = panel.querySelector<HTMLInputElement>('.inspector-browser-address')
    const external = panel.querySelector<HTMLButtonElement>('[data-browser-command="external"]')
    if (!tabs || !activity || !back || !forward || !reload || !address || !external) return false
    renderBrowserTabs(tabs, true)
    updateBrowserActivity(activity, snapshot)
    back.disabled = !active.canGoBack
    forward.disabled = !active.canGoForward
    reload.title = active.loading ? '重新加载' : '刷新'
    reload.classList.toggle('loading', active.loading)
    if (document.activeElement !== address) address.value = active.url === 'about:blank' ? '' : active.url
    external.disabled = active.url === 'about:blank'
    return true
  }

  function renderBrowserSnapshot(snapshot: BrowserSystemSnapshot) {
    browserSnapshot = snapshot
    if (!snapshot.visible) browserDisplayMode = null
    else if (!browserDisplayMode) browserDisplayMode = 'inspector'
    const workspaceVisible = snapshot.visible && browserDisplayMode === 'workspace'
    browserWorkspace.classList.toggle('visible', workspaceVisible)
    browserWorkspace.setAttribute('aria-hidden', String(!workspaceVisible))
    browserToggle?.classList.toggle('active', snapshot.visible)
    renderBrowserTabs(browserTabs)
    updateBrowserActivity(browserActivity, snapshot)
    const active = activeBrowserTab()
    if (document.activeElement !== browserAddress) browserAddress.value = active?.url === 'about:blank' ? '' : active?.url || ''
    browserBack.disabled = !active?.canGoBack
    browserForward.disabled = !active?.canGoForward
    browserReload.classList.toggle('loading', active?.loading === true)
    if (shell.classList.contains('inspector-open') && currentInspectorTab === 'overview') renderInspector()
    else if (currentInspectorTab === 'browser' && !updateInspectorBrowser(snapshot)) renderInspector()
    renderTaskCompanion()
    if (snapshot.visible) scheduleBrowserBoundsSync()
  }

  async function refreshConversationSystemSnapshots(): Promise<void> {
    if (!bridge) return
    const [browserResult, computerResult] = await Promise.allSettled([
      bridge.browserGetState(),
      computerControls?.refresh() || Promise.resolve(null),
    ])
    if (browserResult.status === 'fulfilled') renderBrowserSnapshot(browserResult.value)
    else showToast(errorMessage(browserResult.reason))
    if (computerResult.status === 'rejected') showToast(errorMessage(computerResult.reason))
  }

  async function openBrowser() {
    if (!bridge) return
    try {
      browserDisplayMode = 'workspace'
      closeInspector()
      renderBrowserSnapshot(await bridge.browserShow())
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  function expandBrowser() {
    if (!browserSnapshot?.visible) {
      void openBrowser()
      return
    }
    browserDisplayMode = 'workspace'
    closeInspector()
    renderBrowserSnapshot(browserSnapshot)
  }

  async function openBrowserInInspector(url: string) {
    if (!bridge) return
    try {
      browserDisplayMode = 'inspector'
      openInspector('browser')
      let snapshot = await bridge.browserShow()
      const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId)
      if (active?.url === 'about:blank' && snapshot.tabs.length === 1) snapshot = await bridge.browserNavigate(url, active.id)
      else if (active?.url !== url) snapshot = await bridge.browserNewTab(url)
      renderBrowserSnapshot(snapshot)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function openBrowserTabInInspector(tabId: string) {
    if (!bridge) return
    try {
      browserDisplayMode = 'inspector'
      let snapshot = await bridge.browserShow()
      if (snapshot.tabs.some(tab => tab.id === tabId) && snapshot.activeTabId !== tabId) {
        snapshot = await bridge.browserActivateTab(tabId)
      }
      renderBrowserSnapshot(snapshot)
      openInspector('browser')
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function closeBrowser() {
    if (!bridge) return
    try {
      renderBrowserSnapshot(await bridge.browserHide())
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  function handleBrowserEvent(event: BrowserSystemEvent) {
    if (event.type === 'state') {
      renderBrowserSnapshot(event.snapshot)
      return
    }
    if (event.type === 'blocked-navigation') {
      showToast(`已阻止不安全页面：${event.reason}`)
      return
    }
    if (event.type === 'download') {
      const { download } = event
      const message = download.status === 'started'
        ? `正在下载 ${download.filename}`
        : download.status === 'completed'
          ? `${download.filename} 已保存到产物`
          : `${download.filename} 下载${download.status === 'cancelled' ? '已取消' : '失败'}`
      showToast(message)
    }
  }

  function taskCompanionPreview(snapshot: WorkbenchSnapshot): { title: string; detail: string; url: string } | undefined {
    const service = snapshot.activity.runtimeTasks
      .map(task => ({ task, view: describeRuntimeTask(task) }))
      .filter(item => item.view?.category === 'service' && item.view.active && item.view.previewUrl)
      .sort((left, right) => right.task.updatedAt - left.task.updatedAt)[0]
    if (service?.view?.previewUrl) return { title: '本地预览', detail: service.view.title, url: service.view.previewUrl }
    return undefined
  }

  function browserSiteLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url
    } catch {
      return url
    }
  }

  function browserResearchTabs() {
    return (browserSnapshot?.tabs || []).filter(tab => tab.url && tab.url !== 'about:blank')
  }

  function taskCompanionBrowser(): { title: string; detail: string; tabId: string } | undefined {
    const tabs = browserResearchTabs()
    if (tabs.length === 0) return undefined
    const active = tabs.find(tab => tab.id === browserSnapshot?.activeTabId) || tabs.at(-1)!
    const site = browserSiteLabel(active.url)
    const title = browserSnapshot?.activity ? browserActivityText(browserSnapshot) : '浏览现场'
    const detail = active.loading
      ? `${site} · 正在加载`
      : tabs.length > 1
        ? `${active.title || site} · ${tabs.length} 个页面`
        : active.title || site
    return { title, detail, tabId: active.id }
  }

  function taskCompanionOutputCount(snapshot: WorkbenchSnapshot): number {
    const startedAt = snapshot.runtime.runState.startedAt || activeTaskStartedAt
    if (!startedAt) return 0
    const outputPaths = new Set<string>()
    const artifacts = snapshot.artifacts.artifacts.filter(artifact => (
      artifact.updatedAt >= startedAt
      && (!artifact.conversationId || artifact.conversationId === snapshot.conversation.id)
    ))
    for (const artifact of artifacts) outputPaths.add(artifact.path)
    for (const turn of snapshot.conversation.turns) {
      if (turn.timestamp < startedAt) continue
      for (const result of turn.toolResults || []) {
        if (result.changeSummary) outputPaths.add(result.changeSummary.path)
      }
    }
    return outputPaths.size
  }

  function renderTaskCompanion() {
    const snapshot = currentSnapshot
    const active = Boolean(snapshot && currentMainView === 'workbench' && ['running', 'paused', 'awaiting-action'].includes(snapshot.runtime.status))
    const preview = snapshot ? taskCompanionPreview(snapshot) : undefined
    const browser = taskCompanionBrowser()
    const startedAt = snapshot?.runtime.runState.startedAt || activeTaskStartedAt
    const subagents = (snapshot?.activity.subagents || []).filter(agent => !startedAt || agent.startedAt >= startedAt - 1_000)
    const computer = computerControls?.getCompanionState()
    const execution = snapshot?.activity.execution
    const currentRun = execution?.currentRunId
      ? execution.runs.find(run => run.id === execution.currentRunId && run.presentation === 'work')
      : undefined
    const work = currentRun?.presentation === 'work' ? presentWorkRun(currentRun) : undefined
    const presentation = presentTaskCompanion({
      active,
      work: work && !work.terminal ? {
        title: work.title,
        detail: work.detail,
        attention: work.attention,
      } : undefined,
      preview: preview ? { title: preview.title, detail: preview.detail } : undefined,
      browser: browser ? { title: browser.title, detail: browser.detail, attention: Boolean(browserSnapshot?.lastError) } : undefined,
      subagents: subagents.length > 0 ? {
        total: subagents.length,
        running: subagents.filter(agent => ['starting', 'running'].includes(agent.status)).length,
        completed: subagents.filter(agent => agent.status === 'completed').length,
      } : undefined,
      computer: computer ? { title: computer.title, detail: computer.detail, attention: computer.attention } : undefined,
    })
    const signature = JSON.stringify({ presentation, previewUrl: preview?.url || '', browserTabId: browser?.tabId || '' })
    if (signature === renderedTaskCompanionSignature) return
    renderedTaskCompanionSignature = signature
    taskCompanion.replaceChildren()
    taskCompanion.classList.toggle('visible', presentation.visible)
    taskCompanion.setAttribute('aria-hidden', String(!presentation.visible))
    if (!presentation.visible) return

    const live = document.createElement('span')
    live.className = 'task-companion-live'
    live.innerHTML = '<i aria-hidden="true"></i><span class="visually-hidden">任务正在进行</span>'
    taskCompanion.append(live)
    const icons: Record<TaskCompanionItemKind, string> = {
      work: 'spark', preview: 'globe', browser: 'globe', subagents: 'spark', computer: 'computer',
    }
    for (const item of presentation.items) {
      const button = document.createElement('button')
      button.className = `task-companion-item kind-${item.kind}${item.attention ? ' attention' : ''}`
      button.innerHTML = `${icon(icons[item.kind])}<span><strong></strong><small></small></span>`
      button.querySelector('strong')!.textContent = item.title
      button.querySelector('small')!.textContent = item.detail
      button.title = `${item.title} · ${item.detail}`
      button.addEventListener('click', () => {
        if (item.kind === 'work') openInspector('activity')
        else if (item.kind === 'preview' && preview?.url) void openBrowserInInspector(preview.url)
        else if (item.kind === 'browser' && browser?.tabId) void openBrowserTabInInspector(browser.tabId)
        else if (item.kind === 'subagents') {
          openInspector('activity')
        } else if (item.kind === 'computer') openInspector('activity')
      })
      taskCompanion.append(button)
    }
  }

  const computerControls = bridge ? createComputerControls(app, bridge, {
    showToast,
    onActivityChange: () => {
      renderTaskCompanion()
      if (shell.classList.contains('inspector-open') && currentInspectorTab === 'overview') renderInspector()
    },
  }) : null

  async function enterFullScreenSurface() {
    if (!bridge) return
    fullScreenSurfaceDepth += 1
    if (fullScreenSurfaceDepth > 1) return
    browserModeBeforeFullScreen = browserSnapshot?.visible ? browserDisplayMode : null
    closeComposerMenus()
    closeInspector()
    if (!browserSnapshot?.visible) return
    try {
      renderBrowserSnapshot(await bridge.browserHide())
    } catch (error) {
      browserModeBeforeFullScreen = null
      showToast(errorMessage(error))
    }
  }

  function leaveFullScreenSurface() {
    fullScreenSurfaceDepth = Math.max(0, fullScreenSurfaceDepth - 1)
    if (fullScreenSurfaceDepth > 0) return
    const restoreMode = browserModeBeforeFullScreen
    browserModeBeforeFullScreen = null
    if (!restoreMode || !bridge) return
    void (async () => {
      try {
        browserDisplayMode = restoreMode
        if (restoreMode === 'inspector') openInspector('browser')
        else closeInspector()
        const snapshot = await bridge.browserShow()
        browserDisplayMode = restoreMode
        renderBrowserSnapshot(snapshot)
      } catch (error) {
        showToast(errorMessage(error))
      }
    })()
  }

  const settingsCenter = bridge ? createSettingsCenter(app, bridge, {
    showToast,
    onOpen: enterFullScreenSurface,
    onClose: () => {
      leaveFullScreenSurface()
    },
    computerControls: computerControls || undefined,
    onSnapshot: snapshot => applySnapshot(snapshot),
    onUseCapability: async capability => {
      if (capability.type === 'skill') {
        const skill = currentSnapshot?.skills.find(item => item.id === capability.id)
        if (!skill) throw new Error('能力包已安装，但工作流暂时无法读取')
        draftCapabilities = [
          { type: 'skill', id: skill.id, name: skill.name },
          ...draftCapabilities.filter(item => item.type !== 'skill'),
        ]
      } else {
        draftCapabilities = [
          ...draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id)),
          { ...capability },
        ]
      }
      renderCapabilityTray()
      await persistDraftNow()
      taskInput.focus()
    },
  }) : null

  const commandPalette = bridge ? createCommandPalette(app, bridge, {
    showToast,
    onResult: result => handleCommandResult(result),
  }) : null

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function handleCommandResult(result: WorkbenchCommandResult): Promise<void> {
    if (result.snapshot) applySnapshot(result.snapshot)
    if (result.open === 'activity' || result.open === 'context' || result.open === 'git') openInspector(result.open)
    if (result.open === 'mcp') await settingsCenter?.open('mcp')
    if (result.open === 'skills') await settingsCenter?.open('workpacks')
  }

  function formatRelativeTime(timestamp: number): string {
    const elapsed = Math.max(0, Date.now() - timestamp)
    if (elapsed < 60_000) return '现在'
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`
    return `${Math.floor(elapsed / 86_400_000)} 天`
  }

  function createMessageTime(timestamp: number): HTMLTimeElement {
    const date = new Date(timestamp)
    const time = document.createElement('time')
    time.className = 'message-time'
    time.dateTime = date.toISOString()
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date)
    time.title = date.toLocaleString([], {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    return time
  }

  function openWorkbenchDialog(options: {
    title: string
    message: string
    confirmLabel: string
    inputValue?: string
    danger?: boolean
  }): Promise<string | boolean | null> {
    if (activeWorkbenchDialog) {
      activeWorkbenchDialog.focus()
      return Promise.resolve(null)
    }
    return new Promise(resolve => {
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const overlay = document.createElement('div')
      overlay.className = 'workbench-dialog-overlay'
      const dialog = document.createElement('section')
      dialog.className = 'workbench-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      workbenchDialogSequence += 1
      const titleId = `workbench-dialog-title-${workbenchDialogSequence}`
      dialog.setAttribute('aria-labelledby', titleId)
      const title = document.createElement('h3')
      title.id = titleId
      title.textContent = options.title
      const message = document.createElement('p')
      message.textContent = options.message
      dialog.append(title, message)
      let input: HTMLInputElement | null = null
      if (options.inputValue !== undefined) {
        input = document.createElement('input')
        input.value = options.inputValue
        input.maxLength = 80
        dialog.append(input)
      }
      const actions = document.createElement('footer')
      const cancel = document.createElement('button')
      cancel.className = 'dialog-secondary'
      cancel.textContent = '取消'
      const confirm = document.createElement('button')
      confirm.className = options.danger ? 'dialog-primary danger' : 'dialog-primary'
      confirm.textContent = options.confirmLabel
      actions.append(cancel, confirm)
      dialog.append(actions)
      overlay.append(dialog)
      app.append(overlay)
      let settled = false
      const focusDialog = () => {
        const target = input || (options.danger ? cancel : confirm)
        target.focus()
        input?.select()
      }
      const controller = { focus: focusDialog }
      activeWorkbenchDialog = controller
      const finish = (value: string | boolean | null) => {
        if (settled) return
        settled = true
        if (activeWorkbenchDialog === controller) activeWorkbenchDialog = null
        overlay.classList.remove('visible')
        overlay.style.pointerEvents = 'none'
        window.setTimeout(() => {
          overlay.remove()
          if (previousFocus?.isConnected) previousFocus.focus()
        }, 180)
        resolve(value)
      }
      cancel.addEventListener('click', () => finish(null))
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null) })
      confirm.addEventListener('click', () => finish(input ? input.value.trim() : true))
      input?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        finish(input?.value.trim() || '')
      })
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(null)
          return
        }
        if (event.key !== 'Tab') return
        const focusable = [input, cancel, confirm].filter((element): element is HTMLInputElement | HTMLButtonElement => Boolean(element && !element.disabled))
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      })
      focusDialog()
      window.requestAnimationFrame(() => {
        overlay.classList.add('visible')
      })
    })
  }

  function setConversationMode(active: boolean) {
    mainScroll.classList.toggle('conversation-mode', active)
    app.querySelector('#composer-start-context')?.setAttribute('aria-hidden', String(active))
    resizeTaskInput()
  }

  function resizeTaskInput() {
    const minimumHeight = mainScroll.classList.contains('conversation-mode') ? 48 : 58
    const maximumHeight = 220
    taskInput.style.height = 'auto'
    const nextHeight = Math.min(maximumHeight, Math.max(minimumHeight, taskInput.scrollHeight))
    taskInput.style.height = `${nextHeight}px`
    taskInput.style.overflowY = taskInput.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }

  function cancelTranscriptScroll() {
    if (transcriptScrollFrame !== null) window.cancelAnimationFrame(transcriptScrollFrame)
    transcriptScrollFrame = null
  }

  function refreshHistoryRewriteViewportSpace() {
    if (!historyRewriteAnchorTurnId || !historyRewriteLeadingSpacer?.isConnected || !historyRewriteSpacer?.isConnected) return
    const anchor = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(historyRewriteAnchorTurnId)}"]`)
    if (!anchor) return
    const contentAfterAnchorHeight = Math.max(
      0,
      historyRewriteSpacer.offsetTop - anchor.offsetTop - anchor.offsetHeight,
    )
    const nextHeight = historyRewriteTailSpace({
      clientHeight: transcript.clientHeight,
      contentAfterAnchorHeight,
    })
    const value = `${nextHeight}px`
    if (historyRewriteSpacer.style.height !== value) historyRewriteSpacer.style.height = value
    const contentBeforeAnchorHeight = Math.max(0, anchor.offsetTop - historyRewriteLeadingSpacer.offsetHeight)
    const nextLeadingHeight = historyRewriteLeadingSpace({
      clientHeight: transcript.clientHeight,
      contentBeforeAnchorHeight,
      anchorHeight: anchor.offsetHeight,
      contentAfterAnchorHeight,
    })
    const leadingValue = `${nextLeadingHeight}px`
    if (historyRewriteLeadingSpacer.style.height !== leadingValue) historyRewriteLeadingSpacer.style.height = leadingValue
  }

  function mountHistoryRewriteViewportSpace() {
    if (!historyRewriteAnchorTurnId) return
    historyRewriteSpacer?.remove()
    historyRewriteLeadingSpacer?.remove()
    const anchor = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(historyRewriteAnchorTurnId)}"]`)
    if (!anchor) return
    const leadingSpacer = document.createElement('div')
    leadingSpacer.className = 'history-rewrite-leading-space'
    leadingSpacer.setAttribute('aria-hidden', 'true')
    historyRewriteLeadingSpacer = leadingSpacer
    transcript.insertBefore(leadingSpacer, anchor)
    const spacer = document.createElement('div')
    spacer.className = 'history-rewrite-viewport-space'
    spacer.setAttribute('aria-hidden', 'true')
    historyRewriteSpacer = spacer
    transcript.append(spacer)
    refreshHistoryRewriteViewportSpace()
  }

  function startHistoryRewriteViewport(turnId: string) {
    historyRewriteAnchorTurnId = turnId
    mountHistoryRewriteViewportSpace()
    scrollTranscript(true)
  }

  function clearHistoryRewriteViewport() {
    transcript.querySelector<HTMLElement>('[data-history-rewrite-optimistic="true"]')?.remove()
    historyRewriteOptimisticTurn = null
    historyRewriteAnchorTurnId = ''
    historyRewriteLeadingSpacer?.remove()
    historyRewriteLeadingSpacer = null
    historyRewriteSpacer?.remove()
    historyRewriteSpacer = null
  }

  function appendTranscriptElement(element: HTMLElement) {
    if (historyRewriteSpacer?.isConnected) transcript.insertBefore(element, historyRewriteSpacer)
    else transcript.append(element)
  }

  function scrollTranscript(force = false) {
    if (force) transcriptFollowState = forceTranscriptFollow(transcriptFollowState, transcript)
    if (!transcriptFollowState.following || transcriptScrollFrame !== null) return
    transcriptScrollFrame = window.requestAnimationFrame(() => {
      transcriptScrollFrame = null
      if (!transcriptFollowState.following) return
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' })
      transcriptFollowState = updateTranscriptFollowFromScroll(transcriptFollowState, transcript)
      window.requestAnimationFrame(() => {
        if (transcriptFollowState.following && transcriptDistanceFromBottom(transcript) > 2) scrollTranscript()
      })
    })
  }

  function captureTranscriptViewportAnchor(): { turnId: string; offset: number; scrollTop: number } | null {
    const viewport = transcript.getBoundingClientRect()
    const anchor = Array.from(transcript.querySelectorAll<HTMLElement>('[data-turn-id]'))
      .find(element => element.getBoundingClientRect().bottom >= viewport.top)
    const turnId = anchor?.dataset.turnId
    return turnId
      ? { turnId, offset: anchor!.getBoundingClientRect().top - viewport.top, scrollTop: transcript.scrollTop }
      : { turnId: '', offset: 0, scrollTop: transcript.scrollTop }
  }

  function restoreTranscriptViewportAnchor(anchor: { turnId: string; offset: number; scrollTop: number }) {
    cancelTranscriptScroll()
    transcriptFollowState = suspendTranscriptFollow(transcriptFollowState)
    window.requestAnimationFrame(() => {
      const element = anchor.turnId
        ? transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"]`)
        : null
      if (element) {
        const viewport = transcript.getBoundingClientRect()
        transcript.scrollTop += element.getBoundingClientRect().top - viewport.top - anchor.offset
      } else {
        transcript.scrollTop = anchor.scrollTop
      }
      transcriptFollowState = {
        following: false,
        lastScrollTop: transcript.scrollTop,
      }
    })
  }

  const observedTranscriptChildren = new Set<Element>()
  const transcriptResizeObserver = new ResizeObserver(() => {
    refreshHistoryRewriteViewportSpace()
    scrollTranscript()
  })
  const syncTranscriptResizeTargets = () => {
    for (const child of observedTranscriptChildren) {
      if (child.parentElement === transcript) continue
      transcriptResizeObserver.unobserve(child)
      observedTranscriptChildren.delete(child)
    }
    for (const child of transcript.children) {
      if (observedTranscriptChildren.has(child)) continue
      observedTranscriptChildren.add(child)
      transcriptResizeObserver.observe(child)
    }
  }
  const transcriptMutationObserver = new MutationObserver(() => {
    syncTranscriptResizeTargets()
    refreshHistoryRewriteViewportSpace()
    scrollTranscript()
  })
  transcriptMutationObserver.observe(transcript, { childList: true })
  syncTranscriptResizeTargets()

  function collectToolResults(turns: AgentTurn[]): Map<string, ToolResult> {
    const results = new Map<string, ToolResult>()
    for (const turn of turns) {
      for (const result of turn.toolResults || []) results.set(result.toolCallId, result)
    }
    return results
  }

  function collectChanges(turns: AgentTurn[]): ChangeSummary[] {
    const changes: ChangeSummary[] = []
    const seen = new Set<string>()
    for (const turn of turns) {
      for (const result of turn.toolResults || []) {
        const change = result.changeSummary
        if (!change) continue
        const key = `${result.toolCallId}:${change.path}`
        if (seen.has(key)) continue
        seen.add(key)
        changes.push(change)
      }
    }
    return changes.reverse()
  }

  function visibleToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
    return (calls || []).filter(call => !isInternalRuntimeTool(call.name))
  }

  function prepareForHistoryRewrite(retainedTurns: AgentTurn[]) {
    liveToolCalls.clear()
    liveToolResults.clear()
    activeWorkRunId = ''
    activeTaskStartedAt = 0
    activeTurnIsTask = false
    projectedWorkRunId = ''
    if (currentSnapshot) {
      const retainedRunIds = new Set(retainedTurns
        .filter(turn => turn.role === 'user')
        .map(turn => turn.metadata?.workRunId || turn.id))
      const retainedWorkNodes = Object.fromEntries(Object.entries(currentSnapshot.work.projection.nodes)
        .filter(([, node]) => !node.runId || retainedRunIds.has(node.runId)))
      currentSnapshot.conversation.turns = retainedTurns
      currentSnapshot.activity.execution = {
        ...currentSnapshot.activity.execution,
        currentRunId: null,
        runs: currentSnapshot.activity.execution.runs.filter(run => retainedRunIds.has(run.id)),
      }
      currentSnapshot.work = {
        ...currentSnapshot.work,
        projection: {
          ...currentSnapshot.work.projection,
          revision: currentSnapshot.work.projection.revision + 1,
          activeRunId: undefined,
          nodes: retainedWorkNodes,
          order: currentSnapshot.work.projection.order.filter(key => Boolean(retainedWorkNodes[key])),
        },
      }
    }
    renderProjectedWorkPlan()
    renderTurns(retainedTurns)
  }

  function refreshExecutionVisualEvidence(snapshot: WorkbenchSnapshot) {
    const lastLinearItemByRun = new Map<string, HTMLElement>()
    for (const item of transcript.querySelectorAll<HTMLElement>('.linear-flow-item[data-run-id]')) {
      if (item.dataset.runId) lastLinearItemByRun.set(item.dataset.runId, item)
    }
    for (const item of transcript.querySelectorAll<HTMLElement>('.linear-flow-item[data-run-id]')) {
      if (!item.dataset.runId || lastLinearItemByRun.get(item.dataset.runId) === item) continue
      item.querySelector('.linear-flow-visual-evidence')?.remove()
    }
    const targets = [
      ...transcript.querySelectorAll<HTMLElement>('.execution-group'),
      ...lastLinearItemByRun.values(),
    ]
    for (const group of targets) {
      let host = group.querySelector<HTMLElement>('.execution-visual-evidence')
      if (!host && group.classList.contains('linear-flow-item')) {
        host = document.createElement('div')
        host.className = 'execution-visual-evidence linear-flow-visual-evidence'
        group.append(host)
      }
      const runId = group.dataset.runId || (
        group.nextElementSibling instanceof HTMLElement
          ? group.nextElementSibling.getAttribute('data-run-id') || ''
          : ''
      )
      const run = runId ? snapshot.activity.execution.runs.find(candidate => candidate.id === runId) : undefined
      if (!host) continue
      const runActive = Boolean(
        runId
        && (
          snapshot.activity.execution.currentRunId === runId
          || (run && !executionOutcomeFromWorkRunStatus(run.status))
        )
      )
      if (runActive) {
        host.hidden = true
        host.replaceChildren()
        delete host.dataset.evidenceSignature
        continue
      }
      const startedAt = Number(group.dataset.startedAt) || run?.startedAt || 0
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue
      const completedAt = Number(group.dataset.completedAt)
      const items = visualEvidenceItems(snapshot.artifacts.artifacts, {
        conversationId: snapshot.conversation.id,
        startedAt,
        completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : run?.completedAt,
      })
      renderVisualEvidence(host, items, {
        loadPreview: artifactId => loadArtifactPreview(artifactId, 'thumbnail'),
        open: (evidence, initialIndex) => imageLightbox?.open(evidenceLightboxItems(evidence), initialIndex),
        defaultCollapsed: true,
      })
    }
  }

  async function copyMessageText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = text
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.append(fallback)
      fallback.select()
      document.execCommand('copy')
      fallback.remove()
    }
    showToast('已复制')
  }

  function createMessageActions(turn: AgentTurn, visibleContent: string, row: HTMLElement): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'message-action'
    copyButton.title = '复制'
    copyButton.setAttribute('aria-label', '复制消息')
    copyButton.innerHTML = icon('copy')
    copyButton.addEventListener('click', () => void copyMessageText(visibleContent))
    actions.append(copyButton)
    if (turn.role === 'user') {
      const editButton = document.createElement('button')
      editButton.type = 'button'
      editButton.className = 'message-action'
      editButton.title = '编辑并重发'
      editButton.setAttribute('aria-label', '编辑消息并从这里重新发送')
      editButton.innerHTML = icon('edit')
      editButton.addEventListener('click', () => startEditingTurn(turn, row))
      actions.append(editButton)
    }
    return actions
  }

  function formatMessageDuration(durationMs: number | undefined): string {
    return Number.isFinite(durationMs) && durationMs !== undefined && durationMs >= 0
      ? durationMs < 1_000
        ? '不到 1 秒'
        : `${Math.max(1, Math.round(durationMs / 1_000))} 秒`
      : ''
  }

  function createMessageMeta(turn: AgentTurn, visibleContent: string, row: HTMLElement, includeUsage = false): HTMLElement {
    const meta = document.createElement('div')
    meta.className = 'message-meta'
    if (turn.role === 'user') meta.append(createMessageTime(turn.timestamp))
    if (turn.role === 'assistant' && includeUsage) {
      const usage = document.createElement('span')
      usage.className = 'message-usage'
      usage.textContent = formatMessageDuration(turn.metadata?.duration)
      usage.hidden = !usage.textContent
      meta.append(usage)
      const runId = turn.metadata?.workRunId
    }
    meta.append(createMessageActions(turn, visibleContent, row))
    return meta
  }

  function startEditingTurn(turn: AgentTurn, row: HTMLElement) {
    if (!bridge) return showToast('桌面核心未连接')
    if (currentSnapshot?.persistence.status === 'degraded') return showToast('会话暂时无法保存，请先恢复保存')
    if (editingTurnId && editingTurnId !== turn.id) renderTurns(currentSnapshot?.conversation.turns || [])
    editingTurnId = turn.id
    row.classList.add('editing')
    const editor = document.createElement('div')
    editor.className = 'message-editor'
    const input = document.createElement('textarea')
    input.value = turn.content
    input.rows = 3
    input.setAttribute('aria-label', '编辑消息')
    const footer = document.createElement('div')
    footer.className = 'message-editor-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'message-editor-cancel'
    cancel.textContent = '取消'
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'message-editor-send'
    send.title = '重新发送'
    send.setAttribute('aria-label', '重新发送编辑后的消息')
    send.innerHTML = icon('arrow')
    footer.append(cancel, send)
    editor.append(input, footer)
    row.replaceChildren(editor)

    const resendGuard = new SingleFlightGuard()
    const restore = () => {
      if (resendGuard.active) return
      editingTurnId = ''
      if (pendingConversationRender && currentSnapshot) {
        pendingConversationRender = false
        renderTurns(currentSnapshot.conversation.turns)
        renderedConversationSignature = conversationRenderSignature(currentSnapshot.conversation.turns, latestConversationFailure(currentSnapshot))
        return
      }
      const replacement = createMessageElement(turn, collectToolResults(currentSnapshot?.conversation.turns || []), false)
      if (replacement) row.replaceWith(replacement)
    }
    const resend = async () => {
      const text = input.value.trim()
      if (!text) return showToast('消息不能为空')
      const snapshotTurns = currentSnapshot?.conversation.turns || []
      const rewrite = projectHistoryRewrite(snapshotTurns, turn.id, text)
      if (!rewrite) return showToast('这条消息已经不在当前会话中')
      const release = resendGuard.tryAcquire()
      if (!release) return
      const conversationId = currentSnapshot?.conversation.id || ''
      send.disabled = true
      cancel.disabled = true
      input.readOnly = true
      try {
        if (rewrite.abandonedToolCount > 0) {
          const changedFiles = rewrite.abandonedChangedPaths.length > 0
            ? `，其中涉及 ${rewrite.abandonedChangedPaths.length} 个文件`
            : ''
          const confirmed = await openWorkbenchDialog({
            title: '从这里重新开始？',
            message: `这会删除此消息之后的对话和任务记录${changedFiles}。已经执行的文件修改或外部操作不会自动撤销。`,
            confirmLabel: '编辑并重发',
          })
          if (confirmed !== true) return
        }
        editingTurnId = ''
        pendingConversationRender = false
        resendingTurnId = turn.id
        clearHistoryRewriteViewport()
        historyRewriteOptimisticTurn = rewrite.optimisticTurn
        beginRequestStatusAttempt(turn.id)
        prepareForHistoryRewrite(rewrite.retainedTurns)
        projectedWorkRunId = turn.id
        renderProjectedWorkPlan()
        mountHistoryRewriteOptimisticTurn()
        startHistoryRewriteViewport(turn.id)
        await bridge.resendFromTurn(turn.id, text)
        if (resendingTurnId === turn.id && currentSnapshot?.conversation.id === conversationId) {
          resendingTurnId = ''
          const snapshot = await bridge.getSnapshot()
          if (currentSnapshot?.conversation.id === conversationId && snapshot.conversation.id === conversationId) {
            applySnapshot(snapshot, true)
          }
        }
      } catch (error) {
        if (resendingTurnId === turn.id) resendingTurnId = ''
        if (currentSnapshot?.conversation.id === conversationId) {
          clearHistoryRewriteViewport()
          void bridge.getSnapshot().then(snapshot => {
            if (currentSnapshot?.conversation.id === conversationId && snapshot.conversation.id === conversationId) {
              applySnapshot(snapshot, true)
            }
          }).catch(() => undefined)
          showToast(errorMessage(error))
        }
      } finally {
        release()
        if (input.isConnected) {
          input.readOnly = false
          send.disabled = false
          cancel.disabled = false
          input.focus()
        }
      }
    }
    cancel.addEventListener('click', restore)
    send.addEventListener('click', () => void resend())
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        restore()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void resend()
      }
    })
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  function createMessageElement(
    turn: AgentTurn,
    resultMap: Map<string, ToolResult>,
    includeTools = true,
    includeActions = true,
    includeThinking = includeTools,
    includeSignature = true,
    includeUsage = includeSignature,
  ): HTMLElement | null {
    if (turn.role !== 'user' && turn.role !== 'assistant') return null
    if (isLegacyRecoveryPlaceholder(turn)) return null
    if (isInternalRequestErrorTurn(turn)) return null
    const visibleContent = turn.role === 'assistant'
      ? stripTextToolCallMarkup(turn.content, { stripIncomplete: true }).trim()
      : turn.content
    const calls = includeTools ? visibleToolCalls(turn.toolCalls) : []
    if (!hasRenderableTurnPayload({
      visibleContent,
      hasThinking: Boolean(includeThinking && turn.role === 'assistant' && turn.metadata?.thinking?.content),
      attachmentCount: turn.metadata?.attachments?.length || 0,
      capabilityCount: turn.metadata?.capabilities?.items.length || 0,
      visibleToolCount: calls.length,
    })) return null

    const row = document.createElement('article')
    row.className = `message-row ${turn.role}`
    row.dataset.turnId = turn.id

    if (includeThinking && turn.role === 'assistant' && turn.metadata?.thinking?.content) {
      row.append(createTaskThinkingBlock(turn.metadata.thinking, flowNodeIdForTurn(turn, 'thinking')))
    }

    if (visibleContent) {
      const content = document.createElement('div')
      content.className = 'message-content'
      if (turn.role === 'assistant') renderMarkdown(content, visibleContent)
      else content.textContent = visibleContent
      row.append(content)
    }

    if (turn.metadata?.attachments?.length) {
      const imageAttachments = turn.metadata.attachments.filter(attachment => attachment.type === 'image')
      const fileAttachments = turn.metadata.attachments.filter(attachment => attachment.type !== 'image')
      if (imageAttachments.length) {
        const gallery = document.createElement('div')
        gallery.className = 'message-image-grid'
        gallery.dataset.count = String(Math.min(4, imageAttachments.length))
        const lightboxItems = attachmentLightboxItems(imageAttachments)
        imageAttachments.forEach((attachment, imageIndex) => {
          const thumbnail = document.createElement('button')
          thumbnail.type = 'button'
          thumbnail.className = 'message-image-thumbnail'
          thumbnail.setAttribute('aria-label', `查看图片 ${imageIndex + 1}`)
          const placeholder = document.createElement('span')
          placeholder.className = 'attachment-image-placeholder'
          const image = document.createElement('img')
          image.alt = attachment.filename
          image.decoding = 'async'
          thumbnail.append(placeholder, image)
          thumbnail.addEventListener('click', () => imageLightbox?.open(lightboxItems, imageIndex))
          hydrateAttachmentThumbnail(thumbnail, image, attachment.path)
          gallery.append(thumbnail)
        })
        if (turn.role === 'user') row.insertBefore(gallery, row.querySelector('.message-content'))
        else row.append(gallery)
      }
      if (fileAttachments.length) {
        const attachments = document.createElement('div')
        attachments.className = 'message-attachments'
        for (const attachment of fileAttachments) {
        const chip = document.createElement('span')
        chip.textContent = attachment.filename
        attachments.append(chip)
        }
        row.append(attachments)
      }
    }

    if (turn.metadata?.capabilities?.items.length) {
      const capabilities = document.createElement('div')
      capabilities.className = 'message-capabilities'
      for (const capability of turn.metadata.capabilities.items) {
        const chip = document.createElement('span')
        chip.className = capability.type
        chip.innerHTML = capability.type === 'skill'
          ? icon('spark')
          : capability.id === 'browser'
            ? icon('globe')
            : capability.id === 'computer'
              ? icon('computer')
              : icon('plug')
        chip.append(document.createTextNode(capability.name))
        capabilities.append(chip)
      }
      row.append(capabilities)
    }

    if (includeActions && visibleContent) row.append(createMessageMeta(turn, visibleContent, row, turn.role === 'assistant' && includeUsage))

    if (includeTools) {
      for (const toolCall of calls) {
        const result = resultMap.get(toolCall.id)
        row.append(createToolCard(toolCall, result, result?.isError ? 'failed' : result ? 'completed' : 'running'))
      }
    }
    return row
  }

  function bindTaskFlowNode(element: HTMLElement, nodeId: string | undefined) {
    if (nodeId) element.dataset.taskFlowNodeId = nodeId
  }

  function flowNodeIdForTurn(turn: AgentTurn, kind: 'thinking' | 'answer' | 'input'): string {
    return taskFlowNodeIdForTurn(taskFlowProjection, turn, kind)
  }

  function createTaskThinkingBlock(
    trace: ThinkingTrace,
    nodeId: string | undefined,
    options: { streaming?: boolean; expanded?: boolean } = {},
  ): HTMLElement {
    const block = createThinkingBlock(trace, options)
    bindTaskFlowNode(block, nodeId)
    return block
  }

  function renderCanonicalTaskFlow(force = false) {
    if (!taskFlowProjection) return
    if (canonicalTaskFlowFrame !== null) window.cancelAnimationFrame(canonicalTaskFlowFrame)
    canonicalTaskFlowFrame = null
    canonicalTaskFlowForce = false
    linearTaskFlowRenderer.render(taskFlowProjection, force)
    reconcileHistoryRewriteProjection()
    if (pendingOptimisticUserElement?.isConnected && pendingOptimisticInputId) {
      const committed = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(pendingOptimisticInputId)}"]:not(.optimistic-user-turn)`)
      if (committed) clearPendingOptimisticUserTurn()
    }
    renderProjectedWorkPlan()
    setConversationMode(taskFlowProjection.order.length > 0 || transcript.childElementCount > 0)
    if (currentSnapshot) refreshExecutionVisualEvidence(currentSnapshot)
    scrollTranscript()
  }

  function cancelCanonicalTaskFlowRender() {
    if (canonicalTaskFlowFrame !== null) window.cancelAnimationFrame(canonicalTaskFlowFrame)
    canonicalTaskFlowFrame = null
    canonicalTaskFlowForce = false
  }

  function scheduleCanonicalTaskFlowRender(force = false) {
    canonicalTaskFlowForce ||= force
    if (canonicalTaskFlowFrame !== null) return
    canonicalTaskFlowFrame = window.requestAnimationFrame(() => {
      canonicalTaskFlowFrame = null
      const shouldForce = canonicalTaskFlowForce
      canonicalTaskFlowForce = false
      renderCanonicalTaskFlow(shouldForce)
    })
  }

  function reconcileHistoryRewriteUserTurn(turn: AgentTurn): HTMLElement | null {
    historyRewriteOptimisticTurn = turn
    const committed = taskFlowProjection?.order.some(id => {
      const node = taskFlowProjection?.nodes[id]
      return node?.kind === 'input' && node.turnId === turn.id
    })
    if (committed) {
      clearHistoryRewriteViewport()
      return transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`)
    }
    const existing = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"][data-history-rewrite-optimistic="true"]`)
    if (!existing) return mountHistoryRewriteOptimisticTurn()
    const replacement = createMessageElement(
      turn,
      collectToolResults(currentSnapshot?.conversation.turns || []),
      true,
      true,
      false,
    )
    if (!replacement) return existing
    replacement.classList.add('optimistic-user-turn')
    replacement.dataset.historyRewriteOptimistic = 'true'
    existing.replaceWith(replacement)
    refreshHistoryRewriteViewportSpace()
    return replacement
  }

  function mountHistoryRewriteOptimisticTurn(): HTMLElement | null {
    const turn = historyRewriteOptimisticTurn
    if (!turn) return null
    const existing = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"][data-history-rewrite-optimistic="true"]`)
    if (existing) return existing
    const element = createMessageElement(
      turn,
      collectToolResults(currentSnapshot?.conversation.turns || []),
      false,
      true,
      false,
      false,
    )
    if (!element) return null
    element.classList.add('optimistic-user-turn')
    element.dataset.historyRewriteOptimistic = 'true'
    appendTranscriptElement(element)
    setConversationMode(true)
    return element
  }

  function reconcileHistoryRewriteProjection() {
    const turn = historyRewriteOptimisticTurn
    if (!turn || !taskFlowProjection) return
    const committed = taskFlowProjection.order.some(id => {
      const node = taskFlowProjection?.nodes[id]
      return node?.kind === 'input' && node.turnId === turn.id
    })
    if (!committed) {
      mountHistoryRewriteOptimisticTurn()
      return
    }
    clearHistoryRewriteViewport()
  }

  function createConversationFailureElement(snapshot: WorkbenchSnapshot): HTMLElement | null {
    const failure = latestConversationFailure(snapshot)
    if (!failure) return null
    const row = document.createElement('article')
    row.className = `conversation-failure ${failure.kind}`
    row.dataset.runId = failure.runId
    const copy = document.createElement('span')
    copy.className = 'conversation-failure-copy'
    const title = document.createElement('strong')
    title.textContent = failure.title
    const detail = document.createElement('small')
    detail.textContent = failure.message
    copy.append(title, detail)
    const actions = document.createElement('span')
    actions.className = 'conversation-failure-actions'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重新尝试'
    retry.disabled = !bridge || snapshot.runtime.status === 'running' || snapshot.persistence.status === 'degraded'
    retry.addEventListener('click', async () => {
      if (!bridge) return
      retry.disabled = true
      try {
        beginRequestStatusAttempt(failure.turnId)
        await bridge.resendFromTurn(failure.turnId, failure.prompt)
      } catch (error) {
        retry.disabled = false
        showToast(errorMessage(error))
      }
    })
    actions.append(retry)
    row.append(copy, actions)
    return row
  }

  function createToolCard(
    call: ToolCall,
    result: ToolResult | undefined,
    status: 'running' | 'completed' | 'failed',
    animate = true,
  ): HTMLElement {
    const activity = createToolActivity(call, result, status, {
      animate,
      onPreviewDiff: change => {
        selectedChange = change
        openInspector('outputs')
      },
    })
    bindTaskFlowNode(activity, taskFlowNodeIdForTool(taskFlowProjection, call.id))
    return activity
  }

  function clearPendingOptimisticUserTurn() {
    pendingOptimisticUserElement?.remove()
    pendingOptimisticUserElement = null
    pendingOptimisticUserPrompt = ''
    pendingOptimisticInputId = ''
  }

  function mountOptimisticUserTurn(
    prompt: string,
    attachments: AgentAttachment[] | undefined,
    capabilities: AgentCapabilitySelection | undefined,
  ): HTMLElement | null {
    clearPendingOptimisticUserTurn()
    const turn: AgentTurn = {
      id: `optimistic-user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        attachments,
        capabilities,
      },
    }
    const element = createMessageElement(turn, new Map(), false, false, false, false, false)
    if (!element) return null
    element.classList.add('optimistic-user-turn')
    element.dataset.optimisticUserTurn = 'true'
    pendingOptimisticUserElement = element
    pendingOptimisticUserPrompt = prompt
    pendingOptimisticInputId = ''
    setConversationMode(true)
    appendTranscriptElement(element)
    scrollTranscript(true)
    return element
  }

  function reconcileOptimisticUserTurn(turn: AgentTurn) {
    if (
      turn.role !== 'user'
      || !pendingOptimisticUserElement?.isConnected
      || turn.content !== pendingOptimisticUserPrompt
    ) return
    pendingOptimisticInputId = turn.id
    pendingOptimisticUserElement.dataset.optimisticInputId = turn.id
  }

  function renderTurns(turns: AgentTurn[], animate = false) {
    cancelCanonicalTaskFlowRender()
    const viewportAnchor = !transcriptFollowState.following && !historyRewriteAnchorTurnId
      ? captureTranscriptViewportAnchor()
      : null
    pendingConversationRender = false
    transcript.classList.toggle('restoring', !animate)
    transcript.replaceChildren()
    historyRewriteLeadingSpacer = null
    historyRewriteSpacer = null
    editingTurnId = ''
    liveToolCalls.clear()
    liveToolResults.clear()
    liveTurnCache.clear()
    for (const turn of turns) liveTurnCache.set(turn.id, turn)
    if (currentSnapshot) taskFlowProjection = projectTaskFlowSnapshot(currentSnapshot)
    if (!taskFlowProjection) throw new Error('Canonical task-flow projection unavailable')
    renderCanonicalTaskFlow(true)
    if (currentSnapshot) {
      const failure = createConversationFailureElement(currentSnapshot)
      if (failure) transcript.append(failure)
    }
    activeWorkRunId = taskFlowProjection.activeRunId || ''
    activeTurnIsTask = Boolean(activeWorkRunId)
    activeTaskStartedAt = currentSnapshot?.runtime.runState.startedAt || 0
    if (historyRewriteAnchorTurnId) mountHistoryRewriteViewportSpace()
    if (viewportAnchor) restoreTranscriptViewportAnchor(viewportAnchor)
    else scrollTranscript(true)
    if (!animate) requestAnimationFrame(() => transcript.classList.remove('restoring'))
  }
  function beginRequestStatusAttempt(turnId = requestStatusAttemptTurnId) {
    requestStatusTerminalFence = null
    requestStatusAttemptTurnId = turnId
  }

  function markRequestStatusTerminal() {
    const conversationId = currentSnapshot?.conversation.id
    if (conversationId) {
      requestStatusTerminalFence = {
        conversationId,
        latestUserTurnId: requestStatusAttemptTurnId || historyRewriteOptimisticTurn?.id || latestUserTurnId(currentSnapshot?.conversation.turns || []),
      }
    }
  }

  function renderConversationList(snapshot: WorkbenchSnapshot) {
    const list = app.querySelector<HTMLDivElement>('#conversation-list')!
    const runtimes = new Map(snapshot.conversationRuntimes.map(runtime => [runtime.conversationId, runtime]))
    const activeConversationIds = new Set(snapshot.conversationRuntimes
      .filter(runtime => ['running', 'paused', 'awaiting-action'].includes(runtime.status))
      .map(runtime => runtime.conversationId))
    const conversations = visibleTaskConversations(
      snapshot.conversationCatalog,
      snapshot.conversation.id,
      activeConversationIds,
      Number.MAX_SAFE_INTEGER,
    )
    const currentHasTurns = snapshot.conversation.turns.some(turn => turn.role === 'user' || turn.role === 'assistant')
    if (!conversations.some(item => item.id === snapshot.conversation.id)) {
      const title = snapshot.conversation.turns.find(turn => turn.role === 'user')?.content.trim().slice(0, 36) || NEW_TASK_TITLE
      conversations.unshift({
        id: snapshot.conversation.id,
        title,
        workspacePath: snapshot.workspace.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mode: snapshot.runtime.mode,
        model: snapshot.runtime.model,
        provider: snapshot.runtime.provider,
        turnCount: currentHasTurns ? snapshot.conversation.turns.length : 0,
      })
    }
    const groups = projectWorkspaceConversationGroups({
      conversations,
      projects: snapshot.projects.projects,
      currentConversationId: snapshot.conversation.id,
      platform: snapshot.platform,
      query: workspaceTaskQuery,
    })
    for (const group of groups) {
      if (group.containsCurrent && !Object.hasOwn(workspaceGroupExpansion, group.key)) {
        workspaceGroupExpansion[group.key] = true
      }
    }
    const listSignature = JSON.stringify({
      current: snapshot.conversation.id,
      query: workspaceTaskQuery,
      groups: groups.map(group => ({
        key: group.key,
        name: group.name,
        expanded: workspaceTaskQuery !== '' || workspaceGroupExpansion[group.key] === true,
        showAll: expandedWorkspaceTaskGroups.has(group.key),
        conversations: group.conversations.map(conversation => ({ id: conversation.id, title: conversation.title, updatedMinute: Math.floor(conversation.updatedAt / 60_000), turnCount: conversation.turnCount })),
      })),
      runtimes: snapshot.conversationRuntimes.map(runtime => ({ conversationId: runtime.conversationId, status: runtime.status })),
    })
    if (listSignature === renderedConversationListSignature) return
    renderedConversationListSignature = listSignature
    list.replaceChildren()

    const appendConversation = (host: HTMLElement, conversation: typeof conversations[number]) => {
      const runtime = runtimes.get(conversation.id)
      const row = document.createElement('div')
      row.className = `conversation-row${conversation.id === snapshot.conversation.id ? ' active' : ''}${runtime && runtime.status !== 'ready' ? ` ${runtime.status}` : ''}`
      const button = document.createElement('button')
      button.className = `conversation${conversation.id === snapshot.conversation.id ? ' active' : ''}${runtime && runtime.status !== 'ready' ? ` ${runtime.status}` : ''}`
      button.dataset.conversationId = conversation.id
      const copy = document.createElement('span')
      copy.className = 'conversation-copy'
      const title = document.createElement('strong')
      const displayTitle = taskDisplayTitle(conversation)
      title.textContent = displayTitle
      button.title = displayTitle
      copy.append(title)
      const time = document.createElement('time')
      time.textContent = runtime?.status === 'running'
          ? '工作中'
          : runtime?.status === 'paused'
            ? '已暂停'
            : runtime?.status === 'awaiting-action'
              ? '待确认'
              : formatRelativeTime(conversation.updatedAt)
      copy.append(time)
      button.append(copy)
      if (conversation.id === snapshot.conversation.id) button.setAttribute('aria-current', 'page')
      button.addEventListener('click', () => void switchConversation(conversation.id))
      row.addEventListener('contextmenu', event => {
        event.preventDefault()
        event.stopPropagation()
        document.querySelectorAll('.conversation-menu').forEach(menu => menu.remove())
        const menu = document.createElement('div')
        menu.className = 'conversation-menu'
        menu.style.left = `${event.clientX}px`
        menu.style.top = `${event.clientY}px`
        const rename = document.createElement('button')
        rename.textContent = '重命名'
        rename.addEventListener('click', async () => {
          menu.remove()
          const next = await openWorkbenchDialog({
            title: '重命名任务',
            message: '为这段工作选择一个更容易识别的名字。',
            confirmLabel: '保存',
            inputValue: displayTitle,
          })
          if (typeof next !== 'string' || !next) return
          try {
            if (!await bridge?.renameConversation(conversation.id, next)) throw new Error('无法重命名任务')
            if (bridge) applySnapshot(await bridge.getSnapshot(), false)
          } catch (error) {
            showToast(errorMessage(error))
          }
        })
        const remove = document.createElement('button')
        remove.className = 'danger'
        remove.innerHTML = `${icon('trash')} 删除`
        remove.addEventListener('click', async () => {
          menu.remove()
          const confirmed = await openWorkbenchDialog({
            title: '删除任务？',
            message: '会删除这段会话的本地记录，此操作无法撤销。',
            confirmLabel: '删除',
            danger: true,
          })
          if (confirmed !== true) return
          try {
            if (!await bridge?.deleteConversation(conversation.id)) throw new Error('无法删除任务')
            if (bridge) applySnapshot(await bridge.getSnapshot())
          } catch (error) {
            showToast(errorMessage(error))
          }
        })
        menu.append(rename, remove)
        document.body.append(menu)
        const bounds = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`
        menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`
      })
      row.append(button)
      host.append(row)
    }

    for (const group of groups) {
      const expanded = workspaceTaskQuery !== '' || workspaceGroupExpansion[group.key] === true
      const section = document.createElement('section')
      section.className = `workspace-task-group${group.containsCurrent ? ' contains-current' : ''}`
      section.dataset.workspaceKey = group.key

      const header = document.createElement('div')
      header.className = 'workspace-task-group-header'
      const toggle = document.createElement('button')
      toggle.className = 'workspace-task-group-toggle'
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', String(expanded))
      toggle.setAttribute('aria-label', `${group.name}，${group.conversations.length} 个任务`)
      toggle.title = group.path || group.name
      toggle.innerHTML = `${icon('chevron')}${icon('folder')}`
      const label = document.createElement('strong')
      label.textContent = group.name
      toggle.append(label)
      toggle.addEventListener('click', () => {
        workspaceGroupExpansion = { ...workspaceGroupExpansion, [group.key]: !expanded }
        if (expanded) expandedWorkspaceTaskGroups.delete(group.key)
        localStorage.setItem(workspaceGroupExpansionStorageKey, JSON.stringify(workspaceGroupExpansion))
        renderedConversationListSignature = ''
        if (currentSnapshot) renderConversationList(currentSnapshot)
      })
      header.append(toggle)

      if (group.projectId) {
        const create = document.createElement('button')
        create.className = 'workspace-task-group-create'
        create.type = 'button'
        create.title = `在 ${group.name} 中新建任务`
        create.setAttribute('aria-label', `在 ${group.name} 中新建任务`)
        create.innerHTML = icon('plus')
        create.addEventListener('click', async () => {
          if (!bridge || composerActionGuard.active || conversationNavigationGuard.active) return
          const release = conversationNavigationGuard.tryAcquire()
          if (!release) return
          try {
            await persistDraftNow()
            const result = await bridge.newConversationInProject(group.projectId!)
            taskInput.value = ''
            draftAttachments = []
            draftFiles = []
            pendingPastes = []
            renderDraftTray()
            selectedChange = null
            applySnapshot(result.snapshot)
            taskInput.focus()
          } catch (error) {
            showToast(errorMessage(error))
          } finally {
            finishConversationNavigation(release)
          }
        })
        header.append(create)
      }
      section.append(header)

      if (expanded) {
        const taskHost = document.createElement('div')
        taskHost.className = 'workspace-task-group-conversations'
        const showAll = workspaceTaskQuery !== '' || expandedWorkspaceTaskGroups.has(group.key)
        const visible = showAll ? group.conversations : group.conversations.slice(0, 5)
        for (const conversation of visible) appendConversation(taskHost, conversation)
        if (group.conversations.length > 5 && workspaceTaskQuery === '') {
          const overflow = document.createElement('button')
          overflow.className = 'workspace-task-overflow'
          overflow.type = 'button'
          overflow.setAttribute('aria-expanded', String(showAll))
          overflow.textContent = showAll ? '收起' : '查看更多'
          overflow.addEventListener('click', () => {
            if (showAll) expandedWorkspaceTaskGroups.delete(group.key)
            else expandedWorkspaceTaskGroups.add(group.key)
            renderedConversationListSignature = ''
            if (currentSnapshot) renderConversationList(currentSnapshot)
          })
          taskHost.append(overflow)
        }
        section.append(taskHost)
      }
      list.append(section)
    }

    if (groups.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'workspace-task-empty'
      empty.textContent = workspaceTaskQuery ? '没有匹配的任务' : '还没有工作区任务'
      list.append(empty)
    }
  }

  function showMainView(view: 'workbench' | 'projects' | 'automations') {
    currentMainView = view
    mainScroll.hidden = view !== 'workbench'
    workPlanDock.classList.toggle('view-hidden', view !== 'workbench')
    productView.classList.toggle('visible', view !== 'workbench')
    productView.setAttribute('aria-hidden', String(view === 'workbench'))
    app.querySelector('#breadcrumb-title')!.textContent = view === 'projects'
      ? '项目'
      : view === 'automations'
        ? '自动化'
        : currentSnapshot
          ? currentConversationTitle(currentSnapshot)
          : '工作台'
    if (view === 'workbench') productView.replaceChildren()
    else renderProductView()
    renderTaskCompanion()
  }

  function productHeader(titleText: string, detailText: string, actionText: string, onAction: () => void): HTMLElement {
    const header = document.createElement('header')
    header.className = 'product-view-header'
    const copy = document.createElement('div')
    const title = document.createElement('h1')
    title.textContent = titleText
    const detail = document.createElement('p')
    detail.textContent = detailText
    copy.append(title, detail)
    const action = document.createElement('button')
    action.innerHTML = `${icon('plus')}<span>${actionText}</span>`
    action.addEventListener('click', onAction)
    header.append(copy, action)
    return header
  }

  function renderProjectsView(snapshot: WorkbenchSnapshot) {
    productView.replaceChildren()
    productView.append(productHeader('项目', '固定常用工作区，继续最近的任务。', '添加项目', () => {
      void bridge?.addProject().then(async result => {
        if (!result || !bridge) return
        applySnapshot(await bridge.getSnapshot(), false)
      }).catch(error => showToast(errorMessage(error)))
    }))
    const search = document.createElement('input')
    search.className = 'product-search'
    search.placeholder = '搜索项目'
    const list = document.createElement('div')
    list.className = 'project-grid'
    const renderList = () => {
      list.replaceChildren()
      const query = search.value.trim().toLowerCase()
      const projects = snapshot.projects.projects.filter(project => !query || `${project.name} ${project.path} ${project.tags.join(' ')}`.toLowerCase().includes(query))
      if (projects.length === 0) {
        list.innerHTML = '<div class="product-empty"><strong>还没有项目</strong><p>添加一个文件夹后，可以从这里继续工作。</p></div>'
        return
      }
      for (const project of projects) {
        const card = document.createElement('article')
        card.className = `project-card${project.available ? '' : ' unavailable'}`
        const marker = document.createElement('div')
        marker.className = 'project-marker'
        marker.textContent = project.name.slice(0, 1).toUpperCase()
        const copy = document.createElement('div')
        const name = document.createElement('strong')
        name.textContent = project.name
        const path = document.createElement('small')
        path.textContent = project.available ? project.path : '文件夹不可用'
        const meta = document.createElement('span')
        meta.textContent = project.pinned ? '已固定' : formatRelativeTime(project.lastOpenedAt)
        copy.append(name, path, meta)
        const actions = document.createElement('div')
        actions.className = 'project-card-actions'
        const open = document.createElement('button')
        open.textContent = project.available ? '打开' : '不可用'
        open.disabled = !project.available
        open.addEventListener('click', () => void bridge?.openProject(project.id).then(next => {
          applySnapshot(next)
          showMainView('workbench')
          app.querySelectorAll('.sidebar-nav-item').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.view === 'workbench'))
        }).catch(error => showToast(errorMessage(error))))
        const pin = document.createElement('button')
        pin.textContent = project.pinned ? '取消固定' : '固定'
        pin.addEventListener('click', () => void bridge?.updateProject(project.id, { pinned: !project.pinned }).then(async () => {
          if (bridge) applySnapshot(await bridge.getSnapshot(), false)
        }).catch(error => showToast(errorMessage(error))))
        const reveal = document.createElement('button')
        reveal.textContent = '定位'
        reveal.disabled = !project.available
        reveal.addEventListener('click', () => void bridge?.revealProject(project.id).catch(error => showToast(errorMessage(error))))
        const more = document.createElement('button')
        more.textContent = '•••'
        more.addEventListener('click', async () => {
          const next = await openWorkbenchDialog({ title: '重命名项目', message: project.path, inputValue: project.name, confirmLabel: '保存' })
          if (typeof next !== 'string' || !next.trim()) return
          try {
            await bridge?.updateProject(project.id, { name: next.trim() })
            if (bridge) applySnapshot(await bridge.getSnapshot(), false)
          } catch (error) { showToast(errorMessage(error)) }
        })
        const remove = document.createElement('button')
        remove.className = 'danger'
        remove.textContent = '移除'
        remove.addEventListener('click', async () => {
          const confirmed = await openWorkbenchDialog({ title: '移除项目？', message: '只会从项目列表中移除，不会删除文件夹或任务记录。', confirmLabel: '移除', danger: true })
          if (confirmed !== true) return
          try {
            await bridge?.removeProject(project.id)
            if (bridge) applySnapshot(await bridge.getSnapshot(), false)
          } catch (error) { showToast(errorMessage(error)) }
        })
        actions.append(open, pin, reveal, more, remove)
        card.append(marker, copy, actions)
        list.append(card)
      }
    }
    search.addEventListener('input', renderList)
    productView.append(search, list)
    renderList()
  }

  function automationScheduleLabel(schedule: WorkbenchSnapshot['automations']['automations'][number]['schedule']): string {
    if (schedule.kind === 'manual') return '手动运行'
    if (schedule.kind === 'once') return `单次 · ${new Date(schedule.at).toLocaleString()}`
    if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
    if (schedule.kind === 'daily') return `每天 ${schedule.time}`
    return `每周${['日', '一', '二', '三', '四', '五', '六'][schedule.weekday]} ${schedule.time}`
  }

  function automationStatusLabel(status: WorkbenchSnapshot['automations']['automations'][number]['lastStatus']): string {
    return ({
      queued: '已排队',
      running: '运行中',
      waiting_for_workspace: '等待工作区',
      waiting_for_approval: '等待审批',
      retry_scheduled: '等待重试',
      completed: '已完成',
      failed: '失败',
      canceled: '已取消',
      interrupted: '已中断',
      skipped: '已跳过',
      missed: '已错过',
    } as Record<string, string>)[status || ''] || '尚未运行'
  }

  function automationDurationLabel(durationMs?: number): string {
    if (durationMs === undefined) return ''
    const seconds = Math.max(0, Math.round(durationMs / 1_000))
    if (seconds < 60) return `${seconds} 秒`
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  }

  function toLocalDateTimeInput(value?: string): string {
    const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
  }

  function renderAutomationEditor(snapshot: WorkbenchSnapshot, automationId: string | null): HTMLElement {
    const existing = automationId ? snapshot.automations.automations.find(item => item.id === automationId) : undefined
    const editor = document.createElement('section')
    editor.className = 'automation-editor'
    const heading = document.createElement('header')
    const headingTitle = document.createElement('strong')
    headingTitle.textContent = existing ? '编辑自动化' : '创建自动化'
    const headingDetail = document.createElement('span')
    headingDetail.textContent = '在独立后台任务中运行，不占用当前对话。'
    heading.append(headingTitle, headingDetail)
    const grid = document.createElement('div')
    grid.className = 'automation-editor-grid'
    const field = (labelText: string, control: HTMLElement, wide = false) => {
      const label = document.createElement('label')
      label.className = `automation-field${wide ? ' wide' : ''}`
      const title = document.createElement('span')
      title.textContent = labelText
      label.append(title, control)
      return label
    }
    const name = document.createElement('input')
    name.placeholder = '例如：每天整理项目进展'
    name.value = existing?.name || ''
    const prompt = document.createElement('textarea')
    prompt.placeholder = '描述工作目标、验收标准和最终交付物。'
    prompt.rows = 6
    prompt.value = existing?.prompt || ''
    const schedule = document.createElement('select')
    schedule.innerHTML = '<option value="manual">手动</option><option value="once">单次</option><option value="interval">按间隔</option><option value="daily">每天</option><option value="weekly">每周</option>'
    schedule.value = existing?.schedule.kind || 'manual'
    const value = document.createElement('input')
    value.className = 'automation-schedule-value'
    const weekday = document.createElement('select')
    weekday.className = 'automation-weekday'
    weekday.innerHTML = '<option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option>'
    weekday.value = existing?.schedule.kind === 'weekly' ? String(existing.schedule.weekday) : '1'
    const approval = document.createElement('select')
    approval.className = 'automation-approval'
    approval.innerHTML = '<option value="ask">每次确认</option><option value="agent">低风险自动</option><option value="full">完全访问</option>'
    approval.value = existing?.approvalPolicy || 'ask'
    approval.title = '自动化运行时使用的审批策略'
    const timezone = document.createElement('input')
    timezone.placeholder = 'Asia/Shanghai'
    timezone.value = existing?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    const misfire = document.createElement('select')
    misfire.innerHTML = '<option value="run-once">恢复后补跑一次</option><option value="skip">错过后跳过</option>'
    misfire.value = existing?.misfirePolicy || 'run-once'
    const overlap = document.createElement('select')
    overlap.innerHTML = '<option value="skip">运行中则跳过</option><option value="queue-one">运行中则保留一次</option>'
    overlap.value = existing?.overlapPolicy || 'skip'
    const retries = document.createElement('input')
    retries.type = 'number'
    retries.min = '0'
    retries.max = '10'
    retries.value = String(existing?.retryPolicy.maxRetries ?? 2)
    const backoff = document.createElement('input')
    backoff.type = 'number'
    backoff.min = '1'
    backoff.max = '1440'
    backoff.value = String(existing?.retryPolicy.backoffMinutes ?? 2)
    const maxRuntime = document.createElement('input')
    maxRuntime.type = 'number'
    maxRuntime.min = '1'
    maxRuntime.max = '1440'
    maxRuntime.value = String(existing?.maxRuntimeMinutes ?? 60)
    const syncValue = () => {
      value.hidden = schedule.value === 'manual'
      weekday.hidden = schedule.value !== 'weekly'
      if (value.parentElement) value.parentElement.hidden = value.hidden
      if (weekday.parentElement) weekday.parentElement.hidden = weekday.hidden
      value.type = schedule.value === 'once' ? 'datetime-local' : schedule.value === 'daily' || schedule.value === 'weekly' ? 'time' : 'number'
      value.min = schedule.value === 'interval' ? '1' : ''
      value.max = schedule.value === 'interval' ? '10080' : ''
      value.placeholder = schedule.value === 'interval' ? '分钟' : ''
      if (schedule.value === 'once') value.value = existing?.schedule.kind === 'once' ? toLocalDateTimeInput(existing.schedule.at) : value.value || toLocalDateTimeInput()
      if (schedule.value === 'daily') value.value = existing?.schedule.kind === 'daily' ? existing.schedule.time : value.value || '09:00'
      if (schedule.value === 'weekly') value.value = existing?.schedule.kind === 'weekly' ? existing.schedule.time : value.value || '09:00'
      if (schedule.value === 'interval') value.value = existing?.schedule.kind === 'interval' ? String(existing.schedule.everyMinutes) : value.value || '60'
    }
    schedule.addEventListener('change', syncValue)
    syncValue()
    const enabled = document.createElement('label')
    enabled.className = 'automation-enabled'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = existing?.enabled ?? true
    enabled.append(checkbox, document.createTextNode('启用调度'))
    const footer = document.createElement('footer')
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => { automationEditorId = null; renderProductView() })
    const save = document.createElement('button')
    save.className = 'primary'
    save.textContent = existing ? '保存' : '创建'
    save.addEventListener('click', async () => {
      const normalizedName = name.value.trim()
      const normalizedPrompt = prompt.value.trim()
      if (!normalizedName || !normalizedPrompt) return showToast('请填写名称和任务内容')
      const normalizedSchedule = schedule.value === 'interval'
        ? { kind: 'interval' as const, everyMinutes: Math.max(1, Number(value.value) || 60) }
        : schedule.value === 'once'
          ? { kind: 'once' as const, at: new Date(value.value).toISOString() }
        : schedule.value === 'daily'
          ? { kind: 'daily' as const, time: value.value || '09:00' }
          : schedule.value === 'weekly'
            ? { kind: 'weekly' as const, weekday: Number(weekday.value), time: value.value || '09:00' }
          : { kind: 'manual' as const }
      try {
        const automationInput = {
          name: normalizedName,
          prompt: normalizedPrompt,
          schedule: normalizedSchedule,
          timezone: timezone.value.trim() || 'Asia/Shanghai',
          enabled: checkbox.checked,
          approvalPolicy: approval.value as ApprovalPolicy,
          misfirePolicy: misfire.value as 'run-once' | 'skip',
          overlapPolicy: overlap.value as 'skip' | 'queue-one',
          retryPolicy: {
            maxRetries: Math.max(0, Math.min(10, Number(retries.value) || 0)),
            backoffMinutes: Math.max(1, Math.min(1440, Number(backoff.value) || 2)),
          },
          maxRuntimeMinutes: Math.max(1, Math.min(1440, Number(maxRuntime.value) || 60)),
        }
        if (existing) await bridge?.updateAutomation(existing.id, automationInput)
        else await bridge?.createAutomation(automationInput)
        automationEditorId = null
        if (bridge) applySnapshot(await bridge.getSnapshot(), false)
      } catch (error) { showToast(errorMessage(error)) }
    })
    footer.append(cancel, save)
    grid.append(
      field('名称', name, true),
      field('每次要完成的工作', prompt, true),
      field('运行方式', schedule),
      field('执行时间', value),
      field('星期', weekday),
      field('时区', timezone),
      field('审批策略', approval),
      field('错过计划时', misfire),
      field('上次仍在运行时', overlap),
      field('失败重试次数', retries),
      field('首次重试等待（分钟）', backoff),
      field('最长运行（分钟）', maxRuntime),
    )
    syncValue()
    editor.append(heading, grid, enabled, footer)
    return editor
  }

  async function openAutomationConversation(conversationId: string) {
    try {
      if (conversationId !== currentSnapshot?.conversation.id) await switchConversation(conversationId)
      app.querySelectorAll('.sidebar-nav-item').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.view === 'workbench'))
      showMainView('workbench')
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  function renderAutomationsView(snapshot: WorkbenchSnapshot) {
    productView.replaceChildren()
    productView.append(productHeader('自动化', '用独立后台 Agent 按计划完成重复工作，并保留完整上下文与结果。', '新建自动化', () => {
      automationEditorId = 'new'
      renderProductView()
    }))
    const overview = document.createElement('section')
    overview.className = 'automation-overview'
    const health = snapshot.automations.scheduler
    const healthCopy = document.createElement('div')
    healthCopy.className = `automation-scheduler-health ${health.status}`
    const healthDot = document.createElement('i')
    const healthText = document.createElement('div')
    const healthTitle = document.createElement('strong')
    healthTitle.textContent = health.status === 'degraded' ? '调度器需要注意' : health.status === 'running' ? '后台任务运行中' : health.status === 'watching' ? '调度器已就绪' : '暂无待执行计划'
    const healthDetail = document.createElement('span')
    healthDetail.textContent = health.error || (health.nextWakeAt ? `下次检查 ${new Date(health.nextWakeAt).toLocaleString()}` : '创建或启用计划后会自动开始监听')
    healthText.append(healthTitle, healthDetail)
    healthCopy.append(healthDot, healthText)
    const metrics = document.createElement('div')
    metrics.className = 'automation-metrics'
    const activeCount = snapshot.automations.automations.filter(item => item.activeRunId).length
    const enabledCount = snapshot.automations.automations.filter(item => item.enabled).length
    const failedCount = snapshot.automations.automations.filter(item => item.lastStatus === 'failed' || item.lastStatus === 'interrupted').length
    metrics.innerHTML = `<span><strong>${enabledCount}</strong> 已启用</span><span><strong>${activeCount}</strong> 运行中</span><span><strong>${failedCount}</strong> 待处理</span>`
    overview.append(healthCopy, metrics)
    productView.append(overview)
    if (automationEditorId) productView.append(renderAutomationEditor(snapshot, automationEditorId === 'new' ? null : automationEditorId))
    const list = document.createElement('div')
    list.className = 'automation-list'
    if (snapshot.automations.automations.length === 0) {
      list.innerHTML = '<div class="product-empty"><strong>还没有自动化</strong><p>适合定期整理、检查和生成内容的工作。</p></div>'
    }
    for (const automation of snapshot.automations.automations) {
      const row = document.createElement('article')
      row.className = `automation-row${automation.enabled ? '' : ' disabled'}`
      const status = document.createElement('i')
      status.className = automation.lastStatus || 'idle'
      const copy = document.createElement('div')
      copy.className = 'automation-copy'
      const titleRow = document.createElement('div')
      titleRow.className = 'automation-title-row'
      const name = document.createElement('strong')
      name.textContent = automation.name
      const state = document.createElement('span')
      state.className = `automation-state ${automation.lastStatus || 'idle'}`
      state.textContent = automationStatusLabel(automation.lastStatus)
      titleRow.append(name, state)
      const detail = document.createElement('p')
      detail.textContent = automation.prompt
      const meta = document.createElement('small')
      meta.textContent = `${automationScheduleLabel(automation.schedule)} · ${automation.timezone} · ${automation.approvalPolicy === 'ask' ? '每次确认' : automation.approvalPolicy === 'agent' ? '低风险自动' : '完全访问'}${automation.nextRunAt ? ` · 下次 ${new Date(automation.nextRunAt).toLocaleString()}` : ''}`
      copy.append(titleRow, detail, meta)
      if (automation.history.length > 0) {
        const history = document.createElement('details')
        history.className = 'automation-history'
        const summary = document.createElement('summary')
        summary.textContent = `运行记录 ${automation.history.length}`
        const runs = document.createElement('div')
        for (const item of automation.history.slice(0, 20)) {
          const run = document.createElement('div')
          run.className = `automation-history-run ${item.status}`
          const runCopy = document.createElement('div')
          const runTitle = document.createElement('strong')
          runTitle.textContent = automationStatusLabel(item.status)
          const runMeta = document.createElement('span')
          runMeta.textContent = `${new Date(item.startedAt).toLocaleString()} · 第 ${item.attempt} 次${item.durationMs !== undefined ? ` · ${automationDurationLabel(item.durationMs)}` : ''}`
          runCopy.append(runTitle, runMeta)
          if (item.resultSummary || item.error) {
            const runDetail = document.createElement('p')
            runDetail.textContent = item.resultSummary || item.error || ''
            runCopy.append(runDetail)
          }
          const runActions = document.createElement('div')
          if (item.conversationId) {
            const view = document.createElement('button')
            view.textContent = '查看结果'
            view.addEventListener('click', () => void openAutomationConversation(item.conversationId!))
            runActions.append(view)
          }
          if (['failed', 'interrupted', 'canceled', 'retry_scheduled'].includes(item.status) && !automation.activeRunId) {
            const retry = document.createElement('button')
            retry.textContent = '立即重试'
            retry.addEventListener('click', () => void bridge?.retryAutomationRun(automation.id, item.id).then(result => {
              applySnapshot(result.snapshot, false)
              showToast('已开始重试')
            }).catch(error => showToast(errorMessage(error))))
            runActions.append(retry)
          }
          run.append(runCopy, runActions)
          runs.append(run)
        }
        history.append(summary, runs)
        copy.append(history)
      }
      const controls = document.createElement('div')
      controls.className = 'automation-controls'
      const toggle = document.createElement('button')
      toggle.textContent = automation.enabled ? '暂停' : '启用'
      toggle.addEventListener('click', () => void bridge?.updateAutomation(automation.id, { enabled: !automation.enabled }).then(async () => {
        if (bridge) applySnapshot(await bridge.getSnapshot(), false)
      }).catch(error => showToast(errorMessage(error))))
      const run = document.createElement('button')
      run.textContent = automation.activeRunId ? '停止' : '立即运行'
      if (automation.activeRunId) {
        run.className = 'danger'
        run.addEventListener('click', () => void bridge?.cancelAutomationRun(automation.id).then(async () => {
          if (bridge) applySnapshot(await bridge.getSnapshot(), false)
          showToast('已停止自动化')
        }).catch(error => showToast(errorMessage(error))))
      } else {
        run.addEventListener('click', () => void bridge?.runAutomation(automation.id).then(result => {
          applySnapshot(result.snapshot, false)
          showToast(result.status === 'queued' ? '已加入后台队列' : '自动化已开始')
        }).catch(error => showToast(errorMessage(error))))
      }
      const edit = document.createElement('button')
      edit.textContent = '编辑'
      edit.addEventListener('click', () => { automationEditorId = automation.id; renderProductView() })
      const duplicate = document.createElement('button')
      duplicate.textContent = '复制'
      duplicate.addEventListener('click', () => void bridge?.duplicateAutomation(automation.id).then(async () => {
        if (bridge) applySnapshot(await bridge.getSnapshot(), false)
        showToast('已创建停用的副本')
      }).catch(error => showToast(errorMessage(error))))
      const remove = document.createElement('button')
      remove.className = 'danger'
      remove.textContent = '删除'
      remove.addEventListener('click', async () => {
        const confirmed = await openWorkbenchDialog({ title: '删除自动化？', message: automation.name, confirmLabel: '删除', danger: true })
        if (confirmed !== true) return
        try {
          await bridge?.removeAutomation(automation.id)
          if (bridge) applySnapshot(await bridge.getSnapshot(), false)
        } catch (error) { showToast(errorMessage(error)) }
      })
      controls.append(toggle, run, edit, duplicate, remove)
      row.append(status, copy, controls)
      list.append(row)
    }
    productView.append(list)
  }

  function renderProductView() {
    if (!currentSnapshot) return
    if (currentMainView === 'projects') renderProjectsView(currentSnapshot)
    else if (currentMainView === 'automations') renderAutomationsView(currentSnapshot)
  }

  function openInspector(tab: InspectorTab, workRunId?: string) {
    if (inspectorFastCloseTimer !== null) {
      window.clearTimeout(inspectorFastCloseTimer)
      inspectorFastCloseTimer = null
    }
    shell.classList.remove('inspector-fast-closing')
    currentInspectorTab = tab
    if (tab === 'activity') selectedWorkRunId = workRunId || null
    shell.classList.add('inspector-open')
    app.querySelectorAll('.inspector-tab').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.tab === tab))
    renderInspector()
  }

  function closeInspector(fast = false) {
    if (inspectorFastCloseTimer !== null) {
      window.clearTimeout(inspectorFastCloseTimer)
      inspectorFastCloseTimer = null
    }
    shell.classList.toggle('inspector-fast-closing', fast)
    shell.classList.remove('inspector-open')
    if (fast) {
      inspectorFastCloseTimer = window.setTimeout(() => {
        shell.classList.remove('inspector-fast-closing')
        inspectorFastCloseTimer = null
      }, 280)
    }
    selectedChange = null
    selectedArtifactId = null
    scheduleBrowserBoundsSync()
  }

  function artifactKindLabel(kind: WorkbenchSnapshot['artifacts']['artifacts'][number]['kind']): string {
    return ({
      document: '文档', pdf: 'PDF', presentation: '演示文稿', spreadsheet: '表格', image: '图片', archive: '压缩包', code: '代码', data: '数据', other: '文件',
    } as const)[kind]
  }

  function artifactSourceLabel(source: WorkbenchSnapshot['artifacts']['artifacts'][number]['source']): string {
    return ({ agent: 'Agent', browser: '浏览器', 'browser-download': '浏览器下载', import: '导入', automation: '自动化', plugin: '插件' } as const)[source]
  }

  function artifactGlyph(kind: WorkbenchSnapshot['artifacts']['artifacts'][number]['kind']): string {
    if (kind === 'image') return '▧'
    if (kind === 'pdf') return 'PDF'
    if (kind === 'presentation') return '▶'
    if (kind === 'spreadsheet' || kind === 'data') return '▦'
    if (kind === 'code') return '</>'
    if (kind === 'archive') return 'ZIP'
    return '◇'
  }

  function renderArtifactDetail(artifactId: string) {
    if (!currentSnapshot) return
    const artifact = currentSnapshot.artifacts.artifacts.find(item => item.id === artifactId)
    if (!artifact) {
      selectedArtifactId = null
      renderInspector()
      return
    }
    const back = document.createElement('button')
    back.className = 'inspector-back'
    back.textContent = '‹ 返回产物'
    back.addEventListener('click', () => {
      selectedArtifactId = null
      renderInspector()
    })
    const heading = document.createElement('section')
    heading.className = 'artifact-detail-heading'
    const copy = document.createElement('div')
    const name = document.createElement('strong')
    name.textContent = artifact.name
    const meta = document.createElement('small')
    meta.textContent = `${artifactKindLabel(artifact.kind)} · ${artifactSourceLabel(artifact.source)} · ${Math.max(1, Math.round(artifact.size / 1024)).toLocaleString()} KB`
    copy.append(name, meta)
    const actions = document.createElement('div')
    for (const [label, action] of [
      ['打开', () => bridge?.openArtifact(artifact.id)],
      ['定位', () => bridge?.revealArtifact(artifact.id)],
      ['导出', () => bridge?.exportArtifact(artifact.id)],
    ] as const) {
      const button = document.createElement('button')
      button.textContent = label
      button.disabled = !artifact.available
      button.addEventListener('click', () => void Promise.resolve(action()).catch(error => showToast(errorMessage(error))))
      actions.append(button)
    }
    const remove = document.createElement('button')
    remove.className = 'danger'
    const managedFile = artifact.source === 'browser' || artifact.source === 'browser-download' || artifact.metadata?.visualSource === 'computer'
    remove.textContent = managedFile ? '删除产物' : '移除记录'
    remove.addEventListener('click', async () => {
      const confirmed = await openWorkbenchDialog({
        title: managedFile ? '删除这个产物？' : '移除产物记录？',
        message: managedFile ? '将同时删除 TurboFlux 保存的文件，此操作无法撤销。' : '不会删除工作区中的原始文件。',
        confirmLabel: managedFile ? '删除' : '移除',
        danger: true,
      })
      if (confirmed !== true) return
      try {
        await bridge?.removeArtifact(artifact.id)
        selectedArtifactId = null
        artifactPreviewCache.delete(artifact.id)
        artifactThumbnailCache.delete(artifact.id)
        if (bridge) applySnapshot(await bridge.getSnapshot(), false)
      } catch (error) { showToast(errorMessage(error)) }
    })
    actions.append(remove)
    heading.append(copy, actions)
    const surface = document.createElement('div')
    surface.className = `artifact-preview artifact-preview-${artifact.kind}`
    if (!artifact.available) {
      surface.innerHTML = '<div class="artifact-preview-message"><strong>文件已不可用</strong><p>它可能被移动或删除，可以移除此记录。</p></div>'
    } else {
      const preview = artifactPreviewCache.get(artifact.id)
      if (preview?.mode === 'image' && preview.dataUrl) {
        const image = document.createElement('img')
        image.src = preview.dataUrl
        image.alt = artifact.name
        surface.append(image)
      } else if (preview?.mode === 'pdf' && preview.dataUrl) {
        const frame = document.createElement('iframe')
        frame.src = preview.dataUrl
        frame.title = artifact.name
        surface.append(frame)
      } else if (preview?.mode === 'text') {
        const pre = document.createElement('pre')
        pre.textContent = preview.text || ''
        surface.append(pre)
        if (preview.message) {
          const note = document.createElement('p')
          note.className = 'artifact-preview-note'
          note.textContent = preview.message
          surface.prepend(note)
        }
      } else if (preview?.mode === 'external') {
        const message = document.createElement('div')
        message.className = 'artifact-preview-message'
        message.innerHTML = `<strong>${artifactKindLabel(artifact.kind)}</strong><p>${preview.message || '使用系统应用打开此文件。'}</p>`
        surface.append(message)
      } else {
        surface.innerHTML = '<div class="artifact-preview-message loading"><span></span><p>正在准备预览…</p></div>'
        if (!artifactPreviewLoading && bridge) {
          artifactPreviewLoading = true
          void loadArtifactPreview(artifact.id).catch(error => showToast(errorMessage(error))).finally(() => {
            artifactPreviewLoading = false
            if (selectedArtifactId === artifact.id) renderInspector()
          })
        }
      }
    }
    inspectorContent.append(back, heading, surface)
  }

  function prependComputerActivity() {
    const state = computerControls?.getCompanionState()
    if (!state) return
    const section = document.createElement('section')
    section.className = `companion-computer-activity${state.attention ? ' attention' : ''}`
    section.innerHTML = `${icon('computer')}<span><strong></strong><small></small></span><b></b>`
    section.querySelector('strong')!.textContent = state.title
    section.querySelector('small')!.textContent = state.detail
    section.querySelector('b')!.textContent = state.attention ? '需要接管' : '进行中'
    inspectorContent.prepend(section)
  }

  function createWorkOverviewSection(label: string, count?: number, onOpen?: () => void): HTMLElement {
    const section = document.createElement('section')
    section.className = 'work-overview-section'
    const header = document.createElement('header')
    const title = document.createElement('strong')
    title.textContent = label
    header.append(title)
    if (count !== undefined) {
      const total = document.createElement('span')
      total.textContent = String(count)
      header.append(total)
    }
    if (onOpen) {
      const open = document.createElement('button')
      open.textContent = '查看全部'
      open.addEventListener('click', onOpen)
      header.append(open)
    }
    section.append(header)
    return section
  }

  function createWorkOverviewRow(options: {
    iconName: string
    title: string
    detail?: string
    meta?: string
    attention?: boolean
    onOpen(): void
  }): HTMLButtonElement {
    const row = document.createElement('button')
    row.className = `work-overview-row${options.attention ? ' attention' : ''}`
    row.innerHTML = `${icon(options.iconName)}<span><strong></strong><small></small></span><b></b>`
    row.querySelector('strong')!.textContent = options.title
    const detail = row.querySelector('small')!
    detail.textContent = options.detail || ''
    detail.hidden = !options.detail
    row.querySelector('b')!.textContent = options.meta || '›'
    row.addEventListener('click', options.onOpen)
    return row
  }

  function renderWorkOverview(snapshot: WorkbenchSnapshot): void {
    inspectorContent.classList.add('overview-content')
    const changes = collectChanges(snapshot.conversation.turns)
    const artifacts = snapshot.artifacts.artifacts
      .filter(artifact => !artifact.conversationId || artifact.conversationId === snapshot.conversation.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const previews = snapshot.activity.runtimeTasks
      .map(task => ({ task, view: describeRuntimeTask(task) }))
      .filter(item => item.view?.category === 'service' && item.view.previewUrl)
      .sort((left, right) => right.task.updatedAt - left.task.updatedAt)
    const execution = snapshot.activity.execution
    const workRun = selectWorkRun(execution, execution.currentRunId)
    if (workRun) {
      const work = presentWorkRun(workRun)
      const stage = document.createElement('button')
      stage.className = `work-overview-stage status-${workRun.status}`
      stage.innerHTML = '<i></i><span><strong></strong><small></small></span>'
      stage.querySelector('strong')!.textContent = work.title
      stage.querySelector('small')!.textContent = work.detail
      stage.addEventListener('click', () => openInspector('activity'))
      inspectorContent.append(stage)
    }

    if (previews.length > 0) {
      const surfaces = createWorkOverviewSection('工作面')
      for (const { view } of previews.slice(0, 3)) {
        if (!view?.previewUrl) continue
        surfaces.append(createWorkOverviewRow({
          iconName: 'globe',
          title: '本地预览',
          detail: view.title,
          meta: view.active ? '打开' : '已停止',
          onOpen: () => view.active && void openBrowserInInspector(view.previewUrl!),
        }))
      }
      inspectorContent.append(surfaces)
    }

    const researchTabs = browserResearchTabs()
    if (researchTabs.length > 0) {
      const activeTabId = browserSnapshot?.activeTabId || researchTabs[0].id
      const browsing = createWorkOverviewSection('浏览现场', researchTabs.length, () => void openBrowserTabInInspector(activeTabId))
      for (const tab of researchTabs) {
        browsing.append(createWorkOverviewRow({
          iconName: 'globe',
          title: tab.title || browserSiteLabel(tab.url),
          detail: browserSiteLabel(tab.url),
          meta: tab.loading ? '正在加载' : tab.id === browserSnapshot?.activeTabId && browserSnapshot?.activity ? '正在浏览' : '打开',
          attention: tab.crashed,
          onOpen: () => void openBrowserTabInInspector(tab.id),
        }))
      }
      inspectorContent.append(browsing)
    }

    const subagents = snapshot.activity.subagents
    const computer = computerControls?.getCompanionState()
    if (subagents.length > 0 || computer) {
      const collaboration = createWorkOverviewSection('协作现场')
      const running = subagents.filter(agent => ['starting', 'running'].includes(agent.status))
      const completed = subagents.filter(agent => agent.status === 'completed')
      if (subagents.length > 0) collaboration.append(createWorkOverviewRow({
          iconName: 'spark',
          title: running.length > 0 ? `${running.length} 个并行工作正在推进` : `${completed.length} 个并行工作已结束`,
          detail: running[0]?.objective || completed[0]?.objective || `${subagents.length} 个协作任务`,
          meta: completed.length > 0 ? `${completed.length} 完成` : '查看',
          onOpen: () => {
            openInspector('activity')
          },
        }))
      if (computer) collaboration.append(createWorkOverviewRow({
          iconName: 'computer',
          title: computer.title,
          detail: computer.detail,
          meta: computer.attention ? '需要接管' : '进行中',
          attention: computer.attention,
          onOpen: () => openInspector('activity'),
        }))
      inspectorContent.append(collaboration)
    }

    const deliveryCount = artifacts.length + changes.length
    if (deliveryCount > 0) {
      const delivery = createWorkOverviewSection('交付记录', deliveryCount, () => openInspector('outputs'))
      let visibleDelivery = 0
      for (const artifact of artifacts) {
        if (visibleDelivery >= 4) break
        delivery.append(createWorkOverviewRow({
          iconName: 'folder',
          title: artifact.name,
          detail: `${artifactKindLabel(artifact.kind)} · ${formatRelativeTime(artifact.updatedAt)}`,
          onOpen: () => {
            selectedArtifactId = artifact.id
            openInspector('outputs')
          },
        }))
        visibleDelivery += 1
      }
      for (const change of changes) {
        if (visibleDelivery >= 4) break
        delivery.append(createWorkOverviewRow({
          iconName: 'folder',
          title: change.path.split(/[\\/]/).at(-1) || change.path,
          detail: `${change.path} · +${change.addedLines ?? 0} −${change.removedLines ?? 0}`,
          onOpen: () => {
            selectedChange = change
            openInspector('outputs')
          },
        }))
        visibleDelivery += 1
      }
      inspectorContent.append(delivery)
    }

    const attachments = snapshot.conversation.turns.flatMap(turn => turn.metadata?.attachments || [])
    const sources = [...attachments.map(attachment => ({ name: attachment.filename, detail: `${Math.max(1, Math.round(attachment.size / 1024))} KB` })), ...snapshot.draft.files.map(file => ({ name: file.filename, detail: '待发送' }))]
    if (sources.length > 0) {
      const sourceSection = createWorkOverviewSection('任务输入', sources.length, () => openInspector('context'))
      for (const source of sources.slice(0, 4)) sourceSection.append(createWorkOverviewRow({
        iconName: 'paperclip',
        title: source.name,
        detail: source.detail,
        onOpen: () => openInspector('context'),
      }))
      inspectorContent.append(sourceSection)
    }

    const gitChanges = snapshot.git.snapshot?.files.length || 0
    if (gitChanges > 0) {
      const workspace = createWorkOverviewSection('版本状态')
      workspace.append(createWorkOverviewRow({
        iconName: 'folder',
        title: snapshot.git.snapshot?.branch || snapshot.workspace.name,
        detail: `${gitChanges} 处文件变更`,
        meta: '查看',
        onOpen: () => openInspector('git'),
      }))
      inspectorContent.append(workspace)
    }

    if (!inspectorContent.childElementCount) {
      inspectorContent.innerHTML = '<div class="work-overview-empty"><p>当前工作还没有产生可查看的内容。</p></div>'
    }
  }

  function renderInspector() {
    const snapshot = currentSnapshot
    if (!snapshot) {
      inspectorContent.innerHTML = '<div class="empty-inspector"><p>核心正在启动…</p></div>'
      return
    }
    const title = app.querySelector<HTMLElement>('#inspector-title')!
    const overviewBack = app.querySelector<HTMLButtonElement>('#inspector-overview-back')!
    inspectorContent.replaceChildren()
    inspectorContent.classList.remove('overview-content')
    inspectorContent.classList.toggle('browser-content', currentInspectorTab === 'browser')
    inspectorPanel.classList.toggle('overview-mode', currentInspectorTab === 'overview')
    inspectorPanel.classList.toggle('browser-mode', currentInspectorTab === 'browser')
    overviewBack.hidden = currentInspectorTab === 'overview'
    scheduleBrowserBoundsSync()

    const panelActions = {
      compactContext: async () => {
        if (!bridge) return
        try {
          const result = await bridge.executeCommand('context.compact')
          await handleCommandResult(result)
          if (result.message) showToast(result.message)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      refreshGit: async () => {
        if (!bridge) return
        try {
          const result = await bridge.executeCommand('git.refresh')
          await handleCommandResult(result)
          if (result.message) showToast(result.message)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      acknowledgeNotification: async (id: string) => {
        if (!bridge) return
        try {
          await bridge.acknowledgeNotification(id)
          const next = await bridge.getSnapshot()
          applySnapshot(next, false)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      readSubAgent: async (id: string, offset?: number, limit?: number) => {
        if (!bridge) throw new Error('Desktop bridge is unavailable')
        return bridge.readSubAgent(id, offset, limit)
      },
      stopSubAgent: async (id: string) => {
        if (!bridge) return
        try {
          const result = await bridge.stopSubAgent(id)
          applySnapshot(result.snapshot, false)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      retrySubAgent: async (id: string) => {
        if (!bridge) return
        try {
          const result = await bridge.retrySubAgent(id)
          applySnapshot(result.snapshot, false)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      controlWorkStep: async (id: string, action: WorkStepControlAction) => {
        if (!bridge) return
        try {
          const result = await bridge.controlWorkStep(id, action)
          applySnapshot(result.snapshot, false)
          const messages = { retry: '步骤已准备重试', skip: '步骤已跳过', cancel: '步骤已取消', resume: '步骤已继续' }
          showToast(messages[action])
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      pauseRun: async () => {
        if (!bridge) return
        await bridge.pause()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      resumeRun: async () => {
        if (!bridge) return
        await bridge.resume()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      stopRun: async () => {
        if (!bridge) return
        await bridge.stop()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      selectWorkRun: (id: string) => {
        selectedWorkRunId = id
        renderInspector()
      },
      stageGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitStage(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '暂存失败'); return }
        showToast('已暂存所选文件')
      },
      unstageGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitUnstage(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '取消暂存失败'); return }
        showToast('已取消暂存')
      },
      commitGit: async (message: string) => {
        if (!bridge) return
        const response = await bridge.gitCommit(message)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '提交失败'); return }
        showToast(response.result.nothingToCommit ? '没有可提交的内容' : `已创建提交${response.result.hash ? ` · ${response.result.hash.slice(0, 8)}` : ''}`)
      },
      createGitBranch: async (name: string) => {
        if (!bridge) return
        const response = await bridge.gitCreateBranch(name)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '创建分支失败'); return }
        showToast(`已切换到 ${name}`)
      },
      switchGitBranch: async (name: string) => {
        if (!bridge) return
        const response = await bridge.gitSwitchBranch(name)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '切换分支失败'); return }
        showToast(`已切换到 ${name}`)
      },
      restoreGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitRestore(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '恢复文件失败'); return }
        showToast('已恢复所选文件')
      },
      pushGit: async (remote?: string, branch?: string, setUpstream?: boolean) => {
        if (!bridge) return
        const response = await bridge.gitPush(remote, branch, setUpstream)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '推送失败'); return }
        showToast('已推送到远端')
      },
      readGitDiff: async (path: string, scope: 'working' | 'staged' | 'all') => {
        if (!bridge) throw new Error('Desktop bridge is unavailable')
        const response = await bridge.gitDiff(path, scope)
        if (!response.result.ok) throw new Error(response.result.error || '无法读取差异')
        return response.result.output || '没有可显示的差异。'
      },
      confirm: async (dialogTitle: string, message: string, danger = false) => (
        await openWorkbenchDialog({ title: dialogTitle, message, confirmLabel: danger ? '继续' : '确认', danger }) === true
      ),
      prompt: async (dialogTitle: string, message: string, initialValue = '') => {
        const value = await openWorkbenchDialog({ title: dialogTitle, message, confirmLabel: '继续', inputValue: initialValue })
        return typeof value === 'string' && value.trim() ? value.trim() : null
      },
      openSettings: (section: 'mcp' | 'workpacks') => void settingsCenter?.open(section),
    }

    if (currentInspectorTab === 'overview') {
      title.textContent = '工作'
      renderWorkOverview(snapshot)
      return
    }

    if (currentInspectorTab === 'browser') {
      title.textContent = '浏览器'
      const active = activeBrowserTab()
      if (!browserSnapshot?.visible || !active) {
        inspectorContent.innerHTML = '<div class="empty-inspector browser-empty"><div class="empty-orbit">◎</div><h3>打开浏览器</h3><p>浏览网页、本地应用，或让 Agent 在多个标签页中完成任务。</p><button class="empty-inspector-action">开始浏览</button></div>'
        inspectorContent.querySelector<HTMLButtonElement>('.empty-inspector-action')?.addEventListener('click', () => void openBrowserInInspector(active?.url || 'about:blank'))
        return
      }
      browserDisplayMode = 'inspector'
      const browserPanel = document.createElement('div')
      browserPanel.className = 'inspector-browser'

      const tabbar = document.createElement('div')
      tabbar.className = 'inspector-browser-tabbar'
      const tabs = document.createElement('div')
      tabs.className = 'browser-tabs inspector-browser-tabs'
      renderBrowserTabs(tabs, true)
      const newTab = document.createElement('button')
      newTab.className = 'browser-tab-action'
      newTab.title = '新建标签页'
      newTab.innerHTML = icon('plus')
      newTab.addEventListener('click', () => void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
      const activity = document.createElement('span')
      activity.className = 'browser-activity-pill compact'
      activity.innerHTML = `${icon('spark')}<span>浏览器工作中</span>`
      updateBrowserActivity(activity, browserSnapshot)
      tabbar.append(tabs, newTab, activity)

      const toolbar = document.createElement('div')
      toolbar.className = 'inspector-browser-toolbar'
      const navigation = document.createElement('div')
      navigation.className = 'inspector-browser-navigation'
      const createNavigationButton = (name: string, label: string, disabled: boolean, action: () => void) => {
        const button = document.createElement('button')
        button.dataset.browserCommand = name
        button.title = label
        button.disabled = disabled
        button.innerHTML = icon(name)
        button.addEventListener('click', action)
        return button
      }
      const back = createNavigationButton('back', '后退', !active.canGoBack, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserBack(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      const forward = createNavigationButton('forward', '前进', !active.canGoForward, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserForward(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      const reload = createNavigationButton('reload', active.loading ? '重新加载' : '刷新', false, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserReload(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      if (active.loading) reload.classList.add('loading')
      navigation.append(back, forward, reload)

      const addressForm = document.createElement('form')
      addressForm.className = 'inspector-browser-address-form'
      addressForm.innerHTML = icon('globe')
      const address = document.createElement('input')
      address.className = 'inspector-browser-address'
      address.setAttribute('aria-label', '浏览器地址')
      address.placeholder = '搜索或输入网址'
      address.autocomplete = 'off'
      address.spellcheck = false
      address.value = active.url === 'about:blank' ? '' : active.url
      addressForm.append(address)
      addressForm.addEventListener('submit', event => {
        event.preventDefault()
        address.blur()
        navigateBrowserAddress(address.value, activeBrowserTab()?.id)
      })

      const actions = document.createElement('div')
      actions.className = 'inspector-browser-actions'
      const expand = document.createElement('button')
      expand.title = '在工作区展开'
      expand.innerHTML = icon('panel')
      expand.addEventListener('click', expandBrowser)
      const external = document.createElement('button')
      external.dataset.browserCommand = 'external'
      external.title = '在默认浏览器中打开'
      external.innerHTML = icon('external')
      external.disabled = active.url === 'about:blank'
      external.addEventListener('click', () => {
        const url = activeBrowserTab()?.url
        if (url && url !== 'about:blank') void bridge?.openExternal(url).catch(error => showToast(errorMessage(error)))
      })
      actions.append(external, expand)
      toolbar.append(navigation, addressForm, actions)
      const surface = document.createElement('div')
      surface.className = 'inspector-browser-surface'
      surface.innerHTML = `<div>${icon('globe')}<p>页面正在准备</p></div>`
      browserPanel.append(tabbar, toolbar, surface)
      inspectorContent.append(browserPanel)
      scheduleBrowserBoundsSync()
      return
    }

    if (currentInspectorTab === 'activity') {
      title.textContent = '工作进度'
      renderActivityPanel(inspectorContent, snapshot, panelActions, selectedWorkRunId)
      prependComputerActivity()
      return
    }

    if (currentInspectorTab === 'outputs') {
      title.textContent = selectedChange ? '变更预览' : selectedArtifactId ? '产物预览' : '产物'
      if (selectedChange) {
        const back = document.createElement('button')
        back.className = 'inspector-back'
        back.textContent = '‹ 返回产物'
        back.addEventListener('click', () => {
          selectedChange = null
          renderInspector()
        })
        inspectorContent.append(back)
        const preview = document.createElement('div')
        preview.className = 'output-diff-preview'
        inspectorContent.append(preview)
        renderDiffPreview(preview, selectedChange)
        return
      }
      if (selectedArtifactId) {
        renderArtifactDetail(selectedArtifactId)
        return
      }
      const changes = collectChanges(snapshot.conversation.turns)
      const artifacts = snapshot.artifacts.artifacts
      const previews = snapshot.activity.runtimeTasks
        .map(task => ({ task, view: describeRuntimeTask(task) }))
        .filter(item => item.view?.category === 'service' && item.view.previewUrl)
        .sort((left, right) => right.task.updatedAt - left.task.updatedAt)
      if (changes.length === 0 && previews.length === 0 && artifacts.length === 0) {
        inspectorContent.innerHTML = '<div class="empty-inspector"><div class="empty-orbit">◇</div><h3>暂无产物</h3><p>生成的文件、修改和可预览结果会出现在这里。</p></div>'
        return
      }
      const list = document.createElement('div')
      list.className = 'output-list'
      for (const artifact of artifacts) {
        const button = document.createElement('button')
        button.className = `output-item artifact-item${artifact.available ? '' : ' unavailable'}`
        const glyph = document.createElement('span')
        glyph.textContent = artifactGlyph(artifact.kind)
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = artifact.name
        const detail = document.createElement('small')
        detail.textContent = artifact.available
          ? `${artifactKindLabel(artifact.kind)} · ${artifactSourceLabel(artifact.source)} · ${formatRelativeTime(artifact.updatedAt)}`
          : `${artifactKindLabel(artifact.kind)} · 文件不可用`
        copy.append(name, detail)
        const arrow = document.createElement('span')
        arrow.textContent = '›'
        button.append(glyph, copy, arrow)
        button.addEventListener('click', () => {
          selectedArtifactId = artifact.id
          renderInspector()
        })
        list.append(button)
      }
      for (const { task, view } of previews) {
        if (!view?.previewUrl) continue
        const button = document.createElement('button')
        button.className = `output-item local-preview-item ${task.status}`
        button.disabled = !view.active
        const glyph = document.createElement('span')
        glyph.textContent = '◎'
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = '本地预览'
        const detail = document.createElement('small')
        detail.textContent = view.active ? view.title : `${view.title} · ${view.detail}`
        copy.append(name, detail)
        const action = document.createElement('span')
        action.textContent = view.active ? '打开' : '已停止'
        button.append(glyph, copy, action)
        button.addEventListener('click', () => void openBrowserInInspector(view.previewUrl!))
        list.append(button)
      }
      for (const change of changes) {
        const button = document.createElement('button')
        button.className = 'output-item'
        const glyph = document.createElement('span')
        glyph.textContent = change.operation === 'write' ? '+' : change.operation === 'delete' ? '×' : '±'
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = change.path.split(/[\\/]/).at(-1) || change.path
        const path = document.createElement('small')
        path.textContent = `${change.path} · +${change.addedLines ?? 0} −${change.removedLines ?? 0}`
        copy.append(name, path)
        const arrow = document.createElement('span')
        arrow.textContent = '›'
        button.append(glyph, copy, arrow)
        button.addEventListener('click', () => {
          selectedChange = change
          renderInspector()
        })
        list.append(button)
      }
      inspectorContent.append(list)
      return
    }

    if (currentInspectorTab === 'git') {
      title.textContent = 'Git'
      renderGitPanel(inspectorContent, snapshot, panelActions)
      return
    }

    title.textContent = '上下文'
    renderContextPanel(inspectorContent, snapshot, panelActions)
    const group = document.createElement('div')
    group.className = 'inspector-group'
    const label = document.createElement('div')
    label.className = 'group-label'
    label.textContent = '来源'
    group.append(label, createContextItem('folder', snapshot.workspace.name, snapshot.workspace.path, true))
    const attachments = snapshot.conversation.turns.flatMap(turn => turn.metadata?.attachments || [])
    for (const attachment of attachments) group.append(createContextItem('folder', attachment.filename, `${Math.max(1, Math.round(attachment.size / 1024))} KB`))
    for (const file of snapshot.draft.files) group.append(createContextItem('folder', file.filename, '待发送文件'))
    if (attachments.length === 0 && snapshot.draft.files.length === 0) group.append(createMutedNote('添加到任务的文件、图片和工作区会集中显示在这里。'))
    inspectorContent.append(group)
  }

  function createContextItem(iconName: string, itemTitle: string, itemDetail: string, checked = false): HTMLElement {
    const item = document.createElement('div')
    item.className = 'context-item'
    item.innerHTML = icon(iconName)
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = itemTitle
    const detail = document.createElement('small')
    detail.textContent = itemDetail
    copy.append(title, detail)
    item.append(copy)
    if (checked) {
      const mark = document.createElement('span')
      mark.className = 'context-check'
      mark.textContent = '✓'
      item.append(mark)
    }
    return item
  }

  function createMutedNote(text: string): HTMLElement {
    const note = document.createElement('p')
    note.className = 'inspector-note'
    note.textContent = text
    return note
  }

  function currentDraft() {
    return {
      text: taskInput.value,
      attachments: draftAttachments.map(attachment => ({ ...attachment })),
      files: draftFiles.map(file => ({ ...file })),
      pendingPastes: pendingPastes.map(paste => ({ ...paste })),
      capabilities: { items: draftCapabilities.map(capability => ({ ...capability })) },
    }
  }

  function scheduleDraftRecord() {
    if (draftTimer !== null) window.clearTimeout(draftTimer)
    draftTimer = window.setTimeout(() => {
      draftTimer = null
      const draft = currentDraft()
      if (bridge) void draftRecordQueue.enqueue(() => bridge.recordDraft(draft)).catch(() => undefined)
    }, 350)
  }

  async function persistDraftNow(): Promise<void> {
    if (draftTimer !== null) {
      window.clearTimeout(draftTimer)
      draftTimer = null
    }
    const draft = currentDraft()
    if (bridge) await draftRecordQueue.enqueue(() => bridge.recordDraft(draft))
  }

  function renderDraftTray() {
    draftTray.replaceChildren()
    const items: Array<{ id: string; kind: 'file' | 'paste'; label: string; detail: string }> = [
      ...draftFiles.map(item => ({ id: item.id, kind: 'file' as const, label: item.filename, detail: `${Math.max(1, Math.round(item.size / 1024))} KB`, path: item.path })),
      ...pendingPastes.map(item => ({ id: item.placeholder, kind: 'paste' as const, label: '大段粘贴', detail: `${item.text.length.toLocaleString()} 字符` })),
    ]
    draftTray.classList.toggle('visible', draftAttachments.length + items.length > 0)

    if (draftAttachments.length) {
      const imageStrip = document.createElement('div')
      imageStrip.className = 'draft-image-strip'
      const lightboxItems = attachmentLightboxItems(draftAttachments)
      draftAttachments.forEach((attachment, imageIndex) => {
        const card = document.createElement('article')
        card.className = 'draft-image-card'
        const preview = document.createElement('button')
        preview.type = 'button'
        preview.className = 'draft-image-preview'
        preview.setAttribute('aria-label', `查看图片 ${imageIndex + 1}`)
        const placeholder = document.createElement('span')
        placeholder.className = 'attachment-image-placeholder'
        const image = document.createElement('img')
        image.alt = attachment.filename
        image.decoding = 'async'
        preview.append(placeholder, image)
        preview.addEventListener('click', () => imageLightbox?.open(lightboxItems, imageIndex))
        hydrateAttachmentThumbnail(preview, image, attachment.path, true)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'draft-image-remove'
        remove.title = '移除图片'
        remove.setAttribute('aria-label', `移除图片 ${imageIndex + 1}`)
        remove.addEventListener('click', () => {
          draftAttachments = draftAttachments.filter(candidate => candidate.id !== attachment.id)
          renderDraftTray()
          scheduleDraftRecord()
          if (currentSnapshot) updateRunButton(currentSnapshot)
        })
        card.append(preview, remove)
        imageStrip.append(card)
      })
      draftTray.append(imageStrip)
    }

    for (const item of items) {
      const chip = document.createElement('article')
      chip.className = `draft-chip ${item.kind}`
      const preview = document.createElement('span')
      preview.className = 'draft-chip-preview'
      preview.innerHTML = item.kind === 'paste' ? '¶' : icon('folder')
      const copy = document.createElement('span')
      const label = document.createElement('strong')
      label.textContent = item.label
      const detail = document.createElement('small')
      detail.textContent = item.detail
      copy.append(label, detail)
      const remove = document.createElement('button')
      remove.title = '移除'
      remove.innerHTML = icon('close')
      remove.addEventListener('click', () => {
        draftAttachments = draftAttachments.filter(attachment => attachment.id !== item.id)
        draftFiles = draftFiles.filter(file => file.id !== item.id)
        const paste = pendingPastes.find(candidate => candidate.placeholder === item.id)
        if (paste) taskInput.value = taskInput.value.replace(paste.placeholder, '').replace(/\n{3,}/g, '\n\n').trimStart()
        pendingPastes = pendingPastes.filter(candidate => candidate.placeholder !== item.id)
        renderDraftTray()
        scheduleDraftRecord()
        if (currentSnapshot) updateRunButton(currentSnapshot)
      })
      chip.append(preview, copy, remove)
      draftTray.append(chip)
    }
  }

  function renderCapabilityTray() {
    capabilityTray.replaceChildren()
    capabilityTray.classList.toggle('visible', draftCapabilities.length > 0)
    capabilityTab.classList.toggle('active', draftCapabilities.length > 0)
    const preferredCapability = draftCapabilities.find(capability => capability.type === 'mcp' && capability.id === 'computer')
      || draftCapabilities[0]
    const capabilityLabel = app.querySelector<HTMLElement>('#capability-name')!
    capabilityLabel.textContent = preferredCapability?.name || '能力包'
    const capabilityNames = draftCapabilities.map(capability => capability.name).join('、')
    const capabilityTitle = draftCapabilities.length > 0
      ? `${capabilityNames} · 本轮优先使用，点击管理`
      : '选择本轮优先使用的能力包；未选择的能力仍然可用'
    capabilityTab.title = capabilityTitle
    capabilityTab.setAttribute('aria-label', capabilityTitle)
    const capabilityCount = app.querySelector<HTMLElement>('#capability-count')!
    capabilityCount.textContent = draftCapabilities.length > 1 ? String(draftCapabilities.length) : ''
    capabilityCount.classList.toggle('visible', draftCapabilities.length > 1)
    for (const capability of draftCapabilities) {
      const chip = document.createElement('span')
      chip.className = `composer-capability ${capability.type}`
      chip.innerHTML = capability.type === 'skill'
        ? icon('spark')
        : capability.id === 'browser'
          ? icon('globe')
          : capability.id === 'computer'
            ? icon('computer')
            : icon('plug')
      const label = document.createElement('strong')
      label.textContent = capability.name
      const remove = document.createElement('button')
      remove.title = `移除 ${capability.name}`
      remove.innerHTML = icon('close')
      remove.addEventListener('click', async () => {
        draftCapabilities = draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id))
        renderCapabilityTray()
        await persistDraftNow()
      })
      chip.append(label, remove)
      capabilityTray.append(chip)
    }
  }

  function loadDraft(snapshot: WorkbenchSnapshot) {
    taskInput.value = snapshot.draft.text || ''
    resizeTaskInput()
    draftAttachments = snapshot.draft.attachments.map(attachment => ({ ...attachment }))
    draftFiles = snapshot.draft.files.map(file => ({ ...file }))
    pendingPastes = snapshot.draft.pendingPastes.map(paste => ({ ...paste }))
    draftCapabilities = snapshot.draft.capabilities.items.map(capability => ({ ...capability }))
    renderDraftTray()
    renderCapabilityTray()
  }

  function renderRecoveryState(snapshot: WorkbenchSnapshot) {
    recoveryBanner.replaceChildren()
    const degraded = snapshot.persistence.status === 'degraded'
    recoveryBanner.classList.toggle('visible', degraded)
    if (!degraded) return
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = '暂时无法保存会话'
    const detail = document.createElement('small')
    detail.textContent = '当前消息仍保留在本机。请先重试保存；诊断数据仅用于排查问题。'
    copy.append(title, detail)
    const actions = document.createElement('div')
    const retry = document.createElement('button')
    retry.textContent = '重试保存'
    retry.addEventListener('click', async () => {
      try {
        const health = await bridge?.retryPersistence()
        if (health?.status === 'healthy' && bridge) applySnapshot(await bridge.getSnapshot(), false)
        showToast(health?.status === 'healthy' ? '会话已恢复保存' : '仍无法保存会话')
      } catch (error) {
        showToast(errorMessage(error))
      }
    })
    actions.append(retry)
    const exportButton = document.createElement('button')
    exportButton.textContent = '导出诊断数据'
    exportButton.addEventListener('click', async () => {
      try {
        const path = await bridge?.exportRecovery()
        if (path) showToast('诊断数据已导出')
      } catch (error) {
        showToast(errorMessage(error))
      }
    })
    actions.append(exportButton)
    recoveryBanner.append(copy, actions)
  }

  function updateRunButton(snapshot: WorkbenchSnapshot) {
    const active = submissionPending || snapshot.runtime.status === 'running' || snapshot.runtime.status === 'paused' || snapshot.runtime.status === 'awaiting-action'
    const emptyDraft = !taskInput.value.trim()
    computerControls?.setRuntimeActive(active)
    runButton.classList.toggle('runtime-active', active)
    runButton.disabled = composerActionGuard.active && !submissionPending
    runButton.title = emptyDraft && (submissionPending || snapshot.runtime.status === 'running')
      ? '停止当前任务'
      : emptyDraft && snapshot.runtime.status === 'paused'
        ? '继续当前任务'
        : emptyDraft && snapshot.runtime.status === 'awaiting-action'
          ? '停止当前任务'
          : '发送'
    runButton.innerHTML = emptyDraft && (submissionPending || snapshot.runtime.status === 'running')
      ? icon('stop')
      : emptyDraft && snapshot.runtime.status === 'awaiting-action'
        ? icon('stop')
        : icon('arrow')
    app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.mode === snapshot.runtime.mode)
      button.disabled = snapshot.runtime.status !== 'ready'
    })
  }

  function reasoningSummary(snapshot: WorkbenchSnapshot): string {
    const reasoning = snapshot.runtime.reasoning
    if (!reasoning || reasoning.enabled === false || reasoning.effort === 'none') return '关闭'
    if (reasoning.budgetTokens) return `${Math.round(reasoning.budgetTokens / 1024)}K`
    return reasoning.effort ? reasoningEffortLabel(reasoning.effort) : '开启'
  }

  function applySnapshot(snapshot: WorkbenchSnapshot, renderConversation = true) {
    const snapshotLatestUserTurnId = latestUserTurnId(snapshot.conversation.turns)
    if (shouldIgnoreSnapshotAfterRequestTerminal({
      fence: requestStatusTerminalFence,
      conversationId: snapshot.conversation.id,
      latestUserTurnId: snapshotLatestUserTurnId,
      runtimeStatus: snapshot.runtime.status,
      runPhase: snapshot.runtime.runState.phase,
      activeRunId: snapshot.activity.execution.currentRunId || snapshot.work.projection.activeRunId,
    })) return
    if (requestStatusTerminalFence && !requestStatusTerminalFenceApplies({
      fence: requestStatusTerminalFence,
      conversationId: snapshot.conversation.id,
      latestUserTurnId: snapshotLatestUserTurnId,
    })) {
      requestStatusTerminalFence = null
      requestStatusAttemptTurnId = snapshotLatestUserTurnId || ''
    }
    const conversationChanged = currentSnapshot?.conversation.id !== snapshot.conversation.id
    const firstSnapshot = currentSnapshot === null
    const previousReasoningTone = currentSnapshot ? reasoningTone(currentSnapshot.runtime.reasoning) : null
    const nextReasoningTone = reasoningTone(snapshot.runtime.reasoning)
    if (conversationChanged) {
      selectedWorkRunId = null
      projectedWorkRunId = ''
      clearHistoryRewriteViewport()
      resendingTurnId = ''
      requestStatusTerminalFence = null
      requestStatusAttemptTurnId = ''
    }
    currentSnapshot = snapshot
    taskFlowProjection = projectTaskFlowSnapshot(snapshot)
    const snapshotRunId = snapshot.activity.execution.currentRunId || ''
    if (firstSnapshot || conversationChanged) {
      const latestUserTurn = [...snapshot.conversation.turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)
      projectedWorkRunId = snapshotRunId || latestUserTurn?.metadata?.workRunId || latestUserTurn?.id || ''
    } else if (snapshotRunId) {
      projectedWorkRunId = snapshotRunId
    }
    if (conversationChanged) activeWorkRunId = snapshotRunId
    else if (snapshotRunId) activeWorkRunId = snapshotRunId
    renderProjectedWorkPlan()
    const hasWorkspace = workspaceSpecified(snapshot)
    app.querySelector('#composer-start-workspace-name')!.textContent = hasWorkspace ? snapshot.workspace.name : '选择工作区'
    app.querySelector('#composer-start-workspace-action')!.textContent = hasWorkspace ? '更改' : '选择'
    if (currentMainView === 'workbench') app.querySelector('#breadcrumb-title')!.textContent = currentConversationTitle(snapshot)
    app.querySelector('#model-name')!.textContent = snapshot.runtime.model || '未配置模型'
    renderComposerModelIdentity()
    renderComposerContext(snapshot)
    app.querySelector('#reasoning-name')!.textContent = reasoningSummary(snapshot)
    reasoningTab.dataset.reasoningTone = nextReasoningTone
    if (previousReasoningTone && previousReasoningTone !== 'max' && nextReasoningTone === 'max') {
      reasoningTab.classList.remove('is-max-entering')
      void reasoningTab.offsetWidth
      reasoningTab.classList.add('is-max-entering')
      if (reasoningMaxTimer !== null) window.clearTimeout(reasoningMaxTimer)
      reasoningMaxTimer = window.setTimeout(() => {
        reasoningTab.classList.remove('is-max-entering')
        reasoningMaxTimer = null
      }, 680)
    }
    reasoningTab.classList.toggle('active', Boolean(snapshot.runtime.reasoning && snapshot.runtime.reasoning.enabled !== false && snapshot.runtime.reasoning.effort !== 'none'))
    const approvalLabel = ({ ask: '需要确认', agent: '自动执行', full: '全权执行' } as Record<string, string>)[snapshot.runtime.approvalPolicy] || '按需确认'
    const accessLabel = ({ 'read-only': '只读', 'workspace-write': '工作区访问', 'danger-full-access': '完整访问' } as Record<string, string>)[snapshot.runtime.capabilityProfile || ''] || '默认权限'
    app.querySelector('#runtime-policy')!.textContent = `${approvalLabel} · ${accessLabel}`
    app.querySelector('#approval-name')!.textContent = approvalLabel
    app.querySelector('#approval-pill')!.setAttribute('data-policy', snapshot.runtime.approvalPolicy)
    if (firstSnapshot || conversationChanged) loadDraft(snapshot)
    else {
      renderCapabilityTray()
    }
    renderConversationList(snapshot)
    if (currentMainView !== 'workbench') renderProductView()
    const nextConversationSignature = conversationRenderSignature(snapshot.conversation.turns, latestConversationFailure(snapshot))
    const canRenderConversation = renderConversation || snapshot.runtime.status === 'error'
    if (conversationChanged || canRenderConversation && nextConversationSignature !== renderedConversationSignature) {
      if (editingTurnId && !conversationChanged) {
        pendingConversationRender = true
      } else {
        pendingConversationRender = false
        renderTurns(snapshot.conversation.turns, conversationChanged && !firstSnapshot)
        renderedConversationSignature = nextConversationSignature
      }
    }
    refreshExecutionVisualEvidence(snapshot)
    if (shell.classList.contains('inspector-open')) renderInspector()
    updateRunButton(snapshot)
    renderTaskCompanion()
    renderRecoveryState(snapshot)
    if (conversationChanged && !firstSnapshot) void refreshConversationSystemSnapshots()
  }

  function currentConversationTitle(snapshot: WorkbenchSnapshot): string {
    const indexed = snapshot.conversations.find(conversation => conversation.id === snapshot.conversation.id)
    if (indexed) return taskDisplayTitle(indexed)
    const firstPrompt = snapshot.conversation.turns.find(turn => turn.role === 'user' && turn.metadata?.internal !== true)?.content.trim()
    return firstPrompt ? firstPrompt.replace(/\s+/g, ' ').slice(0, 42) : NEW_TASK_TITLE
  }

  function workspaceSpecified(snapshot: WorkbenchSnapshot): boolean {
    return (snapshot as DesktopWorkbenchSnapshot).workspace.specified !== false
  }

  function scheduleSnapshotRefresh(delay = 80) {
    if (!bridge) return
    snapshotRefreshPending = true
    if (snapshotRefreshTimer !== null || snapshotRefreshInFlight) return
    snapshotRefreshTimer = window.setTimeout(() => {
      snapshotRefreshTimer = null
      snapshotRefreshPending = false
      snapshotRefreshInFlight = true
      const conversationId = currentSnapshot?.conversation.id
      void bridge.getSnapshot()
        .then(snapshot => {
          if (conversationId && (
            currentSnapshot?.conversation.id !== conversationId
            || snapshot.conversation.id !== conversationId
          )) return
          applySnapshot(snapshot, false)
        })
        .catch(() => undefined)
        .finally(() => {
          snapshotRefreshInFlight = false
          if (snapshotRefreshPending) scheduleSnapshotRefresh(120)
        })
    }, Math.max(32, delay))
  }

  function showRequest(event: {
    requestId?: string
    question: string
    options?: string[]
    reason?: string
    toolName?: string
    path?: string
  }) {
    transcript.querySelector(`[data-request-id="${CSS.escape(event.requestId || '')}"]`)?.remove()
    const card = document.createElement('section')
    card.className = 'request-card'
    card.dataset.requestId = event.requestId || ''
    if (event.toolName && isBuiltInBrowserTool(event.toolName)) {
      card.classList.add('browser-request')
      const context = document.createElement('span')
      context.className = 'request-context'
      context.innerHTML = `${icon('globe')}<span>网页操作需要确认</span>`
      card.append(context)
    } else if (event.toolName && isBuiltInComputerTool(event.toolName)) {
      card.classList.add('computer-request')
      const context = document.createElement('span')
      context.className = 'request-context'
      context.innerHTML = `${icon('computer')}<span>电脑操作需要确认</span>`
      card.append(context)
    }
    const question = document.createElement('strong')
    question.textContent = event.question
    card.append(question)
    if (event.reason) {
      const reason = document.createElement('p')
      reason.textContent = event.reason
      card.append(reason)
    }
    const actions = document.createElement('div')
    actions.className = 'request-actions'
    const options = event.options?.length ? event.options : ['提交']
    if (event.options?.length) {
      for (const option of options) {
        const button = document.createElement('button')
        button.className = option === 'deny' ? 'request-button danger' : 'request-button'
        button.textContent = ({ 'allow-once': '仅这次允许', 'allow-run': '本次任务自动', 'allow-session': '本会话自动', deny: '不允许' } as Record<string, string>)[option] || option
        button.addEventListener('click', () => void resolveRequest(event.requestId || '', option, card))
        actions.append(button)
      }
    } else {
      const input = document.createElement('input')
      input.className = 'request-input'
      input.placeholder = '输入回复'
      const button = document.createElement('button')
      button.className = 'request-button'
      button.textContent = '提交'
      button.addEventListener('click', () => void resolveRequest(event.requestId || '', input.value, card))
      actions.append(input, button)
    }
    card.append(actions)
    appendTranscriptElement(card)
    setConversationMode(true)
    scrollTranscript()
  }

  async function resolveRequest(requestId: string, response: string, card: HTMLElement) {
    if (!bridge || !requestId || !response.trim()) return
    if (card.dataset.resolving === 'true') return
    card.dataset.resolving = 'true'
    const controls = Array.from(card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
    for (const control of controls) control.disabled = true
    const feedback = document.createElement('span')
    feedback.className = 'request-feedback'
    feedback.textContent = '已收到，正在继续'
    card.append(feedback)
    try {
      beginRequestStatusAttempt()
      const resolved = await bridge.resolveRequest(requestId, response.trim())
      if (resolved) {
        card.remove()
      } else {
        card.dataset.resolving = 'false'
        feedback.remove()
        for (const control of controls) control.disabled = false
        showToast('回答未能提交，请重新选择')
      }
    } catch (error) {
      card.dataset.resolving = 'false'
      feedback.remove()
      for (const control of controls) control.disabled = false
      showToast(errorMessage(error))
    }
  }

  function handleConversationEvent(event: AnyConversationEvent) {
    if (
      submissionPending
      && (event.type === 'turn.started' || event.type === 'stream.started' || event.type === 'run.started' || event.type === 'run.state_changed')
    ) {
      submissionPending = false
      if (currentSnapshot) updateRunButton(currentSnapshot)
    }
    switch (event.type) {
      case 'turn.started':
      case 'turn.completed': {
        const turn = event.payload.turn
        liveTurnCache.set(turn.id, turn)
        if (event.type === 'turn.started' && turn.role === 'user') {
          requestStatusAttemptTurnId = turn.id
          reconcileOptimisticUserTurn(turn)
          if (isHistoryRewriteUserTurn({
            resendingTurnId,
            eventType: 'turn.started',
            turnId: turn.id,
            turnRole: turn.role,
          })) {
            historyRewriteOptimisticTurn = turn
            resendingTurnId = ''
            reconcileHistoryRewriteUserTurn(turn)
          }
        }
        if (event.type === 'turn.completed') scheduleSnapshotRefresh(32)
        break
      }
      case 'tool.proposed':
        liveToolCalls.set(event.payload.toolCall.id, event.payload.toolCall)
        break
      case 'tool.completed':
        liveToolResults.set(event.payload.toolResult.toolCallId, event.payload.toolResult)
        break
      case 'approval.requested':
        showRequest({
          requestId: event.payload.requestId,
          question: event.payload.question,
          toolName: event.payload.toolName,
          path: event.payload.path,
          options: event.payload.kind === 'permission' ? ['allow-once', 'allow-run', 'allow-session', 'deny'] : undefined,
        })
        break
      case 'approval.resolved':
      case 'approval.cancelled':
        transcript.querySelector(`[data-request-id="${CSS.escape(event.payload.requestId)}"]`)?.remove()
        break
      case 'run.state_changed':
        if (currentSnapshot) {
          currentSnapshot.runtime.runState = event.payload.state
          const phase = event.payload.state.phase
          currentSnapshot.runtime.status = phase === 'paused'
            ? 'paused'
            : phase === 'awaiting_approval' || phase === 'awaiting_input'
              ? 'awaiting-action'
              : ['thinking', 'compacting', 'tool_running', 'aborting'].includes(phase)
                ? 'running'
                : phase === 'recoverable_error'
                  ? 'error'
                  : 'ready'
          updateRunButton(currentSnapshot)
        }
        break
      case 'usage.updated':
        if (currentSnapshot) {
          currentSnapshot.context.usage = { ...currentSnapshot.context.usage, ...event.payload.usage }
          renderComposerContext(currentSnapshot)
        }
        break
      case 'context.compaction':
        if (currentSnapshot) currentSnapshot.context.compaction = event.payload.state
        break
      case 'notification.raised':
        if (event.payload.level === 'warning' || event.payload.level === 'error') showToast(event.payload.message)
        break
      case 'run.completed':
        activeTaskStartedAt = 0
        activeTurnIsTask = false
        activeWorkRunId = ''
        markRequestStatusTerminal()
        scheduleSnapshotRefresh(32)
        break
      case 'runtime.event':
        scheduleSnapshotRefresh()
        break
    }
  }

  function handleRuntimeEvent(event: WorkbenchEvent) {
    if (event.type === 'conversation-event') {
      if (event.conversationId !== currentSnapshot?.conversation.id) return
      if (!taskFlowProjection || taskFlowProjection.conversationId !== event.conversationId) {
        taskFlowProjection = createTaskFlowProjection(event.conversationId)
      }
      taskFlowProjection = applyTaskFlowEvent(taskFlowProjection, event.event)
      handleConversationEvent(event.event)
      scheduleCanonicalTaskFlowRender()
      return
    }
    if (
      event.type === 'conversation-run'
      && event.status === 'completed'
      && event.conversationId !== currentSnapshot?.conversation.id
    ) {
      const title = currentSnapshot?.conversations.find(conversation => conversation.id === event.conversationId)?.title || '后台任务'
      showToast(`${title} 已完成`)
    }
    if (event.type === 'conversation-run' && event.conversationId === currentSnapshot?.conversation.id) {
      markRequestStatusTerminal()
    }
    if (event.type === 'snapshot') {
      applySnapshot(event.snapshot, event.snapshot.runtime.status === 'ready')
    }
    if (event.type === 'persistence' && currentSnapshot) {
      currentSnapshot.persistence = event.health
      renderRecoveryState(currentSnapshot)
      if (event.health.status === 'degraded') showToast(event.health.error || '会话存储暂不可用')
    }
    if (event.type === 'skill-marketplace-install') settingsCenter?.handleSkillInstallJob(event.job)
    if (event.type === 'runtime-error') {
      if (resendingTurnId && (!event.conversationId || event.conversationId === currentSnapshot?.conversation.id)) {
        resendingTurnId = ''
        clearHistoryRewriteViewport()
        scheduleSnapshotRefresh(32)
      }
      if (!event.conversationId || event.conversationId === currentSnapshot?.conversation.id) markRequestStatusTerminal()
      showToast(event.message)
    }
  }

  function insertPromptText(value: string) {
    const start = taskInput.selectionStart
    const end = taskInput.selectionEnd
    taskInput.setRangeText(value, start, end, 'end')
    taskInput.dispatchEvent(new Event('input'))
  }

  function addDraftFiles(files: WorkbenchFileReference[]) {
    const known = new Set([...draftAttachments.map(item => item.id), ...draftFiles.map(item => item.id)])
    for (const file of files) {
      if (known.has(file.id)) continue
      known.add(file.id)
      if (file.type === 'image') {
        draftAttachments.push({
          id: file.id,
          type: 'image',
          path: file.path,
          mime: file.mime,
          filename: file.filename,
          size: file.size,
        })
      } else {
        draftFiles.push({ ...file })
      }
    }
    renderDraftTray()
    scheduleDraftRecord()
    if (currentSnapshot) updateRunButton(currentSnapshot)
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error || new Error('无法读取剪贴板图片'))
      reader.onload = () => resolve(String(reader.result || '').split(',').at(-1) || '')
      reader.readAsDataURL(file)
    })
  }

  async function importDroppedFiles(files: File[]) {
    if (!bridge || files.length === 0) return
    const paths = files.map(file => bridge.pathForFile(file)).filter(Boolean)
    if (paths.length === 0) return showToast('无法读取这些文件的本地路径')
    const imported = await bridge.importFiles(paths)
    addDraftFiles(imported)
    showToast(`已添加 ${imported.length} 个文件`)
  }

  function closeComposerMenus() {
    composerMenu.classList.remove('visible')
    composerMenu.setAttribute('aria-hidden', 'true')
    composerAddButton.setAttribute('aria-expanded', 'false')
    capabilityMenu.classList.remove('visible')
    capabilityMenu.setAttribute('aria-hidden', 'true')
    capabilityTab.setAttribute('aria-expanded', 'false')
    approvalMenu.classList.remove('visible')
    approvalMenu.setAttribute('aria-hidden', 'true')
    approvalPill.setAttribute('aria-expanded', 'false')
  }

  function createComposerMenuRow(options: {
    glyph: string
    title: string
    detail?: string
    selected?: boolean
    disabled?: boolean
    onClick(): void
  }): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = `composer-menu-row${options.selected ? ' selected' : ''}`
    button.disabled = options.disabled === true
    const glyph = document.createElement('span')
    glyph.className = 'composer-menu-glyph'
    glyph.innerHTML = options.glyph
    const copy = document.createElement('span')
    copy.className = 'composer-menu-copy'
    const title = document.createElement('strong')
    title.textContent = options.title
    copy.append(title)
    if (options.detail) {
      const detail = document.createElement('small')
      detail.textContent = options.detail
      copy.append(detail)
    }
    const mark = document.createElement('i')
    mark.innerHTML = options.selected ? icon('check') : ''
    button.setAttribute('role', options.selected === undefined ? 'menuitem' : 'menuitemcheckbox')
    if (options.selected !== undefined) button.setAttribute('aria-checked', String(options.selected))
    button.append(glyph, copy, mark)
    button.addEventListener('click', options.onClick)
    return button
  }

  function appendComposerMenuSection(title: string, target = composerMenu): HTMLElement {
    const section = document.createElement('section')
    const label = document.createElement('div')
    label.className = 'composer-menu-label'
    label.textContent = title
    section.append(label)
    target.append(section)
    return section
  }

  async function chooseDraftFiles() {
    try {
      const files = await bridge?.chooseFiles() || []
      addDraftFiles(files)
      if (files.length > 0) showToast(`已添加 ${files.length} 个文件`)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function chooseTaskWorkspace() {
    if (!bridge) return showToast('桌面核心未连接')
    if (composerActionGuard.active) return
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    try {
      await persistDraftNow()
      const snapshot = await bridge.chooseWorkspace()
      if (snapshot) applySnapshot(snapshot)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationNavigation(release)
    }
  }

  function renderComposerMenu() {
    composerMenu.replaceChildren()
    composerMenu.setAttribute('role', 'menu')
    const addSection = appendComposerMenuSection('添加')
    addSection.append(
      createComposerMenuRow({
        glyph: icon('paperclip'),
        title: '文件和文件夹',
        detail: '图片、文档或项目资料',
        onClick: () => {
          closeComposerMenus()
          void chooseDraftFiles()
        },
      }),
      createComposerMenuRow({
        glyph: icon('folder'),
        title: currentSnapshot && workspaceSpecified(currentSnapshot) ? currentSnapshot.workspace.name : '选择工作区',
        detail: currentSnapshot && workspaceSpecified(currentSnapshot) ? currentSnapshot.workspace.path : '为这项任务指定一个文件夹',
        selected: currentSnapshot ? workspaceSpecified(currentSnapshot) : false,
        onClick: () => {
          closeComposerMenus()
          void chooseTaskWorkspace()
        },
      }),
    )
  }

  function renderCapabilityMenu() {
    capabilityMenu.replaceChildren()
    capabilityMenu.setAttribute('role', 'menu')
    const workPackSection = appendComposerMenuSection('能力包', capabilityMenu)
    const loading = document.createElement('p')
    loading.className = 'composer-menu-empty'
    loading.textContent = '正在读取能力包…'
    workPackSection.append(loading)

    if (!bridge) {
      loading.textContent = '能力包仅在桌面端可用'
      return
    }

    void Promise.all([bridge.listWorkPacks(), bridge.getSettings(false)]).then(([catalog, settings]) => {
      if (!capabilityMenu.classList.contains('visible')) return
      loading.remove()
      let rowCount = 0
      const projectedCapabilityKeys = new Set<string>()
      const appendCapability = (capability: AgentCapabilityReference, title: string, detail: string, glyph: string, disabled = false) => {
        const selected = draftCapabilities.some(item => item.type === capability.type && item.id === capability.id)
        workPackSection.append(createComposerMenuRow({
          glyph,
          title,
          detail: selected ? '已作为本轮重点，点击取消强调' : detail,
          selected,
          disabled,
          onClick: () => void (async () => {
            draftCapabilities = selected
              ? draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id))
              : capability.type === 'skill'
                ? [capability, ...draftCapabilities.filter(item => item.type !== 'skill')]
                : [...draftCapabilities, capability]
            renderCapabilityTray()
            await persistDraftNow()
            renderCapabilityMenu()
          })(),
        }))
        rowCount += 1
      }

      for (const entry of catalog.installed) {
        if (!entry.enabled || !entry.emphasis) continue
        const capability = entry.emphasis
        projectedCapabilityKeys.add(`${capability.type}:${capability.id}`)
        const included = [
          entry.contributions.skills ? `${entry.contributions.skills} 个工作流` : '',
          entry.contributions.tools ? `${entry.contributions.tools} 个工具` : '',
          entry.contributions.commands ? `${entry.contributions.commands} 个命令` : '',
        ].filter(Boolean).join(' · ')
        appendCapability(
          capability,
          entry.name,
          `${entry.kind === 'workflow' ? '工作流' : entry.kind === 'integration' ? '集成' : '混合包'}${included ? ` · ${included}` : ''} · 始终可用`,
          capability.type === 'skill' ? icon('spark') : icon('plug'),
        )
      }

      for (const server of settings.mcpServers) {
        if (projectedCapabilityKeys.has(`mcp:${server.name}`)) continue
        const ready = server.enabled && server.status === 'connected'
        const displayName = server.displayName || server.name
        appendCapability(
          { type: 'mcp', id: server.name, name: displayName },
          displayName,
          ready ? `${server.description || `${server.tools.length} 个可用工具`} · 始终可用` : server.enabled ? '等待连接' : '尚未启用',
          server.name === 'browser' ? icon('globe') : server.name === 'computer' ? icon('computer') : icon('plug'),
          !ready,
        )
      }

      if (rowCount === 0) {
        const empty = document.createElement('p')
        empty.className = 'composer-menu-empty'
        empty.textContent = '还没有可用的能力包'
        workPackSection.append(empty)
      }
    }).catch(error => {
      loading.textContent = errorMessage(error)
    })

  }

  function toggleComposerMenu() {
    const opening = !composerMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening) return
    renderComposerMenu()
    composerMenu.classList.add('visible')
    composerMenu.setAttribute('aria-hidden', 'false')
    composerAddButton.setAttribute('aria-expanded', 'true')
  }

  function toggleCapabilityMenu() {
    const opening = !capabilityMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening) return
    renderCapabilityMenu()
    capabilityMenu.classList.add('visible')
    capabilityMenu.setAttribute('aria-hidden', 'false')
    capabilityTab.setAttribute('aria-expanded', 'true')
  }

  function approvalDescription(policy: ApprovalPolicy): string {
    if (policy === 'ask') return '执行工具前先征求确认'
    if (policy === 'agent') return '低风险操作自动继续'
    return '允许完整主机能力'
  }

  async function selectApprovalPolicy(policy: ApprovalPolicy) {
    if (!bridge) return
    try {
      const settings = await bridge.getSettings(false)
      const update = createSettingsUpdate(settings)
      update.approvalPolicy = policy
      if (policy === 'full') update.capabilityProfile = 'danger-full-access'
      const result = await bridge.saveSettings(update)
      applySnapshot(result.snapshot, false)
      closeComposerMenus()
      showToast(`审批策略已切换为${({ ask: '每次询问', agent: '低风险自动', full: '完全访问' } as const)[policy]}`)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  function toggleApprovalMenu() {
    const opening = !approvalMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening || !currentSnapshot) return
    approvalMenu.replaceChildren()
    approvalMenu.setAttribute('role', 'menu')
    const label = document.createElement('div')
    label.className = 'composer-menu-label'
    label.textContent = '审批策略'
    approvalMenu.append(label)
    const names: Record<ApprovalPolicy, string> = { ask: '每次询问', agent: '低风险自动', full: '完全访问' }
    for (const policy of ['ask', 'agent', 'full'] as ApprovalPolicy[]) {
      approvalMenu.append(createComposerMenuRow({
        glyph: '<span class="approval-option-icon">♢</span>',
        title: names[policy],
        detail: approvalDescription(policy),
        selected: currentSnapshot.runtime.approvalPolicy === policy,
        onClick: () => void selectApprovalPolicy(policy),
      }))
    }
    approvalMenu.classList.add('visible')
    approvalMenu.setAttribute('aria-hidden', 'false')
    approvalPill.setAttribute('aria-expanded', 'true')
  }

  async function submitCurrentPrompt() {
    if (composerActionGuard.active) {
      if (submissionPending && bridge) {
        submissionStopRequested = true
        void bridge.stop().catch(() => undefined)
      }
      return
    }
    const release = composerActionGuard.tryAcquire()
    if (!release) return
    if (currentSnapshot) updateRunButton(currentSnapshot)
    else runButton.disabled = true
    try {
      await submitCurrentPromptOnce()
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      release()
      if (currentSnapshot) updateRunButton(currentSnapshot)
      else runButton.disabled = false
      continuePendingConversationNavigation()
    }
  }

  async function submitCurrentPromptOnce() {
    if (!bridge) return showToast('桌面核心未连接')
    clearHistoryRewriteViewport()
    const value = taskInput.value.trim()
    const hasDraftInput = Boolean(value || draftAttachments.length || draftFiles.length || pendingPastes.length)
    if (value.startsWith('/') && draftAttachments.length === 0 && draftFiles.length === 0 && pendingPastes.length === 0) {
      try {
        const normalized = value.toLowerCase().replace(/\s+/g, ' ')
        const command = (await bridge.listCommands()).find(item => item.slash?.toLowerCase() === normalized)
        if (!command) {
          showToast('没有匹配的命令，已打开命令面板')
          await commandPalette?.open()
          return
        }
        const result = await bridge.executeCommand(command.id)
        taskInput.value = ''
        await persistDraftNow()
        if (result.message) showToast(result.message)
        await handleCommandResult(result)
      } catch (error) {
        showToast(errorMessage(error))
      }
      return
    }
    const active = currentSnapshot && ['running', 'paused', 'awaiting-action'].includes(currentSnapshot.runtime.status)
    if (!hasDraftInput && active) {
      if (currentSnapshot?.runtime.status === 'running') await bridge.stop()
      else if (currentSnapshot?.runtime.status === 'paused') await bridge.resume()
      else await bridge.stop()
      applySnapshot(await bridge.getSnapshot(), false)
      return
    }
    if (!hasDraftInput) {
      taskInput.focus()
      return showToast('先描述你想完成的结果')
    }
    const submittedDraft = currentDraft()
    try {
      let expandedPrompt = value || '请分析并处理这些附件。'
      for (const paste of pendingPastes) expandedPrompt = expandedPrompt.replaceAll(paste.placeholder, paste.text)
      const submittedAttachments = [
        ...draftAttachments,
        ...draftFiles.map(file => ({ ...file, type: 'file' as const })),
      ]
      const submittedCapabilities = draftCapabilities.length > 0
        ? { items: draftCapabilities.map(capability => ({ ...capability })) }
        : undefined
      beginRequestStatusAttempt('')
      const optimisticElement = !active
        ? mountOptimisticUserTurn(
            expandedPrompt,
            submittedAttachments.length > 0 ? submittedAttachments : undefined,
            submittedCapabilities,
          )
        : null
      if (draftTimer !== null) {
        window.clearTimeout(draftTimer)
        draftTimer = null
      }
      submissionPending = !active
      submissionStopRequested = false
      taskInput.value = ''
      draftAttachments = []
      draftFiles = []
      pendingPastes = []
      renderDraftTray()
      resizeTaskInput()
      if (currentSnapshot) updateRunButton(currentSnapshot)
      void draftRecordQueue.enqueue(() => bridge.recordDraft(currentDraft())).catch(() => undefined)
      const result = await bridge.submitPrompt(
        expandedPrompt,
        submittedAttachments.length > 0 ? submittedAttachments : undefined,
        submittedCapabilities,
      )
      if (result.status === 'started') requestStatusAttemptTurnId = result.inputId
      if (optimisticElement?.isConnected) {
        if (result.status === 'started') {
          pendingOptimisticInputId = result.inputId
          optimisticElement.dataset.optimisticInputId = result.inputId
          scheduleCanonicalTaskFlowRender(true)
        } else {
          clearPendingOptimisticUserTurn()
        }
      }
      if (result.status === 'started' && !activeTaskStartedAt) {
        activeTaskStartedAt = Date.now()
      }
      if (result.status !== 'started') {
        submissionPending = false
      }
      if (submissionStopRequested && result.status === 'started') await bridge.stop()
      submissionStopRequested = false
      if (currentSnapshot) updateRunButton(currentSnapshot)
      if (result.status === 'queued') showToast('已加入下一轮')
      if (result.status === 'steering') showToast('已补充到当前任务')
    } catch (error) {
      submissionPending = false
      submissionStopRequested = false
      clearPendingOptimisticUserTurn()
      taskInput.value = [submittedDraft.text, taskInput.value].filter(Boolean).join('\n')
      const attachmentIds = new Set(draftAttachments.map(item => item.id))
      draftAttachments = [
        ...submittedDraft.attachments.filter(item => !attachmentIds.has(item.id)),
        ...draftAttachments,
      ]
      const fileIds = new Set(draftFiles.map(item => item.id))
      draftFiles = [...submittedDraft.files.filter(item => !fileIds.has(item.id)), ...draftFiles]
      const pasteIds = new Set(pendingPastes.map(item => item.placeholder))
      pendingPastes = [...submittedDraft.pendingPastes.filter(item => !pasteIds.has(item.placeholder)), ...pendingPastes]
      draftCapabilities = submittedDraft.capabilities.items.map(item => ({ ...item }))
      renderDraftTray()
      resizeTaskInput()
      void draftRecordQueue.enqueue(() => bridge.recordDraft(currentDraft())).catch(() => undefined)
      if (currentSnapshot) updateRunButton(currentSnapshot)
      showToast(errorMessage(error))
    }
  }

  async function switchConversation(id: string) {
    if (!bridge) return
    if (composerActionGuard.active || conversationNavigationGuard.active) {
      pendingConversationNavigationId = id
      return
    }
    if (id === currentSnapshot?.conversation.id) return
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    try {
      await persistDraftNow()
      const result = await bridge.switchConversation(id)
      selectedChange = null
      applySnapshot(result.snapshot)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationNavigation(release)
    }
  }

  function finishConversationNavigation(release: () => void) {
    release()
    continuePendingConversationNavigation()
  }

  function continuePendingConversationNavigation() {
    if (composerActionGuard.active || conversationNavigationGuard.active) return
    const pendingId = pendingConversationNavigationId
    pendingConversationNavigationId = ''
    if (pendingId && pendingId !== currentSnapshot?.conversation.id) void switchConversation(pendingId)
  }

  app.querySelectorAll<HTMLButtonElement>('.sidebar-nav-item[data-view]').forEach(button => {
    button.addEventListener('click', () => {
      const view = button.dataset.view
      if (view === 'skills') {
        void settingsCenter?.open('workpacks')
        return
      }
      app.querySelectorAll('.sidebar-nav-item').forEach(item => item.classList.remove('active'))
      button.classList.add('active')
      if (view === 'projects' || view === 'automations' || view === 'workbench') showMainView(view)
    })
  })

  const workspaceTaskSearch = app.querySelector<HTMLElement>('#workspace-task-search')!
  const workspaceTaskSearchInput = app.querySelector<HTMLInputElement>('#workspace-task-search-input')!
  app.querySelector('#workspace-task-search-toggle')?.addEventListener('click', () => {
    workspaceTaskSearch.hidden = false
    workspaceTaskSearchInput.focus()
  })
  workspaceTaskSearchInput.addEventListener('input', () => {
    workspaceTaskQuery = workspaceTaskSearchInput.value
    renderedConversationListSignature = ''
    if (currentSnapshot) renderConversationList(currentSnapshot)
  })
  app.querySelector('#workspace-task-search-close')?.addEventListener('click', () => {
    workspaceTaskQuery = ''
    workspaceTaskSearchInput.value = ''
    workspaceTaskSearch.hidden = true
    renderedConversationListSignature = ''
    if (currentSnapshot) renderConversationList(currentSnapshot)
  })
  app.querySelector('#workspace-task-manage')?.addEventListener('click', () => {
    app.querySelectorAll('.sidebar-nav-item').forEach(item => item.classList.remove('active'))
    app.querySelector<HTMLButtonElement>('.sidebar-nav-item[data-view="projects"]')?.classList.add('active')
    showMainView('projects')
  })
  app.querySelector('#workspace-task-add')?.addEventListener('click', async () => {
    if (!bridge) return
    try {
      const added = await bridge.addProject()
      if (!added) return
      applySnapshot(await bridge.getSnapshot(), false)
    } catch (error) {
      showToast(errorMessage(error))
    }
  })

  app.querySelector('#run-button')?.addEventListener('click', () => void submitCurrentPrompt())
  app.querySelector('#new-task')?.addEventListener('click', async () => {
    if (!bridge) return
    if (composerActionGuard.active) return
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    try {
      await persistDraftNow()
      const result = await bridge.newConversation()
      taskInput.value = ''
      draftAttachments = []
      draftFiles = []
      pendingPastes = []
      renderDraftTray()
      selectedChange = null
      applySnapshot(result.snapshot)
      taskInput.focus()
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationNavigation(release)
    }
  })
  app.querySelector('#composer-start-workspace')?.addEventListener('click', () => void chooseTaskWorkspace())
  app.querySelector('#composer-add')?.addEventListener('click', toggleComposerMenu)
  app.querySelector('#capability-tab')?.addEventListener('click', toggleCapabilityMenu)
  app.querySelector('#approval-pill')?.addEventListener('click', toggleApprovalMenu)
  app.querySelector('#command-palette')?.addEventListener('click', () => void commandPalette?.open())
  app.querySelector('#settings-button')?.addEventListener('click', () => void settingsCenter?.open())
  app.querySelector('#composer-context')?.addEventListener('click', () => openInspector('context'))
  app.querySelector('#model-pill')?.addEventListener('click', event => void settingsCenter?.openModelPicker(event.currentTarget as HTMLElement))
  app.querySelector('#reasoning-tab')?.addEventListener('click', event => void settingsCenter?.openReasoningPicker(event.currentTarget as HTMLElement))
  app.querySelector('#inspector-toggle')?.addEventListener('click', () => shell.classList.contains('inspector-open') ? closeInspector() : openInspector('overview'))
  app.querySelector('#inspector-overview-back')?.addEventListener('click', () => {
    selectedChange = null
    selectedArtifactId = null
    openInspector('overview')
  })
  app.querySelector('#inspector-close')?.addEventListener('click', () => closeInspector())
  app.querySelector('#inspector-scrim')?.addEventListener('click', () => closeInspector())
  browserToggle?.addEventListener('click', () => {
    if (!browserSnapshot?.visible) void openBrowser()
    else if (browserDisplayMode === 'workspace') void closeBrowser()
    else expandBrowser()
  })
  app.querySelector('#browser-close')?.addEventListener('click', () => void closeBrowser())
  app.querySelector('#browser-new-tab')?.addEventListener('click', () => void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
  browserBack.addEventListener('click', () => void bridge?.browserBack().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
  browserForward.addEventListener('click', () => void bridge?.browserForward().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
  browserReload.addEventListener('click', () => void bridge?.browserReload().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error))))
  app.querySelector('#browser-address-form')?.addEventListener('submit', event => {
    event.preventDefault()
    navigateBrowserAddress(browserAddress.value)
  })
  app.querySelector('#browser-open-external')?.addEventListener('click', () => {
    const url = activeBrowserTab()?.url
    if (url && url !== 'about:blank') void bridge?.openExternal(url).catch(error => showToast(errorMessage(error)))
  })
  inspectorResizeHandle.addEventListener('pointerdown', event => {
    if (!shell.classList.contains('inspector-open')) return
    event.preventDefault()
    const startX = event.clientX
    const startRect = inspectorPanel.getBoundingClientRect()
    const startWidth = startRect.width
    const dismissTriggerX = inspectorDismissTriggerX(startRect.left, startWidth)
    const pointerId = event.pointerId
    let dragging = true
    inspectorResizeHandle.setPointerCapture(event.pointerId)
    shell.classList.add('inspector-resizing')
    const cleanup = () => {
      if (!dragging) return
      dragging = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (inspectorResizeHandle.hasPointerCapture(pointerId)) inspectorResizeHandle.releasePointerCapture(pointerId)
      shell.classList.remove('inspector-resizing')
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !dragging) return
      if (shouldDismissInspectorAtPointer(moveEvent.clientX, dismissTriggerX)) {
        cleanup()
        closeInspector(true)
        setInspectorWidth(startWidth)
        return
      }
      setInspectorWidth(startWidth + startX - moveEvent.clientX)
    }
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId || !dragging) return
      cleanup()
      if (upEvent.type === 'pointercancel') {
        setInspectorWidth(startWidth)
        return
      }
      setInspectorWidth(inspectorPanel.getBoundingClientRect().width, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  })
  inspectorResizeHandle.addEventListener('dblclick', () => setInspectorWidth(defaultInspectorWidth(), true))
  inspectorResizeHandle.addEventListener('keydown', event => {
    if (!shell.classList.contains('inspector-open')) return
    const width = inspectorWidthFromKey(
      inspectorPanel.getBoundingClientRect().width,
      event.key,
      event.shiftKey,
      window.innerWidth,
    )
    if (width === null) return
    event.preventDefault()
    setInspectorWidth(width, true)
  })
  window.addEventListener('resize', () => {
    if (shell.classList.contains('inspector-open')) setInspectorWidth(inspectorPanel.getBoundingClientRect().width)
  })
  new ResizeObserver(() => scheduleBrowserBoundsSync()).observe(browserSurface)
  new ResizeObserver(() => scheduleBrowserBoundsSync()).observe(inspectorPanel)
  app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', async () => {
    if (!bridge || !currentSnapshot || button.dataset.mode === currentSnapshot.runtime.mode) return
    try {
      applySnapshot(await bridge.setMode(button.dataset.mode === 'plan' ? 'plan' : 'vibe'), false)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }))

  taskInput.addEventListener('input', () => {
    resizeTaskInput()
    if (currentSnapshot) updateRunButton(currentSnapshot)
    scheduleDraftRecord()
  })
  taskInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submitCurrentPrompt()
    }
  })
  taskInput.addEventListener('paste', event => {
    const clipboardFiles = Array.from(event.clipboardData?.files || [])
    const images = clipboardFiles.filter(file => file.type.startsWith('image/'))
    if (images.length > 0 && bridge) {
      event.preventDefault()
      void Promise.all(images.map(async (file, index) => bridge.importClipboardImage(
        await fileToBase64(file),
        file.type || 'image/png',
        file.name || `clipboard-${index + 1}.png`,
      ))).then(files => {
        addDraftFiles(files)
        showToast(`已粘贴 ${files.length} 张图片`)
      }).catch(error => showToast(errorMessage(error)))
      return
    }
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text.length < 4_000) return
    event.preventDefault()
    const placeholder = `【粘贴文本 ${pendingPastes.length + 1} · ${text.length.toLocaleString()} 字符】`
    pendingPastes.push({ placeholder, text })
    insertPromptText(placeholder)
    renderDraftTray()
    scheduleDraftRecord()
  })
  for (const eventName of ['dragenter', 'dragover']) {
    composerCard.addEventListener(eventName, event => {
      const dragEvent = event as DragEvent
      if (!dragEvent.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      composerCard.classList.add('drop-active')
    })
  }
  for (const eventName of ['dragleave', 'drop']) {
    composerCard.addEventListener(eventName, event => {
      if (eventName === 'drop') event.preventDefault()
      composerCard.classList.remove('drop-active')
    })
  }
  composerCard.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length > 0) void importDroppedFiles(files).catch(error => showToast(errorMessage(error)))
  })
  transcript.addEventListener('wheel', event => {
    transcriptWheelScrolling = true
    if (event.deltaY < 0) cancelTranscriptScroll()
    if (transcriptWheelTimer !== null) window.clearTimeout(transcriptWheelTimer)
    transcriptWheelTimer = window.setTimeout(() => {
      transcriptWheelTimer = null
      transcriptWheelScrolling = false
    }, 160)
  }, { passive: true })
  transcript.addEventListener('pointerdown', event => {
    if (event.target === transcript) transcriptPointerScrolling = true
  })
  window.addEventListener('pointerup', () => { transcriptPointerScrolling = false })
  window.addEventListener('pointercancel', () => { transcriptPointerScrolling = false })
  transcript.addEventListener('scroll', () => {
    transcriptFollowState = updateTranscriptFollowFromScroll(
      transcriptFollowState,
      transcript,
      transcriptPointerScrolling || transcriptWheelScrolling,
    )
    if (!transcriptFollowState.following) cancelTranscriptScroll()
  }, { passive: true })
  transcript.addEventListener('click', event => {
    const target = event.target
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor) return
    event.preventDefault()
    void bridge?.openExternal(anchor.href).catch(error => showToast(errorMessage(error)))
  })

  window.addEventListener('keydown', event => {
    if (settingsCenter?.isOpen()) {
      if (event.key === 'Escape') settingsCenter.close()
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'l' && browserSnapshot?.visible) {
      event.preventDefault()
      const address = browserDisplayMode === 'inspector'
        ? inspectorContent.querySelector<HTMLInputElement>('.inspector-browser-address')
        : browserAddress
      address?.focus()
      address?.select()
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 't' && browserSnapshot?.visible) {
      event.preventDefault()
      void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'w' && browserSnapshot?.visible) {
      event.preventDefault()
      void bridge?.browserCloseTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      void commandPalette?.open()
    }
    if (event.key === 'Escape') {
      if (commandPalette?.isOpen()) commandPalette.close()
      else if (composerMenu.classList.contains('visible') || capabilityMenu.classList.contains('visible') || approvalMenu.classList.contains('visible')) closeComposerMenus()
      else if (browserDisplayMode === 'workspace') void closeBrowser()
      else if (shell.classList.contains('inspector-open')) closeInspector()
    }
  })

  document.addEventListener('click', event => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.conversation-menu')) document.querySelectorAll('.conversation-menu').forEach(menu => menu.remove())
    if (target instanceof Element && !target.closest('#composer-menu, #composer-add, #capability-menu, #capability-tab, #approval-menu, #approval-pill')) closeComposerMenus()
  })

  app.querySelectorAll<HTMLButtonElement>('.inspector-tab').forEach(button => {
    button.addEventListener('click', () => {
      selectedChange = null
      openInspector(button.dataset.tab as InspectorTab)
    })
  })

  if (bridge) {
    bridge.onRuntimeEvent(handleRuntimeEvent)
    bridge.onBrowserEvent(handleBrowserEvent)
    void bridge.getSnapshot().then(snapshot => applySnapshot(snapshot)).catch(error => showToast(errorMessage(error)))
    void bridge.browserGetState().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  } else {
    showToast('桌面核心桥接不可用')
  }
}
