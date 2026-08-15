import { mkdirSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  session,
  WebContentsView,
  type BrowserWindow,
  type DownloadItem,
  type OnCompletedListenerDetails,
  type OnErrorOccurredListenerDetails,
} from 'electron'
import type {
  BrowserBounds,
  BrowserObservation,
  BrowserActivityPhase,
  BrowserActivitySnapshot,
  BrowserDownloadSnapshot,
  BrowserErrorSnapshot,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  BrowserTabSnapshot,
  McpClient,
  McpLocalToolResult,
} from '@turboflux/agent-core/extensions'
import { validateBrowserNavigation } from './browserPolicy'
import {
  normalizeBrowserKey,
  normalizeBrowserTimeout,
  redactDiagnosticUrl,
  sanitizeBrowserRef,
} from './browserTesting'
import {
  SerializedOperationCoordinator,
  assertOperationActive,
  createOperationAbortError,
  isOperationAbort,
} from '../systems/operationCoordinator'
import type { RuntimePausableSystemCapability } from '../systems/systemCapability'
import { captureBrowserViewport, type BrowserViewportCapture } from './browserCapture'
import { browserPartition, registerBrowserSession } from './browserSession'
import type { BrowserConsoleEntry, BrowserNetworkIssue, BrowserTab } from './browserTypes'
import { registerBrowserCapability } from './browserCapability'
import { browserTools, MAX_OBSERVED_ELEMENTS } from './browserTools'

const BACKGROUND_BROWSER_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
const MAX_OBSERVED_TEXT = 10_000
const MAX_DIAGNOSTIC_ENTRIES = 120
const MAX_BROWSER_DOWNLOAD_BYTES = 250 * 1024 * 1024
const BROWSER_OPERATION_ABORT_MESSAGE = 'Browser operation aborted'

function safeFilename(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'download'
}

function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function browserOperationAbortError(): Error {
  return createOperationAbortError(BROWSER_OPERATION_ABORT_MESSAGE)
}

function assertBrowserOperationActive(signal?: AbortSignal): void {
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
}

export class BrowserSystem implements RuntimePausableSystemCapability<BrowserSystemSnapshot> {
  private readonly partition: string
  private releaseSession: (() => void) | null = null
  private readonly tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private visible = false
  private presentationEnabled = true
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private nextTabId = 1
  private nextDownloadId = 1
  private workspacePath: string
  private activity: BrowserActivitySnapshot | undefined
  private lastError: BrowserErrorSnapshot | undefined
  private readonly downloads = new Map<string, BrowserDownloadSnapshot>()
  private readonly activeDownloads = new Set<DownloadItem>()
  private readonly operations = new SerializedOperationCoordinator(BROWSER_OPERATION_ABORT_MESSAGE)
  private stateEmitTimer: NodeJS.Timeout | null = null
  private destroyed = false

  constructor(
    private readonly window: BrowserWindow,
    workspacePath: string,
    private readonly emit: (event: BrowserSystemEvent) => void,
    scopeKey = 'default',
  ) {
    this.workspacePath = resolve(workspacePath)
    this.partition = browserPartition(scopeKey)
  }

  register(client: McpClient): void {
    registerBrowserCapability(
      client,
      browserTools(),
      (toolName, args, options) => this.enqueueTool(toolName, args, options?.signal),
    )
  }

  setWorkspacePath(workspacePath: string): void {
    const nextPath = resolve(workspacePath)
    if (nextPath !== this.workspacePath) {
      for (const download of this.activeDownloads) download.cancel()
      this.workspacePath = nextPath
      for (const tab of this.tabs.values()) tab.observationEpoch += 1
    }
  }

  setPresentationEnabled(enabled: boolean): void {
    if (this.presentationEnabled === enabled) return
    this.presentationEnabled = enabled
    if (!enabled) this.detachAllViews()
    else if (this.visible) this.attachActiveView()
  }

  getSnapshot(): BrowserSystemSnapshot {
    return {
      visible: this.visible,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(tab => this.tabSnapshot(tab)),
      activity: this.activity ? { ...this.activity } : undefined,
      downloads: [...this.downloads.values()].map(download => ({ ...download })),
      lastError: this.lastError ? { ...this.lastError } : undefined,
    }
  }

  async show(): Promise<BrowserSystemSnapshot> {
    this.visible = true
    if (!this.activeTabId) await this.createTab('about:blank')
    if (this.presentationEnabled) this.attachActiveView()
    this.emitState()
    return this.getSnapshot()
  }

  hide(): BrowserSystemSnapshot {
    this.visible = false
    this.detachAllViews()
    this.emitState()
    return this.getSnapshot()
  }

  setBounds(bounds: BrowserBounds): BrowserSystemSnapshot {
    const contentBounds = this.window.getContentBounds()
    const nextBounds = {
      x: Math.max(0, Math.min(contentBounds.width, Math.round(bounds.x))),
      y: Math.max(0, Math.min(contentBounds.height, Math.round(bounds.y))),
      width: Math.max(0, Math.min(contentBounds.width, Math.round(bounds.width))),
      height: Math.max(0, Math.min(contentBounds.height, Math.round(bounds.height))),
    }
    if (sameBounds(this.bounds, nextBounds)) return this.getSnapshot()
    this.bounds = nextBounds
    this.layoutActiveView()
    return this.getSnapshot()
  }

  async createTab(address = 'about:blank'): Promise<BrowserSystemSnapshot> {
    this.ensureSession()
    const id = `browser-tab-${this.nextTabId++}`
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds(BACKGROUND_BROWSER_BOUNDS)
    const tab: BrowserTab = {
      id,
      view,
      title: '新标签页',
      url: 'about:blank',
      loading: false,
      crashed: false,
      consoleEntries: [],
      networkIssues: [],
      observationEpoch: 0,
    }
    this.tabs.set(id, tab)
    this.bindTab(tab)
    this.activeTabId = id
    if (this.visible && this.presentationEnabled) this.attachActiveView()
    await this.navigate(address, id)
    return this.getSnapshot()
  }

  activateTab(tabId: string): BrowserSystemSnapshot {
    this.requireTab(tabId)
    this.activeTabId = tabId
    if (this.visible && this.presentationEnabled) this.attachActiveView()
    this.emitState()
    return this.getSnapshot()
  }

  async closeTab(tabId?: string): Promise<BrowserSystemSnapshot> {
    const target = this.requireTab(tabId)
    const wasActive = target.id === this.activeTabId
    this.detachView(target.view)
    this.tabs.delete(target.id)
    target.view.webContents.close({ waitForBeforeUnload: false })
    if (wasActive) this.activeTabId = this.tabs.keys().next().value || null
    if (!this.activeTabId) this.visible = false
    else if (this.visible && this.presentationEnabled) this.attachActiveView()
    this.emitState()
    return this.getSnapshot()
  }

  async navigate(address: string, tabId?: string): Promise<BrowserSystemSnapshot> {
    const tab = this.requireTab(tabId)
    let target: URL
    try {
      target = validateBrowserNavigation(address)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.recordError({ code: 'navigation-blocked', message: reason, tabId: tab.id, recoverable: false })
      this.emit({ type: 'blocked-navigation', url: address, reason })
      throw error
    }
    tab.crashed = false
    await tab.view.webContents.loadURL(target.href)
    this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  goBack(tabId?: string): BrowserSystemSnapshot {
    const tab = this.requireTab(tabId)
    if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack()
    return this.getSnapshot()
  }

  goForward(tabId?: string): BrowserSystemSnapshot {
    const tab = this.requireTab(tabId)
    if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward()
    return this.getSnapshot()
  }

  reload(tabId?: string): BrowserSystemSnapshot {
    this.requireTab(tabId).view.webContents.reload()
    return this.getSnapshot()
  }

  async observe(tabId?: string, maxElements = MAX_OBSERVED_ELEMENTS): Promise<BrowserObservation> {
    const tab = this.requireTab(tabId)
    const observationPrefix = this.nextObservationPrefix(tab)
    const cap = Math.max(1, Math.min(MAX_OBSERVED_ELEMENTS, Math.floor(maxElements)))
    const result = await tab.view.webContents.executeJavaScript(`(() => {
      const visible = element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const roleFor = element => element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: element.type || 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[element.tagName] || element.tagName.toLowerCase())
      const nameFor = element => (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
      const descriptionFor = element => {
        if (element.tagName === 'A') return element.href || ''
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return [element.type, element.placeholder].filter(Boolean).join(' · ')
        return ''
      }
      const selector = 'a[href],button,input,textarea,select,summary,canvas,[role="button"],[role="link"],[role="textbox"],[role="application"],[contenteditable="true"]'
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, ${cap}).map((element, index) => {
        const ref = ${JSON.stringify(observationPrefix)} + '-e' + (index + 1)
        element.dataset.turbofluxRef = ref
        const rect = element.getBoundingClientRect()
        const isPassword = element instanceof HTMLInputElement && element.type === 'password'
        const value = isPassword ? undefined : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? String(element.value || '').slice(0, 240) : undefined
        const options = element instanceof HTMLSelectElement ? [...element.options].slice(0, 80).map(option => option.value || option.text).filter(Boolean) : undefined
        return {
          ref,
          role: roleFor(element),
          name: nameFor(element),
          description: descriptionFor(element).slice(0, 300),
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
          checked: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.checked : undefined,
          value,
          options,
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        }
      })
      const rawText = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim()
      return {
        title: document.title || '',
        url: location.href,
        text: rawText.slice(0, ${MAX_OBSERVED_TEXT}),
        elements,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        truncated: rawText.length > ${MAX_OBSERVED_TEXT} || document.querySelectorAll(selector).length > ${cap},
      }
    })()`, true) as Omit<BrowserObservation, 'tabId'>
    return { tabId: tab.id, ...result }
  }

  async find(query: string, role?: string, maxResults = 12, tabId?: string): Promise<{ tabId: string; query: string; matches: BrowserObservation['elements'] }> {
    const tab = this.requireTab(tabId)
    const normalizedQuery = query.trim()
    if (!normalizedQuery) throw new Error('Browser find requires a query')
    const observationPrefix = this.nextObservationPrefix(tab)
    const cap = Math.max(1, Math.min(30, Math.floor(maxResults)))
    const matches = await tab.view.webContents.executeJavaScript(`(() => {
      const visible = element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const roleFor = element => element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: element.type || 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[element.tagName] || element.tagName.toLowerCase())
      const nameFor = element => (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
      const selector = 'a[href],button,input,textarea,select,summary,canvas,[role="button"],[role="link"],[role="textbox"],[role="application"],[contenteditable="true"]'
      const query = ${JSON.stringify(normalizedQuery.toLocaleLowerCase())}
      const terms = query.split(/\\s+/).filter(Boolean)
      const requestedRole = ${JSON.stringify(role?.trim().toLocaleLowerCase() || '')}
      return [...document.querySelectorAll(selector)]
        .filter(visible)
        .map(element => {
          const elementRole = roleFor(element)
          const name = nameFor(element)
          const description = element.tagName === 'A' ? element.href || '' : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? [element.type, element.placeholder].filter(Boolean).join(' · ') : ''
          const haystack = [name, description, elementRole, element.getAttribute('aria-describedby') || ''].join(' ').toLocaleLowerCase()
          const rect = element.getBoundingClientRect()
          const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
          const exact = name.toLocaleLowerCase() === query
          const starts = name.toLocaleLowerCase().startsWith(query)
          return { element, elementRole, name, description, rect, inViewport, exact, starts, matches: terms.every(term => haystack.includes(term)) }
        })
        .filter(item => item.matches && (!requestedRole || item.elementRole.toLocaleLowerCase() === requestedRole))
        .sort((left, right) => Number(right.exact) - Number(left.exact) || Number(right.starts) - Number(left.starts) || Number(right.inViewport) - Number(left.inViewport))
        .slice(0, ${cap})
        .map((item, index) => {
          const ref = ${JSON.stringify(observationPrefix)} + '-f' + (index + 1)
          item.element.dataset.turbofluxRef = ref
          const isPassword = item.element instanceof HTMLInputElement && item.element.type === 'password'
          const value = isPassword ? undefined : item.element instanceof HTMLInputElement || item.element instanceof HTMLTextAreaElement || item.element instanceof HTMLSelectElement ? String(item.element.value || '').slice(0, 240) : undefined
          const options = item.element instanceof HTMLSelectElement ? [...item.element.options].slice(0, 80).map(option => option.value || option.text).filter(Boolean) : undefined
          return {
            ref,
            role: item.elementRole,
            name: item.name,
            description: item.description.slice(0, 300),
            disabled: Boolean(item.element.disabled || item.element.getAttribute('aria-disabled') === 'true'),
            checked: item.element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(item.element.type) ? item.element.checked : undefined,
            value,
            options,
            bounds: { x: Math.round(item.rect.x), y: Math.round(item.rect.y), width: Math.round(item.rect.width), height: Math.round(item.rect.height) },
          }
        })
    })()`, true) as BrowserObservation['elements']
    return { tabId: tab.id, query: normalizedQuery, matches }
  }

  async click(ref: string, clickCount = 1, tabId?: string): Promise<{ clicked: string; clickCount: number; delivered: boolean; mode: 'native' | 'dom-fallback'; targetUrl?: string; openedTab?: BrowserTabSnapshot; before: { title: string; url: string }; after: { title: string; url: string; loading: boolean }; changed: boolean }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const count = clickCount === 2 ? 2 : 1
    const before = { title: tab.title, url: tab.url }
    const tabsBefore = new Set(this.tabs.keys())
    const probeKey = `__turbofluxClickProbe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const target = await tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!element) throw new Error('Element ref is stale; observe the page again')
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled')
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      window[${JSON.stringify(probeKey)}] = false
      element.addEventListener('click', () => { window[${JSON.stringify(probeKey)}] = true }, { capture: true, once: true })
      const rect = element.getBoundingClientRect()
      return {
        label: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || element.tagName).trim().slice(0, 240),
        href: element instanceof HTMLAnchorElement ? element.href || undefined : undefined,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
      }
    })()`, true) as { label: string; href?: string; x: number; y: number }
    const point = this.validatePoint(tab, target.x, target.y)
    await this.dispatchMouseSequence(tab, [
      { type: 'mouseMoved', ...point },
      { type: 'mousePressed', button: 'left', clickCount: count, ...point },
      { type: 'mouseReleased', button: 'left', clickCount: count, ...point },
    ])
    await new Promise(resolveWait => setTimeout(resolveWait, 180))
    let delivered = false
    try {
      delivered = await tab.view.webContents.executeJavaScript(`Boolean(window[${JSON.stringify(probeKey)}])`, true) as boolean
    } catch {
      delivered = tab.loading || tab.view.webContents.getURL() !== before.url
    }
    let mode: 'native' | 'dom-fallback' = 'native'
    if (!delivered) {
      mode = 'dom-fallback'
      await tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
        if (!element) throw new Error('Element ref is stale; observe the page again')
        element.click()
      })()`, true)
      await new Promise(resolveWait => setTimeout(resolveWait, 260))
      delivered = true
    }
    this.updateTab(tab)
    const opened = [...this.tabs.values()].find(candidate => !tabsBefore.has(candidate.id))
    if (opened) this.updateTab(opened)
    const followedTab = opened || tab
    const after = { title: followedTab.title, url: followedTab.url, loading: followedTab.loading }
    try {
      await tab.view.webContents.executeJavaScript(`delete window[${JSON.stringify(probeKey)}]`, true)
    } catch {}
    tab.observationEpoch += 1
    return {
      clicked: target.label,
      clickCount: count,
      delivered,
      mode,
      targetUrl: target.href,
      openedTab: opened ? this.tabSnapshot(opened) : undefined,
      before,
      after,
      changed: before.url !== after.url || before.title !== after.title || after.loading || Boolean(opened),
    }
  }

  async type(ref: string, text: string, submit = false, tabId?: string): Promise<{ filled: string; submitted: boolean }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const result = await (tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!element) throw new Error('Element ref is stale; observe the page again')
      if (element instanceof HTMLInputElement && element.type === 'password') throw new Error('Password fields must be filled manually')
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error('Element is not editable')
      element.focus()
      const value = ${JSON.stringify(text)}
      if (element.isContentEditable) element.textContent = value
      else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter) setter.call(element, value)
        else element.value = value
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      const form = ${submit === true} ? element.closest('form') : null
      if (form instanceof HTMLFormElement) form.requestSubmit()
      return { filled: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || element.tagName, submitted: Boolean(form) }
    })()`, true) as Promise<{ filled: string; submitted: boolean }>)
    if (submit && !result.submitted) {
      await this.press('Enter', safeRef, [], tabId)
      result.submitted = true
    }
    tab.observationEpoch += 1
    return result
  }

  async press(key: string, ref?: string, modifiers: string[] = [], tabId?: string): Promise<{ key: string; modifiers: string[] }> {
    const tab = this.requireTab(tabId)
    if (ref) {
      const safeRef = this.requireCurrentRef(tab, ref)
      await tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
        if (!element) throw new Error('Element ref is stale; observe the page again')
        element.focus()
      })()`, true)
    }
    const keyCode = normalizeBrowserKey(key)
    const normalizedModifiers = [...new Set(modifiers.filter(value => ['shift', 'control', 'alt', 'meta'].includes(value)))]
      .slice(0, 4) as Array<'shift' | 'control' | 'alt' | 'meta'>
    const modifierMask = normalizedModifiers.reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 } as const)[modifier], 0)
    const keyMetadata = ({
      Up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      Down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      Left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      Right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    } as Record<string, { key: string; code: string; windowsVirtualKeyCode?: number }>)[keyCode] || { key: keyCode, code: keyCode }
    tab.view.webContents.focus()
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    const probeKey = `__turbofluxKeyProbe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    await tab.view.webContents.executeJavaScript(`window[${JSON.stringify(probeKey)}] = false; window.addEventListener('keydown', () => { window[${JSON.stringify(probeKey)}] = true }, { capture: true, once: true })`, true)
    const debuggerApi = tab.view.webContents.debugger
    const attachedHere = !debuggerApi.isAttached()
    try {
      if (attachedHere) debuggerApi.attach('1.3')
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...keyMetadata, modifiers: modifierMask })
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...keyMetadata, modifiers: modifierMask })
    } catch {
      tab.view.webContents.focus()
      tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: normalizedModifiers })
      tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: normalizedModifiers })
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
    const delivered = await tab.view.webContents.executeJavaScript(`Boolean(window[${JSON.stringify(probeKey)}])`, true) as boolean
    if (!delivered) {
      await tab.view.webContents.executeJavaScript(`(() => {
        const target = document.activeElement || document
        const init = { key: ${JSON.stringify(keyMetadata.key)}, code: ${JSON.stringify(keyMetadata.code)}, bubbles: true, cancelable: true }
        target.dispatchEvent(new KeyboardEvent('keydown', init))
        target.dispatchEvent(new KeyboardEvent('keyup', init))
      })()`, true)
    }
    await tab.view.webContents.executeJavaScript(`delete window[${JSON.stringify(probeKey)}]`, true)
    tab.observationEpoch += 1
    return { key: keyCode, modifiers: normalizedModifiers }
  }

  async selectOption(ref: string, values: string[], tabId?: string): Promise<{ selected: string[] }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const selected = await tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a native select')
      if (element.disabled) throw new Error('Element is disabled')
      const requested = new Set(${JSON.stringify(values.slice(0, 20))})
      for (const option of element.options) option.selected = requested.has(option.value) || requested.has(option.text)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return [...element.selectedOptions].map(option => option.value || option.text)
    })()`, true) as string[]
    if (selected.length === 0) throw new Error('No matching select option was found')
    tab.observationEpoch += 1
    return { selected }
  }

  async setChecked(ref: string, checked = true, tabId?: string): Promise<{ checked: boolean }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const result = await tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) throw new Error('Element is not a checkbox or radio input')
      if (element.disabled) throw new Error('Element is disabled')
      element.checked = ${checked === true}
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { checked: element.checked }
    })()`, true) as { checked: boolean }
    tab.observationEpoch += 1
    return result
  }

  async uploadFile(ref: string, requestedPath: string, tabId?: string): Promise<{ filename: string; size: number; ref: string }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(this.workspacePath, requestedPath)
    const [workspaceRoot, filePath] = await Promise.all([realpath(this.workspacePath), realpath(candidate)])
    const relativePath = relative(workspaceRoot, filePath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
      throw new Error('Browser uploads must use a file inside the active workspace')
    }
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('Browser upload source must be a regular file')
    if (info.size > 250 * 1024 * 1024) throw new Error('Browser upload source exceeds the 250 MB limit')

    const debuggerApi = tab.view.webContents.debugger
    const attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    try {
      const document = await debuggerApi.sendCommand('DOM.getDocument', { depth: 1, pierce: true }) as { root?: { nodeId?: number } }
      const rootNodeId = document.root?.nodeId
      if (!rootNodeId) throw new Error('Unable to inspect the current page')
      const match = await debuggerApi.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-turboflux-ref="${safeRef}"]`,
      }) as { nodeId?: number }
      if (!match.nodeId) throw new Error('Element ref is stale; observe the page again')
      const description = await debuggerApi.sendCommand('DOM.describeNode', { nodeId: match.nodeId }) as {
        node?: { nodeName?: string; attributes?: string[] }
      }
      const attributes = description.node?.attributes || []
      const typeIndex = attributes.findIndex((value, index) => index % 2 === 0 && value.toLowerCase() === 'type')
      const inputType = typeIndex >= 0 ? String(attributes[typeIndex + 1] || '').toLowerCase() : ''
      if (description.node?.nodeName?.toUpperCase() !== 'INPUT' || inputType !== 'file') {
        throw new Error('Observed element is not a native file input')
      }
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: match.nodeId })
      tab.observationEpoch += 1
      return { filename: basename(filePath), size: info.size, ref: safeRef }
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
  }

  async hover(ref: string, tabId?: string): Promise<{ hovered: string }> {
    const tab = this.requireTab(tabId)
    const safeRef = this.requireCurrentRef(tab, ref)
    const target = await tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!element) throw new Error('Element ref is stale; observe the page again')
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }))
      const rect = element.getBoundingClientRect()
      return {
        hovered: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || element.tagName).trim().slice(0, 240),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
      }
    })()`, true) as { hovered: string; x: number; y: number }
    const point = this.validatePoint(tab, target.x, target.y)
    tab.view.webContents.focus()
    tab.view.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    tab.observationEpoch += 1
    return { hovered: target.hovered }
  }

  async clickAt(x: number, y: number, tabId?: string): Promise<{ x: number; y: number }> {
    const tab = this.requireTab(tabId)
    const point = this.validatePoint(tab, x, y)
    await this.dispatchMouseSequence(tab, [
      { type: 'mouseMoved', ...point },
      { type: 'mousePressed', button: 'left', clickCount: 1, ...point },
      { type: 'mouseReleased', button: 'left', clickCount: 1, ...point },
    ])
    tab.observationEpoch += 1
    return point
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, tabId?: string): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    const tab = this.requireTab(tabId)
    const from = this.validatePoint(tab, fromX, fromY)
    const to = this.validatePoint(tab, toX, toY)
    const events: Array<Record<string, unknown>> = [
      { type: 'mouseMoved', ...from },
      { type: 'mousePressed', button: 'left', clickCount: 1, ...from },
    ]
    for (let step = 1; step <= 12; step += 1) {
      const point = {
        x: Math.round(from.x + ((to.x - from.x) * step / 12)),
        y: Math.round(from.y + ((to.y - from.y) * step / 12)),
      }
      events.push({ type: 'mouseMoved', button: 'left', buttons: 1, ...point })
    }
    events.push({ type: 'mouseReleased', button: 'left', clickCount: 1, ...to })
    await this.dispatchMouseSequence(tab, events)
    tab.observationEpoch += 1
    return { from, to }
  }

  private async dispatchMouseSequence(tab: BrowserTab, events: Array<Record<string, unknown>>): Promise<void> {
    const debuggerApi = tab.view.webContents.debugger
    const attachedHere = !debuggerApi.isAttached()
    try {
      if (attachedHere) debuggerApi.attach('1.3')
      for (const event of events) {
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', event)
        if (event.type === 'mouseMoved') await new Promise(resolveWait => setTimeout(resolveWait, 16))
      }
    } catch {
      tab.view.webContents.focus()
      for (const event of events) {
        const type = event.type === 'mousePressed' ? 'mouseDown' : event.type === 'mouseReleased' ? 'mouseUp' : 'mouseMove'
        tab.view.webContents.sendInputEvent({
          type,
          x: Number(event.x),
          y: Number(event.y),
          button: event.button === 'left' ? 'left' : undefined,
          clickCount: typeof event.clickCount === 'number' ? event.clickCount : undefined,
          modifiers: event.buttons === 1 ? ['leftbuttondown'] : undefined,
        })
      }
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
  }

  async scroll(direction: string, amount = 700, tabId?: string): Promise<{ direction: string; amount: number }> {
    const tab = this.requireTab(tabId)
    const distance = Math.max(100, Math.min(3000, Math.floor(amount)))
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
    const signed = direction === 'up' || direction === 'left' ? -distance : distance
    await tab.view.webContents.executeJavaScript(`window.scrollBy({ ${axis === 'x' ? 'left' : 'top'}: ${signed}, behavior: 'smooth' })`, true)
    tab.observationEpoch += 1
    return { direction, amount: distance }
  }

  async waitFor(
    condition: string,
    value: string | undefined,
    ref: string | undefined,
    timeoutMs: unknown,
    tabId?: string,
    signal?: AbortSignal,
  ): Promise<{ condition: string; matched: true; elapsedMs: number }> {
    const tab = this.requireTab(tabId)
    const timeout = normalizeBrowserTimeout(timeoutMs)
    const startedAt = Date.now()
    const safeRef = ref ? this.requireCurrentRef(tab, ref) : undefined
    if (!['load', 'text', 'url', 'element'].includes(condition)) throw new Error(`Unsupported wait condition: ${condition}`)
    if ((condition === 'text' || condition === 'url') && !value) throw new Error(`${condition} wait requires value`)
    if (condition === 'element' && !safeRef) throw new Error('element wait requires ref')

    while (Date.now() - startedAt <= timeout) {
      if (signal?.aborted) throw browserOperationAbortError()
      let matched = false
      if (condition === 'load') matched = !tab.loading
      else if (condition === 'url') matched = tab.view.webContents.getURL().includes(value!)
      else {
        matched = await tab.view.webContents.executeJavaScript(`(() => {
          ${condition === 'text'
            ? `return (document.body?.innerText || '').includes(${JSON.stringify(value)})`
            : `const element = document.querySelector('[data-turboflux-ref="${safeRef}"]'); if (!element) return false; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0`}
        })()`, true) as boolean
      }
      if (matched) return { condition, matched: true, elapsedMs: Date.now() - startedAt }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out after ${timeout}ms waiting for browser ${condition}`)
  }

  async assertPage(condition: string, value?: string, ref?: string, tabId?: string): Promise<{ passed: boolean; condition: string; expected?: string; actual: unknown }> {
    const tab = this.requireTab(tabId)
    if (!['text_contains', 'url_contains', 'element_visible', 'element_enabled', 'element_checked'].includes(condition)) {
      throw new Error(`Unsupported browser assertion: ${condition}`)
    }
    if ((condition === 'text_contains' || condition === 'url_contains') && !value) throw new Error(`${condition} assertion requires value`)
    const safeRef = ref ? this.requireCurrentRef(tab, ref) : undefined
    if (condition.startsWith('element_') && !safeRef) throw new Error(`${condition} assertion requires ref`)

    if (condition === 'url_contains') {
      const actual = tab.view.webContents.getURL()
      return { passed: actual.includes(value!), condition, expected: value, actual }
    }
    if (condition === 'text_contains') {
      const actual = await tab.view.webContents.executeJavaScript(`(document.body?.innerText || '').slice(0, ${MAX_OBSERVED_TEXT})`, true) as string
      return { passed: actual.includes(value!), condition, expected: value, actual: actual.slice(0, 2_000) }
    }

    const actual = await tab.view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-turboflux-ref="${safeRef}"]')
      if (!element) return { exists: false, visible: false, enabled: false, checked: false }
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        exists: true,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
        enabled: !(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true',
      }
    })()`, true) as { exists: boolean; visible: boolean; enabled: boolean; checked: boolean }
    const key = condition === 'element_visible' ? 'visible' : condition === 'element_enabled' ? 'enabled' : 'checked'
    return { passed: actual[key], condition, expected: 'true', actual }
  }

  diagnostics(clear = false, tabId?: string): { console: BrowserConsoleEntry[]; network: BrowserNetworkIssue[]; counts: { console: number; network: number } } {
    const tab = this.requireTab(tabId)
    const result = {
      console: tab.consoleEntries.map(entry => ({ ...entry })),
      network: tab.networkIssues.map(issue => ({ ...issue })),
      counts: { console: tab.consoleEntries.length, network: tab.networkIssues.length },
    }
    if (clear) {
      tab.consoleEntries = []
      tab.networkIssues = []
    }
    return result
  }

  async screenshot(tabId?: string): Promise<{ path: string; title: string; url: string }> {
    const capture = await this.captureViewport(tabId)
    return { path: capture.path, title: capture.title, url: capture.url }
  }

  async visualObserve(tabId?: string, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const capture = await this.captureViewport(tabId, signal)
    return {
      kind: 'local_tool_result',
      content: JSON.stringify({
        tabId: capture.tabId,
        title: capture.title,
        url: capture.url,
        viewport: capture.viewport,
        instruction: 'Inspect the attached current viewport as visual evidence. Any coordinates are relative to this viewport and must be refreshed after navigation, scrolling, animation, resize, or interaction.',
      }, null, 2),
      attachments: [capture.attachment],
    }
  }

  private async captureViewport(tabId?: string, signal?: AbortSignal): Promise<BrowserViewportCapture> {
    const tab = this.requireTab(tabId)
    return captureBrowserViewport(tab, this.workspacePath, this.emit, signal)
  }

  pauseForRuntime(): BrowserSystemSnapshot {
    this.operations.invalidate()
    this.activity = undefined
    this.emitState()
    return this.getSnapshot()
  }

  resumeForRuntime(): BrowserSystemSnapshot {
    this.operations.invalidate()
    return this.getSnapshot()
  }

  pauseOperations(): BrowserSystemSnapshot {
    return this.pauseForRuntime()
  }

  resumeOperations(): BrowserSystemSnapshot {
    return this.resumeForRuntime()
  }

  async finishTask(): Promise<void> {
    this.operations.invalidate()
    this.activity = undefined
    await this.operations.drain()
    this.emitState()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.operations.invalidate()
    if (this.stateEmitTimer) clearTimeout(this.stateEmitTimer)
    this.stateEmitTimer = null
    for (const download of this.activeDownloads) download.cancel()
    this.activeDownloads.clear()
    this.detachAllViews()
    for (const tab of this.tabs.values()) tab.view.webContents.close({ waitForBeforeUnload: false })
    this.tabs.clear()
    this.activeTabId = null
    this.releaseSession?.()
    this.releaseSession = null
  }

  private ensureSession(): void {
    if (this.releaseSession) return
    const browserSession = session.fromPartition(this.partition, { cache: true })
    this.releaseSession = registerBrowserSession(browserSession, {
      ownsWebContents: webContentsId => this.ownsWebContents(webContentsId),
      handleDownload: item => this.handleDownload(item),
      recordNetworkIssue: details => this.recordNetworkIssue(details),
    })
  }

  private ownsWebContents(webContentsId: number): boolean {
    return [...this.tabs.values()].some(tab => tab.view.webContents.id === webContentsId)
  }

  private handleDownload(item: DownloadItem): void {
    this.activeDownloads.add(item)
    const filename = safeFilename(item.getFilename())
    const id = `browser-download-${this.nextDownloadId++}`
    const workspacePath = this.workspacePath
    const directory = join(workspacePath, '.turboflux', 'browser-downloads')
    const path = join(directory, `${Date.now()}-${filename}`)
    const startedAt = Date.now()
    let limitError: string | undefined
    const update = (status: BrowserDownloadSnapshot['status'], error?: string) => {
      const existing = this.downloads.get(id)
      const download: BrowserDownloadSnapshot = {
        id,
        filename,
        path: status === 'completed' ? path : undefined,
        status,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        error,
        startedAt: existing?.startedAt || startedAt,
        updatedAt: Date.now(),
      }
      this.downloads.set(id, download)
      while (this.downloads.size > 24) this.downloads.delete(this.downloads.keys().next().value as string)
      this.emit({ type: 'download', download, filename, path: download.path, status, error })
      this.emitState()
    }
    try {
      mkdirSync(directory, { recursive: true })
      item.setSavePath(path)
    } catch (error) {
      this.activeDownloads.delete(item)
      item.cancel()
      const message = error instanceof Error ? error.message : String(error)
      this.recordError({ code: 'download-failed', message, recoverable: true })
      update('failed', message)
      return
    }
    if (item.getTotalBytes() > MAX_BROWSER_DOWNLOAD_BYTES) {
      this.activeDownloads.delete(item)
      limitError = 'Browser download exceeds the 250 MB limit'
      item.cancel()
      update('failed', limitError)
      return
    }
    update('started')
    item.on('updated', () => {
      if (item.getReceivedBytes() > MAX_BROWSER_DOWNLOAD_BYTES) {
        limitError = 'Browser download exceeds the 250 MB limit'
        item.cancel()
        update('failed', limitError)
        return
      }
      update('started')
    })
    item.once('done', (_event, state) => {
      this.activeDownloads.delete(item)
      const status = limitError ? 'failed' : state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed'
      const error = limitError || (status === 'failed' ? 'Browser download failed' : undefined)
      if (error) this.recordError({ code: 'download-failed', message: error, recoverable: true })
      update(status, error)
      if (status === 'completed') {
        this.emit({ type: 'artifact-ready', path, name: filename, mime: item.getMimeType() || 'application/octet-stream', kind: 'download' })
      }
    })
  }

  private bindTab(tab: BrowserTab): void {
    const contents = tab.view.webContents
    contents.on('did-start-loading', () => {
      tab.observationEpoch += 1
      tab.loading = true
      tab.consoleEntries = []
      tab.networkIssues = []
      this.emitState()
    })
    contents.on('did-stop-loading', () => { tab.loading = false; this.updateTab(tab); this.emitState() })
    contents.on('console-message', event => {
      this.pushBounded(tab.consoleEntries, {
        level: event.level,
        message: event.message.slice(0, 2_000),
        source: event.sourceId ? redactDiagnosticUrl(event.sourceId) : undefined,
        line: event.lineNumber || undefined,
        timestamp: Date.now(),
      })
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.pushBounded(tab.networkIssues, {
        method: 'GET',
        url: redactDiagnosticUrl(url),
        resourceType: 'mainFrame',
        error: errorDescription,
        timestamp: Date.now(),
      })
      this.recordError({ code: 'load-failed', message: errorDescription, tabId: tab.id, recoverable: true })
    })
    contents.on('page-title-updated', (event, title) => { event.preventDefault(); tab.title = title || tab.title; this.emitState() })
    contents.on('did-navigate', (_event, url) => { tab.observationEpoch += 1; tab.url = url; this.emitState() })
    contents.on('did-navigate-in-page', (_event, url) => { tab.observationEpoch += 1; tab.url = url; this.emitState() })
    contents.on('will-navigate', (event, url) => {
      try {
        validateBrowserNavigation(url)
      } catch (error) {
        event.preventDefault()
        const reason = error instanceof Error ? error.message : String(error)
        this.recordError({ code: 'navigation-blocked', message: reason, tabId: tab.id, recoverable: false })
        this.emit({ type: 'blocked-navigation', url, reason })
      }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('render-process-gone', () => {
      tab.crashed = true
      tab.loading = false
      this.recordError({ code: 'renderer-crashed', message: '浏览器页面进程已停止，可以重新加载恢复', tabId: tab.id, recoverable: true })
    })
    contents.setWindowOpenHandler(details => {
      try {
        validateBrowserNavigation(details.url)
        void this.createTab(details.url)
      } catch (error) {
        this.emit({ type: 'blocked-navigation', url: details.url, reason: error instanceof Error ? error.message : String(error) })
      }
      return { action: 'deny' }
    })
  }

  private updateTab(tab: BrowserTab): void {
    if (tab.view.webContents.isDestroyed()) return
    tab.title = tab.view.webContents.getTitle() || tab.title
    tab.url = tab.view.webContents.getURL() || tab.url
  }

  private requireTab(tabId?: string): BrowserTab {
    const id = tabId || this.activeTabId
    const tab = id ? this.tabs.get(id) : undefined
    if (!tab) throw new Error('Browser tab not found')
    return tab
  }

  private nextObservationPrefix(tab: BrowserTab): string {
    tab.observationEpoch += 1
    return `o${tab.observationEpoch.toString(36)}`
  }

  private requireCurrentRef(tab: BrowserTab, ref: string): string {
    const safeRef = sanitizeBrowserRef(ref)
    if (!safeRef.startsWith(`o${tab.observationEpoch.toString(36)}-`)) {
      throw new Error('Element ref is stale; observe the page again')
    }
    return safeRef
  }

  private validatePoint(tab: BrowserTab, x: number, y: number): { x: number; y: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Browser coordinates must be finite numbers')
    const bounds = tab.view.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Browser surface is not ready for coordinate input')
    const point = { x: Math.round(x), y: Math.round(y) }
    if (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height) {
      throw new Error(`Browser coordinates are outside the ${bounds.width}x${bounds.height} viewport`)
    }
    return point
  }

  private recordNetworkIssue(details: OnCompletedListenerDetails | OnErrorOccurredListenerDetails): void {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId)
    if (!tab) return
    this.pushBounded(tab.networkIssues, {
      method: details.method,
      url: redactDiagnosticUrl(details.url),
      resourceType: details.resourceType,
      status: 'statusCode' in details ? details.statusCode : undefined,
      error: details.error || undefined,
      timestamp: Date.now(),
    })
  }

  private pushBounded<T>(target: T[], value: T): void {
    target.push(value)
    if (target.length > MAX_DIAGNOSTIC_ENTRIES) target.splice(0, target.length - MAX_DIAGNOSTIC_ENTRIES)
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const history = tab.view.webContents.navigationHistory
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      crashed: tab.crashed || undefined,
    }
  }

  private activeTabToolResult(tabId = this.activeTabId): { activeTabId: string | null; tab?: BrowserTabSnapshot; tabCount: number } {
    const tab = tabId ? this.tabs.get(tabId) : undefined
    return {
      activeTabId: this.activeTabId,
      tab: tab ? this.tabSnapshot(tab) : undefined,
      tabCount: this.tabs.size,
    }
  }

  private tabsToolResult(): { activeTabId: string | null; tabs: BrowserTabSnapshot[]; tabCount: number } {
    const tabs = [...this.tabs.values()].map(tab => this.tabSnapshot(tab))
    return { activeTabId: this.activeTabId, tabs, tabCount: tabs.length }
  }

  private attachActiveView(): void {
    if (!this.visible || !this.presentationEnabled || !this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    for (const candidate of this.tabs.values()) {
      if (candidate.id !== tab.id) this.detachView(candidate.view)
    }
    if (!this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view)
    this.layoutActiveView()
  }

  private layoutActiveView(): void {
    if (!this.visible || !this.presentationEnabled || !this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    if (this.bounds.width < 2 || this.bounds.height < 2) {
      tab.view.setVisible(false)
      return
    }
    if (!sameBounds(tab.view.getBounds(), this.bounds)) tab.view.setBounds(this.bounds)
    tab.view.setVisible(true)
  }

  private detachAllViews(): void {
    for (const tab of this.tabs.values()) this.detachView(tab.view)
  }

  private detachView(view: WebContentsView): void {
    try {
      view.setVisible(false)
      this.window.contentView.removeChildView(view)
    } catch {}
  }

  private emitState(): void {
    if (this.destroyed || this.stateEmitTimer) return
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null
      if (!this.destroyed) this.emit({ type: 'state', snapshot: this.getSnapshot() })
    }, 16)
  }

  private recordError(input: Omit<BrowserErrorSnapshot, 'occurredAt'>): void {
    this.lastError = { ...input, occurredAt: Date.now() }
    this.emitState()
  }

  private async withActivity<T>(phase: BrowserActivityPhase, operation: string, tabId: string | undefined, description: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const activity: BrowserActivitySnapshot = { phase, operation, tabId, description, startedAt: Date.now() }
    this.activity = activity
    this.lastError = undefined
    this.emitState()
    try {
      const result = await work()
      assertBrowserOperationActive(signal)
      return result
    } catch (error) {
      if (signal?.aborted || isOperationAbort(error)) throw browserOperationAbortError()
      const lastError = this.lastError as BrowserErrorSnapshot | undefined
      if (!lastError || lastError.occurredAt < activity.startedAt) {
        this.recordError({ code: 'operation-failed', message: error instanceof Error ? error.message : String(error), tabId, recoverable: true })
      }
      throw error
    } finally {
      if (this.activity === activity) {
        this.activity = undefined
        this.emitState()
      }
    }
  }

  private enqueueTool<T>(toolName: string, args: Record<string, unknown>, externalSignal?: AbortSignal): Promise<T> {
    const requestedTabId = typeof args.tab_id === 'string' ? args.tab_id : this.activeTabId || undefined
    const stopLoading = () => {
      const tab = requestedTabId ? this.tabs.get(requestedTabId) : undefined
      if (tab?.view.webContents.isLoading()) tab.view.webContents.stop()
    }
    return this.operations.enqueue(async signal => {
      const result = await this.handleTool(toolName, args, signal)
      return result as T
    }, { externalSignal, onAbort: stopLoading })
  }

  private async handleTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertBrowserOperationActive(signal)
    if (!this.activeTabId && !['open', 'tabs', 'close'].includes(toolName)) await this.createTab('about:blank')
    const tabId = typeof args.tab_id === 'string' ? args.tab_id : this.activeTabId || undefined
    if (tabId && toolName !== 'close' && this.tabs.has(tabId) && this.activeTabId !== tabId) this.activateTab(tabId)
    const phase: BrowserActivityPhase = ['open'].includes(toolName) ? 'opening' : ['observe', 'find', 'diagnostics', 'assert', 'tabs'].includes(toolName) ? 'observing' : ['screenshot', 'visual_observe'].includes(toolName) ? 'capturing' : ['navigate', 'back', 'forward', 'reload', 'activate'].includes(toolName) ? 'navigating' : 'acting'
    return this.withActivity(phase, toolName, tabId, `浏览器${toolName}中`, async () => {
      switch (toolName) {
      case 'open': {
        await this.createTab(String(args.url || ''))
        return this.activeTabToolResult()
      }
      case 'tabs': return this.tabsToolResult()
      case 'activate': {
        const targetId = String(args.tab_id || '')
        this.activateTab(targetId)
        return this.activeTabToolResult(targetId)
      }
      case 'navigate': {
        await this.navigate(String(args.url || ''), args.tab_id as string | undefined)
        return this.activeTabToolResult(args.tab_id as string | undefined)
      }
      case 'observe': return this.observe(args.tab_id as string | undefined, Number(args.max_elements || MAX_OBSERVED_ELEMENTS))
      case 'find': return this.find(String(args.query || ''), typeof args.role === 'string' ? args.role : undefined, Number(args.max_results || 12), args.tab_id as string | undefined)
      case 'click': return this.click(String(args.ref || ''), Number(args.click_count || 1), args.tab_id as string | undefined)
      case 'type': return this.type(String(args.ref || ''), String(args.text || ''), args.submit === true, args.tab_id as string | undefined)
      case 'press': return this.press(
        String(args.key || ''),
        typeof args.ref === 'string' ? args.ref : undefined,
        Array.isArray(args.modifiers) ? args.modifiers.map(String) : [],
        args.tab_id as string | undefined,
      )
      case 'select_option': return this.selectOption(
        String(args.ref || ''),
        Array.isArray(args.values) ? args.values.map(String) : [],
        args.tab_id as string | undefined,
      )
      case 'set_checked': return this.setChecked(String(args.ref || ''), args.checked !== false, args.tab_id as string | undefined)
      case 'upload_file': return this.uploadFile(String(args.ref || ''), String(args.path || ''), args.tab_id as string | undefined)
      case 'hover': return this.hover(String(args.ref || ''), args.tab_id as string | undefined)
      case 'click_at': return this.clickAt(Number(args.x), Number(args.y), args.tab_id as string | undefined)
      case 'drag': return this.drag(Number(args.from_x), Number(args.from_y), Number(args.to_x), Number(args.to_y), args.tab_id as string | undefined)
      case 'scroll': return this.scroll(String(args.direction || 'down'), Number(args.amount || 700), args.tab_id as string | undefined)
      case 'wait': return this.waitFor(
        String(args.condition || ''),
        typeof args.value === 'string' ? args.value : undefined,
        typeof args.ref === 'string' ? args.ref : undefined,
        args.timeout_ms,
        args.tab_id as string | undefined,
        signal,
      )
      case 'assert': return this.assertPage(
        String(args.condition || ''),
        typeof args.value === 'string' ? args.value : undefined,
        typeof args.ref === 'string' ? args.ref : undefined,
        args.tab_id as string | undefined,
      )
      case 'diagnostics': return this.diagnostics(args.clear === true, args.tab_id as string | undefined)
      case 'back': return this.goBack(args.tab_id as string | undefined)
      case 'forward': return this.goForward(args.tab_id as string | undefined)
      case 'reload': return this.reload(args.tab_id as string | undefined)
      case 'screenshot': {
        const capture = await this.captureViewport(args.tab_id as string | undefined, signal)
        return { kind: 'local_tool_result', content: JSON.stringify({ tabId: capture.tabId, title: capture.title, url: capture.url, path: capture.path }, null, 2), attachments: [capture.attachment] } satisfies McpLocalToolResult
      }
      case 'visual_observe': return this.visualObserve(args.tab_id as string | undefined, signal)
      case 'close': return this.closeTab(args.tab_id as string | undefined)
      default: throw new Error(`Unknown browser tool: ${toolName}`)
      }
    }, signal)
  }
}
