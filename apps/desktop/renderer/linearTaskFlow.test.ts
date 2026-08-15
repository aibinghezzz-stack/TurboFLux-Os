import { describe, expect, it } from 'vitest'
import {
  browserToolGroupKind,
  firstVisibleLine,
  deepSeekHarnessToolIconKind,
  groupedToolStatus,
  isFinalDeliveryAnswer,
  isTaskPlanTool,
  latestVisibleLine,
  linearFlowGapBefore,
  linearTaskFlowItems,
  nextReasoningDisclosureState,
  phaseTitle,
  reasoningSummary,
  shouldDeferCanonicalTaskFlowRender,
  shouldUpdateLinearAnswerInPlace,
} from './linearTaskFlow'
import type { TaskFlowNode, TaskFlowProjectionState } from './taskFlowProjection'

function node(id: string, kind: TaskFlowNode['kind'], content: string, runId = 'run-1'): TaskFlowNode {
  return {
    id,
    runId,
    ordinal: 1,
    kind,
    phase: kind === 'thinking' ? 'reasoning' : kind === 'answer' ? 'delivery' : kind === 'input' ? 'control' : 'execution',
    status: 'completed',
    content,
    createdAt: 1,
    updatedAt: 1,
    settled: true,
  }
}

describe('linear task flow', () => {
  it('renders assistant response segments without product signatures', () => {
    const nodes = {
      input: node('input', 'input', '开始'),
      thinking: node('thinking', 'thinking', '分析'),
      tool: node('tool', 'tool', 'read_file'),
      answer: node('answer', 'answer', '完成'),
      steering: node('steering', 'input', '继续'),
      next: node('next', 'thinking', '继续分析'),
    }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      lastSeq: 6,
      nodes,
      order: ['input', 'thinking', 'tool', 'answer', 'steering', 'next'],
      sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:thinking',
      'node:tool',
      'node:answer',
      'node:steering',
      'node:next',
    ])
  })

  it('derives one non-stacking rhythm from adjacent semantic items', () => {
    const input = { key: 'node:input', kind: 'node' as const, node: node('input', 'input', '开始') }
    const answer = { key: 'node:answer', kind: 'node' as const, node: node('answer', 'answer', '正文') }
    const tool = { key: 'node:tool', kind: 'node' as const, node: node('tool', 'tool', 'read_file') }
    const nextInput = { key: 'node:next-input', kind: 'node' as const, node: node('next-input', 'input', '继续') }

    expect(linearFlowGapBefore(undefined, input)).toBe('none')
    expect(linearFlowGapBefore(input, answer)).toBe('content')
    expect(linearFlowGapBefore(answer, tool)).toBe('content')
    expect(linearFlowGapBefore(tool, answer)).toBe('content')
    expect(linearFlowGapBefore(answer, nextInput)).toBe('turn')
  })

  it('moves an early phase to the tail without adding presentation nodes', () => {
    const nodes = {
      phase: { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false },
      input: node('input', 'input', '开始'),
      thinking: node('thinking', 'thinking', '分析'),
      tool: node('tool', 'tool', 'read_file'),
    }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      activeRunId: 'run-1',
      lastSeq: 4,
      nodes,
      order: ['phase', 'thinking', 'input', 'tool'],
      sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:thinking',
      'node:tool',
      'node:phase',
    ])
  })

  it('moves each run input ahead of interleaved work without changing run order', () => {
    const toolB = node('tool-b', 'tool', 'read b', 'run-b')
    const toolA = node('tool-a', 'tool', 'read a', 'run-a')
    const inputA = node('input-a', 'input', 'start a', 'run-a')
    const inputB = node('input-b', 'input', 'start b', 'run-b')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      lastSeq: 4,
      nodes: {
        'tool-b': toolB,
        'tool-a': toolA,
        'input-a': inputA,
        'input-b': inputB,
      },
      order: ['tool-b', 'tool-a', 'input-a', 'input-b'],
      sequenceGaps: [],
    }

    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input-b',
      'node:tool-b',
      'node:input-a',
      'node:tool-a',
    ])
  })

  it('suppresses the phase placeholder while real active work is visible', () => {
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const thinking = { ...node('thinking', 'thinking', '正在分析'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { phase, thinking }, order: ['phase', 'thinking'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:thinking',
    ])
  })

  it('keeps one canonical request phase below the user input', () => {
    const input = node('input', 'input', '开始')
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { input, phase }, order: ['input', 'phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:phase',
    ])
  })

  it('does not restore a running request phase after the answer is visible', () => {
    const input = node('input', 'input', '开始')
    const answer = node('answer', 'answer', '最终答案')
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 3,
      nodes: { input, answer, phase }, order: ['input', 'answer', 'phase'], sequenceGaps: [],
    }

    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:answer',
    ])
  })

  it('does not show a run phase before its user input exists', () => {
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 1,
      nodes: { phase }, order: ['phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state)).toEqual([])
  })

  it('groups settled browser inspections across one run while keeping raw nodes', () => {
    const observe = { ...node('observe', 'tool', 'browser__observe'), toolName: 'browser__observe' }
    const diagnostics = { ...node('diagnostics', 'tool', 'browser__diagnostics'), toolName: 'browser__diagnostics' }
    const visual = { ...node('visual', 'tool', 'browser__visual_observe'), toolName: 'browser__visual_observe' }
    const thinking = node('thinking', 'thinking', '核对页面状态')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 4,
      nodes: { observe, thinking, diagnostics, visual },
      order: ['observe', 'thinking', 'diagnostics', 'visual'],
      sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state)
    expect(items.map(item => item.key)).toEqual([
      'tool-group:observe',
      'node:thinking',
    ])
    expect(items[0]).toMatchObject({ kind: 'tool-group', group: 'inspection' })
    expect(items[0]?.kind === 'tool-group' ? items[0].nodes.map(item => item.id) : []).toEqual([
      'observe',
      'diagnostics',
      'visual',
    ])
  })

  it('keeps browser inspection grouping stable while the latest call is running', () => {
    const completed = { ...node('completed', 'tool', 'browser__observe'), toolName: 'browser__observe' }
    const running = { ...node('running', 'tool', 'browser__observe'), toolName: 'browser__observe', status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { completed, running }, order: ['completed', 'running'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'tool-group:completed',
    ])
    expect(linearTaskFlowItems(state)[0]).toMatchObject({
      kind: 'tool-group',
      group: 'inspection',
      nodes: [completed, running],
      active: true,
    })
  })

  it('does not change the browser group key when a call settles', () => {
    const running = { ...node('observe', 'tool', 'browser__observe'), toolName: 'browser__observe', status: 'running' as const, settled: false }
    const completed = { ...running, status: 'completed' as const, settled: true }
    const state = (tool: TaskFlowNode): TaskFlowProjectionState => ({
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 1,
      nodes: { observe: tool }, order: ['observe'], sequenceGaps: [],
    })
    expect(browserToolGroupKind(running)).toBe('inspection')
    expect(linearTaskFlowItems(state(running))[0]?.key).toBe('tool-group:observe')
    expect(linearTaskFlowItems(state(completed))[0]?.key).toBe('tool-group:observe')
    const activeGroup = linearTaskFlowItems(state(completed))[0]
    expect(activeGroup).toMatchObject({ active: true })
    expect(activeGroup?.kind === 'tool-group' ? groupedToolStatus(activeGroup) : null).toBe('running')
    const settledGroup = linearTaskFlowItems({ ...state(completed), activeRunId: undefined })[0]
    expect(settledGroup?.kind === 'tool-group' ? groupedToolStatus(settledGroup) : null).toBe('completed')
  })

  it('collapses exact consecutive duplicate tool results', () => {
    const first = { ...node('search-1', 'tool', 'search_content'), toolName: 'search_content', detail: 'same result' }
    const second = { ...node('search-2', 'tool', 'search_content'), toolName: 'search_content', detail: 'same result' }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 2,
      nodes: { first, second }, order: ['first', 'second'], sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state)
    expect(items.map(item => item.key)).toEqual(['tool-group:search-1'])
    expect(items[0]).toMatchObject({ kind: 'tool-group', group: 'repeat' })
  })

  it('recognizes task mutations as semantic plan audit rows', () => {
    expect(isTaskPlanTool('create_task')).toBe(true)
    expect(isTaskPlanTool('create_tasks')).toBe(true)
    expect(isTaskPlanTool('update_task')).toBe(true)
    expect(isTaskPlanTool('read_file')).toBe(false)
  })

  it('uses the DeepSeek Harness tool icon families', () => {
    expect(deepSeekHarnessToolIconKind('browser__open')).toBe('browse')
    expect(deepSeekHarnessToolIconKind('web_search')).toBe('globe')
    expect(deepSeekHarnessToolIconKind('grep')).toBe('search')
    expect(deepSeekHarnessToolIconKind('read_file')).toBe('browse')
    expect(deepSeekHarnessToolIconKind('apply_patch')).toBe('edit')
    expect(deepSeekHarnessToolIconKind('run_command')).toBe('api')
    expect(deepSeekHarnessToolIconKind('create_tasks')).toBe('checklist')
  })

  it('does not render settled phases as conversation rows', () => {
    const phase = node('phase', 'phase', 'completed')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 1,
      nodes: { phase }, order: ['phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state)).toEqual([])
  })

  it('localizes pause and resume runtime phases', () => {
    expect(phaseTitle({ content: 'Paused by user', status: 'running' })).toBe('工作已暂停')
    expect(phaseTitle({ content: 'Resuming run', status: 'running' })).toBe('正在继续工作')
  })

  it('uses the latest reasoning line while streaming and the first when settled', () => {
    expect(firstVisibleLine('第一步\n第二步')).toBe('第一步')
    expect(latestVisibleLine('第一步\n第二步\n')).toBe('第二步')
    expect(reasoningSummary({ content: '第一步\n第二步', status: 'running', settled: false })).toBe('第二步')
    expect(reasoningSummary({ content: '第一步\n第二步', status: 'completed', settled: true })).toBe('第一步')
  })

  it('turns the running preview into a full user expansion on the first click', () => {
    expect(nextReasoningDisclosureState({ running: true, expanded: true })).toEqual({
      expanded: true,
      userExpanded: true,
    })
    expect(nextReasoningDisclosureState({ running: true, expanded: true, userExpanded: true })).toEqual({
      expanded: false,
      userExpanded: false,
    })
  })

  it('only exposes message actions on the final answer of a terminal run', () => {
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-1', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'completed',
    })).toBe(false)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'running',
    })).toBe(false)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'completed',
    })).toBe(true)
  })

  it('keeps streaming answers on one stable DOM node', () => {
    const running = { ...node('answer', 'answer', '正在输出'), status: 'running' as const, settled: false }
    expect(shouldUpdateLinearAnswerInPlace(running, true)).toBe(true)
    expect(shouldUpdateLinearAnswerInPlace(running, false)).toBe(false)
    expect(shouldUpdateLinearAnswerInPlace(node('answer', 'answer', '完成'), true)).toBe(false)
  })

  it('defers canonical rendering while live transcript nodes own the stream', () => {
    expect(shouldDeferCanonicalTaskFlowRender({
      streamingAnswer: true, streamingReasoning: false,
    })).toBe(true)
    expect(shouldDeferCanonicalTaskFlowRender({
      streamingAnswer: false, streamingReasoning: false,
    })).toBe(false)
    expect(shouldDeferCanonicalTaskFlowRender({
      force: true, streamingAnswer: true, streamingReasoning: true,
    })).toBe(false)
  })
})
