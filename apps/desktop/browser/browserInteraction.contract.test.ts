import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./browserSystem.ts', import.meta.url), 'utf8')
const capture = readFileSync(new URL('./browserCapture.ts', import.meta.url), 'utf8')
const browserSession = readFileSync(new URL('./browserSession.ts', import.meta.url), 'utf8')
const capability = readFileSync(new URL('./browserCapability.ts', import.meta.url), 'utf8')
const tools = readFileSync(new URL('./browserTools.ts', import.meta.url), 'utf8')
const coordinator = readFileSync(new URL('../systems/operationCoordinator.ts', import.meta.url), 'utf8')

describe('browser interaction contract', () => {
  it('scopes element refs to the latest observation', () => {
    expect(source).toContain('const observationPrefix = this.nextObservationPrefix(tab)')
    expect(source).toContain("throw new Error('Element ref is stale; observe the page again')")
    expect(source).toContain("contents.on('did-navigate', (_event, url) => { tab.observationEpoch += 1")
  })

  it('exposes semantic discovery and visible tab following', () => {
    expect(tools).toContain("name: 'find'")
    expect(tools).toContain("name: 'activate'")
    expect(source).toContain('this.activeTabId !== tabId) this.activateTab(tabId)')
  })

  it('keeps routine navigation results compact for model context', () => {
    expect(source).toContain('const MAX_OBSERVED_TEXT = 10_000')
    expect(tools).toContain('export const MAX_OBSERVED_ELEMENTS = 160')
    expect(source).toContain("case 'tabs': return this.tabsToolResult()")
    expect(source).toContain('return this.activeTabToolResult()')
    expect(source).not.toContain("case 'open': return this.createTab")
  })

  it('uses native browser input for semantic clicks', () => {
    const clickMethod = source.slice(source.indexOf('async click('), source.indexOf('async type('))
    expect(clickMethod).toContain("type: 'mousePressed'")
    expect(clickMethod).toContain("type: 'mouseReleased'")
    expect(clickMethod).toContain('this.dispatchMouseSequence')
    expect(clickMethod).toContain("mode = 'dom-fallback'")
    expect(clickMethod).toContain('openedTab: opened ? this.tabSnapshot(opened) : undefined')
  })

  it('requires an observed result after interactive work', () => {
    expect(capability).toContain('Do not claim a webpage action happened unless the corresponding browser action returned successfully')
    expect(capability).toContain('wait for the response, then observe or assert the resulting state')
  })

  it('captures visual evidence without reparenting the visible native view', () => {
    expect(source).toContain('captureBrowserViewport(tab, this.workspacePath, this.emit, signal)')
    expect(capture).toContain("debuggerApi.sendCommand('Page.getLayoutMetrics')")
    expect(capture).toContain("debuggerApi.sendCommand('Page.captureScreenshot'")
    expect(capture).not.toContain('captureWindow.contentView.addChildView(tab.view)')
    expect(capture).not.toContain('capturePage()')
    expect(capture).toContain("requestAnimationFrame(() => requestAnimationFrame(resolve))")
    expect(capture).toContain("throw new Error('Browser viewport capture produced no image data')")
  })

  it('isolates browser session policy from system orchestration', () => {
    const constructorSource = source.slice(source.indexOf('constructor('), source.indexOf('register(client'))
    expect(source).toContain('private ensureSession(): void')
    expect(source).toContain('this.ensureSession()')
    expect(source).toContain('if (this.releaseSession) return')
    expect(source.indexOf('this.ensureSession()')).toBeLessThan(source.indexOf('new WebContentsView({'))
    expect(constructorSource).not.toContain('session.fromPartition')
    expect(browserSession).toContain('setPermissionCheckHandler(() => false)')
    expect(browserSession).toContain('setPermissionRequestHandler')
    expect(browserSession).toContain("browserSession.webRequest.onCompleted(filter")
    expect(browserSession).toContain('registry.owners.delete(owner)')
  })

  it('keeps native browser view attachment and layout idempotent', () => {
    expect(source).toContain('if (sameBounds(this.bounds, nextBounds)) return this.getSnapshot()')
    expect(source).toContain('if (!this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view)')
    expect(source).toContain('if (this.bounds.width < 2 || this.bounds.height < 2)')
    expect(source).toContain('tab.view.setVisible(false)')
    expect(source).toContain('if (!sameBounds(tab.view.getBounds(), this.bounds)) tab.view.setBounds(this.bounds)')
  })

  it('serializes browser tools and rejects late operation results', () => {
    expect(source).toContain('new SerializedOperationCoordinator(BROWSER_OPERATION_ABORT_MESSAGE)')
    expect(source).toContain('this.operations.enqueue(async signal =>')
    expect(source).toContain('this.operations.invalidate()')
    expect(source).toContain('const cancelled = options?.signal?.aborted || isOperationAbort(error)')
    expect(coordinator).toContain('private queue: Promise<void> = Promise.resolve()')
    expect(coordinator).toContain('if (epoch !== this.epoch) throw createOperationAbortError(this.abortMessage)')
    expect(coordinator).toContain("error.name = 'AbortError'")
    expect(coordinator).toContain('this.activeController?.abort')
  })

  it('owns a bounded Agent execution index and opens the surface on activity', () => {
    expect(source).toContain('private readonly executions = new Map<string, BrowserExecutionSnapshot>()')
    expect(source).toContain('const MAX_BROWSER_EXECUTIONS = 200')
    expect(source).toContain('executionContext.conversationId !== this.conversationId')
    expect(source).toContain('this.visible = true')
    expect(source).toContain("this.finishExecution(execution, 'completed', result)")
    expect(source).toContain("this.finishExecution(execution, cancelled ? 'cancelled' : 'failed')")
    expect(source).not.toContain('JSON.parse(result')
  })
})
