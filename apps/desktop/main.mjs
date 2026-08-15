import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, Menu, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const devUrl = process.env.TURBOFLUX_DESKTOP_URL
const desktopDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(desktopDirectory, '..', '..')
const rendererEntryPath = app.isPackaged
  ? join(process.resourcesPath, 'renderer', 'index.html')
  : join(repositoryRoot, 'dist-desktop', 'renderer', 'index.html')
const productIconPath = app.isPackaged
  ? join(process.resourcesPath, 'renderer', 'assets', 'turboflux-mark-VUo_7eDU.png')
  : join(repositoryRoot, 'apps', 'website', 'public', 'turboflux-app-icon.png')

app.setName('TurboFlux')

if (app.isPackaged) {
  const esbuildPackage = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
  const esbuildBinary = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', esbuildPackage, 'bin', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild')
  if (existsSync(esbuildBinary)) process.env.ESBUILD_BINARY_PATH = esbuildBinary
}
let mainWindow
let runtimeHost
let runtimeHostPromise
let runtimeHostGeneration = 0
let runtimeHostResetPromise = Promise.resolve()
let unsubscribeRuntime
const browserSystems = new Map()
const computerSystems = new Map()
let activeConversationId = null
let browserSystem
let computerSystem
let computerLeaseOwnerId = null
let computerActivityOverlay
const COMPUTER_APPROVAL_RESTORE_TOOLS = new Set([
  'computer__click',
  'computer__double_click',
  'computer__move',
  'computer__drag',
  'computer__scroll',
  'computer__type_text',
  'computer__press',
])

function isTrustedWorkbenchUrl(value) {
  try {
    const actual = new URL(value)
    if (devUrl) return actual.origin === new URL(devUrl).origin
    return actual.protocol === 'file:' && fileURLToPath(actual) === rendererEntryPath
  } catch {
    return false
  }
}

function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Rejected IPC request from an untrusted window')
  }
  const frameUrl = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedWorkbenchUrl(frameUrl)) throw new Error('Rejected IPC request from an untrusted frame')
}

const ipcMain = {
  handle(channel, listener) {
    electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event)
      return listener(event, ...args)
    })
  },
}

electronIpcMain.handle('desktop:computer-overlay-action', async (event, action, payload) => {
  if (!computerActivityOverlay?.ownsWebContents(event.sender)) throw new Error('Rejected Computer overlay action from an untrusted window')
  return handleComputerOverlayAction(action, payload)
})

const { DesktopRuntimeHost } = await tsImport('./runtimeHost.ts', import.meta.url)
const { BrowserSystem } = await tsImport('./browser/browserSystem.ts', import.meta.url)
const { ComputerSystem } = await tsImport('./computer/computerSystem.ts', import.meta.url)
const { ComputerActivityOverlay } = await tsImport('./computer/computerActivityOverlay.ts', import.meta.url)


async function getInstallationId() {
  if (!installationIdPromise) {
    installationIdPromise = (async () => {
      const directory = app.getPath('userData')
      const filePath = join(directory, 'installation-id')
      try {
        const existing = (await readFile(filePath, 'utf8')).trim()
        if (existing) return existing
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Failed to read installation ID:', error)
      }
      const created = randomUUID()
      await mkdir(directory, { recursive: true })
      await writeFile(filePath, `${created}\n`, { encoding: 'utf8', mode: 0o600 })
      return created
    })()
  }
  return installationIdPromise
}

function broadcastRuntimeEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:runtime-event', event)
}

function broadcastBrowserEvent(conversationId, event) {
  if (event?.type === 'artifact-ready' && event.path) {
    const source = event.kind === 'download' ? 'browser-download' : 'browser'
    void getRuntimeHost().then(host => host.registerArtifact(event.path, source, {
      name: event.name,
      mime: event.mime,
      conversationId,
      metadata: {
        browserTabId: event.tabId || '',
        browserTitle: event.title || '',
        browserUrl: event.url || '',
      },
    })).catch(error => {
      console.error('Failed to register browser artifact:', error)
    })
  }
  if (conversationId === activeConversationId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:browser-event', event)
  }
}

function broadcastComputerEvent(conversationId, event) {
  if (event?.type === 'artifact-ready' && event.path) {
    void getRuntimeHost().then(host => host.registerArtifact(event.path, 'agent', {
      name: event.name,
      mime: event.mime,
      conversationId,
      metadata: {
        visualSource: 'computer',
        capturedAt: event.capturedAt || Date.now(),
        observationId: event.observationId || '',
        computerAppName: event.appName || '',
        computerWindowTitle: event.windowTitle || '',
      },
    })).catch(error => {
      console.error('Failed to register computer visual evidence:', error)
    })
  }
  const system = computerSystems.get(conversationId)
  if (conversationId !== activeConversationId || !system) return
  if (computerActivityOverlay) computerActivityOverlay.handleEvent(event, system.getSnapshot())
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:computer-event', event)
}

function syncComputerActivityOverlay(snapshot = runtimeHost?.getSnapshot()) {
  if (!computerActivityOverlay || !computerSystem) return
  const computerSnapshot = computerSystem.getSnapshot()
  const active = computerSnapshot.sessionActive || computerSnapshot.handoffActive
  const request = active
    ? snapshot?.runtime?.pendingRequests?.find(candidate => candidate.kind === 'permission')
    : undefined
  computerActivityOverlay.sync(computerSnapshot, request ? {
    id: request.id,
    kind: 'permission',
    question: request.question,
    reason: request.reason,
    toolName: request.toolName,
    options: Array.isArray(request.options) ? request.options : [],
  } : null)
}

function handleRuntimeEvent(event) {
  const conversationId = event?.conversationId
    || event?.snapshot?.conversation?.id
    || activeConversationId
  const taskFinished = event?.type === 'runtime-error'
    || event?.type === 'conversation-run'
    || (event?.type === 'agent' && ['session:complete', 'error'].includes(event.event?.type))
  if (taskFinished && conversationId) {
    const browser = browserSystems.get(conversationId)
    const computer = computerSystems.get(conversationId)
    if (browser) void browser.finishTask().catch(error => console.error('Failed to clear Browser task data:', error))
    if (computer) void computer.finishTask().catch(error => console.error('Failed to clear Computer task data:', error))
  }
  if (event?.type === 'snapshot' && event.snapshot?.conversation?.id) {
    activateConversationSystems(event.snapshot.conversation.id)
  }
  if (
    (!conversationId || conversationId === activeConversationId)
    && (event?.type === 'snapshot' || taskFinished)
  ) {
    syncComputerActivityOverlay(event?.type === 'snapshot' ? event.snapshot : undefined)
  }
  broadcastRuntimeEvent(event)
}

function ensureConversationSystems(conversationId) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Workbench window is not ready')
  let browser = browserSystems.get(conversationId)
  if (!browser) {
    browser = new BrowserSystem(mainWindow, process.cwd(), event => broadcastBrowserEvent(conversationId, event), conversationId)
    browser.setPresentationEnabled(conversationId === activeConversationId)
    browserSystems.set(conversationId, browser)
  }
  let computer = computerSystems.get(conversationId)
  if (!computer) {
    computer = new ComputerSystem(mainWindow, process.cwd(), event => broadcastComputerEvent(conversationId, event), undefined, {
      pauseRuntime: () => runtimeHost?.pauseConversation(conversationId),
      requestPermission: kind => requestComputerPermissionForAgent(computer, kind),
      beforeVisualCapture: () => conversationId === activeConversationId ? computerActivityOverlay?.suspendForCapture() : undefined,
      afterVisualCapture: () => conversationId === activeConversationId ? computerActivityOverlay?.resumeAfterCapture() : undefined,
      acquireControl: () => {
        if (computerLeaseOwnerId && computerLeaseOwnerId !== conversationId) return false
        computerLeaseOwnerId = conversationId
        return true
      },
      releaseControl: () => {
        if (computerLeaseOwnerId === conversationId) computerLeaseOwnerId = null
      },
    })
    computerSystems.set(conversationId, computer)
  }
  return { browser, computer }
}

function activateConversationSystems(conversationId) {
  if (!conversationId || !mainWindow || mainWindow.isDestroyed()) return
  if (activeConversationId && activeConversationId !== conversationId) {
    browserSystems.get(activeConversationId)?.setPresentationEnabled(false)
  }
  activeConversationId = conversationId
  const systems = ensureConversationSystems(conversationId)
  browserSystem = systems.browser
  computerSystem = systems.computer
  browserSystem.setPresentationEnabled(true)
  computerActivityOverlay?.refresh(computerSystem.getSnapshot())
  syncComputerActivityOverlay()
}

function destroyConversationSystems(conversationId) {
  browserSystems.get(conversationId)?.destroy()
  browserSystems.delete(conversationId)
  computerSystems.get(conversationId)?.destroy()
  computerSystems.delete(conversationId)
  if (computerLeaseOwnerId === conversationId) computerLeaseOwnerId = null
  if (activeConversationId === conversationId) {
    activeConversationId = null
    browserSystem = null
    computerSystem = null
  }
}

function destroyAllConversationSystems() {
  for (const browser of browserSystems.values()) browser.destroy()
  for (const computer of computerSystems.values()) computer.destroy()
  browserSystems.clear()
  computerSystems.clear()
  activeConversationId = null
  browserSystem = null
  computerSystem = null
  computerLeaseOwnerId = null
}

function reconcileConversationSystems(snapshot) {
  const validConversationIds = new Set(snapshot.conversationRuntimes.map(runtime => runtime.conversationId))
  for (const conversationId of new Set([...browserSystems.keys(), ...computerSystems.keys()])) {
    if (!validConversationIds.has(conversationId)) destroyConversationSystems(conversationId)
  }
  for (const conversationId of validConversationIds) {
    const systems = ensureConversationSystems(conversationId)
    systems.browser.setWorkspacePath(snapshot.workspace.path)
    systems.computer.setWorkspacePath(snapshot.workspace.path)
  }
  activateConversationSystems(snapshot.conversation.id)
}

function registerSystemPlugins(client, context) {
  const systems = ensureConversationSystems(context.conversationId)
  systems.computer.register(client)
}

function unscopedWorkspacePath() {
  return join(app.getPath('userData'), 'workspace', 'unscoped')
}

async function getRuntimeHost() {
  while (true) {
    await runtimeHostResetPromise
    if (runtimeHost) return runtimeHost
    if (!runtimeHostPromise) {
      const generation = runtimeHostGeneration
      const pending = mkdir(unscopedWorkspacePath(), { recursive: true })
        .then(() => DesktopRuntimeHost.create(unscopedWorkspacePath(), {
          registerSystemPlugins,
          storagePath: join(app.getPath('userData'), 'platform'),
          unscopedWorkspacePath: unscopedWorkspacePath(),
        }))
        .then(async host => {
          if (generation !== runtimeHostGeneration) {
            await host.destroy()
            throw new Error('Desktop runtime initialization was superseded')
          }
          runtimeHost = host
          unsubscribeRuntime = host.subscribe(handleRuntimeEvent)
          const snapshot = host.getSnapshot()
          reconcileConversationSystems(snapshot)
          return host
        })
        .catch(error => {
          if (runtimeHostPromise === pending) runtimeHostPromise = null
          throw error
        })
      runtimeHostPromise = pending
    }
    const generation = runtimeHostGeneration
    const pending = runtimeHostPromise
    try {
      const host = await pending
      if (generation !== runtimeHostGeneration) continue
      return host
    } catch (error) {
      if (generation !== runtimeHostGeneration) continue
      throw error
    }
  }
}

async function startNewConversation() {
  const host = await getRuntimeHost()
  try {
    return await host.newConversation()
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区',
    buttonLabel: '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  const workspacePath = result.canceled ? null : result.filePaths[0] || null
  if (!workspacePath) return null
  const host = await getRuntimeHost()
  try {
    return await host.setWorkspace(workspacePath)
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
}


function resetRuntimeHost() {
  const reset = runtimeHostResetPromise.catch(() => undefined).then(async () => {
    runtimeHostGeneration += 1
    const current = runtimeHost
    const pending = runtimeHostPromise
    runtimeHost = null
    runtimeHostPromise = null
    unsubscribeRuntime?.()
    unsubscribeRuntime = null
    if (current) await current.destroy()
    else if (pending) await pending.catch(() => undefined)
    destroyAllConversationSystems()
  })
  runtimeHostResetPromise = reset
  return reset
}

function assertRuntimeResetAllowed() {
  if (!runtimeHost) return
  const blocker = runtimeHost.transitionBlocker()
  if (blocker) throw new Error(blocker)
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function requireTextArray(value, name, max = 200) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`${name} must contain 1-${max} items`)
  return value.map((item, index) => requireText(item, `${name}[${index}]`))
}

function mimeForPath(filePath) {
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
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })[extension] || 'application/octet-stream'
}

async function normalizeAttachments(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const normalized = []
  const host = await getRuntimeHost()
  const attachmentRoot = await realpath(resolve(host.getSnapshot().workspace.path, '.turboflux', 'attachments'))
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') continue
    const attachmentPath = await realpath(resolve(item.path))
    const attachmentRelativePath = relative(attachmentRoot, attachmentPath)
    if (!attachmentRelativePath || attachmentRelativePath === '..' || attachmentRelativePath.startsWith('../') || isAbsolute(attachmentRelativePath)) {
      throw new Error(`Attachment is outside the TurboFlux attachment store: ${item.path}`)
    }
    const info = await stat(attachmentPath)
    if (!info.isFile() || info.size === 0 || info.size > 50 * 1024 * 1024) {
      throw new Error(`Attachment must be a non-empty file up to 50 MB: ${item.path}`)
    }
    const mime = mimeForPath(attachmentPath)
    normalized.push({
      id: typeof item.id === 'string' && item.id ? item.id : `desktop-image-${Date.now()}-${normalized.length}`,
      type: mime.startsWith('image/') ? 'image' : 'file',
      path: attachmentPath,
      filename: attachmentPath.split(/[\\/]/).at(-1) || attachmentPath,
      mime,
      size: info.size,
    })
  }
  return normalized.length > 0 ? normalized : undefined
}

function normalizeCapabilities(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return undefined
  const items = []
  const seen = new Set()
  for (const item of value.items.slice(0, 16)) {
    if (!item || typeof item !== 'object' || !['skill', 'mcp'].includes(item.type)) continue
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : ''
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
    const key = `${item.type}:${id}`
    if (!id || !name || seen.has(key)) continue
    seen.add(key)
    items.push({ type: item.type, id, name })
  }
  return items.length > 0 ? { items } : undefined
}

function createWindow() {
  destroyAllConversationSystems()
  computerActivityOverlay?.destroy()
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: 'TurboFlux',
    icon: productIconPath,
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopDirectory, 'preload.cjs'),
    },
  })
  const workbenchWindow = mainWindow

  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadURL(pathToFileURL(rendererEntryPath).href)
  }
  computerActivityOverlay = new ComputerActivityOverlay(mainWindow)
  const guardWorkbenchNavigation = (event, url) => {
    if (isTrustedWorkbenchUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardWorkbenchNavigation)
  mainWindow.webContents.on('will-redirect', guardWorkbenchNavigation)
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  mainWindow.on('focus', () => {
    void computerSystem?.refresh().catch(error => console.error('Failed to refresh Computer permissions:', error))
    if (computerSystem) computerActivityOverlay?.refresh(computerSystem.getSnapshot())
  })
  mainWindow.on('blur', () => {
    if (computerSystem) computerActivityOverlay?.refresh(computerSystem.getSnapshot())
  })
  mainWindow.on('closed', () => {
    if (mainWindow !== workbenchWindow) return
    destroyAllConversationSystems()
    computerActivityOverlay?.destroy()
    computerActivityOverlay = null
    mainWindow = null
  })
  runtimeHost?.setSystemPluginRegistrar(registerSystemPlugins)
}

function requireBrowserSystem() {
  if (!browserSystem) throw new Error('Browser system is not ready')
  return browserSystem
}

function requireComputerSystem() {
  if (!computerSystem) throw new Error('Computer system is not ready')
  return computerSystem
}

const COMPUTER_PERMISSION_GUIDES = {
  'screen-recording': {
    title: '屏幕录制',
    message: '允许 TurboFlux 查看目标应用',
    detail: '接下来 macOS 会申请“屏幕与系统音频录制”权限。TurboFlux 只会在电脑操控任务中读取目标应用窗口，并自动遮挡自身窗口。',
    settingsLabel: '屏幕与系统音频录制',
  },
  accessibility: {
    title: '辅助功能',
    message: '允许 TurboFlux 理解并操作应用控件',
    detail: '接下来 macOS 会申请“辅助功能”权限，用于识别按钮、输入框并优先执行语义操作。密码、验证码和系统授权始终由你接管。',
    settingsLabel: '辅助功能',
  },
  'post-event': {
    title: '输入控制',
    message: '允许 TurboFlux 执行点击与输入',
    detail: '接下来 macOS 会申请本机输入控制权限。TurboFlux 只会对刚刚观察并核验过的目标应用执行动作。',
    settingsLabel: '辅助功能',
  },
}

function computerPermissionStatus(snapshot, kind) {
  if (kind === 'screen-recording') return snapshot.permissions.screenRecording
  if (kind === 'accessibility') return snapshot.permissions.accessibility
  if (kind === 'post-event') return snapshot.permissions.postEvent
  throw new Error(`Unknown computer permission: ${kind}`)
}

function computerPermissionGuide(kind) {
  const guide = COMPUTER_PERMISSION_GUIDES[kind]
  if (!guide) throw new Error(`Unknown computer permission: ${kind}`)
  return guide
}

function computerPermissionIdentity(kind) {
  if (kind === 'screen-recording') return app.isPackaged ? 'TurboFlux' : 'Electron'
  return app.isPackaged
    ? 'TurboFlux Computer Helper（系统也可能显示 TurboFluxComputerHelper）'
    : 'TurboFluxComputerHelper'
}

async function requestComputerPermission(system, kind) {
  const guide = computerPermissionGuide(kind)
  const current = system.getSnapshot()
  if (computerPermissionStatus(current, kind).state === 'granted') {
    return { kind, outcome: 'granted', snapshot: current }
  }
  const identityHint = `在系统列表中允许“${computerPermissionIdentity(kind)}”。`
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: guide.message,
    detail: `${guide.detail}\n\n${identityHint}`,
    buttons: ['继续申请', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return { kind, outcome: 'cancelled', snapshot: current }
  const snapshot = await system.requestPermission(kind)
  return {
    kind,
    outcome: computerPermissionStatus(snapshot, kind).state === 'granted' ? 'granted' : 'needs-settings',
    snapshot,
  }
}

async function openComputerPermissionSettings(system, kind) {
  const guide = computerPermissionGuide(kind)
  const identityHint = `请在列表中开启“${computerPermissionIdentity(kind)}”。`
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: `在 macOS“${guide.settingsLabel}”中完成授权`,
    detail: `${identityHint}\n完成后回到 TurboFlux，权限状态会自动重新检查。若 macOS 提示需要重新打开应用，请按系统提示操作。`,
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return false
  await system.openPermissionSettings(kind)
  return true
}

async function requestComputerPermissionForAgent(system, kind) {
  const first = await requestComputerPermission(system, kind)
  if (first.outcome === 'granted') return true
  if (first.outcome === 'cancelled') return false
  const guide = computerPermissionGuide(kind)
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: `请在 macOS 中开启“${guide.settingsLabel}”权限`,
    detail: `${guide.detail}\n\n授权后回到 TurboFlux，点击“已完成，继续”，当前 Agent 步骤会自动继续。`,
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return false
  await system.openPermissionSettings(kind)
  const completed = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '等待权限生效',
    message: '授权完成后返回 TurboFlux',
    detail: '点击“继续”重新检查权限；如果 macOS 要求重新打开应用，请按系统提示处理。',
    buttons: ['已完成，继续', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (completed.response !== 0) return false
  const refreshed = await system.refresh()
  return computerPermissionStatus(refreshed, kind).state === 'granted'
}

ipcMain.handle('desktop:get-snapshot', async () => (await getRuntimeHost()).getSnapshot())
ipcMain.handle('desktop:get-settings', async (_event, forceModels) => (
  (await getRuntimeHost()).getSettings(forceModels === true)
))
ipcMain.handle('desktop:save-settings', async (_event, update) => (
  (async () => {
    try {
      return await (await getRuntimeHost()).saveSettings(update)
    } finally {
      if (runtimeHost) reconcileConversationSystems(runtimeHost.getSnapshot())
    }
  })()
))
ipcMain.handle('desktop:list-commands', async () => (await getRuntimeHost()).listCommands())
ipcMain.handle('desktop:execute-command', async (_event, command) => {
  const commandId = requireText(command, 'command')
  if (commandId === 'flow.export') {
    const result = await dialog.showSaveDialog({
      title: '导出 TurboFlux 恢复包',
      defaultPath: `turboflux-recovery-${Date.now()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { message: '已取消导出' }
    const path = (await getRuntimeHost()).exportRecoveryBundle(result.filePath)
    return { message: `恢复包已导出：${path}` }
  }
  return (await getRuntimeHost()).executeCommand(commandId)
})
ipcMain.handle('desktop:submit-prompt', async (_event, prompt, attachments, capabilities) => (
  (await getRuntimeHost()).submitPrompt(requireText(prompt, 'prompt'), await normalizeAttachments(attachments), normalizeCapabilities(capabilities))
))
ipcMain.handle('desktop:resend-from-turn', async (_event, turnId, prompt) => (
  (await getRuntimeHost()).resendFromTurn(requireText(turnId, 'turnId'), requireText(prompt, 'prompt'))
))
ipcMain.handle('desktop:record-draft', async (_event, draft) => (await getRuntimeHost()).recordDraft(draft && typeof draft === 'object' ? draft : typeof draft === 'string' ? draft : ''))
ipcMain.handle('desktop:open-external', async (_event, value) => {
  const target = requireText(value, 'url')
  const parsed = new URL(target)
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
  await shell.openExternal(parsed.href)
  return true
})
ipcMain.handle('desktop:browser-get-state', async () => {
  await getRuntimeHost()
  return requireBrowserSystem().getSnapshot()
})
ipcMain.handle('desktop:browser-show', () => requireBrowserSystem().show())
ipcMain.handle('desktop:browser-hide', () => requireBrowserSystem().hide())
ipcMain.handle('desktop:browser-new-tab', async (_event, url) => requireBrowserSystem().createTab(typeof url === 'string' ? url : 'about:blank'))
ipcMain.handle('desktop:browser-activate-tab', (_event, tabId) => requireBrowserSystem().activateTab(requireText(tabId, 'tabId')))
ipcMain.handle('desktop:browser-close-tab', async (_event, tabId) => requireBrowserSystem().closeTab(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-navigate', async (_event, url, tabId) => requireBrowserSystem().navigate(requireText(url, 'url'), typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-back', (_event, tabId) => requireBrowserSystem().goBack(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-forward', (_event, tabId) => requireBrowserSystem().goForward(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-reload', (_event, tabId) => requireBrowserSystem().reload(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-set-bounds', (_event, bounds) => {
  if (!bounds || typeof bounds !== 'object') throw new Error('Invalid browser bounds')
  return requireBrowserSystem().setBounds({
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Number(bounds.width) || 0,
    height: Number(bounds.height) || 0,
  })
})

async function takeComputerControl() {
  const conversationId = computerLeaseOwnerId || activeConversationId
  const system = conversationId ? computerSystems.get(conversationId) || requireComputerSystem() : requireComputerSystem()
  const snapshot = system.takeControl()
  if (conversationId) {
    browserSystems.get(conversationId)?.pauseForRuntime()
    await (await getRuntimeHost()).pauseConversation(conversationId)
  }
  syncComputerActivityOverlay()
  return snapshot
}

async function resumeComputerControl() {
  const conversationId = computerLeaseOwnerId || activeConversationId
  const system = conversationId ? computerSystems.get(conversationId) || requireComputerSystem() : requireComputerSystem()
  const snapshot = system.resumeControl()
  if (conversationId) {
    browserSystems.get(conversationId)?.resumeForRuntime()
    await (await getRuntimeHost()).resumeConversation(conversationId)
  }
  syncComputerActivityOverlay()
  return snapshot
}

async function emergencyStopComputerControl() {
  const host = await getRuntimeHost()
  const browsers = [...browserSystems.values()]
  const systems = [...computerSystems.values()]
  for (const browser of browsers) browser.pauseForRuntime()
  for (const system of systems) system.emergencyStop()
  for (const runtime of host.getSnapshot().conversationRuntimes) host.stopConversation(runtime.conversationId)
  await Promise.all([
    ...browsers.map(browser => browser.finishTask()),
    ...systems.map(system => system.finishTask()),
  ])
  syncComputerActivityOverlay()
  return requireComputerSystem().getSnapshot()
}

async function resolveRuntimeRequest(requestId, response) {
  const host = await getRuntimeHost()
  const request = host.getSnapshot().runtime.pendingRequests.find(candidate => candidate.id === requestId)
  if (!request) return false
  if (request.kind === 'permission' && COMPUTER_APPROVAL_RESTORE_TOOLS.has(request.toolName || '') && response !== 'deny') {
    await requireComputerSystem().restoreObservedTargetAfterApproval()
  }
  const resolved = host.resolveRequest(requestId, response)
  syncComputerActivityOverlay(host.getSnapshot())
  return resolved
}

async function handleComputerOverlayAction(action, payload) {
  if (action === 'take-control') return takeComputerControl()
  if (action === 'resume-control') return resumeComputerControl()
  if (action === 'stop-control') return emergencyStopComputerControl()
  if (action === 'resolve-approval') {
    const requestId = requireText(payload?.requestId, 'requestId')
    const response = requireText(payload?.response, 'response')
    return resolveRuntimeRequest(requestId, response)
  }
  throw new Error(`Unsupported Computer overlay action: ${String(action)}`)
}

ipcMain.handle('desktop:computer-get-state', async () => {
  await getRuntimeHost()
  return requireComputerSystem().getSnapshot()
})
ipcMain.handle('desktop:computer-refresh', async () => {
  await getRuntimeHost()
  return requireComputerSystem().refresh()
})
ipcMain.handle('desktop:computer-request-permission', (_event, kind) => requestComputerPermission(requireComputerSystem(), requireText(kind, 'permission')))
ipcMain.handle('desktop:computer-open-permission-settings', (_event, kind) => openComputerPermissionSettings(requireComputerSystem(), requireText(kind, 'permission')))
ipcMain.handle('desktop:computer-take-control', () => takeComputerControl())
ipcMain.handle('desktop:computer-resume-control', () => resumeComputerControl())
ipcMain.handle('desktop:computer-emergency-stop', () => emergencyStopComputerControl())
ipcMain.handle('desktop:stop', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const stopped = host.stopConversation(conversationId)
  if (browserSystem) await browserSystem.finishTask()
  if (computerSystem) await computerSystem.finishTask()
  return stopped
})
ipcMain.handle('desktop:pause', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const paused = host.pauseConversation(conversationId)
  browserSystems.get(conversationId)?.pauseForRuntime()
  computerSystems.get(conversationId)?.pauseForRuntime()
  return paused
})
ipcMain.handle('desktop:resume', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const resumed = host.resumeConversation(conversationId)
  if (resumed) {
    browserSystems.get(conversationId)?.resumeForRuntime()
    computerSystems.get(conversationId)?.resumeForRuntime()
  }
  return resumed
})
ipcMain.handle('desktop:control-work-step', async (_event, taskId, action) => {
  const allowed = new Set(['retry', 'skip', 'cancel', 'resume'])
  if (!allowed.has(action)) throw new Error(`Unsupported work step action: ${String(action)}`)
  return (await getRuntimeHost()).controlWorkStep(requireText(taskId, 'taskId'), action)
})
ipcMain.handle('desktop:resolve-request', async (_event, requestId, response) => (
  resolveRuntimeRequest(requireText(requestId, 'requestId'), requireText(response, 'response'))
))
ipcMain.handle('desktop:set-mode', async (_event, mode) => {
  if (mode !== 'vibe' && mode !== 'plan') throw new Error(`Unsupported mode: ${String(mode)}`)
  return (await getRuntimeHost()).setMode(mode)
})
ipcMain.handle('desktop:new-conversation', async () => {
  return startNewConversation()
})
ipcMain.handle('desktop:new-project-conversation', async (_event, id) => {
  const host = await getRuntimeHost()
  try {
    const result = await host.newConversationInProject(requireText(id, 'projectId'))
    activateConversationSystems(result.id)
    return result
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
})
ipcMain.handle('desktop:switch-conversation', async (_event, id) => {
  const result = await (await getRuntimeHost()).switchConversation(requireText(id, 'conversationId'))
  activateConversationSystems(result.id)
  return result
})
ipcMain.handle('desktop:delete-conversation', async (_event, id) => {
  const conversationId = requireText(id, 'conversationId')
  const host = await getRuntimeHost()
  const deleted = await host.deleteConversation(conversationId)
  if (deleted) destroyConversationSystems(conversationId)
  const snapshot = host.getSnapshot()
  activateConversationSystems(snapshot.conversation.id)
  return deleted
})
ipcMain.handle('desktop:rename-conversation', async (_event, id, title) => (
  (await getRuntimeHost()).renameConversation(requireText(id, 'conversationId'), requireText(title, 'title'))
))
ipcMain.handle('desktop:read-subagent', async (_event, taskId, offset, limit) => (
  (await getRuntimeHost()).readSubAgent(
    requireText(taskId, 'taskId'),
    Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : undefined,
    Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : undefined,
  )
))
ipcMain.handle('desktop:stop-subagent', async (_event, taskId) => (
  (await getRuntimeHost()).stopSubAgent(requireText(taskId, 'taskId'))
))
ipcMain.handle('desktop:retry-subagent', async (_event, taskId) => (
  (await getRuntimeHost()).retrySubAgent(requireText(taskId, 'taskId'))
))
ipcMain.handle('desktop:git-stage', async (_event, paths) => (
  (await getRuntimeHost()).stageGit(requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-unstage', async (_event, paths) => (
  (await getRuntimeHost()).unstageGit(requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-commit', async (_event, message, paths) => (
  (await getRuntimeHost()).commitGit(requireText(message, 'message'), paths === undefined ? undefined : requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-create-branch', async (_event, name, startPoint) => (
  (await getRuntimeHost()).createGitBranch(requireText(name, 'name'), typeof startPoint === 'string' && startPoint.trim() ? startPoint.trim() : undefined)
))
ipcMain.handle('desktop:git-switch-branch', async (_event, name) => (
  (await getRuntimeHost()).switchGitBranch(requireText(name, 'name'))
))
ipcMain.handle('desktop:git-restore', async (_event, paths, source) => (
  (await getRuntimeHost()).restoreGit(requireTextArray(paths, 'paths'), typeof source === 'string' && source.trim() ? source.trim() : undefined)
))
ipcMain.handle('desktop:git-push', async (_event, remote, branch, setUpstream) => (
  (await getRuntimeHost()).pushGit(
    typeof remote === 'string' && remote.trim() ? remote.trim() : undefined,
    typeof branch === 'string' && branch.trim() ? branch.trim() : undefined,
    setUpstream === true,
  )
))
ipcMain.handle('desktop:git-diff', async (_event, path, scope) => (
  (await getRuntimeHost()).readGitDiff(
    typeof path === 'string' && path.trim() ? path.trim() : undefined,
    ['working', 'staged', 'all'].includes(scope) ? scope : 'working',
  )
))
ipcMain.handle('desktop:list-projects', async () => (await getRuntimeHost()).listProjects())
ipcMain.handle('desktop:add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '添加项目文件夹', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return (await getRuntimeHost()).addProject(result.filePaths[0])
})
ipcMain.handle('desktop:update-project', async (_event, id, patch) => (
  (await getRuntimeHost()).updateProject(requireText(id, 'projectId'), patch && typeof patch === 'object' ? patch : {})
))
ipcMain.handle('desktop:remove-project', async (_event, id) => (
  (await getRuntimeHost()).removeProject(requireText(id, 'projectId'))
))
ipcMain.handle('desktop:open-project', async (_event, id) => {
  const host = await getRuntimeHost()
  try {
    return await host.openProject(requireText(id, 'projectId'))
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
})
ipcMain.handle('desktop:reveal-project', async (_event, id) => {
  const project = (await getRuntimeHost()).getProject(requireText(id, 'projectId'))
  if (!project?.available) throw new Error('Project folder is unavailable')
  shell.showItemInFolder(project.path)
  return true
})
ipcMain.handle('desktop:list-automations', async () => (await getRuntimeHost()).listAutomations())
ipcMain.handle('desktop:create-automation', async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('Invalid automation input')
  return (await getRuntimeHost()).createAutomation(input)
})
ipcMain.handle('desktop:update-automation', async (_event, id, patch) => (
  (await getRuntimeHost()).updateAutomation(requireText(id, 'automationId'), patch && typeof patch === 'object' ? patch : {})
))
ipcMain.handle('desktop:remove-automation', async (_event, id) => (
  (await getRuntimeHost()).removeAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:duplicate-automation', async (_event, id) => (
  (await getRuntimeHost()).duplicateAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:run-automation', async (_event, id) => (
  (await getRuntimeHost()).runAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:retry-automation-run', async (_event, id, runId) => (
  (await getRuntimeHost()).retryAutomationRun(requireText(id, 'automationId'), requireText(runId, 'automationRunId'))
))
ipcMain.handle('desktop:cancel-automation-run', async (_event, id) => (
  (await getRuntimeHost()).cancelAutomationRun(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:list-artifacts', async () => (await getRuntimeHost()).listArtifacts())
ipcMain.handle('desktop:preview-artifact', async (_event, id, purpose) => (
  (await getRuntimeHost()).previewArtifact(requireText(id, 'artifactId'), purpose === 'thumbnail' ? 'thumbnail' : 'full')
))
ipcMain.handle('desktop:preview-image-attachment', async (_event, filePath, purpose) => (
  (await getRuntimeHost()).previewImageAttachment(requireText(filePath, 'attachmentPath'), purpose === 'thumbnail' ? 'thumbnail' : 'full')
))
ipcMain.handle('desktop:open-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  const error = await shell.openPath(artifact.path)
  if (error) throw new Error(error)
  return true
})
ipcMain.handle('desktop:reveal-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  shell.showItemInFolder(artifact.path)
  return true
})
ipcMain.handle('desktop:export-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  const result = await dialog.showSaveDialog(mainWindow, { title: '导出产物', defaultPath: basename(artifact.path) })
  if (result.canceled || !result.filePath) return null
  await copyFile(artifact.path, result.filePath)
  return result.filePath
})
ipcMain.handle('desktop:export-image-attachment', async (_event, filePath) => {
  const attachment = await (await getRuntimeHost()).resolveImageAttachment(requireText(filePath, 'attachmentPath'))
  const result = await dialog.showSaveDialog(mainWindow, { title: '导出图片', defaultPath: attachment.filename })
  if (result.canceled || !result.filePath) return null
  await copyFile(attachment.path, result.filePath)
  return result.filePath
})
ipcMain.handle('desktop:remove-artifact', async (_event, id) => (
  (await getRuntimeHost()).removeArtifact(requireText(id, 'artifactId'))
))
ipcMain.handle('desktop:list-plugins', async () => (await getRuntimeHost()).listPlugins())
ipcMain.handle('desktop:install-plugin', async () => {
  const chosen = await dialog.showOpenDialog(mainWindow, { title: '选择 TurboFlux 插件文件夹', properties: ['openDirectory'] })
  if (chosen.canceled || !chosen.filePaths[0]) return null
  const host = await getRuntimeHost()
  const inspected = await host.inspectPlugin(chosen.filePaths[0])
  const permissions = inspected.manifest.permissions || []
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: permissions.length ? 'warning' : 'info',
    title: `安装 ${inspected.manifest.name}`,
    message: permissions.length ? '这个插件请求以下权限' : '这个插件不请求额外权限',
    detail: permissions.length
      ? `${permissions.join('\n')}\n\n代码插件会在独立沙箱进程中运行；无法可靠隔离的权限会阻止激活。`
      : '声明式插件不会执行代码。代码插件仍会在独立沙箱进程中运行。',
    buttons: ['取消', '安装'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (confirmation.response !== 1) return null
  return host.installPlugin(chosen.filePaths[0], permissions)
})
ipcMain.handle('desktop:install-marketplace-plugin', async (_event, id) => (
  (await getRuntimeHost()).installMarketplacePlugin(requireText(id, 'marketplacePluginId'))
))
ipcMain.handle('desktop:set-plugin-enabled', async (_event, id, enabled) => (
  (await getRuntimeHost()).setPluginEnabled(requireText(id, 'pluginId'), enabled === true)
))
ipcMain.handle('desktop:uninstall-plugin', async (_event, id) => (
  (await getRuntimeHost()).uninstallPlugin(requireText(id, 'pluginId'))
))
ipcMain.handle('desktop:retry-persistence', async () => (await getRuntimeHost()).retryPersistence())
ipcMain.handle('desktop:export-recovery', async () => {
  const result = await dialog.showSaveDialog({
    title: '导出 TurboFlux 恢复包',
    defaultPath: `turboflux-recovery-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return null
  return (await getRuntimeHost()).exportRecoveryBundle(result.filePath)
})
ipcMain.handle('desktop:activate-skill', async (_event, skillId) => (
  (await getRuntimeHost()).activateSkill(requireText(skillId, 'skillId'))
))
ipcMain.handle('desktop:deactivate-skill', async () => (await getRuntimeHost()).deactivateSkill())
ipcMain.handle('desktop:reload-skills', async () => (await getRuntimeHost()).reloadSkills())
ipcMain.handle('desktop:list-skill-marketplace', async () => (await getRuntimeHost()).listSkillMarketplace())
ipcMain.handle('desktop:install-marketplace-skill', async (_event, marketplaceId, allowOverwrite) => (
  (await getRuntimeHost()).installMarketplaceSkill(requireText(marketplaceId, 'marketplaceId'), allowOverwrite === true)
))
ipcMain.handle('desktop:cancel-marketplace-skill-install', async (_event, marketplaceId) => (
  (await getRuntimeHost()).cancelMarketplaceSkillInstall(requireText(marketplaceId, 'marketplaceId'))
))
ipcMain.handle('desktop:uninstall-marketplace-skill', async (_event, marketplaceId) => (
  (await getRuntimeHost()).uninstallMarketplaceSkill(requireText(marketplaceId, 'marketplaceId'))
))
ipcMain.handle('desktop:list-work-packs', async () => (await getRuntimeHost()).listWorkPacks())
ipcMain.handle('desktop:install-work-pack', async (_event, workPackId, allowOverwrite) => {
  const host = await getRuntimeHost()
  const id = requireText(workPackId, 'workPackId')
  const entry = host.listWorkPacks().entries.find(item => item.id === id)
  if (!entry) throw new Error(`Work Pack not found: ${id}`)
  const permissions = entry.permissions || []
  if (permissions.length) {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: `安装 ${entry.name}`,
      message: '这个 Work Pack 请求以下权限',
      detail: `${permissions.join('\n')}\n\n集成代码只会在独立沙箱进程中运行；未批准的权限不会生效。`,
      buttons: ['取消', '安装并授权'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (confirmation.response !== 1) return null
  }
  return host.installWorkPack(id, allowOverwrite === true, permissions)
})
ipcMain.handle('desktop:cancel-work-pack-install', async (_event, workPackId) => (
  (await getRuntimeHost()).cancelWorkPackInstall(requireText(workPackId, 'workPackId'))
))
ipcMain.handle('desktop:set-work-pack-enabled', async (_event, workPackId, enabled) => (
  (await getRuntimeHost()).setWorkPackEnabled(requireText(workPackId, 'workPackId'), enabled === true)
))
ipcMain.handle('desktop:uninstall-work-pack', async (_event, workPackId) => (
  (await getRuntimeHost()).uninstallWorkPack(requireText(workPackId, 'workPackId'))
))
ipcMain.handle('desktop:reconnect-mcp', async (_event, name) => (
  (await getRuntimeHost()).reconnectMcp(requireText(name, 'serverName'))
))
ipcMain.handle('desktop:acknowledge-notification', async (_event, id) => (
  (await getRuntimeHost()).acknowledgeNotification(requireText(id, 'notificationId'))
))
ipcMain.handle('desktop:list-memories', async (_event, filters, forceReload) => (
  (await getRuntimeHost()).listMemories(filters && typeof filters === 'object' ? filters : undefined, forceReload === true)
))
ipcMain.handle('desktop:remember-memory', async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('memory input must be an object')
  return (await getRuntimeHost()).rememberMemory({ ...input, text: requireText(input.text, 'memory text') })
})
ipcMain.handle('desktop:update-memory', async (_event, id, update) => {
  if (!update || typeof update !== 'object') throw new Error('memory update must be an object')
  return (await getRuntimeHost()).updateMemory(requireText(id, 'memory id'), update)
})
ipcMain.handle('desktop:forget-memory', async (_event, id, reason) => (
  (await getRuntimeHost()).forgetMemory(requireText(id, 'memory id'), typeof reason === 'string' ? reason.slice(0, 240) : undefined)
))
ipcMain.handle('desktop:choose-files', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Add files to this task',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled) return []
  return (await getRuntimeHost()).importFiles(result.filePaths)
})
ipcMain.handle('desktop:import-files', async (_event, paths) => {
  if (!Array.isArray(paths)) return []
  return (await getRuntimeHost()).importFiles(paths.filter(path => typeof path === 'string'))
})
ipcMain.handle('desktop:import-clipboard-image', async (_event, base64, mime, filename) => (
  (await getRuntimeHost()).importClipboardImage(
    requireText(base64, 'imageData'),
    requireText(mime, 'mime'),
    typeof filename === 'string' && filename ? filename : 'clipboard.png',
  )
))
ipcMain.handle('desktop:choose-skill', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 SKILL.md',
    properties: ['openFile'],
    filters: [{ name: 'TurboFlux Skill', extensions: ['md'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return (await getRuntimeHost()).importSkill(result.filePaths[0])
})

ipcMain.handle('desktop:choose-workspace', async () => {
  return chooseWorkspace()
})

app.setName('TurboFlux')

function installProductMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'TurboFlux',
      submenu: [
        { role: 'about', label: '关于 TurboFlux' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 TurboFlux' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 TurboFlux' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => void startNewConversation() },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace() },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'togglefullscreen', label: '进入全屏幕' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : [])] },
    { label: '帮助', submenu: [{ label: 'TurboFlux 官网', click: () => void shell.openExternal('https://turbofluxai.com') }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function applyProductDockIcon() {
  if (process.platform !== 'darwin') return
  app.dock.setIcon(productIconPath)
  void app.dock.show()
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: 'TurboFlux', applicationVersion: app.getVersion(), copyright: 'TurboFlux' })
  installProductMenu()
  applyProductDockIcon()
  createWindow()
  app.on('activate', () => {
    applyProductDockIcon()
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  unsubscribeRuntime?.()
  unsubscribeRuntime = null
  if (runtimeHost) void runtimeHost.destroy()
  destroyAllConversationSystems()
  computerActivityOverlay?.destroy()
  computerActivityOverlay = null
})
