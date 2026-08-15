import './styles.css'
import {
  createFallbackLinearMessage,
  createLinearTaskFlowRenderer,
} from './linearTaskFlow'
import type { TaskFlowNode, TaskFlowProjectionState } from './taskFlowProjection'
import { createWorkPlanDockRenderer } from './workPlanPresentation'
import type { WorkRun, WorkStep } from '@turboflux/agent-core/workbench'

const app = document.querySelector<HTMLDivElement>('#work-flow-preview')!

app.innerHTML = `
  <main class="work-flow-preview-page main-panel">
    <header><strong>任务流验收</strong><span>稳定顺序、运行展开、完成收束</span></header>
    <section class="work-plan-dock" aria-live="polite"></section>
    <section class="main-scroll conversation-mode">
      <section class="transcript"></section>
    </section>
  </main>
`

function node(input: Partial<TaskFlowNode> & Pick<TaskFlowNode, 'id' | 'kind' | 'content'>): TaskFlowNode {
  return {
    runId: 'run-live',
    ordinal: 1,
    phase: input.kind === 'thinking'
      ? 'reasoning'
      : input.kind === 'answer'
        ? 'delivery'
        : input.kind === 'input'
          ? 'control'
          : 'execution',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settled: true,
    ...input,
  }
}

const nodes = {
  input: node({ id: 'input', kind: 'input', turnId: 'user-1', content: '重构 Work 流，并完整检查长任务的展开、折叠与输出。' }),
  thinking: node({
    id: 'thinking',
    kind: 'thinking',
    status: 'running',
    settled: false,
    content: '正在检查当前任务数据。\n已经确认 keyed 节点顺序。\n正在验收滚动与工具详情。',
  }),
  plan: node({
    id: 'plan',
    kind: 'tool',
    callId: 'plan-1',
    toolName: 'create_tasks',
    content: 'create_tasks',
  }),
  read: node({
    id: 'read',
    kind: 'tool',
    callId: 'read-1',
    toolName: 'read_file',
    content: 'read_file',
    detail: JSON.stringify({ path: 'apps/desktop/renderer/workbench.ts' }),
  }),
  browser: node({
    id: 'browser',
    kind: 'tool',
    callId: 'browser-1',
    toolName: 'browser__click',
    status: 'running',
    settled: false,
    content: 'browser__click',
    detail: JSON.stringify({ target: '任务流参考页面' }),
  }),
  answer: node({
    id: 'answer',
    kind: 'answer',
    turnId: 'assistant-1',
    status: 'running',
    settled: false,
    content: '已完成新的线性任务流骨架，正在继续检查细节与真实运行行为。',
  }),
  phase: node({
    id: 'phase',
    kind: 'phase',
    status: 'running',
    settled: false,
    content: '正在深入处理…',
  }),
} satisfies Record<string, TaskFlowNode>

const state: TaskFlowProjectionState = {
  conversationId: 'preview',
  source: 'work',
  revision: 1,
  activeRunId: 'run-live',
  lastSeq: 6,
  nodes,
  order: ['input', 'thinking', 'plan', 'read', 'browser', 'answer', 'phase'],
  sequenceGaps: [],
}

const transcript = app.querySelector<HTMLElement>('.transcript')!
const renderer = createLinearTaskFlowRenderer(transcript, {
  createInput: item => createFallbackLinearMessage(item, 'user'),
  createAnswer: item => createFallbackLinearMessage(item, 'assistant'),
  resolveTool: item => {
    if (item.callId === 'plan-1') {
      return {
        call: {
          id: 'plan-1',
          name: 'create_tasks',
          arguments: {
            tasks: [
              { title: '核对任务数据链', description: '', priority: 'major' },
              { title: '实现当前轮任务投影', description: '', priority: 'major' },
              { title: '验收投影布局与恢复', description: '', priority: 'medium' },
            ],
          },
        },
        result: { toolCallId: 'plan-1', name: 'create_tasks', output: '{"created":3}', isError: false },
      }
    }
    if (item.callId === 'browser-1') {
      return {
        call: { id: 'browser-1', name: 'browser__click', arguments: { target: '任务流参考页面' } },
      }
    }
    return {
      call: { id: 'read-1', name: 'read_file', arguments: { path: 'apps/desktop/renderer/workbench.ts' } },
      result: {
        toolCallId: 'read-1',
        name: 'read_file',
        output: '读取完成：定位到 canonical Work projection 与 renderer 接缝。',
        isError: false,
      },
    }
  },
})
renderer.render(state)

function step(id: string, title: string, order: number, status: WorkStep['status']): WorkStep {
  return {
    id,
    runId: 'run-live',
    title,
    description: '',
    status,
    parentId: null,
    childIds: [],
    dependencyIds: [],
    order,
    progress: status === 'completed' ? 100 : null,
    progressMode: status === 'completed' ? 'explicit' : 'indeterminate',
    activityIds: [],
    createdAt: order,
    updatedAt: Date.now(),
  }
}

const previewRun: WorkRun = {
  id: 'run-live',
  conversationId: 'preview',
  objective: '完整改进 Work 任务投影',
  presentation: 'work',
  status: 'running',
  phase: 'tool_running',
  rootStepIds: ['research', 'projection', 'acceptance'],
  steps: {
    research: step('research', '核对任务数据链', 1, 'completed'),
    projection: step('projection', '实现当前轮任务投影', 2, 'running'),
    acceptance: step('acceptance', '验收投影布局与恢复', 3, 'pending'),
  },
  activities: {},
  startedAt: Date.now() - 38_000,
  updatedAt: Date.now(),
}
createWorkPlanDockRenderer(app.querySelector<HTMLElement>('.work-plan-dock')!).render(previewRun)

const previewStyle = document.createElement('style')
previewStyle.textContent = `
  body { overflow: hidden; background: #f4f4f1; }
  .work-flow-preview-page { position: relative; display: flex; width: min(1380px, calc(100vw - 64px)); height: calc(100vh - 64px); margin: 32px auto; overflow: hidden; flex-direction: column; border: 1px solid rgba(34,34,31,.1); border-radius: 14px; background: #fff; box-shadow: 0 24px 70px rgba(34,34,31,.08); }
  .work-flow-preview-page > header { display: flex; height: 48px; align-items: center; gap: 9px; padding: 0 20px; border-bottom: 1px solid var(--line); }
  .work-flow-preview-page > header strong { font-size: 13px; font-weight: 630; }
  .work-flow-preview-page > header span { color: var(--muted); font-size: 11px; }
  .work-flow-preview-page .main-scroll { justify-content: flex-start; padding-top: 16px; }
`
document.head.append(previewStyle)
