import type {
  WorkbenchApiConfigInput,
  WorkbenchMcpServerInput,
  WorkbenchMemoryFilters,
  WorkbenchMemorySnapshot,
  WorkbenchModelOption,
  WorkbenchWorkPackSnapshot,
  WorkbenchSettingsSnapshot,
  WorkbenchSettingsUpdate,
  WorkbenchSnapshot,
  SkillMarketplaceInstallJob,
  AgentCapabilityReference,
  NativeReasoningConfig,
} from '@turboflux/agent-core/workbench'
import {
  buildReasoningOptions,
  effectiveReasoningConfig,
  reasoningEffortDetail,
  reasoningEffortLabel,
  reasoningOptionIndex,
  reasoningTone,
} from './reasoningPresentation'
import type { ComputerControlsController } from './computerControls'
import { formatCreditMultiplier, modelProviderMark, normalizedModelProvider } from './modelPresentation'
import {
  anchoredComposerPopoverPosition,
  type ComposerPopoverPlacement,
} from './composerPopoverPlacement'
import {
  currentThemePreference,
  setThemePreference,
  type ThemePreference,
} from './theme'

type SettingsSection = 'appearance' | 'api' | 'mcp' | 'computer' | 'workpacks' | 'memory' | 'persona' | 'permissions' | 'advanced'
type SettingsGroup = 'basics' | 'capabilities' | 'system'

interface SettingsSectionMeta {
  id: SettingsSection
  title: string
  subtitle: string
  group: SettingsGroup
  icon: 'appearance' | 'model' | 'plug' | 'computer' | 'skills' | 'plugins' | 'memory' | 'persona' | 'shield' | 'advanced'
  keywords: string
}

interface SettingsCenterOptions {
  showToast(message: string): void
  onSnapshot(snapshot: WorkbenchSnapshot): void
  onUseCapability(capability: AgentCapabilityReference): Promise<void>
  onOpen?(): Promise<void> | void
  onClose?(): void
  onOpenAccount?(): void
  computerControls?: ComputerControlsController
  getComposerPopoverPlacement?(): ComposerPopoverPlacement
}

export interface SettingsCenterController {
  open(section?: SettingsSection): Promise<void>
  openModelPicker(anchor: HTMLElement): Promise<void>
  openReasoningPicker(anchor: HTMLElement): Promise<void>
  repositionComposerPicker(): void
  close(): void
  isOpen(): boolean
  handleSkillInstallJob(job: SkillMarketplaceInstallJob): void
}

const sectionGroups: Array<[SettingsGroup, string]> = [
  ['basics', '基础'],
  ['capabilities', '能力与集成'],
  ['system', '系统'],
]

const sectionLabels: SettingsSectionMeta[] = [
  { id: 'appearance', title: '外观', subtitle: '深浅主题与系统同步', group: 'basics', icon: 'appearance', keywords: '外观 主题 深色 浅色 dark light system appearance' },
  { id: 'api', title: '模型与 API', subtitle: '连接、模型与推理', group: 'basics', icon: 'model', keywords: '供应商 密钥 base url provider reasoning' },
  { id: 'persona', title: '人设与语言', subtitle: '行为风格与全局指令', group: 'basics', icon: 'persona', keywords: '语言 风格 persona prompt instructions' },
  { id: 'permissions', title: '权限与审批', subtitle: '工具边界与确认策略', group: 'basics', icon: 'shield', keywords: 'approval policy git sandbox 安全' },
  { id: 'workpacks', title: '插件', subtitle: '安装与管理本地插件', group: 'capabilities', icon: 'skills', keywords: '插件 能力 安装 工作流 工具 集成' },
  { id: 'mcp', title: 'MCP', subtitle: '外部连接与工具', group: 'capabilities', icon: 'plug', keywords: 'server tools 插件 服务' },
  { id: 'computer', title: '电脑操控', subtitle: '系统权限与接管边界', group: 'capabilities', icon: 'computer', keywords: 'computer use accessibility screen recording 辅助功能 屏幕录制' },
  { id: 'memory', title: '长期记忆', subtitle: '审核、编辑与遗忘', group: 'capabilities', icon: 'memory', keywords: 'memory 记忆 规则 偏好 审核 固定 删除' },
  { id: 'advanced', title: '高级', subtitle: '模型元数据与运行参数', group: 'system', icon: 'advanced', keywords: 'metadata runtime context tokens' },
]

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function capabilityInstallStateLabel(state?: string): string {
  return ({
    'not-installed': '未安装',
    installed: '已安装',
    'update-available': '可更新',
    modified: '有本地修改',
    broken: '需要修复',
    local: '本地来源',
  } as Record<string, string>)[state || 'not-installed'] || '未安装'
}

type WorkPackEntry = WorkbenchWorkPackSnapshot['entries'][number]

function workPackStateLabel(entry: WorkPackEntry): string {
  if (entry.installState === 'enabled') return '已启用'
  if (entry.installState === 'disabled') return '已停用'
  if (entry.installState === 'blocked') return '已阻止'
  if (entry.installState === 'error') return '异常'
  return capabilityInstallStateLabel(entry.installState)
}

function workPackKindLabel(kind: WorkPackEntry['kind']): string {
  return kind === 'workflow' ? '工作流插件' : kind === 'integration' ? '工具插件' : '组合插件'
}

function workPackPrimaryActionLabel(entry: WorkPackEntry): string {
  if (entry.installState === 'update-available') return '更新'
  if (entry.installState === 'modified') return '重新安装'
  if (entry.installState === 'broken') return '修复安装'
  if (!entry.installed) return '立即安装'
  if (entry.supportsToggle && !entry.enabled) return '启用'
  if (entry.emphasis) return '用于本轮'
  return '已可用'
}

function workPackIconMarkup(entry: WorkPackEntry, large = false): string {
  const className = `official-pack-icon${large ? ' large' : ''}`
  if (entry.icon === 'pdf-file') {
    return `<span class="${className}" aria-hidden="true"><svg class="official-pack-file-icon" viewBox="0 0 32 32"><path d="M8.5 3.75h10l5 5V27a1.25 1.25 0 0 1-1.25 1.25H8.5A1.25 1.25 0 0 1 7.25 27V5A1.25 1.25 0 0 1 8.5 3.75Z"/><path d="M18.5 3.75V9h5"/><path d="M10.75 21.75h10.5M10.75 17.75h10.5M10.75 13.75h5.25"/></svg></span>`
  }
  return `<span class="${className}">${escapeHtml(entry.icon)}</span>`
}

function formatSkillBytes(value?: number): string {
  if (!value) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / 1024 / 102.4) / 10} MB`
  return `${Math.round(value / 1024 / 1024 / 102.4) / 10} GB`
}

function formatSkillDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function skillInstallPhaseLabel(job: SkillMarketplaceInstallJob): string {
  return ({
    queued: job.queuePosition ? `等待下载 · 第 ${job.queuePosition} 位` : '等待下载',
    resolving: '正在读取文件清单',
    downloading: '正在下载',
    verifying: '正在校验完整性',
    replacing: '正在安全替换',
    completed: '安装完成',
    failed: '安装失败',
    canceled: '已取消',
  } as Record<string, string>)[job.phase] || '正在处理'
}

function skillInstallJobMarkup(job?: SkillMarketplaceInstallJob): string {
  if (!job || (!['queued', 'running', 'failed', 'canceled'].includes(job.status) && Date.now() - (job.completedAt || 0) > 8_000)) return ''
  const percent = Math.round(job.progress * 100)
  const determinate = job.bytesTotal > 0 || job.filesTotal > 0
  const progressLabel = determinate ? `${percent}%` : '准备中'
  const fileProgress = job.filesTotal ? `${job.filesCompleted}/${job.filesTotal} 个文件` : ''
  const byteProgress = job.bytesTotal ? `${formatSkillBytes(job.bytesCompleted)} / ${formatSkillBytes(job.bytesTotal)}` : ''
  const speed = job.bytesPerSecond > 0 && job.status === 'running' ? `${formatSkillBytes(job.bytesPerSecond)}/s` : ''
  const elapsed = job.startedAt ? formatSkillDuration((job.completedAt || job.updatedAt) - job.startedAt) : ''
  const channel = job.transport === 'github-api' ? 'GitHub API' : job.transport === 'github-raw' ? '文件直连' : ''
  const details = [fileProgress, byteProgress, speed, elapsed, channel].filter(Boolean).join(' · ')
  const retry = job.retry ? `<span class="skill-install-retry">连接波动，${Math.max(1, Math.ceil(job.retry.delayMs / 1_000))} 秒后进行第 ${job.retry.attempt + 1} 次尝试</span>` : ''
  const circuit = job.circuits?.find(item => item.state === 'open')
  const circuitNote = circuit ? `<span class="skill-install-retry">${circuit.transport === 'github-raw' ? '文件源' : 'GitHub API'}暂时熔断，正在使用可用通道或等待恢复</span>` : ''
  return `<section class="skill-install-job state-${job.status}">
    <div class="skill-install-job-head"><strong>${escapeHtml(skillInstallPhaseLabel(job))}</strong><span>${progressLabel}</span></div>
    <div class="skill-install-track ${determinate ? '' : 'indeterminate'}"><i style="--skill-install-progress:${percent}%"></i></div>
    ${details ? `<div class="skill-install-meta">${escapeHtml(details)}</div>` : ''}
    ${job.currentFile ? `<div class="skill-install-file">${escapeHtml(job.currentFile)}</div>` : ''}
    ${retry}${circuitNote}
    ${job.error ? `<div class="skill-install-error">${escapeHtml(job.error)}</div>` : ''}
  </section>`
}

function settingsNavIcon(name: SettingsSectionMeta['icon']): string {
  const paths: Record<SettingsSectionMeta['icon'], string> = {
    appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
    model: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    plug: '<path d="M8 4v5m8-5v5M6 9h12v1a6 6 0 0 1-6 6v4m-3 0h6"/>',
    computer: '<rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/>',
    skills: '<path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    plugins: '<path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-3 0h6"/><path d="M8 8h8"/>',
    memory: '<path d="M7 5.5A3.5 3.5 0 0 1 10.5 2H12v20h-1.5A3.5 3.5 0 0 1 7 18.5a3.5 3.5 0 0 1-1.1-6.9A3.5 3.5 0 0 1 7 5.5Z"/><path d="M17 5.5A3.5 3.5 0 0 0 13.5 2H12v20h1.5a3.5 3.5 0 0 0 3.5-3.5 3.5 3.5 0 0 0 1.1-6.9A3.5 3.5 0 0 0 17 5.5Z"/>',
    persona: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
    shield: '<path d="M12 3.5 19 6v5.4c0 4.2-2.9 7.5-7 9.1-4.1-1.6-7-4.9-7-9.1V6z"/><path d="m9 12 2 2 4-4"/>',
    advanced: '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h7m4 0h5"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
  }
  return `<span class="settings-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${paths[name]}</svg></span>`
}

function settingsNavigationMarkup(): string {
  return sectionGroups.map(([group, label]) => {
    const items = sectionLabels.filter(item => item.group === group)
    return `<section class="settings-nav-group" data-settings-group="${group}">
      <div class="settings-nav-group-label">${label}</div>
      <div class="settings-nav-items">${items.map(item => `<button data-settings-section="${item.id}" data-settings-search="${escapeHtml(`${item.title} ${item.subtitle} ${item.keywords}`.toLowerCase())}">${settingsNavIcon(item.icon)}<strong>${item.title}</strong></button>`).join('')}</div>
    </section>`
  }).join('')
}

export function createSettingsUpdate(snapshot: WorkbenchSettingsSnapshot): WorkbenchSettingsUpdate {
  return {
    activeApiConfigId: snapshot.activeApiConfigId,
    approvalPolicy: snapshot.approvalPolicy,
    capabilityProfile: snapshot.capabilityProfile,
    gitEnabled: snapshot.gitEnabled,
    mcpServers: snapshot.mcpServers.filter(server => !server.system).map(server => ({
      name: server.name,
      enabled: server.enabled,
      command: server.command,
      args: server.args ? [...server.args] : undefined,
      url: server.url,
      cwd: server.cwd,
      startupTimeoutMs: server.startupTimeoutMs,
      toolTimeoutMs: server.toolTimeoutMs,
      enabledTools: server.enabledTools ? [...server.enabledTools] : undefined,
      disabledTools: server.disabledTools ? [...server.disabledTools] : undefined,
      preserveEnv: server.envKeys.length > 0,
      preserveHttpHeaders: server.headerKeys.length > 0,
    })),
    apiProfiles: snapshot.apiProfiles.map(({ hasApiKey: _hasApiKey, ...profile }) => ({
      ...profile,
      apiKey: '',
      reasoning: profile.reasoning ? { ...profile.reasoning } : undefined,
    })),
    profile: {
      ...snapshot.profile,
      enabledPersonaIds: [...snapshot.profile.enabledPersonaIds],
    },
  }
}

function generatedProfileId(): string {
  return `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function mcpStatusLabel(status: string): string {
  return ({
    disabled: '已停用',
    disconnected: '未连接',
    connecting: '连接中',
    connected: '已连接',
    error: '连接失败',
    closed: '已关闭',
  } as Record<string, string>)[status] || status
}

function selectedProfile(draft: WorkbenchSettingsUpdate): WorkbenchApiConfigInput | undefined {
  return draft.apiProfiles.find(profile => profile.id === draft.activeApiConfigId) ?? draft.apiProfiles[0]
}

function isManagedProfile(profile?: Pick<WorkbenchApiConfigInput, 'id'>): boolean {
  return profile?.id === 'turboflux-managed'
}

function modelFor(settings: WorkbenchSettingsSnapshot, id: string): WorkbenchModelOption | undefined {
  return settings.models.find(model => model.model === id || model.id === id)
}

function managedModelOptions(settings: WorkbenchSettingsSnapshot): WorkbenchModelOption[] {
  return settings.models
}

function reasoningLabel(config?: NativeReasoningConfig): string {
  if (!config) return '默认'
  if (config.enabled === false || config.effort === 'none') return '关闭'
  if (config.budgetTokens) return `${Math.round(config.budgetTokens / 1024)}K`
  return config.effort ? reasoningEffortLabel(config.effort) : '开启'
}

function field(label: string, control: string, hint = ''): string {
  return `<label class="settings-field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`
}

function settingsRow(title: string, description: string, control: string, className = ''): string {
  return `<div class="settings-row ${className}"><div class="settings-row-copy"><strong>${title}</strong>${description ? `<span>${description}</span>` : ''}</div><div class="settings-row-control">${control}</div></div>`
}

function managedModelDescription(model?: WorkbenchModelOption): string {
  const id = `${model?.id || ''} ${model?.model || ''}`.toLocaleLowerCase()
  if (id.includes('deepseek') && id.includes('flash')) return '低延迟通用模型，适合日常工作与快速任务。'
  if (id.includes('deepseek')) return '适合复杂分析、长任务与高质量内容处理。'
  if (id.includes('gpt')) return '适合通用工作、工具调用与多步骤任务。'
  if (id.includes('claude')) return '适合长文本理解、写作与严谨分析。'
  if (id.includes('kimi')) return '适合长上下文阅读、资料整理与通用任务。'
  if (id.includes('glm')) return '适合中文工作、工具调用与通用任务。'
  return '用于新任务和后续对话。'
}

function reasoningControls(model: WorkbenchModelOption | undefined, profile: WorkbenchApiConfigInput): string {
  const capability = model?.reasoningCapabilities
  if (!capability) return '<div class="settings-inline-note">当前模型没有可调整的原生推理参数。</div>'
  const config = profile.reasoning || model?.reasoning || {}
  const toggle = capability.supportsToggle
    ? `<label class="settings-switch"><input id="reasoning-enabled" type="checkbox" ${config.enabled !== false ? 'checked' : ''}><span></span><b>启用推理</b></label>`
    : '<span class="settings-lock-note">该模型始终启用推理</span>'
  let control = ''
  if (capability.control === 'budget') {
    control = field('推理预算', `<input id="reasoning-budget" type="number" min="1024" max="128000" step="1024" value="${config.budgetTokens || capability.defaultBudgetTokens || 8192}">`, '单位：tokens')
  } else if (capability.efforts.length > 0) {
    control = field('推理强度', `<select id="reasoning-effort">${capability.efforts.map(effort => `<option value="${effort}" ${effort === (config.effort || capability.defaultEffort) ? 'selected' : ''}>${reasoningEffortLabel(effort)}</option>`).join('')}</select>`)
  }
  return `<div class="reasoning-controls"><div class="settings-switch-row">${toggle}<small>${escapeHtml(capability.description)}</small></div>${control}</div>`
}

export function createSettingsCenter(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: SettingsCenterOptions,
): SettingsCenterController {
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = `
    <section class="settings-window" role="dialog" aria-modal="true" aria-label="TurboFlux 设置">
      <aside class="settings-nav">
        <div class="settings-nav-drag-region" aria-hidden="true"></div>
        <button class="settings-back" id="settings-back" aria-label="返回应用"><span class="settings-back-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></span><span>返回应用</span></button>
        <label class="settings-search"><span aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg></span><input id="settings-search" type="search" placeholder="搜索设置…" autocomplete="off" spellcheck="false"><kbd>⌘F</kbd></label>
        <div class="settings-nav-scroll">${settingsNavigationMarkup()}<div class="settings-nav-empty" id="settings-nav-empty" hidden>没有匹配的设置</div></div>
      </aside>
      <main class="settings-main">
        <header class="settings-header"><div class="settings-header-inner"><h2 id="settings-title">模型与 API</h2></div></header>
        <div class="settings-content" id="settings-content"><div class="settings-loading">正在读取设置…</div></div>
        <footer class="settings-footer"><div class="settings-footer-inner"><span id="settings-state">修改后需要保存</span><div><button class="settings-secondary" id="settings-cancel">取消</button><button class="settings-primary" id="settings-save">保存更改</button></div></div></footer>
      </main>
    </section>`
  app.append(overlay)

  const popover = document.createElement('section')
  popover.className = 'model-popover'
  popover.setAttribute('aria-hidden', 'true')
  app.append(popover)

  const content = overlay.querySelector<HTMLDivElement>('#settings-content')!
  const saveButton = overlay.querySelector<HTMLButtonElement>('#settings-save')!
  const stateLabel = overlay.querySelector<HTMLElement>('#settings-state')!
  const searchInput = overlay.querySelector<HTMLInputElement>('#settings-search')!
  const navEmpty = overlay.querySelector<HTMLElement>('#settings-nav-empty')!
  const backButton = overlay.querySelector<HTMLButtonElement>('#settings-back')!
  let settings: WorkbenchSettingsSnapshot | null = null
  let draft: WorkbenchSettingsUpdate | null = null
  let baseline = ''
  let section: SettingsSection = 'api'
  let selectedMcpName = ''
  let activePickerAnchor: HTMLElement | null = null
  let activePickerWidth = 252
  let loading: Promise<void> | null = null
  let workPackView: 'marketplace' | 'installed' = 'marketplace'
  let workPackPage: 'catalog' | 'detail' = 'catalog'
  let workPacks: WorkbenchWorkPackSnapshot | null = null
  let workPacksLoading = false
  let workPacksError = ''
  let workPackSearch = ''
  let workPackCategory = '全部'
  let selectedWorkPackId = ''
  let workPackBusyId = ''
  let memorySnapshot: WorkbenchMemorySnapshot | null = null
  let memoryLoading = false
  let memoryEditorId: string | null | undefined
  let memorySearchTimer: ReturnType<typeof setTimeout> | null = null
  const memoryFilters: WorkbenchMemoryFilters = { includeInactive: true }
  let previousFocus: HTMLElement | null = null

  function filterNavigation(value: string): void {
    const query = value.trim().toLocaleLowerCase()
    let visibleCount = 0
    overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => {
      const visible = !query || (button.dataset.settingsSearch || '').includes(query)
      button.hidden = !visible
      if (visible) visibleCount += 1
    })
    overlay.querySelectorAll<HTMLElement>('[data-settings-group]').forEach(group => {
      group.hidden = !group.querySelector('[data-settings-section]:not([hidden])')
    })
    navEmpty.hidden = visibleCount > 0
  }

  function serializedDraft(): string {
    return JSON.stringify(draft)
  }

  function updateDirtyState(): void {
    const dirty = Boolean(draft && serializedDraft() !== baseline)
    saveButton.disabled = !dirty
    stateLabel.textContent = dirty ? '有未保存的更改' : '修改后需要保存'
  }

  async function ensureSettings(force = false): Promise<void> {
    if (settings && !force) return
    if (loading) return loading
    loading = bridge.getSettings(force).then(snapshot => {
      settings = snapshot
      draft = createSettingsUpdate(snapshot)
      baseline = serializedDraft()
    }).finally(() => {
      loading = null
    })
    return loading
  }

  function updateProfile(mutator: (profile: WorkbenchApiConfigInput) => void, rerender = false): void {
    if (!draft) return
    const profile = selectedProfile(draft)
    if (!profile) return
    mutator(profile)
    updateDirtyState()
    if (rerender) renderSection()
  }

  function renderApi(): void {
    if (!settings || !draft) return
    const profile = selectedProfile(draft)
    if (!profile) {
      content.innerHTML = '<div class="settings-empty"><strong>还没有 API 配置</strong><p>新建一个连接后即可选择模型并开始工作。</p><button class="settings-primary" id="profile-add-empty">新建连接</button></div>'
      content.querySelector('#profile-add-empty')?.addEventListener('click', addProfile)
      return
    }
    const managedProduct = isManagedProfile(profile)
    if (managedProduct) {
      const availableManagedModels = managedModelOptions(settings)
      const model = availableManagedModels.find(item => item.model === profile.model || item.id === profile.model)
      const modelCount = availableManagedModels.length
      const managedModels = availableManagedModels.map(item => `<option value="${escapeHtml(item.model)}" ${item.model === profile.model ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')
      const reasoning = model?.reasoningCapabilities
      const modelDescription = managedModelDescription(model)
      const reasoningDescription = reasoning ? '复杂任务会使用模型的原生推理能力。' : '当前模型不提供可调节的推理选项。'
      const reasoningConfig = profile.reasoning || model?.reasoning || {}
      const reasoningEnabled = reasoningConfig.enabled !== false && reasoningConfig.effort !== 'none'
      const reasoningToggle = reasoning
        ? `<label class="settings-switch settings-row-switch"><input id="reasoning-enabled" type="checkbox" ${reasoningEnabled ? 'checked' : ''}><span aria-hidden="true"></span><b>${reasoningEnabled ? '已开启' : '已关闭'}</b></label>`
        : '<span class="settings-row-value muted">当前模型不支持</span>'
      let reasoningEffort = ''
      if (reasoning?.control === 'budget') {
        reasoningEffort = `<input id="reasoning-budget" class="settings-row-input" type="number" min="1024" max="128000" step="1024" value="${reasoningConfig.budgetTokens || reasoning.defaultBudgetTokens || 8192}" aria-label="推理预算">`
      } else if (reasoning?.efforts.length) {
        reasoningEffort = `<select id="reasoning-effort" class="settings-row-select" aria-label="推理强度">${reasoning.efforts.map(effort => `<option value="${effort}" ${effort === (reasoningConfig.effort || reasoning.defaultEffort) ? 'selected' : ''}>${reasoningEffortLabel(effort)}</option>`).join('')}</select>`
      }
      content.innerHTML = `
        <div class="managed-model-page">
          <div class="settings-page-intro"><div><h3>连接与模型</h3><p>在本机配置自己的模型服务与 API Key，随时切换当前连接。</p></div><span class="settings-plan-badge">FREE</span></div>
          <div class="api-profile-toolbar managed-profile-toolbar">
            <select id="api-profile-select" aria-label="当前连接">${draft.apiProfiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === profile.id ? 'selected' : ''}>${escapeHtml(item.name)}${isManagedProfile(item) ? ' · 托管' : ''}</option>`).join('')}</select>
            <button class="settings-icon-action" id="profile-add" title="添加自己的 API">＋</button>
          </div>
          <section class="settings-group-block managed-account-group" aria-label="账户用量">
            ${settingsRow('可用模型', '由当前方案动态开放', `<span class="settings-row-value">${escapeHtml(modelCount)} 个</span>`)}
          </section>
          <div class="managed-model-section-head"><h4>模型设置</h4><span>TurboFlux 托管</span></div>
          <section class="settings-group-block managed-model-group" aria-label="模型设置">
            ${settingsRow('当前模型', modelDescription, `<select id="managed-model-select" class="settings-row-select" aria-label="当前模型">${managedModels}</select>`)}
            ${settingsRow('启用推理', reasoningDescription, reasoningToggle)}
            ${reasoningEffort ? settingsRow(reasoning?.control === 'budget' ? '推理预算' : '推理强度', reasoning?.control === 'budget' ? '控制单次任务可使用的推理额度' : '更高强度通常会使用更多时间与计算量', reasoningEffort, 'reasoning-effort-row') : ''}
          </section>
          <div class="settings-footnote"><span aria-hidden="true">i</span><p>可以同时使用 TurboFlux 托管模型与自己的 API、OpenRouter 或第三方模型服务。</p></div>
        </div>
      `
      content.querySelector<HTMLSelectElement>('#api-profile-select')?.addEventListener('change', event => {
        draft!.activeApiConfigId = (event.target as HTMLSelectElement).value
        renderSection()
        updateDirtyState()
      })
      content.querySelector('#profile-add')?.addEventListener('click', addProfile)
      content.querySelector<HTMLSelectElement>('#managed-model-select')?.addEventListener('change', event => {
        const value = (event.target as HTMLSelectElement).value
        const selected = managedModelOptions(settings!).find(item => item.model === value || item.id === value)
        profile.model = value
        if (selected) {
          profile.contextWindow = selected.contextWindow
          profile.maxTokens = selected.maxTokens
          profile.maxOutputTokens = selected.maxOutputTokens
          profile.reasoning = selected.reasoning ? { ...selected.reasoning } : undefined
        }
        renderSection()
        updateDirtyState()
      })
      bindReasoning(profile)
      content.querySelector<HTMLInputElement>('#reasoning-enabled')?.addEventListener('change', event => {
        const input = event.target as HTMLInputElement
        const label = input.closest('.settings-switch')?.querySelector('b')
        if (label) label.textContent = input.checked ? '已开启' : '已关闭'
      })
      return
    }
    const preset = settings.providerPresets.find(item => item.provider === profile.provider && item.id !== 'custom')
      ?? settings.providerPresets.find(item => item.provider === profile.provider)
    const activeSummary = settings.apiProfiles.find(item => item.id === profile.id)
    const model = modelFor(settings, profile.model)
    const filteredModels = settings.models.filter(item => profile.provider === 'custom' || profile.provider === 'openrouter' || item.provider === profile.provider)
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>连接与模型</h3><p>管理多个连接，选择当前模型与原生推理强度。</p></div><button class="settings-secondary" id="refresh-models">刷新模型</button></div>
      <div class="api-profile-toolbar">
        <select id="api-profile-select">${draft.apiProfiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === profile.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>
        <button class="settings-icon-action" id="profile-add" title="新建连接">＋</button>
        <button class="settings-icon-action danger" id="profile-delete" title="删除连接" ${isManagedProfile(profile) ? 'disabled' : ''}>−</button>
      </div>
      <div class="settings-card settings-grid-two">
        ${field('名称', `<input id="profile-name" value="${escapeHtml(profile.name)}" autocomplete="off">`)}
        ${field('服务商', `<select id="profile-provider">${settings.providerPresets.map(item => `<option value="${item.provider}" ${item.provider === profile.provider ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>`)}
        ${field('API 地址', `<input id="profile-base-url" value="${escapeHtml(profile.baseUrl)}" placeholder="https://api.example.com/v1" spellcheck="false">`)}
        ${field('API 密钥', `<input id="profile-api-key" type="password" value="" placeholder="${activeSummary?.hasApiKey ? '已安全保存 · 留空保持不变' : '输入 API Key'}" autocomplete="new-password">`, activeSummary?.hasApiKey ? '密钥保存在本机凭据文件中，不会发送给界面。' : '')}
      </div>
      <div class="settings-card">
        <div class="settings-card-title"><strong>模型</strong><span>${escapeHtml(settings.modelDiscovery.source)}${settings.modelDiscovery.stale ? ' · 缓存已过期' : ''}</span></div>
        ${field('模型 ID', `<input id="profile-model" list="settings-model-options" value="${escapeHtml(profile.model)}" placeholder="选择或输入模型 ID" spellcheck="false"><datalist id="settings-model-options">${filteredModels.map(item => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.name)}</option>`).join('')}</datalist>`, model?.description || settings.modelDiscovery.error || '')}
        <div id="settings-reasoning">${reasoningControls(model, profile)}</div>
      </div>
      <div class="settings-card settings-grid-three">
        ${field('上下文窗口', `<input id="profile-context" type="number" min="1024" step="1024" value="${profile.contextWindow}">`)}
        ${field('单次输出上限', `<input id="profile-max-tokens" type="number" min="1" step="1024" value="${profile.maxTokens}">`)}
        ${field('模型最大输出', `<input id="profile-max-output" type="number" min="1" step="1024" value="${profile.maxOutputTokens || ''}" placeholder="自动">`)}
      </div>
      ${preset ? `<div class="settings-inline-note">${escapeHtml(preset.description)}</div>` : ''}
    `
    content.querySelector<HTMLSelectElement>('#api-profile-select')!.addEventListener('change', event => {
      draft!.activeApiConfigId = (event.target as HTMLSelectElement).value
      renderSection()
      updateDirtyState()
    })
    content.querySelector('#profile-add')?.addEventListener('click', addProfile)
    content.querySelector('#profile-delete')?.addEventListener('click', deleteProfile)
    content.querySelector('#refresh-models')?.addEventListener('click', () => void refreshModels())
    bindText('#profile-name', value => { profile.name = value })
    bindText('#profile-base-url', value => { profile.baseUrl = value })
    bindText('#profile-api-key', value => { profile.apiKey = value })
    bindNumber('#profile-context', value => { profile.contextWindow = value })
    bindNumber('#profile-max-tokens', value => { profile.maxTokens = value })
    bindOptionalNumber('#profile-max-output', value => { profile.maxOutputTokens = value })
    content.querySelector<HTMLSelectElement>('#profile-provider')!.addEventListener('change', event => {
      const previousPreset = settings!.providerPresets.find(item => item.provider === profile.provider && item.id !== 'custom')
      profile.provider = (event.target as HTMLSelectElement).value as WorkbenchApiConfigInput['provider']
      const nextPreset = settings!.providerPresets.find(item => item.provider === profile.provider && item.id !== 'custom')
        ?? settings!.providerPresets.find(item => item.provider === profile.provider)
      if (!profile.baseUrl || profile.baseUrl === previousPreset?.baseUrl) profile.baseUrl = nextPreset?.baseUrl || ''
      if (!profile.model && nextPreset?.defaultModel) profile.model = nextPreset.defaultModel
      renderSection()
      updateDirtyState()
    })
    content.querySelector<HTMLInputElement>('#profile-model')!.addEventListener('change', event => {
      const value = (event.target as HTMLInputElement).value.trim()
      const selected = modelFor(settings!, value)
      profile.model = value
      if (selected) {
        profile.contextWindow = selected.contextWindow
        profile.maxTokens = selected.maxTokens
        profile.maxOutputTokens = selected.maxOutputTokens
        profile.reasoning = selected.reasoning ? { ...selected.reasoning } : undefined
      }
      renderSection()
      updateDirtyState()
    })
    bindReasoning(profile)
  }

  function bindReasoning(profile: WorkbenchApiConfigInput): void {
    content.querySelector<HTMLInputElement>('#reasoning-enabled')?.addEventListener('change', event => {
      profile.reasoning = { ...profile.reasoning, enabled: (event.target as HTMLInputElement).checked }
      updateDirtyState()
    })
    content.querySelector<HTMLSelectElement>('#reasoning-effort')?.addEventListener('change', event => {
      profile.reasoning = { ...profile.reasoning, enabled: true, effort: (event.target as HTMLSelectElement).value as NativeReasoningConfig['effort'] }
      updateDirtyState()
    })
    content.querySelector<HTMLInputElement>('#reasoning-budget')?.addEventListener('input', event => {
      profile.reasoning = { ...profile.reasoning, enabled: true, budgetTokens: Number((event.target as HTMLInputElement).value) }
      updateDirtyState()
    })
  }

  function bindText(selector: string, update: (value: string) => void): void {
    content.querySelector<HTMLInputElement>(selector)?.addEventListener('input', event => {
      update((event.target as HTMLInputElement).value)
      updateDirtyState()
    })
  }

  function bindNumber(selector: string, update: (value: number) => void): void {
    content.querySelector<HTMLInputElement>(selector)?.addEventListener('input', event => {
      update(Number((event.target as HTMLInputElement).value))
      updateDirtyState()
    })
  }

  function bindOptionalNumber(selector: string, update: (value: number | undefined) => void): void {
    content.querySelector<HTMLInputElement>(selector)?.addEventListener('input', event => {
      const value = (event.target as HTMLInputElement).value
      update(value ? Number(value) : undefined)
      updateDirtyState()
    })
  }

  function addProfile(): void {
    if (!draft || !settings) return
    const preset = settings.providerPresets.find(item => item.id === 'openai') || settings.providerPresets[0]
    const model = settings.models.find(item => item.model === preset?.defaultModel)
    const profile: WorkbenchApiConfigInput = {
      id: generatedProfileId(),
      name: '新连接',
      provider: preset?.provider || 'custom',
      apiKey: '',
      baseUrl: preset?.baseUrl || '',
      model: preset?.defaultModel || '',
      contextWindow: model?.contextWindow || 200_000,
      maxTokens: model?.maxTokens || 16_384,
      maxOutputTokens: model?.maxOutputTokens,
      reasoning: model?.reasoning ? { ...model.reasoning } : undefined,
    }
    draft.apiProfiles.push(profile)
    draft.activeApiConfigId = profile.id
    renderSection()
    updateDirtyState()
  }

  function deleteProfile(): void {
    if (!draft) return
    const profile = selectedProfile(draft)
    if (!profile) return
    if (isManagedProfile(profile)) return options.showToast('托管连接不能删除')
    draft.apiProfiles = draft.apiProfiles.filter(item => item.id !== profile.id)
    draft.activeApiConfigId = draft.apiProfiles[0]?.id
    renderSection()
    updateDirtyState()
  }

  async function refreshModels(): Promise<void> {
    const button = content.querySelector<HTMLButtonElement>('#refresh-models')
    if (button) {
      button.disabled = true
      button.textContent = '刷新中…'
    }
    try {
      const latest = await bridge.getSettings(true)
      const currentDraft = draft
      settings = latest
      draft = currentDraft || createSettingsUpdate(latest)
      renderSection()
      options.showToast(latest.modelDiscovery.error || `已发现 ${latest.models.length} 个模型`)
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
      renderSection()
    }
  }

  function mcpDrafts(): WorkbenchMcpServerInput[] {
    if (!draft) return []
    draft.mcpServers ||= []
    return draft.mcpServers
  }

  function selectedMcp(): WorkbenchMcpServerInput | undefined {
    const servers = mcpDrafts()
    return servers.find(server => server.name === selectedMcpName) || servers[0]
  }

  function splitValues(value: string): string[] | undefined {
    const values = value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
    return values.length > 0 ? values : undefined
  }

  function parseRecord(value: string, label: string): Record<string, string> | undefined {
    if (!value.trim()) return undefined
    const parsed = JSON.parse(value) as unknown
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 对象`)
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
  }

  function renderMcp(): void {
    if (!settings || !draft) return
    const systemServers = settings.mcpServers.filter(server => server.system)
    const servers = mcpDrafts()
    const server = selectedMcp()
    if (server && !selectedMcpName) selectedMcpName = server.name
    const systemMarkup = systemServers.length > 0
      ? `<div class="settings-section-head"><div><h3>内置能力</h3><p>随 TurboFlux 桌面端提供，由核心维护，不会写入项目 MCP 配置。</p></div></div>
        <div class="system-plugin-list">${systemServers.map(item => `
          <article class="system-plugin-row">
            <span class="system-plugin-glyph" aria-hidden="true">${item.name === 'browser' ? '◎' : item.name === 'computer' ? '⌘' : '◇'}</span>
            <div class="system-plugin-copy"><div><strong>${escapeHtml(item.displayName || item.name)}</strong><small>系统内置</small></div><p>${escapeHtml(item.description || 'TurboFlux 内置能力')}</p></div>
            <div class="system-plugin-state ${escapeHtml(item.status)}"><span></span><strong>${escapeHtml(mcpStatusLabel(item.status))}</strong><small>${item.tools.length} 个工具</small></div>
          </article>`).join('')}</div>`
      : ''
    if (!server) {
      content.innerHTML = `${systemMarkup}<div class="settings-section-head external-mcp-heading"><div><h3>外部连接</h3><p>添加本地命令或 HTTP MCP 服务，让 Agent 获得额外能力。</p></div></div><div class="settings-empty"><strong>还没有外部 MCP 连接</strong><p>内置能力保持只读，外部服务会保存到当前项目。</p><button class="settings-primary" id="mcp-add-empty">添加连接</button></div>`
      content.querySelector('#mcp-add-empty')?.addEventListener('click', addMcp)
      return
    }
    const summary = settings.mcpServers.find(item => item.name === server.name)
    const transport = server.url ? 'http' : 'stdio'
    content.innerHTML = `
      ${systemMarkup}
      <div class="settings-section-head external-mcp-heading"><div><h3>外部连接</h3><p>连接外部工具服务。敏感环境变量和请求头不会回显，留空会保留已有值。</p></div><button class="settings-secondary" id="mcp-reconnect">重新连接</button></div>
      <div class="api-profile-toolbar">
        <select id="mcp-select">${servers.map(item => `<option value="${escapeHtml(item.name)}" ${item === server ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>
        <button class="settings-icon-action" id="mcp-add" title="添加 MCP">＋</button>
        <button class="settings-icon-action danger" id="mcp-delete" title="删除 MCP">−</button>
      </div>
      <div class="settings-card settings-grid-two">
        ${field('名称', `<input id="mcp-name" value="${escapeHtml(server.name)}" spellcheck="false">`)}
        ${field('连接方式', `<select id="mcp-transport"><option value="stdio" ${transport === 'stdio' ? 'selected' : ''}>本地命令</option><option value="http" ${transport === 'http' ? 'selected' : ''}>HTTP</option></select>`)}
        <label class="settings-switch"><input id="mcp-enabled" type="checkbox" ${server.enabled ? 'checked' : ''}><span></span><b>启用此连接</b></label>
        <div class="mcp-status ${escapeHtml(summary?.status || 'disconnected')}"><span></span><strong>${escapeHtml(summary ? mcpStatusLabel(summary.status) : '尚未保存')}</strong>${summary?.error ? `<small>${escapeHtml(summary.error)}</small>` : ''}</div>
      </div>
      <div class="settings-card settings-grid-two">
        ${transport === 'http'
          ? field('服务地址', `<input id="mcp-url" value="${escapeHtml(server.url || '')}" placeholder="https://example.com/mcp" spellcheck="false">`)
          : `${field('命令', `<input id="mcp-command" value="${escapeHtml(server.command || '')}" placeholder="npx" spellcheck="false">`)}${field('参数', `<textarea id="mcp-args" rows="4" placeholder="每行一个参数">${escapeHtml((server.args || []).join('\n'))}</textarea>`)}`}
        ${field('工作目录', `<input id="mcp-cwd" value="${escapeHtml(server.cwd || '')}" placeholder="默认继承当前工作区" spellcheck="false">`)}
      </div>
      <div class="settings-card settings-grid-two">
        ${field('环境变量 JSON', `<textarea id="mcp-env" rows="5" placeholder="${summary?.envKeys.length ? `已保存：${escapeHtml(summary.envKeys.join(', '))} · 留空保持` : '{&quot;TOKEN&quot;:&quot;...&quot;}'}</textarea>`)}
        ${field('HTTP Headers JSON', `<textarea id="mcp-headers" rows="5" placeholder="${summary?.headerKeys.length ? `已保存：${escapeHtml(summary.headerKeys.join(', '))} · 留空保持` : '{&quot;Authorization&quot;:&quot;Bearer ...&quot;}'}</textarea>`)}
        ${field('启用工具', `<textarea id="mcp-enabled-tools" rows="3" placeholder="留空表示全部">${escapeHtml((server.enabledTools || []).join('\n'))}</textarea>`)}
        ${field('禁用工具', `<textarea id="mcp-disabled-tools" rows="3" placeholder="每行一个工具名">${escapeHtml((server.disabledTools || []).join('\n'))}</textarea>`)}
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>已发现工具</strong><span>${summary?.tools.length || 0}</span></div><div class="mcp-tool-list">${summary?.tools.length ? summary.tools.map(tool => `<div><strong>${escapeHtml(tool.name.replace(`${server.name}__`, ''))}</strong><small>${escapeHtml(tool.description || '无描述')}</small></div>`).join('') : '<p class="settings-card-copy">连接成功后会在这里显示可用工具。</p>'}</div></div>
    `
    content.querySelector<HTMLSelectElement>('#mcp-select')!.addEventListener('change', event => {
      selectedMcpName = (event.target as HTMLSelectElement).value
      renderSection()
    })
    content.querySelector('#mcp-add')?.addEventListener('click', addMcp)
    content.querySelector('#mcp-delete')?.addEventListener('click', deleteMcp)
    content.querySelector('#mcp-reconnect')?.addEventListener('click', () => void reconnectMcp())
    bindText('#mcp-name', value => {
      const previous = server.name
      server.name = value
      selectedMcpName = value || previous
    })
    content.querySelector<HTMLSelectElement>('#mcp-transport')!.addEventListener('change', event => {
      if ((event.target as HTMLSelectElement).value === 'http') {
        server.url ||= 'https://'
      } else {
        server.url = undefined
        server.command ||= 'npx'
      }
      renderSection()
      updateDirtyState()
    })
    content.querySelector<HTMLInputElement>('#mcp-enabled')!.addEventListener('change', event => {
      server.enabled = (event.target as HTMLInputElement).checked
      updateDirtyState()
    })
    bindText('#mcp-url', value => { server.url = value })
    bindText('#mcp-command', value => { server.command = value })
    bindText('#mcp-cwd', value => { server.cwd = value })
    content.querySelector<HTMLTextAreaElement>('#mcp-args')?.addEventListener('input', event => {
      server.args = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    content.querySelector<HTMLTextAreaElement>('#mcp-enabled-tools')!.addEventListener('input', event => {
      server.enabledTools = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    content.querySelector<HTMLTextAreaElement>('#mcp-disabled-tools')!.addEventListener('input', event => {
      server.disabledTools = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    const bindRecord = (selector: string, key: 'env' | 'httpHeaders', preserveKey: 'preserveEnv' | 'preserveHttpHeaders', label: string) => {
      content.querySelector<HTMLTextAreaElement>(selector)!.addEventListener('change', event => {
        try {
          const value = (event.target as HTMLTextAreaElement).value
          const record = parseRecord(value, label)
          if (record) {
            server[key] = record
            server[preserveKey] = false
          }
          updateDirtyState()
        } catch (error) {
          options.showToast(error instanceof Error ? error.message : String(error))
        }
      })
    }
    bindRecord('#mcp-env', 'env', 'preserveEnv', '环境变量')
    bindRecord('#mcp-headers', 'httpHeaders', 'preserveHttpHeaders', '请求头')
  }

  function addMcp(): void {
    const servers = mcpDrafts()
    let index = servers.length + 1
    let name = `mcp-${index}`
    while (servers.some(server => server.name === name)) name = `mcp-${++index}`
    servers.push({ name, enabled: true, command: 'npx', args: [], preserveEnv: false, preserveHttpHeaders: false })
    selectedMcpName = name
    renderSection()
    updateDirtyState()
  }

  function deleteMcp(): void {
    if (!draft) return
    const server = selectedMcp()
    if (!server) return
    draft.mcpServers = mcpDrafts().filter(item => item !== server)
    selectedMcpName = draft.mcpServers[0]?.name || ''
    renderSection()
    updateDirtyState()
  }

  async function reconnectMcp(): Promise<void> {
    const server = selectedMcp()
    if (!server) return
    if (serializedDraft() !== baseline && !await save()) return
    try {
      settings = await bridge.reconnectMcp(server.name)
      draft = createSettingsUpdate(settings)
      baseline = serializedDraft()
      renderSection()
      options.showToast('MCP 已重新连接')
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
    }
  }

  function renderPersona(): void {
    if (!settings || !draft) return
    const profile = draft.profile
    const enabled = new Set(profile.enabledPersonaIds || [])
    const personas = settings.personas.filter(persona => !persona.isCustom)
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>语言与行为</h3><p>这些设置会组成 TurboFlux 的全局行为与输出偏好。</p></div></div>
      <div class="settings-card settings-grid-two">
        ${field('界面语言', `<select id="interface-language"><option value="zh-CN" ${profile.interfaceLanguage === 'zh-CN' ? 'selected' : ''}>简体中文</option><option value="en" ${profile.interfaceLanguage === 'en' ? 'selected' : ''}>English</option></select>`)}
        ${field('AI 输出语言', `<select id="output-language"><option value="follow-user">跟随用户</option><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="custom">自定义</option></select>`)}
        ${field('默认人设', `<select id="default-persona">${settings.personas.map(persona => `<option value="${persona.id}" ${persona.id === profile.defaultPersonaId ? 'selected' : ''}>${escapeHtml(persona.nameZh)}</option>`).join('')}</select>`)}
        ${field('自定义输出语言', `<input id="custom-output-language" value="${escapeHtml(profile.customAiOutputLanguage || '')}" placeholder="例如：粤语、德语">`)}
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>可用人设</strong><span>选择会出现在切换列表中的内置人设</span></div><div class="persona-grid">${personas.map(persona => `<label class="persona-option"><input type="checkbox" data-persona-id="${persona.id}" ${enabled.has(persona.id) ? 'checked' : ''}><span><strong>${escapeHtml(persona.nameZh)}</strong><small>${escapeHtml(persona.descriptionZh)}</small></span></label>`).join('')}</div></div>
      <div class="settings-card settings-grid-two">
        ${field('自定义人设名称', `<input id="custom-persona-name" value="${escapeHtml(profile.customPersonaName || '')}" placeholder="我的人设">`)}
        ${field('自定义人设 Prompt', `<textarea id="custom-persona-prompt" rows="5" placeholder="描述 AI 的身份、风格与行为边界">${escapeHtml(profile.customPersonaPrompt || '')}</textarea>`)}
      </div>
      <div class="settings-card">${field('全局指令', `<textarea id="custom-instructions" rows="7" placeholder="会附加到所有人设之后，例如你的工作习惯、输出偏好和长期约束">${escapeHtml(profile.customInstructions || '')}</textarea>`)}</div>
    `
    const output = content.querySelector<HTMLSelectElement>('#output-language')!
    output.value = String(profile.aiOutputLanguage || 'follow-user')
    content.querySelector<HTMLSelectElement>('#interface-language')!.addEventListener('change', event => updateProfileData('interfaceLanguage', (event.target as HTMLSelectElement).value))
    output.addEventListener('change', event => updateProfileData('aiOutputLanguage', (event.target as HTMLSelectElement).value))
    content.querySelector<HTMLSelectElement>('#default-persona')!.addEventListener('change', event => updateProfileData('defaultPersonaId', (event.target as HTMLSelectElement).value))
    bindProfileText('#custom-output-language', 'customAiOutputLanguage')
    bindProfileText('#custom-persona-name', 'customPersonaName')
    bindProfileText('#custom-persona-prompt', 'customPersonaPrompt')
    bindProfileText('#custom-instructions', 'customInstructions')
    content.querySelectorAll<HTMLInputElement>('[data-persona-id]').forEach(input => input.addEventListener('change', () => {
      const ids = Array.from(content.querySelectorAll<HTMLInputElement>('[data-persona-id]:checked')).map(item => item.dataset.personaId!)
      draft!.profile.enabledPersonaIds = ids
      if (draft!.profile.defaultPersonaId !== 'custom' && !ids.includes(String(draft!.profile.defaultPersonaId))) {
        draft!.profile.defaultPersonaId = ids[0] || 'default'
      }
      updateDirtyState()
    }))
  }

  function updateProfileData(key: string, value: unknown): void {
    if (!draft) return
    ;(draft.profile as Record<string, unknown>)[key] = value
    updateDirtyState()
  }

  function bindProfileText(selector: string, key: string): void {
    content.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener('input', event => {
      updateProfileData(key, (event.target as HTMLInputElement | HTMLTextAreaElement).value)
    })
  }

  function optionCard(group: string, value: string, title: string, description: string, checked: boolean): string {
    return `<label class="policy-option"><input type="radio" name="${group}" value="${value}" ${checked ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`
  }

  function renderPermissions(): void {
    if (!draft) return
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>执行边界</h3><p>决定 Agent 在执行工具前何时需要你确认，以及它能触达的文件范围。</p></div></div>
      <div class="settings-card"><div class="settings-card-title"><strong>审批策略</strong></div><div class="policy-grid">
        ${optionCard('approval', 'ask', '每次询问', '文件修改、命令、MCP 与外部动作前都确认。', draft.approvalPolicy === 'ask')}
        ${optionCard('approval', 'agent', '低风险自动', '工作区内低风险操作自动继续，检测到风险时询问。', draft.approvalPolicy === 'agent')}
        ${optionCard('approval', 'full', '完全访问', '不弹出审批，并自动使用完整主机能力。', draft.approvalPolicy === 'full')}
      </div></div>
      <div class="settings-card"><div class="settings-card-title"><strong>能力边界</strong></div><div class="policy-grid">
        ${optionCard('capability', 'read-only', '只读', '只读取工作区，禁止写入与命令。', draft.capabilityProfile === 'read-only')}
        ${optionCard('capability', 'workspace-write', '工作区读写', '可读写当前工作区，阻止外部路径与主机命令。', draft.capabilityProfile === 'workspace-write')}
        ${optionCard('capability', 'danger-full-access', '完整主机访问', '允许访问工作区外路径和主机命令，仍受审批策略约束。', draft.capabilityProfile === 'danger-full-access')}
      </div></div>
      <div class="settings-card"><label class="settings-switch"><input id="git-enabled" type="checkbox" ${draft.gitEnabled ? 'checked' : ''}><span></span><b>启用 Git 工具</b></label><p class="settings-card-copy">让核心使用结构化 Git 状态、Diff、提交与分支能力。</p></div>
    `
    content.querySelectorAll<HTMLInputElement>('input[name="approval"]').forEach(input => input.addEventListener('change', () => {
      draft!.approvalPolicy = input.value as WorkbenchSettingsUpdate['approvalPolicy']
      if (draft!.approvalPolicy === 'full') draft!.capabilityProfile = 'danger-full-access'
      renderSection()
      updateDirtyState()
    }))
    content.querySelectorAll<HTMLInputElement>('input[name="capability"]').forEach(input => input.addEventListener('change', () => {
      draft!.capabilityProfile = input.value as WorkbenchSettingsUpdate['capabilityProfile']
      updateDirtyState()
    }))
    content.querySelector<HTMLInputElement>('#git-enabled')!.addEventListener('change', event => {
      draft!.gitEnabled = (event.target as HTMLInputElement).checked
      updateDirtyState()
    })
  }

  function renderAdvanced(): void {
    if (!settings || !draft) return
    const profile = selectedProfile(draft)
    const model = profile ? modelFor(settings, profile.model) : undefined
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>运行信息</h3><p>查看模型发现来源与当前运行参数。</p></div><button class="settings-secondary" id="advanced-refresh">重新发现模型</button></div>
      <div class="settings-metrics">
        <div><span>模型数量</span><strong>${settings.models.length}</strong></div>
        <div><span>发现来源</span><strong>${escapeHtml(settings.modelDiscovery.source)}</strong></div>
        <div><span>当前模型</span><strong>${escapeHtml(profile?.model || '未配置')}</strong></div>
        <div><span>推理强度</span><strong>${escapeHtml(reasoningLabel(profile?.reasoning))}</strong></div>
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>模型能力</strong><span>${escapeHtml(model?.name || profile?.model || '未配置')}</span></div><div class="capability-tags">
        ${model?.capabilities?.vision ? '<span>图像</span>' : ''}${model?.capabilities?.tools !== false ? '<span>工具调用</span>' : ''}${model?.reasoningCapabilities ? '<span>原生推理</span>' : ''}${model?.capabilities?.structuredOutput ? '<span>结构化输出</span>' : ''}
      </div><p class="settings-card-copy">${escapeHtml(model?.description || settings.modelDiscovery.error || '模型能力会从 API、网关元数据和 TurboFlux 内置注册表合并。')}</p></div>
      <div class="settings-inline-note">配置与人设保存在 <code>~/.turboflux</code>，API 密钥单独保存，Renderer 只能看到是否已配置。</div>
    `
    content.querySelector('#advanced-refresh')?.addEventListener('click', () => void refreshModels())
  }

  function memoryScopeLabel(scope: string): string {
    return ({ global: '全局', workspace_shared: '项目共享', workspace_private: '项目私有', conversation: '对话' } as Record<string, string>)[scope] || scope
  }

  function memoryKindLabel(kind: string): string {
    return ({ rule: '规则', fact: '事实', preference: '偏好', episode: '经历', todo: '待办', verdict: '结论', strategy: '策略', pitfall: '避坑', workflow: '流程' } as Record<string, string>)[kind] || kind
  }

  async function loadMemories(forceReload = false): Promise<void> {
    if (memoryLoading) return
    memoryLoading = true
    if (section === 'memory') content.innerHTML = '<div class="settings-loading">正在整理长期记忆…</div>'
    try {
      memorySnapshot = await bridge.listMemories({ ...memoryFilters }, forceReload)
      if (section === 'memory') renderMemory()
    } catch (error) {
      if (section === 'memory') content.innerHTML = `<div class="settings-empty"><strong>记忆读取失败</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button class="settings-primary" id="memory-retry">重试</button></div>`
      content.querySelector('#memory-retry')?.addEventListener('click', () => void loadMemories(true))
    } finally {
      memoryLoading = false
    }
  }

  function memoryEditorMarkup(): string {
    if (memoryEditorId === undefined) return ''
    const item = memoryEditorId ? memorySnapshot?.items.find(candidate => candidate.id === memoryEditorId) : undefined
    return `<section class="settings-card memory-editor">
      <div class="settings-card-title"><strong>${item ? '编辑记忆' : '新增记忆'}</strong><button class="settings-icon-action" id="memory-editor-close" aria-label="关闭">×</button></div>
      ${field('内容', `<textarea id="memory-editor-text" rows="5" placeholder="写下需要长期保留的规则、偏好或事实">${escapeHtml(item?.text || '')}</textarea>`)}
      <div class="settings-grid-three">
        ${field('范围', `<select id="memory-editor-scope"><option value="workspace_private" ${item?.scope === 'workspace_private' ? 'selected' : ''}>项目私有</option><option value="workspace_shared" ${item?.scope === 'workspace_shared' ? 'selected' : ''}>项目共享</option><option value="global" ${item?.scope === 'global' ? 'selected' : ''}>全局</option><option value="conversation" ${item?.scope === 'conversation' ? 'selected' : ''}>当前对话</option></select>`)}
        ${field('类型', `<select id="memory-editor-kind">${['rule', 'fact', 'preference', 'episode', 'todo', 'verdict', 'strategy', 'pitfall', 'workflow'].map(kind => `<option value="${kind}" ${item?.kind === kind ? 'selected' : ''}>${memoryKindLabel(kind)}</option>`).join('')}</select>`)}
        ${field('可信度', `<select id="memory-editor-confidence"><option value="asserted" ${item?.confidence === 'asserted' ? 'selected' : ''}>明确确认</option><option value="observed" ${!item || item.confidence === 'observed' ? 'selected' : ''}>实际观察</option><option value="inferred" ${item?.confidence === 'inferred' ? 'selected' : ''}>推断</option></select>`)}
      </div>
      ${field('标签', `<input id="memory-editor-tags" value="${escapeHtml(item?.tags.join(', ') || '')}" placeholder="用逗号分隔，最多 12 个">`)}
      <div class="memory-editor-footer"><label class="settings-switch"><input id="memory-editor-pinned" type="checkbox" ${item?.pinned ? 'checked' : ''}><span></span><b>固定到优先记忆</b></label><button class="settings-primary" id="memory-editor-save">保存</button></div>
    </section>`
  }

  function renderWorkPacks(): void {
    if (!settings) return
    if (!workPacks) {
      content.innerHTML = workPacksError
        ? `<div class="settings-empty"><strong>能力暂时无法载入</strong><p>${escapeHtml(workPacksError)}</p><button class="settings-primary" id="work-pack-retry">重新载入</button></div>`
        : '<div class="settings-loading">正在载入能力…</div>'
      content.querySelector('#work-pack-retry')?.addEventListener('click', () => void loadWorkPacks(true))
      if (!workPacksLoading && !workPacksError) void loadWorkPacks()
      return
    }
    const catalogEntries = workPacks.entries
    const baseEntries = workPackView === 'installed' ? workPacks.installed : catalogEntries
    const categoryLabel = (category: string) => ({ productivity: '效率提升', writing: '内容创作', research: '研究分析', design: '设计表达' } as Record<string, string>)[category.toLowerCase()] || category
    const categories = ['全部', ...new Set(baseEntries.map(entry => categoryLabel(entry.category)))]
    const query = workPackSearch.trim().toLowerCase()
    const entries = baseEntries.filter(entry => {
      if (workPackCategory !== '全部' && categoryLabel(entry.category) !== workPackCategory) return false
      return !query || `${entry.name} ${entry.description} ${entry.publisher} ${entry.category} ${entry.tags.join(' ')} ${entry.capabilities.join(' ')}`.toLowerCase().includes(query)
    })
    if (!entries.some(entry => entry.id === selectedWorkPackId)) selectedWorkPackId = entries[0]?.id || ''
    const selected = entries.find(entry => entry.id === selectedWorkPackId)
    const detail = selected ? `<div class="official-pack-detail">
      <button class="official-pack-back" id="work-pack-back">‹ 返回能力列表</button>
      <section class="official-pack-detail-hero">
        <div class="official-pack-detail-heading">${workPackIconMarkup(selected, true)}<div><h3>${escapeHtml(selected.name)}</h3><p>${escapeHtml(selected.description)}</p></div></div>
        <div class="official-pack-detail-actions"><button class="settings-primary" data-work-pack-primary="${escapeHtml(selected.id)}" ${workPackBusyId || (selected.installed && selected.enabled && !selected.emphasis) ? 'disabled' : ''}>${workPackBusyId === selected.id ? '正在处理…' : workPackPrimaryActionLabel(selected)}</button>${selected.supportsToggle && selected.enabled ? `<button class="settings-secondary" data-work-pack-toggle="${escapeHtml(selected.id)}" data-enabled="true">停用</button>` : ''}${selected.canUninstall ? `<button class="settings-secondary danger-text" data-work-pack-uninstall="${escapeHtml(selected.id)}">卸载</button>` : ''}</div>
      </section>
      ${selected.error ? `<div class="skill-market-action-error">${escapeHtml(selected.error)}</div>` : ''}
      <p class="official-pack-summary">${escapeHtml(selected.description)}</p>
      <section class="official-pack-text-section"><h4>应用授权</h4><div class="official-pack-text-list">${selected.permissions.length ? selected.permissions.map(permission => `<article><strong>${escapeHtml(permission)}</strong><p>启用前会再次确认，所有操作继续遵循你的权限与审批设置。</p></article>`).join('') : '<article><strong>无需额外授权</strong><p>安装后即可使用，不会扩大当前工作区的权限范围。</p></article>'}</div></section>
      <section class="official-pack-text-section"><h4>包含能力 <span>${selected.capabilities.length || 1}</span></h4><div class="official-pack-text-list">${(selected.capabilities.length ? selected.capabilities : [selected.description]).map(item => `<article><strong>${escapeHtml(item)}</strong><p>由插件定义，并在适合的任务中自动参与工作。</p></article>`).join('')}</div></section>
      <section class="official-pack-text-section official-pack-product-info"><h4>能力信息</h4><dl><div><dt>发布方</dt><dd>TurboFlux</dd></div><div><dt>版本</dt><dd>${escapeHtml(selected.version)}</dd></div><div><dt>分类</dt><dd>${escapeHtml(categoryLabel(selected.category))}</dd></div><div><dt>类型</dt><dd>${workPackKindLabel(selected.kind)}</dd></div></dl></section>
    </div>` : '<div class="official-market-empty"><strong>没有找到匹配的插件</strong><p>试试更换关键词或分类。</p></div>'
    const featured = entries.find(entry => entry.featured) || entries[0]
    const catalog = `<div class="official-market">
      <header class="official-market-header"><div><h3>插件</h3><p>安装、启用与卸载本机插件。</p></div><div class="official-market-tabs"><button data-work-pack-view="marketplace" class="${workPackView === 'marketplace' ? 'active' : ''}">可用</button><button data-work-pack-view="installed" class="${workPackView === 'installed' ? 'active' : ''}">已安装 <span>${workPacks.installed.length}</span></button></div></header>
      <div class="official-market-toolbar"><label><span>⌕</span><input id="work-pack-search" value="${escapeHtml(workPackSearch)}" placeholder="搜索能力"></label><button class="settings-secondary" id="work-pack-refresh">刷新</button></div>
      <div class="official-market-categories">${categories.map(category => `<button data-work-pack-category="${escapeHtml(category)}" class="${category === workPackCategory ? 'active' : ''}">${escapeHtml(category)}</button>`).join('')}</div>
      <section class="official-market-section"><div class="official-market-section-head"><div><span>${workPackView === 'installed' ? '你的插件' : '可用插件'}</span><h4>${workPackView === 'installed' ? '已安装的插件' : '本机可用的插件'}</h4></div><small>${entries.length} 项</small></div><div class="official-pack-grid">${entries.map(entry => `<article class="official-pack-card"><button class="official-pack-card-open" data-work-pack-open="${escapeHtml(entry.id)}">${workPackIconMarkup(entry)}<span class="official-pack-card-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.description)}</small><i>${escapeHtml(categoryLabel(entry.category))}</i></span></button><footer><span class="state-${escapeHtml(entry.installState)}">${workPackStateLabel(entry)}</span><button class="official-pack-action" data-work-pack-primary="${escapeHtml(entry.id)}" ${workPackBusyId ? 'disabled' : ''}>${workPackPrimaryActionLabel(entry)}</button></footer></article>`).join('') || '<div class="official-market-empty"><strong>这里还没有插件</strong><p>可用的插件会显示在这里。</p></div>'}</div></section>
      <footer class="official-market-note"><strong>本地管理</strong><span>插件在本机安装与运行，可启停；非内置插件可以卸载。</span></footer>
    </div>`
    content.innerHTML = `<div class="skill-page work-pack-page">${workPackPage === 'detail' ? detail : catalog}</div>`

    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-view]').forEach(button => button.addEventListener('click', () => {
      workPackView = button.dataset.workPackView === 'installed' ? 'installed' : 'marketplace'
      workPackCategory = '全部'
      workPackPage = 'catalog'
      renderWorkPacks()
    }))
    content.querySelector<HTMLInputElement>('#work-pack-search')?.addEventListener('input', event => {
      workPackSearch = (event.target as HTMLInputElement).value
      renderWorkPacks()
      content.querySelector<HTMLInputElement>('#work-pack-search')?.focus()
    })
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-category]').forEach(button => button.addEventListener('click', () => {
      workPackCategory = button.dataset.workPackCategory || '全部'
      renderWorkPacks()
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-open]').forEach(button => button.addEventListener('click', () => {
      selectedWorkPackId = button.dataset.workPackOpen || ''
      workPackPage = 'detail'
      renderWorkPacks()
    }))
    content.querySelector('#work-pack-back')?.addEventListener('click', () => { workPackPage = 'catalog'; renderWorkPacks() })
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-primary]').forEach(button => button.addEventListener('click', () => void useWorkPack(button.dataset.workPackPrimary || '')))
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-cancel]').forEach(button => button.addEventListener('click', () => void cancelWorkPack(button.dataset.workPackCancel || '')))
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-toggle]').forEach(button => button.addEventListener('click', () => void toggleWorkPack(button.dataset.workPackToggle || '', button.dataset.enabled !== 'true')))
    content.querySelectorAll<HTMLButtonElement>('[data-work-pack-uninstall]').forEach(button => button.addEventListener('click', () => void uninstallWorkPack(button.dataset.workPackUninstall || '')))
    content.querySelector('#work-pack-refresh')?.addEventListener('click', () => void loadWorkPacks(true))
  }

  async function loadWorkPacks(force = false): Promise<void> {
    if (workPacksLoading) return
    workPacksLoading = true
    workPacksError = ''
    if (force) workPacks = null
    if (isOpen() && section === 'workpacks') renderWorkPacks()
    try {
      workPacks = await bridge.listWorkPacks()
      settings = await bridge.getSettings(false)
    } catch (error) {
      workPacksError = error instanceof Error ? error.message : String(error)
    } finally {
      workPacksLoading = false
      if (isOpen() && section === 'workpacks') renderWorkPacks()
    }
  }

  async function useWorkPack(id: string): Promise<void> {
    const entry = workPacks?.entries.find(candidate => candidate.id === id)
    if (!entry) return
    if (entry.installed && entry.enabled && entry.emphasis && !['update-available', 'modified', 'broken'].includes(entry.installState)) {
      await options.onUseCapability(entry.emphasis)
      close()
      return
    }
    const overwrite = entry.installState === 'modified' || entry.installState === 'broken'
    if (overwrite && !window.confirm(`重新安装“${entry.name}”会替换插件管理的文件，继续吗？`)) return
    workPackBusyId = id
    renderWorkPacks()
    try {
      const next = entry.installed && entry.supportsToggle && !entry.enabled
        ? await bridge.setWorkPackEnabled(id, true)
        : await bridge.installWorkPack(id, overwrite)
      if (!next) return
      workPacks = next
      settings = await bridge.getSettings(false)
      options.showToast(entry.installed ? '插件已启用' : '插件已安装并可用')
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  async function cancelWorkPack(id: string): Promise<void> {
    try { await bridge.cancelWorkPackInstall(id) } catch (error) { options.showToast(error instanceof Error ? error.message : String(error)) }
  }

  async function toggleWorkPack(id: string, enabled: boolean): Promise<void> {
    workPackBusyId = id
    renderWorkPacks()
    try {
      workPacks = await bridge.setWorkPackEnabled(id, enabled)
      settings = await bridge.getSettings(false)
      options.showToast(enabled ? '插件已启用' : '插件已停用')
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  async function uninstallWorkPack(id: string): Promise<void> {
    const entry = workPacks?.entries.find(candidate => candidate.id === id)
    if (!entry || !window.confirm(`卸载“${entry.name}”？由它提供的工作流和工具将同时移除。`)) return
    workPackBusyId = id
    renderWorkPacks()
    try {
      workPacks = await bridge.uninstallWorkPack(id)
      settings = await bridge.getSettings(false)
      options.showToast('插件已卸载')
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  function renderMemory(): void {
    if (!memorySnapshot) {
      void loadMemories()
      return
    }
    const kinds = ['', 'rule', 'fact', 'preference', 'episode', 'todo', 'verdict', 'strategy', 'pitfall', 'workflow']
    const scopes = ['', 'global', 'workspace_shared', 'workspace_private', 'conversation']
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>长期记忆</h3><p>管理会参与后续任务的规则、偏好、事实与经验。</p></div><div class="settings-head-actions"><button class="settings-secondary" id="memory-refresh">刷新</button><button class="settings-primary" id="memory-add">新增记忆</button></div></div>
      <div class="memory-metrics"><div><span>记录</span><strong>${memorySnapshot.totalCount}</strong></div><div><span>当前结果</span><strong>${memorySnapshot.items.length}</strong></div><div><span>注入预算</span><strong>${memorySnapshot.injectionTokens.toLocaleString()}</strong></div></div>
      ${memorySnapshot.warnings.length ? `<div class="settings-inline-note memory-warning">${memorySnapshot.warnings.map(warning => escapeHtml(warning)).join('<br>')}</div>` : ''}
      <div class="memory-toolbar">
        <input id="memory-search" type="search" value="${escapeHtml(memoryFilters.query || '')}" placeholder="搜索内容、标签或来源">
        <select id="memory-scope">${scopes.map(scope => `<option value="${scope}" ${memoryFilters.scope === scope ? 'selected' : ''}>${scope ? memoryScopeLabel(scope) : '全部范围'}</option>`).join('')}</select>
        <select id="memory-kind">${kinds.map(kind => `<option value="${kind}" ${memoryFilters.kind === kind ? 'selected' : ''}>${kind ? memoryKindLabel(kind) : '全部类型'}</option>`).join('')}</select>
        <select id="memory-status"><option value="" ${!memoryFilters.status ? 'selected' : ''}>全部状态</option><option value="active" ${memoryFilters.status === 'active' ? 'selected' : ''}>生效中</option><option value="rejected" ${memoryFilters.status === 'rejected' ? 'selected' : ''}>已遗忘</option><option value="stale" ${memoryFilters.status === 'stale' ? 'selected' : ''}>待复核</option><option value="superseded" ${memoryFilters.status === 'superseded' ? 'selected' : ''}>已替代</option></select>
      </div>
      ${memoryEditorMarkup()}
      <div class="memory-list">${memorySnapshot.items.map(item => `<article class="memory-card status-${item.status}">
        <header><div><span>${memoryKindLabel(item.kind)}</span><span>${memoryScopeLabel(item.scope)}</span>${item.pinned ? '<span class="memory-pinned">已固定</span>' : ''}</div><small>${new Date(item.updatedAt).toLocaleString()}</small></header>
        <p>${escapeHtml(item.text)}</p>
        <div class="memory-tags">${item.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        <footer><span>${escapeHtml(item.source)} · ${item.reviewState === 'auto' ? '待审核' : item.reviewState === 'user_approved' ? '已审核' : '用户编辑'} · ${item.status === 'active' ? '生效中' : '已遗忘'}</span><div>
          <button data-memory-pin="${escapeHtml(item.id)}">${item.pinned ? '取消固定' : '固定'}</button>
          ${item.reviewState === 'auto' || item.status !== 'active' ? `<button data-memory-approve="${escapeHtml(item.id)}">${item.status === 'active' ? '通过审核' : '恢复'}</button>` : ''}
          <button data-memory-edit="${escapeHtml(item.id)}">编辑</button>
          ${item.status === 'active' ? `<button class="danger" data-memory-forget="${escapeHtml(item.id)}">删除</button>` : ''}
        </div></footer>
      </article>`).join('') || '<div class="settings-empty compact"><strong>没有匹配的记忆</strong><p>调整筛选条件，或新增一条经过确认的长期记忆。</p></div>'}</div>`

    content.querySelector('#memory-refresh')?.addEventListener('click', () => void loadMemories(true))
    content.querySelector('#memory-add')?.addEventListener('click', () => { memoryEditorId = null; renderMemory() })
    content.querySelector('#memory-editor-close')?.addEventListener('click', () => { memoryEditorId = undefined; renderMemory() })
    const reloadFromControls = () => {
      memoryFilters.scope = (content.querySelector<HTMLSelectElement>('#memory-scope')?.value || undefined) as WorkbenchMemoryFilters['scope']
      memoryFilters.kind = (content.querySelector<HTMLSelectElement>('#memory-kind')?.value || undefined) as WorkbenchMemoryFilters['kind']
      memoryFilters.status = (content.querySelector<HTMLSelectElement>('#memory-status')?.value || undefined) as WorkbenchMemoryFilters['status']
      void loadMemories()
    }
    content.querySelectorAll<HTMLSelectElement>('#memory-scope, #memory-kind, #memory-status').forEach(select => select.addEventListener('change', reloadFromControls))
    content.querySelector<HTMLInputElement>('#memory-search')?.addEventListener('input', event => {
      memoryFilters.query = (event.target as HTMLInputElement).value
      if (memorySearchTimer) clearTimeout(memorySearchTimer)
      memorySearchTimer = setTimeout(() => void loadMemories(), 180)
    })
    content.querySelector('#memory-editor-save')?.addEventListener('click', async () => {
      const text = content.querySelector<HTMLTextAreaElement>('#memory-editor-text')?.value.trim() || ''
      if (!text) return options.showToast('记忆内容不能为空')
      const input = {
        text,
        scope: content.querySelector<HTMLSelectElement>('#memory-editor-scope')?.value as 'global' | 'workspace_shared' | 'workspace_private' | 'conversation',
        kind: content.querySelector<HTMLSelectElement>('#memory-editor-kind')?.value as 'rule' | 'fact' | 'preference' | 'episode' | 'todo' | 'verdict' | 'strategy' | 'pitfall' | 'workflow',
        confidence: content.querySelector<HTMLSelectElement>('#memory-editor-confidence')?.value as 'asserted' | 'observed' | 'inferred',
        tags: (content.querySelector<HTMLInputElement>('#memory-editor-tags')?.value || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12),
        pinned: content.querySelector<HTMLInputElement>('#memory-editor-pinned')?.checked === true,
      }
      try {
        memorySnapshot = memoryEditorId ? await bridge.updateMemory(memoryEditorId, input) : await bridge.rememberMemory(input)
        memoryEditorId = undefined
        renderMemory()
        options.showToast('长期记忆已保存')
      } catch (error) {
        options.showToast(error instanceof Error ? error.message : String(error))
      }
    })
    content.querySelectorAll<HTMLButtonElement>('[data-memory-edit]').forEach(button => button.addEventListener('click', () => { memoryEditorId = button.dataset.memoryEdit || null; renderMemory() }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-pin]').forEach(button => button.addEventListener('click', async () => {
      const item = memorySnapshot?.items.find(candidate => candidate.id === button.dataset.memoryPin)
      if (!item) return
      try { memorySnapshot = await bridge.updateMemory(item.id, { pinned: !item.pinned }); renderMemory() } catch (error) { options.showToast(error instanceof Error ? error.message : String(error)) }
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-approve]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.memoryApprove
      if (!id) return
      try { memorySnapshot = await bridge.updateMemory(id, { reviewState: 'user_approved', status: 'active' }); renderMemory() } catch (error) { options.showToast(error instanceof Error ? error.message : String(error)) }
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-forget]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.memoryForget
      if (!id || !window.confirm('删除后这条记忆将不再参与后续任务。继续吗？')) return
      try { memorySnapshot = await bridge.forgetMemory(id, 'desktop-user-delete'); renderMemory() } catch (error) { options.showToast(error instanceof Error ? error.message : String(error)) }
    }))
  }

  function renderAppearance(): void {
    const activeTheme = currentThemePreference()
    const themeChoices: Array<{ id: ThemePreference; title: string; description: string }> = [
      { id: 'system', title: '跟随系统', description: '自动匹配 macOS 的浅色或深色外观。' },
      { id: 'light', title: '浅色', description: '明亮、中性的工作台，适合日间环境。' },
      { id: 'dark', title: '深色', description: '低眩光深色工作台，适合夜间与长时间工作。' },
    ]
    content.innerHTML = `
      <div class="appearance-page">
        <div class="settings-page-intro"><div><h3>主题</h3><p>浅色与深色使用同一套语义层级、状态颜色和可读性标准，切换立即生效。</p></div></div>
        <div class="theme-choice-grid" role="radiogroup" aria-label="界面主题">
          ${themeChoices.map(choice => `<button class="theme-choice ${choice.id === activeTheme ? 'selected' : ''}" type="button" role="radio" aria-checked="${choice.id === activeTheme}" data-theme-choice="${choice.id}">
            <span class="theme-choice-preview theme-choice-preview-${choice.id}" aria-hidden="true"><i></i><b></b><em></em></span>
            <span class="theme-choice-copy"><strong>${choice.title}</strong><small>${choice.description}</small></span>
            <span class="theme-choice-check" aria-hidden="true">${choice.id === activeTheme ? '✓' : ''}</span>
          </button>`).join('')}
        </div>
        <div class="settings-footnote"><span>i</span><p>选择“跟随系统”时，TurboFlux 会实时响应系统外观变化，并在下次启动时保持该选择。</p></div>
      </div>`
    content.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
      const preference = button.dataset.themeChoice as ThemePreference
      setThemePreference(preference)
      renderAppearance()
      options.showToast(`已切换为${preference === 'system' ? '跟随系统' : preference === 'light' ? '浅色' : '深色'}主题`)
    }))
  }

  function renderSection(): void {
    overlay.dataset.section = section
    content.dataset.section = section
    overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => button.classList.toggle('active', button.dataset.settingsSection === section))
    const label = sectionLabels.find(item => item.id === section)!
    overlay.querySelector('#settings-title')!.textContent = label.title
    if (section === 'appearance') {
      renderAppearance()
      return
    }
    if (!settings || !draft) return
    if (section === 'api') renderApi()
    if (section === 'mcp') renderMcp()
    if (section === 'computer') options.computerControls?.renderSettings(content)
    if (section === 'workpacks') renderWorkPacks()
    if (section === 'memory') renderMemory()
    if (section === 'persona') renderPersona()
    if (section === 'permissions') renderPermissions()
    if (section === 'advanced') renderAdvanced()
    updateDirtyState()
  }

  async function save(): Promise<boolean> {
    if (!draft) return false
    saveButton.disabled = true
    saveButton.textContent = '保存中…'
    try {
      const result = await bridge.saveSettings(draft)
      settings = result.settings
      draft = createSettingsUpdate(result.settings)
      baseline = serializedDraft()
      options.onSnapshot(result.snapshot)
      renderSection()
      options.showToast('设置已保存并应用')
      return true
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
      updateDirtyState()
      return false
    } finally {
      saveButton.textContent = '保存更改'
    }
  }

  async function open(nextSection: SettingsSection = 'api'): Promise<void> {
    section = nextSection
    if (!isOpen()) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await options.onOpen?.()
    }
    searchInput.value = ''
    filterNavigation('')
    overlay.classList.add('visible')
    overlay.setAttribute('aria-hidden', 'false')
    content.innerHTML = '<div class="settings-loading">正在读取设置…</div>'
    requestAnimationFrame(() => backButton.focus({ preventScroll: true }))
    if (section === 'appearance') {
      renderSection()
      return
    }
    try {
      await ensureSettings(true)
      renderSection()
    } catch (error) {
      content.innerHTML = `<div class="settings-empty"><strong>设置读取失败</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div>`
    }
  }

  function close(): void {
    if (!isOpen()) return
    if (settings) {
      draft = createSettingsUpdate(settings)
      baseline = serializedDraft()
      updateDirtyState()
    }
    overlay.classList.remove('visible')
    overlay.setAttribute('aria-hidden', 'true')
    popover.classList.remove('visible')
    popover.setAttribute('aria-hidden', 'true')
    activePickerAnchor = null
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(anchor => anchor.setAttribute('aria-expanded', 'false'))
    options.onClose?.()
    const focusTarget = previousFocus
    previousFocus = null
    if (focusTarget?.isConnected && overlay.contains(document.activeElement)) {
      requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }))
    }
  }

  function isOpen(): boolean {
    return overlay.classList.contains('visible')
  }

  function positionModelPicker(anchor: HTMLElement, mainWidth = 252): void {
    const rect = anchor.getBoundingClientRect()
    const position = anchoredComposerPopoverPosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      mainWidth,
      options.getComposerPopoverPlacement?.() || 'above',
    )
    activePickerAnchor = anchor
    activePickerWidth = mainWidth
    popover.classList.remove('submenu-left')
    popover.dataset.placement = position.placement
    popover.style.left = `${position.left}px`
    popover.style.width = `${position.width}px`
    popover.style.right = 'auto'
    popover.style.top = position.top === null ? 'auto' : `${position.top}px`
    popover.style.bottom = position.bottom === null ? 'auto' : `${position.bottom}px`
    popover.style.maxHeight = `${position.maxHeight}px`
    popover.style.transformOrigin = position.transformOrigin
  }

  function repositionComposerPicker(): void {
    if (!popover.classList.contains('visible') || !activePickerAnchor?.isConnected) return
    positionModelPicker(activePickerAnchor, activePickerWidth)
  }

  function hidePicker(): void {
    popover.classList.remove('visible')
    popover.setAttribute('aria-hidden', 'true')
    activePickerAnchor = null
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', 'false'))
  }

  async function persistQuickChange(behavior: { keepPickerOpen?: boolean; applySnapshot?: boolean } = {}): Promise<WorkbenchSnapshot | null> {
    if (!draft) return null
    updateDirtyState()
    try {
      const result = await bridge.saveSettings({ ...draft, mcpServers: undefined })
      settings = result.settings
      draft = createSettingsUpdate(result.settings)
      baseline = serializedDraft()
      if (behavior.applySnapshot !== false) options.onSnapshot(result.snapshot)
      if (!behavior.keepPickerOpen) hidePicker()
      return result.snapshot
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function openModelPicker(anchor: HTMLElement): Promise<void> {
    positionModelPicker(anchor, 276)
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', String(item === anchor)))
    popover.className = 'model-popover model-only-popover'
    popover.innerHTML = '<div class="model-quick-menu model-picker-loading" role="status" aria-live="polite"><span class="model-picker-spinner"></span><span>正在读取模型…</span></div>'
    popover.classList.add('visible')
    popover.setAttribute('aria-hidden', 'false')
    try {
      await ensureSettings(true)
    } catch (error) {
      if (!popover.classList.contains('visible')) return
      const message = error instanceof Error ? error.message : String(error)
      popover.innerHTML = `<div class="model-quick-menu model-picker-error"><strong>模型读取失败</strong><span>${escapeHtml(message)}</span></div>`
      return
    }
    if (!popover.classList.contains('visible')) return
    if (!settings || !draft) return
    const profile = selectedProfile(draft)
    if (!profile) return void open('api')
    const currentModel = modelFor(settings, profile.model)
    const candidates = isManagedProfile(profile)
      ? managedModelOptions(settings)
      : settings.models.filter(item => profile.provider === 'custom' || profile.provider === 'openrouter' || item.provider === profile.provider)
    const current = candidates.find(item => item.model === profile.model)
    const ordered = current ? [current, ...candidates.filter(item => item !== current)] : candidates
    const modelIdentity = (item: WorkbenchModelOption) => {
      const provider = item.provider
      const multiplier = formatCreditMultiplier(undefined)
      return `<span class="model-selection-icon" data-provider="${escapeHtml(normalizedModelProvider(provider, item.model))}">${modelProviderMark(provider, item.model)}</span><span class="model-selection-copy"><strong>${escapeHtml(item.name)}</strong>${item.name !== item.model ? `<small>${escapeHtml(item.model)}</small>` : ''}</span>${multiplier ? `<em class="model-credit-multiplier" title="倍率">${escapeHtml(multiplier)}</em>` : ''}`
    }
    popover.innerHTML = `
      <div class="model-only-menu">
        <header><span>模型</span><strong>${escapeHtml(currentModel?.name || profile.model || '未配置')}</strong></header>
        <div class="model-submenu-list model-selection-list ${ordered.length > 6 ? 'scrollable' : ''}">${ordered.map(item => `<button data-quick-model="${escapeHtml(item.model)}" class="${item.model === profile.model ? 'selected' : ''}">${modelIdentity(item)}<i>${item.model === profile.model ? '✓' : ''}</i></button>`).join('') || '<div class="model-submenu-empty">没有发现可用模型</div>'}</div>
        <button class="model-popover-footer" data-model-settings>模型与 API 设置 <i>›</i></button>
      </div>`
    popover.querySelectorAll<HTMLButtonElement>('[data-quick-model]').forEach(button => button.addEventListener('click', async () => {
      const chosen = modelFor(settings!, button.dataset.quickModel || '')
      if (!chosen) return
      if (chosen.model === profile.model) {
        hidePicker()
        return
      }
      profile.model = chosen.model
      profile.contextWindow = chosen.contextWindow
      profile.maxTokens = chosen.maxTokens
      profile.maxOutputTokens = chosen.maxOutputTokens
      profile.reasoning = chosen.reasoning ? { ...chosen.reasoning } : undefined
      await persistQuickChange()
    }))
    popover.querySelector('[data-model-settings]')?.addEventListener('click', () => {
      hidePicker()
      void open('api')
    })
  }

  async function openReasoningPicker(anchor: HTMLElement): Promise<void> {
    positionModelPicker(anchor, 372)
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', String(item === anchor)))
    popover.className = 'model-popover reasoning-popover'
    popover.innerHTML = '<div class="reasoning-slider-card model-picker-loading" role="status" aria-live="polite"><span class="model-picker-spinner"></span><span>正在读取推理能力…</span></div>'
    popover.classList.add('visible')
    popover.setAttribute('aria-hidden', 'false')
    try {
      await ensureSettings()
    } catch (error) {
      if (!popover.classList.contains('visible')) return
      const message = error instanceof Error ? error.message : String(error)
      popover.innerHTML = `<div class="reasoning-slider-card model-picker-error"><strong>推理设置读取失败</strong><span>${escapeHtml(message)}</span></div>`
      return
    }
    if (!popover.classList.contains('visible') || !settings || !draft) return
    const profile = selectedProfile(draft)
    if (!profile) return void open('api')
    const model = modelFor(settings, profile.model)
    const capability = model?.reasoningCapabilities
    if (!capability) {
      popover.innerHTML = '<div class="reasoning-slider-card reasoning-unavailable"><strong>当前模型没有可调整的推理强度</strong><span>模型仍会使用服务商默认行为。</span></div>'
      return
    }
    const effectiveReasoning = effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)
    const reasoningOptions = buildReasoningOptions(capability, effectiveReasoning)
    const activeIndex = reasoningOptionIndex(reasoningOptions, effectiveReasoning)
    const active = reasoningOptions[activeIndex]
    if (!active) {
      popover.innerHTML = '<div class="reasoning-slider-card reasoning-unavailable"><strong>该模型的推理强度固定</strong><span>无需手动调整。</span></div>'
      return
    }
    const progress = reasoningOptions.length > 1 ? (activeIndex / (reasoningOptions.length - 1)) * 100 : 100
    popover.innerHTML = `
      <div class="reasoning-slider-card" data-reasoning-tone="${active.tone}" style="--reasoning-progress:${progress}%;--reasoning-count:${reasoningOptions.length}">
        <header><span>推理强度</span><strong><i aria-hidden="true"></i><span id="reasoning-slider-value">${active.label}</span></strong></header>
        <p id="reasoning-slider-detail">${active.detail}</p>
        <div class="reasoning-slider-shell">
          <div class="reasoning-slider-rail" aria-hidden="true">
            <div class="reasoning-slider-track"><span class="reasoning-slider-fill"></span></div>
            <div class="reasoning-slider-dots">${reasoningOptions.map((_, index) => `<i class="${index <= activeIndex ? 'filled' : ''} ${index === activeIndex ? 'current' : ''}"></i>`).join('')}</div>
            <span class="reasoning-slider-thumb"></span>
          </div>
          <input id="reasoning-slider" type="range" min="0" max="${reasoningOptions.length - 1}" step="1" value="${activeIndex}" aria-label="推理强度" aria-valuetext="${active.label}">
        </div>
        <div class="reasoning-slider-scale">${reasoningOptions.map((option, index) => `<button data-reasoning-index="${index}" class="${index === activeIndex ? 'active' : ''}" data-reasoning-tone="${option.tone}">${option.label}</button>`).join('')}</div>
      </div>`
    const card = popover.querySelector<HTMLElement>('.reasoning-slider-card')!
    const slider = popover.querySelector<HTMLInputElement>('#reasoning-slider')!
    const value = popover.querySelector<HTMLElement>('#reasoning-slider-value')!
    const detail = popover.querySelector<HTMLElement>('#reasoning-slider-detail')!
    const preview = (index: number) => {
      const option = reasoningOptions[index]
      if (!option) return
      const nextProgress = reasoningOptions.length > 1 ? (index / (reasoningOptions.length - 1)) * 100 : 100
      const previousTone = card.dataset.reasoningTone
      card.classList.remove('is-shifting', 'is-max-entering')
      void card.offsetWidth
      card.classList.add('is-shifting')
      card.dataset.reasoningTone = option.tone
      if (option.tone === 'max' && previousTone !== 'max') card.classList.add('is-max-entering')
      card.style.setProperty('--reasoning-progress', `${nextProgress}%`)
      value.textContent = option.label
      detail.textContent = option.detail
      slider.setAttribute('aria-valuetext', option.label)
      const reasoningName = app.querySelector<HTMLElement>('#reasoning-name')
      const reasoningTab = app.querySelector<HTMLElement>('#reasoning-tab')
      if (reasoningName) reasoningName.textContent = option.label
      if (reasoningTab) reasoningTab.dataset.reasoningTone = option.tone
      popover.querySelectorAll<HTMLElement>('.reasoning-slider-dots i').forEach((dot, dotIndex) => {
        dot.classList.toggle('filled', dotIndex <= index)
        dot.classList.toggle('current', dotIndex === index)
      })
      popover.querySelectorAll<HTMLButtonElement>('[data-reasoning-index]').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === index))
    }
    let latestReasoningIndex = activeIndex
    let reasoningRevision = 0
    let persistedReasoningRevision = 0
    let reasoningPersistTimer: number | null = null
    let reasoningPersisting = false
    const persistLatestReasoning = async () => {
      if (reasoningPersisting) return
      reasoningPersisting = true
      let latestSnapshot: WorkbenchSnapshot | null = null
      let persistFailed = false
      try {
        while (persistedReasoningRevision < reasoningRevision) {
          const targetRevision = reasoningRevision
          const index = latestReasoningIndex
          const option = reasoningOptions[index]
          const currentProfile = draft ? selectedProfile(draft) : undefined
          if (!option || !currentProfile) {
            persistedReasoningRevision = targetRevision
            continue
          }
          currentProfile.reasoning = { ...option.config }
          const snapshot = await persistQuickChange({ keepPickerOpen: true, applySnapshot: false })
          if (!snapshot) {
            persistFailed = true
            return
          }
          latestSnapshot = snapshot
          persistedReasoningRevision = targetRevision
          if (reasoningRevision > persistedReasoningRevision && draft) {
            const pendingProfile = selectedProfile(draft)
            const pendingOption = reasoningOptions[latestReasoningIndex]
            if (pendingProfile && pendingOption) pendingProfile.reasoning = { ...pendingOption.config }
          }
        }
      } finally {
        reasoningPersisting = false
        if (!persistFailed && persistedReasoningRevision < reasoningRevision) {
          void persistLatestReasoning()
        } else if (latestSnapshot) {
          options.onSnapshot(latestSnapshot)
        }
      }
    }
    const commit = (index: number) => {
      if (index === latestReasoningIndex) return
      const option = reasoningOptions[index]
      const currentProfile = draft ? selectedProfile(draft) : undefined
      if (!option || !currentProfile) return
      currentProfile.reasoning = { ...option.config }
      latestReasoningIndex = index
      reasoningRevision += 1
      if (reasoningPersistTimer !== null) window.clearTimeout(reasoningPersistTimer)
      reasoningPersistTimer = window.setTimeout(() => {
        reasoningPersistTimer = null
        void persistLatestReasoning()
      }, 80)
    }
    slider.addEventListener('input', () => {
      const index = Number(slider.value)
      preview(index)
      void commit(index)
    })
    slider.addEventListener('pointerdown', () => card.classList.add('is-dragging'))
    const finishDragging = () => card.classList.remove('is-dragging')
    slider.addEventListener('pointerup', finishDragging)
    slider.addEventListener('pointercancel', finishDragging)
    slider.addEventListener('lostpointercapture', finishDragging)
    popover.querySelectorAll<HTMLButtonElement>('[data-reasoning-index]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.reasoningIndex)
      slider.value = String(index)
      preview(index)
      void commit(index)
    }))
  }

  overlay.querySelector('#settings-back')?.addEventListener('click', close)
  overlay.querySelector('#settings-cancel')?.addEventListener('click', close)
  saveButton.addEventListener('click', () => void save())
  overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => button.addEventListener('click', async () => {
    section = button.dataset.settingsSection as SettingsSection
    content.scrollTop = 0
    if (section === 'appearance' || (settings && draft)) {
      renderSection()
      return
    }
    content.innerHTML = '<div class="settings-loading">正在读取设置…</div>'
    try {
      await ensureSettings(true)
      renderSection()
    } catch (error) {
      content.innerHTML = `<div class="settings-empty"><strong>设置读取失败</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div>`
    }
  }))
  searchInput.addEventListener('input', () => filterNavigation(searchInput.value))
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      overlay.querySelector<HTMLButtonElement>('[data-settings-section]:not([hidden])')?.click()
      return
    }
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault()
      event.stopPropagation()
      searchInput.value = ''
      filterNavigation('')
    }
  })
  overlay.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getClientRects().length > 0)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
  document.addEventListener('keydown', event => {
    if (!isOpen() || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  })
  document.addEventListener('pointerdown', event => {
    if (!popover.classList.contains('visible')) return
    const target = event.target as Node
    if (!popover.contains(target) && !(target instanceof Element && target.closest('#model-pill, #reasoning-tab'))) {
      popover.classList.remove('visible')
      popover.setAttribute('aria-hidden', 'true')
      activePickerAnchor = null
      app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(anchor => anchor.setAttribute('aria-expanded', 'false'))
    }
  })
  window.addEventListener('resize', repositionComposerPicker)

  function handleSkillInstallJob(job: SkillMarketplaceInstallJob): void {
    if (workPacks) {
      const index = workPacks.jobs.findIndex(candidate => candidate.id === job.id)
      if (index >= 0) workPacks.jobs[index] = job
      else workPacks.jobs.unshift(job)
    }
    if (['failed', 'canceled'].includes(job.status)) workPackBusyId = ''
    if (isOpen() && section === 'workpacks') renderWorkPacks()
  }

  return { open, openModelPicker, openReasoningPicker, repositionComposerPicker, close, isOpen, handleSkillInstallJob }
}
