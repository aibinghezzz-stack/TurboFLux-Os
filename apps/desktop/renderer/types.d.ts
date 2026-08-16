import type {
  WorkbenchCommandDefinition,
  WorkbenchCommandId,
  WorkbenchCommandResult,
  WorkbenchDraftSnapshot,
  WorkbenchFileReference,
  WorkbenchGitActionResult,
  WorkbenchGitDiffResult,
  WorkbenchMemoryCreateInput,
  WorkbenchMemoryFilters,
  WorkbenchMemorySnapshot,
  WorkbenchMemoryUpdateInput,
  WorkbenchSkillMarketplaceInstallResult,
  SkillMarketplaceInstallJob,
  WorkbenchSkillMarketplaceSnapshot,
  WorkbenchWorkPackSnapshot,
  WorkbenchSettingsSnapshot,
  WorkbenchSettingsUpdate,
  WorkbenchSubAgentActionResult,
  WorkbenchSubAgentDetail,
  WorkbenchWorkStepActionResult,
  WorkbenchSubmitResult,
  ProjectSnapshot,
  AutomationSnapshot,
  AutomationSchedule,
  AutomationUpdateInput,
  ArtifactSnapshot,
  WorkbenchArtifactPreview,
  PluginSnapshot,
  ConversationPersistenceHealth,
  AgentAttachment,
  AgentCapabilitySelection,
  AgentMode,
  BrowserBounds,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  ComputerPermissionKind,
  ComputerPermissionRequestResult,
  ComputerSystemEvent,
  ComputerSystemSnapshot,
} from '@turboflux/agent-core/workbench'
import type {
  DesktopWorkbenchConversationResult,
  DesktopWorkbenchEvent,
  DesktopWorkbenchSettingsSaveResult,
  DesktopWorkbenchSnapshot,
} from '../desktopTypes'

declare global {
  interface TurboFluxDesktopBridge {
    getSnapshot(): Promise<DesktopWorkbenchSnapshot>
    getSettings(forceModels?: boolean): Promise<WorkbenchSettingsSnapshot>
    saveSettings(update: WorkbenchSettingsUpdate): Promise<DesktopWorkbenchSettingsSaveResult>
    listCommands(): Promise<WorkbenchCommandDefinition[]>
    executeCommand(command: WorkbenchCommandId): Promise<WorkbenchCommandResult>
    submitPrompt(prompt: string, attachments?: AgentAttachment[], capabilities?: AgentCapabilitySelection): Promise<WorkbenchSubmitResult>
    resendFromTurn(turnId: string, prompt: string): Promise<WorkbenchSubmitResult>
    recordDraft(draft: WorkbenchDraftSnapshot | string): Promise<boolean>
    openExternal(url: string): Promise<boolean>
    browserGetState(): Promise<BrowserSystemSnapshot>
    browserShow(): Promise<BrowserSystemSnapshot>
    browserHide(): Promise<BrowserSystemSnapshot>
    browserNewTab(url?: string): Promise<BrowserSystemSnapshot>
    browserActivateTab(tabId: string): Promise<BrowserSystemSnapshot>
    browserCloseTab(tabId?: string): Promise<BrowserSystemSnapshot>
    browserNavigate(url: string, tabId?: string): Promise<BrowserSystemSnapshot>
    browserBack(tabId?: string): Promise<BrowserSystemSnapshot>
    browserForward(tabId?: string): Promise<BrowserSystemSnapshot>
    browserReload(tabId?: string): Promise<BrowserSystemSnapshot>
    browserSetBounds(bounds: BrowserBounds): Promise<BrowserSystemSnapshot>
    computerGetState(): Promise<ComputerSystemSnapshot>
    computerRefresh(): Promise<ComputerSystemSnapshot>
    computerRequestPermission(kind: ComputerPermissionKind): Promise<ComputerPermissionRequestResult>
    computerOpenPermissionSettings(kind: ComputerPermissionKind): Promise<boolean>
    computerRelaunch(): Promise<boolean>
    computerTakeControl(): Promise<ComputerSystemSnapshot>
    computerResumeControl(): Promise<ComputerSystemSnapshot>
    computerEmergencyStop(): Promise<ComputerSystemSnapshot>
    stop(): Promise<boolean>
    pause(): Promise<boolean>
    resume(): Promise<boolean>
    controlWorkStep(taskId: string, action: 'retry' | 'skip' | 'cancel' | 'resume'): Promise<WorkbenchWorkStepActionResult>
    resolveRequest(requestId: string, response: string): Promise<boolean>
    setMode(mode: AgentMode): Promise<DesktopWorkbenchSnapshot>
    newConversation(): Promise<DesktopWorkbenchConversationResult>
    newConversationInProject(id: string): Promise<DesktopWorkbenchConversationResult>
    switchConversation(id: string): Promise<DesktopWorkbenchConversationResult>
    deleteConversation(id: string): Promise<boolean>
    renameConversation(id: string, title: string): Promise<boolean>
    readSubAgent(taskId: string, offset?: number, limit?: number): Promise<WorkbenchSubAgentDetail>
    stopSubAgent(taskId: string): Promise<WorkbenchSubAgentActionResult>
    retrySubAgent(taskId: string): Promise<WorkbenchSubAgentActionResult>
    gitStage(paths: string[]): Promise<WorkbenchGitActionResult>
    gitUnstage(paths: string[]): Promise<WorkbenchGitActionResult>
    gitCommit(message: string, paths?: string[]): Promise<WorkbenchGitActionResult>
    gitCreateBranch(name: string, startPoint?: string): Promise<WorkbenchGitActionResult>
    gitSwitchBranch(name: string): Promise<WorkbenchGitActionResult>
    gitRestore(paths: string[], source?: string): Promise<WorkbenchGitActionResult>
    gitPush(remote?: string, branch?: string, setUpstream?: boolean): Promise<WorkbenchGitActionResult>
    gitDiff(path?: string, scope?: 'working' | 'staged' | 'all'): Promise<WorkbenchGitDiffResult>
    listProjects(): Promise<ProjectSnapshot>
    addProject(): Promise<ProjectSnapshot | null>
    updateProject(id: string, patch: { name?: string; pinned?: boolean; tags?: string[] }): Promise<ProjectSnapshot>
    removeProject(id: string): Promise<ProjectSnapshot>
    openProject(id: string): Promise<DesktopWorkbenchSnapshot>
    revealProject(id: string): Promise<boolean>
    listAutomations(): Promise<AutomationSnapshot>
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
    }): Promise<AutomationSnapshot>
    updateAutomation(id: string, patch: AutomationUpdateInput): Promise<AutomationSnapshot>
    removeAutomation(id: string): Promise<AutomationSnapshot>
    duplicateAutomation(id: string): Promise<AutomationSnapshot>
    runAutomation(id: string): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    retryAutomationRun(id: string, runId: string): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    cancelAutomationRun(id: string): Promise<AutomationSnapshot>
    listArtifacts(): Promise<ArtifactSnapshot>
    previewArtifact(id: string, purpose?: 'thumbnail' | 'full'): Promise<WorkbenchArtifactPreview>
    previewImageAttachment(path: string, purpose?: 'thumbnail' | 'full'): Promise<{ mode: 'image'; dataUrl: string; path: string; filename: string; mime: string; size: number }>
    openArtifact(id: string): Promise<boolean>
    revealArtifact(id: string): Promise<boolean>
    exportArtifact(id: string): Promise<string | null>
    exportImageAttachment(path: string): Promise<string | null>
    removeArtifact(id: string): Promise<ArtifactSnapshot>
    listPlugins(): Promise<PluginSnapshot>
    installPlugin(): Promise<PluginSnapshot | null>
    installMarketplacePlugin(id: string): Promise<PluginSnapshot>
    setPluginEnabled(id: string, enabled: boolean): Promise<PluginSnapshot>
    uninstallPlugin(id: string): Promise<PluginSnapshot>
    retryPersistence(): Promise<ConversationPersistenceHealth>
    exportRecovery(): Promise<string | null>
    activateSkill(skillId: string): Promise<WorkbenchSnapshot>
    deactivateSkill(): Promise<WorkbenchSnapshot>
    reloadSkills(): Promise<WorkbenchSnapshot>
    listSkillMarketplace(): Promise<WorkbenchSkillMarketplaceSnapshot>
    installMarketplaceSkill(marketplaceId: string, allowOverwrite?: boolean): Promise<WorkbenchSkillMarketplaceInstallResult>
    cancelMarketplaceSkillInstall(marketplaceId: string): Promise<SkillMarketplaceInstallJob | undefined>
    uninstallMarketplaceSkill(marketplaceId: string): Promise<WorkbenchSkillMarketplaceInstallResult>
    listWorkPacks(): Promise<WorkbenchWorkPackSnapshot>
    installWorkPack(workPackId: string, allowOverwrite?: boolean): Promise<WorkbenchWorkPackSnapshot | null>
    cancelWorkPackInstall(workPackId: string): Promise<SkillMarketplaceInstallJob | undefined>
    setWorkPackEnabled(workPackId: string, enabled: boolean): Promise<WorkbenchWorkPackSnapshot>
    uninstallWorkPack(workPackId: string): Promise<WorkbenchWorkPackSnapshot>
    reconnectMcp(name: string): Promise<WorkbenchSettingsSnapshot>
    acknowledgeNotification(id: string): Promise<boolean>
    listMemories(filters?: WorkbenchMemoryFilters, forceReload?: boolean): Promise<WorkbenchMemorySnapshot>
    rememberMemory(input: WorkbenchMemoryCreateInput): Promise<WorkbenchMemorySnapshot>
    updateMemory(id: string, update: WorkbenchMemoryUpdateInput): Promise<WorkbenchMemorySnapshot>
    forgetMemory(id: string, reason?: string): Promise<WorkbenchMemorySnapshot>
    chooseFiles(): Promise<WorkbenchFileReference[]>
    importFiles(paths: string[]): Promise<WorkbenchFileReference[]>
    importClipboardImage(base64: string, mime: string, filename?: string): Promise<WorkbenchFileReference>
    chooseSkill(): Promise<WorkbenchSnapshot | null>
    pathForFile(file: File): string
    chooseWorkspace(): Promise<DesktopWorkbenchSnapshot | null>
    onRuntimeEvent(listener: (event: DesktopWorkbenchEvent) => void): void
    onBrowserEvent(listener: (event: BrowserSystemEvent) => void): void
    onComputerEvent(listener: (event: ComputerSystemEvent) => void): void
  }

  interface Window {
    turbofluxDesktop?: TurboFluxDesktopBridge
  }
}
