import type { ChangeSummary, ToolCall, ToolResult, WorkRun } from '@turboflux/agent-core/workbench'
import { stripTextToolCallMarkup } from '@turboflux/agent-core/renderer'
import {
  browserToolActionTitle,
  browserToolResultDetail,
  normalizeThinkingContent,
  renderMarkdown,
  toolDisplayName,
} from './richContent'
import type { TaskFlowNode, TaskFlowProjectionState } from './taskFlowProjection'
import { toolIcon, type ToolIconKind } from './toolIcons'

export type LinearTaskFlowItem =
  | { key: string; kind: 'node'; node: TaskFlowNode }
  | { key: string; kind: 'tool-group'; runId?: string; group: LinearToolGroupKind; nodes: TaskFlowNode[]; active?: boolean }

export type LinearToolGroupKind = 'inspection' | 'keyboard' | 'scroll' | 'repeat'

export type LinearFlowGap = 'none' | 'content' | 'turn'

export interface LinearTaskFlowTool {
  call: ToolCall
  result?: ToolResult
  onPreviewDiff?: (change: ChangeSummary) => void
}

export interface LinearTaskFlowRendererOptions {
  createInput(node: TaskFlowNode): HTMLElement
  createAnswer(node: TaskFlowNode, presentation: { finalDelivery: boolean }): HTMLElement
  resolveTool(node: TaskFlowNode): LinearTaskFlowTool
  resolveRun?(runId: string): WorkRun | undefined
  nodeVersion?(node: TaskFlowNode): string
}

export interface LinearTaskFlowRenderer {
  render(state: TaskFlowProjectionState, force?: boolean): void
  clear(): void
}

export function shouldDeferCanonicalTaskFlowRender(input: {
  force?: boolean
  streamingAnswer: boolean
  streamingReasoning: boolean
}): boolean {
  return !input.force && (input.streamingAnswer || input.streamingReasoning)
}

export function shouldUpdateLinearAnswerInPlace(node: Pick<TaskFlowNode, 'kind' | 'status' | 'settled'>, hasExistingAnswer: boolean): boolean {
  return hasExistingAnswer && node.kind === 'answer' && node.status === 'running' && !node.settled
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])

export function isFinalDeliveryAnswer(input: {
  nodeKind: TaskFlowNode['kind']
  nodeId: string
  runId?: string
  finalAnswerId?: string
  runStatus?: string
}): boolean {
  return Boolean(
    input.nodeKind === 'answer'
    && input.runId
    && input.finalAnswerId === input.nodeId
    && input.runStatus
    && TERMINAL_RUN_STATUSES.has(input.runStatus),
  )
}

function orderedPresentationNodes(state: TaskFlowProjectionState): { nodes: TaskFlowNode[]; phase?: TaskFlowNode } {
  const nodes = state.order.map(id => state.nodes[id]).filter((node): node is TaskFlowNode => Boolean(node))
  const hasActivePresentation = Boolean(state.activeRunId && nodes.some(node => (
    node.kind !== 'phase'
    && node.runId === state.activeRunId
    && !node.settled
    && (node.status === 'running' || node.status === 'waiting')
  )))
  const hasAnswerPresentation = Boolean(state.activeRunId && nodes.some(node => (
    node.kind === 'answer'
    && node.runId === state.activeRunId
    && node.content.trim()
  )))
  const phase = !state.activeRunId || hasActivePresentation || hasAnswerPresentation
    ? undefined
    : [...nodes].reverse().find(node => (
        node.kind === 'phase'
        && node.status === 'running'
        && !node.settled
        && node.runId === state.activeRunId
      ))
  const ordinary = nodes.filter(node => node.kind !== 'phase')
  const firstInputByRun = new Map<string, TaskFlowNode>()
  for (const node of ordinary) {
    if (node.kind !== 'input' || !node.runId || firstInputByRun.has(node.runId)) continue
    firstInputByRun.set(node.runId, node)
  }
  const ordered: TaskFlowNode[] = []
  const emittedFirstInputs = new Set<string>()
  for (const node of ordinary) {
    const runId = node.runId
    const firstInput = runId ? firstInputByRun.get(runId) : undefined
    if (runId && firstInput && !emittedFirstInputs.has(runId) && node !== firstInput) {
      ordered.push(firstInput)
      emittedFirstInputs.add(runId)
    }
    if (runId && firstInput === node) {
      if (emittedFirstInputs.has(runId)) continue
      emittedFirstInputs.add(runId)
    }
    ordered.push(node)
  }
  return { nodes: ordered, phase }
}

const PASSIVE_BROWSER_OPERATIONS = new Set([
  'browser__observe',
  'browser__visual_observe',
  'browser__diagnostics',
  'browser__wait',
  'browser__screenshot',
  'browser__assert',
  'browser__find',
  'browser__tabs',
])

export function browserToolGroupKind(node: TaskFlowNode): Exclude<LinearToolGroupKind, 'repeat'> | null {
  if (node.kind !== 'tool') return null
  const name = node.toolName || node.content
  if (PASSIVE_BROWSER_OPERATIONS.has(name)) return 'inspection'
  if (name === 'browser__press') return 'keyboard'
  if (name === 'browser__scroll') return 'scroll'
  return null
}

function repeatToolFingerprint(node: TaskFlowNode): string | null {
  if (node.kind !== 'tool' || !node.settled || !node.detail) return null
  const name = node.toolName || node.content
  return `${name}\u0000${node.content}\u0000${node.detail}`
}

export function linearTaskFlowItems(
  state: TaskFlowProjectionState,
): LinearTaskFlowItem[] {
  const items: LinearTaskFlowItem[] = []
  const inspectionGroups = new Map<string, Extract<LinearTaskFlowItem, { kind: 'tool-group' }>>()
  const { nodes, phase } = orderedPresentationNodes(state)
  for (const node of nodes) {
    if (node.kind === 'input') {
      items.push({ key: `node:${node.id}`, kind: 'node', node })
      inspectionGroups.clear()
      continue
    }
    const group = browserToolGroupKind(node)
    const previous = items.at(-1)
    if (group === 'inspection') {
      const groupKey = `${node.runId || state.conversationId}:inspection`
      const existing = inspectionGroups.get(groupKey)
      if (existing) {
        existing.nodes.push(node)
      } else {
        const item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }> = {
          key: `tool-group:${node.id}`,
          kind: 'tool-group',
          runId: node.runId,
          group,
          nodes: [node],
          active: Boolean(node.runId && node.runId === state.activeRunId),
        }
        inspectionGroups.set(groupKey, item)
        items.push(item)
      }
      continue
    }
    if (
      group
      && previous?.kind === 'tool-group'
      && previous.group === group
      && previous.runId === node.runId
    ) {
      previous.nodes.push(node)
    } else if (group) {
      items.push({
        key: `tool-group:${node.id}`,
        kind: 'tool-group',
        runId: node.runId,
        group,
        nodes: [node],
        active: Boolean(node.runId && node.runId === state.activeRunId),
      })
    } else {
      const fingerprint = repeatToolFingerprint(node)
      if (
        fingerprint
        && previous?.kind === 'node'
        && repeatToolFingerprint(previous.node) === fingerprint
      ) {
        items[items.length - 1] = {
          key: `tool-group:${previous.node.id}`,
          kind: 'tool-group',
          runId: node.runId,
          group: 'repeat',
          nodes: [previous.node, node],
        }
      } else if (
        fingerprint
        && previous?.kind === 'tool-group'
        && previous.group === 'repeat'
        && repeatToolFingerprint(previous.nodes.at(-1)!) === fingerprint
      ) {
        previous.nodes.push(node)
      } else {
        items.push({ key: `node:${node.id}`, kind: 'node', node })
      }
    }
  }
  const phaseHasInput = Boolean(phase?.runId && nodes.some(node => node.kind === 'input' && node.runId === phase.runId))
  if (phase && phaseHasInput) {
    items.push({ key: `node:${phase.id}`, kind: 'node', node: phase })
  }
  return items
}

function linearFlowItemRole(item: LinearTaskFlowItem): 'input' | 'content' {
  if (item.kind === 'node' && item.node.kind === 'input') return 'input'
  return 'content'
}

export function linearFlowGapBefore(
  previous: LinearTaskFlowItem | undefined,
  current: LinearTaskFlowItem,
): LinearFlowGap {
  if (!previous) return 'none'
  const currentRole = linearFlowItemRole(current)
  if (currentRole === 'input') return 'turn'
  return 'content'
}

export function firstVisibleLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() || ''
}

export function latestVisibleLine(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/)
  return lines.at(-1)?.trim() || ''
}

export function reasoningSummary(node: Pick<TaskFlowNode, 'content' | 'status' | 'settled'>): string {
  const content = normalizeThinkingContent(node.content)
  return node.status === 'running' && !node.settled
    ? latestVisibleLine(content)
    : firstVisibleLine(content)
}

function isTerminal(node: TaskFlowNode): boolean {
  return node.settled || TERMINAL_STATUSES.has(node.status)
}

function disclosureChevron(): HTMLElement {
  const chevron = document.createElement('span')
  chevron.className = 'linear-disclosure-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.innerHTML = '<svg viewBox="0 0 16 16"><path d="m6 3.75 4.25 4.25L6 12.25"/></svg>'
  return chevron
}

function toggleDisclosure(root: HTMLElement, expanded: boolean): void {
  root.classList.toggle('expanded', expanded)
  root.querySelector<HTMLElement>('.linear-disclosure-row')?.setAttribute('aria-expanded', String(expanded))
  root.querySelector<HTMLElement>('.linear-disclosure-body')?.setAttribute('aria-hidden', String(!expanded))
}

export function nextReasoningDisclosureState(input: {
  running: boolean
  expanded: boolean
  userExpanded?: boolean
}): { expanded: boolean; userExpanded: boolean } {
  if (input.running && input.expanded && input.userExpanded === undefined) {
    return { expanded: true, userExpanded: true }
  }
  const expanded = !input.expanded
  return { expanded, userExpanded: expanded }
}

function scheduleReasoningCollapse(root: HTMLElement): void {
  if (root.dataset.collapseScheduled === 'true' || root.dataset.userExpanded === 'true') return
  root.dataset.collapseScheduled = 'true'
  window.setTimeout(() => {
    delete root.dataset.collapseScheduled
    if (!root.isConnected || root.dataset.userExpanded === 'true') return
    toggleDisclosure(root, false)
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420)
}

function scrollReasoningToLatest(root: HTMLElement): void {
  window.requestAnimationFrame(() => {
    const body = root.querySelector<HTMLElement>('.linear-reasoning-body')
    if (body) body.scrollTop = body.scrollHeight
  })
}

function createReasoningNode(node: TaskFlowNode): HTMLElement {
  const content = normalizeThinkingContent(node.content)
  const root = document.createElement('section')
  root.className = 'linear-reasoning linear-disclosure'
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading linear-reasoning-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-reasoning-icon'
  icon.innerHTML = toolIcon('think')
  const hoverChevron = disclosureChevron()
  hoverChevron.classList.add('linear-reasoning-hover-chevron')
  leading.append(icon, hoverChevron)
  row.append(leading)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = node.status === 'interrupted' ? '推理已中断' : '推理过程'
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  separator.setAttribute('aria-hidden', 'true')
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = reasoningSummary(node) || (isTerminal(node) ? '已完成推理' : '正在思考')
  row.append(title, separator, summary)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-reasoning-body'
  bodyInner.textContent = content || '正在整理思路…'
  body.append(bodyInner)
  root.append(row, body)
  const running = node.status === 'running' && !node.settled
  root.dataset.status = node.status
  root.classList.toggle('running', running)
  toggleDisclosure(root, running)
  if (running) scrollReasoningToLatest(root)
  row.addEventListener('click', () => {
    const next = nextReasoningDisclosureState({
      running: root.classList.contains('running'),
      expanded: root.classList.contains('expanded'),
      userExpanded: root.dataset.userExpanded === undefined ? undefined : root.dataset.userExpanded === 'true',
    })
    root.dataset.userExpanded = String(next.userExpanded)
    toggleDisclosure(root, next.expanded)
  })
  return root
}

function updateReasoningNode(root: HTMLElement, node: TaskFlowNode): void {
  const content = normalizeThinkingContent(node.content)
  const wasRunning = root.classList.contains('running')
  const running = node.status === 'running' && !node.settled
  root.dataset.status = node.status
  root.classList.toggle('running', running)
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = node.status === 'interrupted' ? '推理已中断' : '推理过程'
  root.querySelector<HTMLElement>('.linear-disclosure-summary')!.textContent = reasoningSummary(node) || (isTerminal(node) ? '已完成推理' : '正在思考')
  root.querySelector<HTMLElement>('.linear-reasoning-body')!.textContent = content || '正在整理思路…'
  if (running && root.dataset.userExpanded !== 'false') toggleDisclosure(root, true)
  if (running) scrollReasoningToLatest(root)
  if (wasRunning && !running) scheduleReasoningCollapse(root)
}

function safeJson(value: string | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compactText(value: unknown, limit = 132): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function friendlyPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '').trim()
  if (!normalized) return ''
  const workspace = normalized.match(/\/workspace\/(?:[^/]+\/)?(.+)$/)?.[1]
  if (workspace) return workspace
  if (/\/workspace\/(?:unscoped)?$/i.test(normalized)) return '当前工作区'
  if (!normalized.startsWith('/')) return compactText(normalized, 96)
  return normalized.split('/').filter(Boolean).slice(-3).join('/') || '当前工作区'
}

function cleanToolProtocol(value: string): string {
  return value
    .replace(/<\s*tool_retry_hint\b[^>]*>[\s\S]*?(?:<\s*\/\s*tool_retry_hint\s*>|$)/gi, '')
    .replace(/<\s*(runtime_context|additional_instructions|recent_files)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi, '')
    .trim()
}

function toolArgumentSummary(call: ToolCall): string {
  const path = friendlyPath(call.arguments.path || call.arguments.file_path)
  if (path) return path
  const candidate = call.arguments.query || call.arguments.url || call.arguments.command || call.arguments.session_id
  return compactText(candidate, 96) || '查看执行详情'
}

const TASK_PLAN_TOOLS = new Set(['create_task', 'create_tasks', 'update_task'])

export function isTaskPlanTool(name: string): boolean {
  return TASK_PLAN_TOOLS.has(name)
}

function taskStatusLabel(status: unknown): string {
  return ({
    pending: '等待',
    in_progress: '开始',
    completed: '完成',
    failed: '遇到问题',
  } as Record<string, string>)[String(status || '')] || '更新'
}

function taskPlanSummary(call: ToolCall, result?: ToolResult): { title: string; summary: string } {
  if (call.name === 'create_tasks') {
    const tasks = Array.isArray(call.arguments.tasks)
      ? call.arguments.tasks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    const firstTitle = compactText(tasks[0]?.title, 72)
    return {
      title: '建立任务计划',
      summary: tasks.length > 0
        ? `${tasks.length} 项${firstTitle ? ` · ${firstTitle}${tasks.length > 1 ? ` +${tasks.length - 1}` : ''}` : ''}`
        : '正在整理工作步骤',
    }
  }
  if (call.name === 'create_task') {
    return { title: '加入任务计划', summary: compactText(call.arguments.title, 88) || '新增 1 项任务' }
  }
  const output = safeJson(result?.output)
  const outputTitle = output && typeof output === 'object' ? compactText((output as Record<string, unknown>).title, 88) : ''
  return {
    title: '更新任务计划',
    summary: `${taskStatusLabel(call.arguments.status)}${outputTitle ? ` · ${outputTitle}` : ''}`,
  }
}

export function toolIconKind(name: string): ToolIconKind {
  const normalized = name.toLowerCase()
  if (isTaskPlanTool(normalized) || /todo|checklist/.test(normalized)) return 'checklist'
  if (/ask|question/.test(normalized)) return 'question'
  if (/browser__search|web_search/.test(normalized)) return 'globe'
  if (/browser__find|grep|glob|search|find/.test(normalized)) return 'search'
  if (/browser__|web_fetch|read|list_directory|list_files/.test(normalized)) return 'browse'
  if (/write|edit|patch|create|delete|move|rename/.test(normalized)) return 'edit'
  if (/bash|terminal|command|shell|exec/.test(normalized)) return 'api'
  return 'sparkle'
}



function toolPresentation(node: TaskFlowNode, tool: LinearTaskFlowTool): {
  title: string
  summary: string
  input: string
  output: string
} {
  const { call, result } = tool
  const plan = isTaskPlanTool(call.name) ? taskPlanSummary(call, result) : undefined
  const title = plan?.title || browserToolActionTitle(call.name) || toolDisplayName(call.name)
  const browserDetail = browserToolResultDetail(call.name, result)
  const change = result?.changeSummary
  const argument = toolArgumentSummary(call)
  const summary = plan?.summary || browserDetail
    || (change ? `${change.path} · +${change.addedLines ?? 0} −${change.removedLines ?? 0}` : '')
    || (result?.isError || node.status === 'failed'
      ? '未能完成，正在调整方案'
      : node.status === 'running'
        ? argument
        : argument === '查看执行详情' ? '已完成' : argument)
  const parsedInput = safeJson(JSON.stringify(call.arguments))
  const input = typeof parsedInput === 'string' ? parsedInput : JSON.stringify(parsedInput, null, 2)
  const outputValue = result?.isError
    ? '本次执行未完成。Agent 已保留错误详情并将调整后续方案。'
    : cleanToolProtocol(result?.output || (node.settled ? node.detail : '') || '')
  const parsedOutput = safeJson(outputValue)
  const output = typeof parsedOutput === 'string' ? parsedOutput : JSON.stringify(parsedOutput, null, 2)
  return { title, summary, input: input || '{}', output }
}

function appendToolDetailSection(host: HTMLElement, labelText: string, value: string): void {
  if (!value) return
  const section = document.createElement('section')
  section.className = 'linear-tool-detail-section'
  section.dataset.detailKind = labelText
  const label = document.createElement('span')
  label.className = 'linear-tool-detail-label'
  label.textContent = labelText
  const pre = document.createElement('pre')
  pre.textContent = value
  section.append(label, pre)
  host.append(section)
}

function updateToolDetailSection(host: HTMLElement, labelText: string, value: string): void {
  const selector = `.linear-tool-detail-section[data-detail-kind="${CSS.escape(labelText)}"]`
  const existing = host.querySelector<HTMLElement>(selector)
  if (!value) {
    existing?.remove()
    return
  }
  if (!existing) {
    appendToolDetailSection(host, labelText, value)
    return
  }
  existing.querySelector('pre')!.textContent = value
}

function createToolNode(node: TaskFlowNode, tool: LinearTaskFlowTool): HTMLElement {
  const presentation = toolPresentation(node, tool)
  const root = document.createElement('section')
  root.className = `linear-tool linear-disclosure status-${node.status}`
  root.classList.toggle('linear-plan-audit', isTaskPlanTool(tool.call.name))
  root.dataset.toolId = node.callId || tool.call.id
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row linear-tool-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-tool-icon'
  icon.dataset.toolName = tool.call.name
  icon.innerHTML = toolIcon(toolIconKind(tool.call.name))
  const hoverChevron = disclosureChevron()
  hoverChevron.classList.add('linear-tool-hover-chevron')
  leading.append(icon, hoverChevron)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = presentation.title
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  separator.setAttribute('aria-hidden', 'true')
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = presentation.summary
  const status = document.createElement('span')
  status.className = 'visually-hidden'
  status.textContent = node.status === 'running'
    ? '执行中'
    : node.status === 'failed'
      ? '失败'
      : node.status === 'cancelled' || node.status === 'interrupted'
        ? '已停止'
        : '完成'
  row.append(leading, title, separator, summary, status)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-tool-body'
  appendToolDetailSection(bodyInner, '输入', presentation.input)
  appendToolDetailSection(bodyInner, '输出', presentation.output)
  if (tool.result?.changeSummary && tool.onPreviewDiff) {
    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'linear-tool-preview'
    preview.textContent = '查看文件变更'
    preview.addEventListener('click', event => {
      event.stopPropagation()
      tool.onPreviewDiff?.(tool.result!.changeSummary!)
    })
    bodyInner.append(preview)
  }
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.addEventListener('click', () => {
    const expanded = !root.classList.contains('expanded')
    root.dataset.userExpanded = String(expanded)
    toggleDisclosure(root, expanded)
  })
  return root
}

function updateToolNode(root: HTMLElement, node: TaskFlowNode, tool: LinearTaskFlowTool): boolean {
  if (!root.classList.contains('linear-tool') || root.classList.contains('linear-tool-group')) return false
  const presentation = toolPresentation(node, tool)
  root.classList.remove('status-waiting', 'status-running', 'status-completed', 'status-failed', 'status-cancelled', 'status-interrupted')
  root.classList.add(`status-${node.status}`)
  root.classList.toggle('linear-plan-audit', isTaskPlanTool(tool.call.name))
  root.dataset.toolId = node.callId || tool.call.id
  const icon = root.querySelector<HTMLElement>('.linear-tool-icon')
  if (icon && icon.dataset.toolName !== tool.call.name) {
    icon.innerHTML = toolIcon(toolIconKind(tool.call.name))
    icon.dataset.toolName = tool.call.name
  }
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = presentation.title
  root.querySelector<HTMLElement>('.linear-disclosure-summary')!.textContent = presentation.summary
  root.querySelector<HTMLElement>('.visually-hidden')!.textContent = node.status === 'running'
    ? '执行中'
    : node.status === 'failed'
      ? '失败'
      : node.status === 'cancelled' || node.status === 'interrupted'
        ? '已停止'
        : '完成'
  const body = root.querySelector<HTMLElement>('.linear-tool-body')!
  updateToolDetailSection(body, '输入', presentation.input)
  updateToolDetailSection(body, '输出', presentation.output)
  const preview = body.querySelector<HTMLButtonElement>('.linear-tool-preview')
  if (tool.result?.changeSummary && tool.onPreviewDiff) {
    const button = preview || document.createElement('button')
    if (!preview) {
      button.type = 'button'
      button.className = 'linear-tool-preview'
      body.append(button)
    }
    button.textContent = '查看文件变更'
    button.onclick = event => {
      event.stopPropagation()
      tool.onPreviewDiff?.(tool.result!.changeSummary!)
    }
  } else {
    preview?.remove()
  }
  return true
}

export function groupedToolStatus(item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>): TaskFlowNode['status'] {
  if (item.active && item.group !== 'repeat') return 'running'
  if (item.nodes.some(node => node.status === 'running' && !node.settled)) return 'running'
  if (item.nodes.some(node => node.status === 'failed')) return 'failed'
  if (item.nodes.some(node => node.status === 'cancelled')) return 'cancelled'
  if (item.nodes.some(node => node.status === 'interrupted')) return 'interrupted'
  if (item.nodes.some(node => node.status === 'waiting')) return 'waiting'
  return 'completed'
}

function browserToolGroupTitle(group: LinearToolGroupKind, repeatedTitle = '', count = 2): string {
  if (count === 1) return repeatedTitle || '浏览器操作'
  if (group === 'repeat') return repeatedTitle || '重复工具调用'
  if (group === 'keyboard') return '浏览器键盘操作'
  if (group === 'scroll') return '浏览器页面滚动'
  return '浏览器状态检查'
}

function toolGroupSummary(item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>, status: TaskFlowNode['status'], firstSummary: string): string {
  const statusLabel = item.group === 'repeat'
    ? firstSummary
    : status === 'running'
      ? '进行中'
      : status === 'failed'
        ? '部分未完成'
        : status === 'cancelled' || status === 'interrupted'
          ? '已停止'
          : '已完成'
  return `${item.nodes.length} 次 · ${statusLabel}`
}

function createToolGroupEntry(node: TaskFlowNode, options: LinearTaskFlowRendererOptions, index: number): HTMLDetailsElement {
  const presentation = toolPresentation(node, options.resolveTool(node))
  const detail = document.createElement('details')
  detail.className = 'linear-tool-group-entry'
  detail.dataset.taskFlowNodeId = node.id
  const entrySummary = document.createElement('summary')
  const entryTitle = document.createElement('strong')
  entryTitle.textContent = `${index + 1}. ${presentation.title}`
  const entryDetail = document.createElement('span')
  entryDetail.textContent = presentation.summary
  entrySummary.append(entryTitle, entryDetail)
  const entryBody = document.createElement('div')
  entryBody.className = 'linear-tool-group-entry-body'
  appendToolDetailSection(entryBody, '输入', presentation.input)
  appendToolDetailSection(entryBody, '输出', presentation.output)
  detail.append(entrySummary, entryBody)
  return detail
}

function updateToolGroupEntry(
  detail: HTMLDetailsElement,
  node: TaskFlowNode,
  options: LinearTaskFlowRendererOptions,
  index: number,
): void {
  const presentation = toolPresentation(node, options.resolveTool(node))
  detail.dataset.taskFlowNodeId = node.id
  detail.querySelector<HTMLElement>(':scope > summary > strong')!.textContent = `${index + 1}. ${presentation.title}`
  detail.querySelector<HTMLElement>(':scope > summary > span')!.textContent = presentation.summary
  const body = detail.querySelector<HTMLElement>(':scope > .linear-tool-group-entry-body')!
  updateToolDetailSection(body, '输入', presentation.input)
  updateToolDetailSection(body, '输出', presentation.output)
}

function createToolGroupNode(
  item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>,
  options: LinearTaskFlowRendererOptions,
): HTMLElement {
  const status = groupedToolStatus(item)
  const firstPresentation = toolPresentation(item.nodes[0]!, options.resolveTool(item.nodes[0]!))
  const root = document.createElement('section')
  root.className = `linear-tool linear-tool-group linear-disclosure status-${status}`
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row linear-tool-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-tool-icon'
  const firstToolName = item.nodes[0]?.toolName || item.nodes[0]?.content || 'browser__observe'
  icon.dataset.toolName = firstToolName
  icon.innerHTML = toolIcon(toolIconKind(firstToolName))
  const hoverChevron = disclosureChevron()
  hoverChevron.classList.add('linear-tool-hover-chevron')
  leading.append(icon, hoverChevron)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = browserToolGroupTitle(item.group, firstPresentation.title, item.nodes.length)
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = toolGroupSummary(item, status, firstPresentation.summary)
  row.append(leading, title, separator, summary)

  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-tool-group-body'
  for (const [index, node] of item.nodes.entries()) bodyInner.append(createToolGroupEntry(node, options, index))
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.addEventListener('click', () => {
    const expanded = !root.classList.contains('expanded')
    root.dataset.userExpanded = String(expanded)
    toggleDisclosure(root, expanded)
  })
  return root
}

function updateToolGroupNode(
  root: HTMLElement,
  item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>,
  options: LinearTaskFlowRendererOptions,
): boolean {
  if (!root.classList.contains('linear-tool-group')) return false
  const status = groupedToolStatus(item)
  const firstNode = item.nodes[0]
  if (!firstNode) return false
  const firstPresentation = toolPresentation(firstNode, options.resolveTool(firstNode))
  root.classList.remove('status-waiting', 'status-running', 'status-completed', 'status-failed', 'status-cancelled', 'status-interrupted')
  root.classList.add(`status-${status}`)
  const icon = root.querySelector<HTMLElement>('.linear-tool-icon')
  const toolName = firstNode.toolName || firstNode.content || 'browser__observe'
  if (icon && icon.dataset.toolName !== toolName) {
    icon.dataset.toolName = toolName
    icon.innerHTML = toolIcon(toolIconKind(toolName))
  }
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = browserToolGroupTitle(item.group, firstPresentation.title, item.nodes.length)
  root.querySelector<HTMLElement>('.linear-disclosure-summary')!.textContent = toolGroupSummary(item, status, firstPresentation.summary)

  const body = root.querySelector<HTMLElement>('.linear-tool-group-body')!
  const desired = new Set(item.nodes.map(node => node.id))
  const entries = new Map(Array.from(body.querySelectorAll<HTMLDetailsElement>(':scope > .linear-tool-group-entry'))
    .map(entry => [entry.dataset.taskFlowNodeId || '', entry]))
  for (const entry of entries.values()) {
    if (!desired.has(entry.dataset.taskFlowNodeId || '')) entry.remove()
  }
  let cursor: ChildNode | null = body.firstChild
  for (const [index, node] of item.nodes.entries()) {
    let entry = entries.get(node.id)
    if (!entry) entry = createToolGroupEntry(node, options, index)
    else updateToolGroupEntry(entry, node, options, index)
    if (entry !== cursor) body.insertBefore(entry, cursor)
    cursor = entry.nextSibling
  }
  return true
}

export function phaseTitle(node: Pick<TaskFlowNode, 'content' | 'status'>): string {
  if (node.status === 'failed') return '任务遇到问题'
  if (node.status === 'cancelled' || node.status === 'interrupted') return '任务已停止'
  if (node.status === 'completed') return '任务已完成'
  const normalized = node.content.trim().toLowerCase()
  if (normalized.includes('paused by user') || normalized === 'paused') return '工作已暂停'
  if (normalized.includes('resuming')) return '正在继续工作'
  if (normalized.includes('planning') || normalized.includes('next step')) return '请求中'
  if (/running\s+\d+\s+tools?/.test(normalized) || normalized.includes('tool_running')) return '正在执行工具'
  if (normalized.includes('thinking')) return '请求中'
  if (normalized.includes('compact')) return '正在整理上下文'
  if (normalized.includes('approval')) return '等待确认后继续'
  if (normalized.includes('input')) return '等待补充信息'
  if (normalized.includes('abort')) return '正在停止任务'
  return node.content.trim() || '请求中'
}

function createRuntimeNode(node: TaskFlowNode): HTMLElement {
  if (node.kind === 'phase' && node.status === 'running') {
    const row = document.createElement('div')
    row.className = 'linear-turn-status'
    row.setAttribute('role', 'status')
    row.textContent = phaseTitle(node)
    return row
  }
  const root = document.createElement('section')
  root.className = `linear-runtime linear-disclosure status-${node.status}`
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row'
  row.append(disclosureChevron())
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = node.kind === 'approval' ? '等待确认' : phaseTitle(node)
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = node.detail || node.content
  row.append(title, separator, summary)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-runtime-body'
  bodyInner.textContent = node.detail || node.content
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.addEventListener('click', () => toggleDisclosure(root, !root.classList.contains('expanded')))
  return root
}

function nodeContent(
  node: TaskFlowNode,
  options: LinearTaskFlowRendererOptions,
  finalDelivery = false,
): HTMLElement {
  if (node.kind === 'input') return options.createInput(node)
  if (node.kind === 'answer') return options.createAnswer(node, { finalDelivery })
  if (node.kind === 'thinking') return createReasoningNode(node)
  if (node.kind === 'tool') return createToolNode(node, options.resolveTool(node))
  return createRuntimeNode(node)
}

function updateRunningAnswerElement(element: HTMLElement, node: TaskFlowNode): boolean {
  const row = element.querySelector<HTMLElement>(':scope > .message-row.assistant')
  if (!shouldUpdateLinearAnswerInPlace(node, Boolean(row)) || !row) return false
  let content = row.querySelector<HTMLElement>('.message-content')
  if (!content) {
    content = document.createElement('div')
    content.className = 'message-content'
    row.append(content)
  }
  row.classList.add('streaming')
  const visible = stripTextToolCallMarkup(node.content, { stripIncomplete: true }).trim()
  renderMarkdown(content, visible || '…', true)
  return true
}

function directPreservedChildren(host: HTMLElement): HTMLElement[] {
  return Array.from(host.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement
    && !child.dataset.linearFlowKey
    && (
      child.classList.contains('request-card')
      || child.classList.contains('conversation-failure')
      || child.classList.contains('optimistic-user-turn')
      || child.classList.contains('history-rewrite-leading-space')
      || child.classList.contains('history-rewrite-viewport-space')
    )
  ))
}

export function createLinearTaskFlowRenderer(
  host: HTMLElement,
  options: LinearTaskFlowRendererOptions,
): LinearTaskFlowRenderer {
  const elements = new Map<string, HTMLElement>()

  const render = (state: TaskFlowProjectionState, force = false): void => {
    host.classList.add('linear-task-flow')
    const items = linearTaskFlowItems(state)
    const finalAnswerByRun = new Map<string, string>()
    for (const item of items) {
      if (item.kind === 'node' && item.node.kind === 'answer' && item.node.runId) {
        finalAnswerByRun.set(item.node.runId, item.node.id)
      }
    }
    const desired = new Set(items.map(item => item.key))
    const preserved = directPreservedChildren(host)
    const preservedSet = new Set(preserved)
    for (const child of Array.from(host.children)) {
      if (!(child instanceof HTMLElement) || child.dataset.linearFlowKey || preservedSet.has(child)) continue
      child.remove()
    }
    for (const [key, element] of elements) {
      if (desired.has(key)) continue
      element.remove()
      elements.delete(key)
    }

    const leading = preserved.filter(element => element.classList.contains('history-rewrite-leading-space'))
    let cursor: ChildNode | null = leading.at(-1)?.nextSibling || host.firstChild
    for (const [index, item] of items.entries()) {
      let element = elements.get(item.key)
      if (!element) {
        element = document.createElement('div')
        element.dataset.linearFlowKey = item.key
        if (item.kind === 'tool-group') {
          element.className = 'linear-flow-item linear-flow-tool linear-flow-tool-group'
          element.dataset.runId = item.runId || ''
        } else {
          element.className = `linear-flow-item linear-flow-${item.node.kind}`
          element.dataset.taskFlowNodeId = item.node.id
          element.dataset.runId = item.node.runId || ''
        }
        elements.set(item.key, element)
      }
      element.dataset.flowGap = linearFlowGapBefore(items[index - 1], item)
      if (item.kind === 'tool-group') {
        element.classList.toggle('is-running', item.nodes.some(node => node.status === 'running' && !node.settled))
        const version = item.nodes.map(node => [
          node.id,
          node.status,
          node.settled ? 1 : 0,
          node.updatedAt,
          node.detail?.length || 0,
          options.nodeVersion?.(node) || '',
        ].join(':')).join('|')
        if (force || element.dataset.linearFlowVersion !== version) {
          const previousDisclosure = element.querySelector<HTMLElement>('.linear-disclosure')
          const previousExpanded = previousDisclosure?.classList.contains('expanded') === true
          const previousUserExpanded = previousDisclosure?.dataset.userExpanded
          if (
            !(element.firstElementChild instanceof HTMLElement)
            || !updateToolGroupNode(element.firstElementChild, item, options)
          ) {
            const content = createToolGroupNode(item, options)
            if (previousUserExpanded !== undefined) content.dataset.userExpanded = previousUserExpanded
            if (previousExpanded) toggleDisclosure(content, true)
            element.replaceChildren(content)
          }
          element.dataset.linearFlowVersion = version
        }
      } else if (item.kind === 'node') {
        const run = item.node.runId ? options.resolveRun?.(item.node.runId) : undefined
        const finalDelivery = isFinalDeliveryAnswer({
          nodeKind: item.node.kind,
          nodeId: item.node.id,
          runId: item.node.runId,
          finalAnswerId: item.node.runId ? finalAnswerByRun.get(item.node.runId) : undefined,
          runStatus: run?.status,
        })
        element.classList.toggle('is-running', item.node.status === 'running' && !item.node.settled)
        const version = [
          item.node.status,
          item.node.settled ? 1 : 0,
          item.node.updatedAt,
          item.node.content.length,
          item.node.detail?.length || 0,
          finalDelivery ? 1 : 0,
          options.nodeVersion?.(item.node) || '',
        ].join(':')
        if (force || element.dataset.linearFlowVersion !== version) {
          const previousDisclosure = element.querySelector<HTMLElement>('.linear-disclosure')
          const previousExpanded = previousDisclosure?.classList.contains('expanded') === true
          const previousUserExpanded = previousDisclosure?.dataset.userExpanded
          const previousStatus = previousDisclosure?.dataset.status
          if (item.node.kind === 'thinking' && previousDisclosure) {
            updateReasoningNode(previousDisclosure, item.node)
          } else if (
            item.node.kind === 'tool'
            && element.firstElementChild instanceof HTMLElement
            && updateToolNode(element.firstElementChild, item.node, options.resolveTool(item.node))
          ) {
          } else if (!updateRunningAnswerElement(element, item.node)) {
            const content = nodeContent(item.node, options, finalDelivery)
            if (previousUserExpanded !== undefined) content.dataset.userExpanded = previousUserExpanded
            if (previousExpanded && content.classList.contains('linear-disclosure')) toggleDisclosure(content, true)
            element.replaceChildren(content)
          }
          if (
            item.node.kind === 'thinking'
            && previousStatus === 'running'
            && item.node.status !== 'running'
            && previousDisclosure
          ) scheduleReasoningCollapse(previousDisclosure)
          element.dataset.linearFlowVersion = version
        }
      }
      if (element !== cursor) host.insertBefore(element, cursor)
      cursor = element.nextSibling
    }
  }

  return {
    render,
    clear: () => {
      for (const element of elements.values()) element.remove()
      elements.clear()
      host.classList.remove('linear-task-flow')
    },
  }
}

export function createFallbackLinearMessage(node: TaskFlowNode, role: 'user' | 'assistant'): HTMLElement {
  const row = document.createElement('article')
  row.className = `message-row ${role}${node.status === 'running' ? ' streaming' : ''}`
  if (node.turnId) row.dataset.turnId = node.turnId
  const content = document.createElement('div')
  content.className = 'message-content'
  if (role === 'assistant') renderMarkdown(content, node.content || '…', node.status === 'running')
  else content.textContent = node.content
  row.append(content)
  return row
}
