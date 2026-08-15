import { describe, expect, it } from 'vitest'
import type { AgentEventType } from '../../core/agentEngine'
import type { AgentSession, AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import { ConversationEventLog } from './conversationEventLog'
import { ConversationEventNormalizer } from './conversationEventNormalizer'

const userTurn: AgentTurn = {
  id: 'user-1',
  role: 'user',
  content: '检查项目',
  timestamp: 10,
  metadata: { workRunId: 'run-1' },
}

const assistantTurn: AgentTurn = {
  id: 'assistant-1',
  role: 'assistant',
  content: '检查完成',
  timestamp: 20,
  metadata: {
    workRunId: 'run-1',
    thinking: { content: '先分析项目', status: 'complete', source: 'provider' },
  },
}

const session: AgentSession = {
  id: 'conversation-1',
  mode: 'vibe',
  turns: [userTurn, assistantTurn],
  currentTaskId: null,
  createdAt: 1,
  updatedAt: 20,
  totalTokens: { input: 1, output: 1 },
}

function append(log: ConversationEventLog, events: ReturnType<ConversationEventNormalizer['normalizeAgent']>) {
  return log.appendMany(events)
}

describe('ConversationEventNormalizer', () => {
  it('normalizes an ordinary send into one ordered run, turn, step, stream, and terminal lifecycle', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')

    log.appendMany(normalizer.startRun({ runId: 'run-1', objective: userTurn.content, at: 1 }))
    append(log, normalizer.normalizeAgent({ type: 'turn:start', turn: userTurn }, { at: 2 }))
    append(log, normalizer.normalizeAgent({ type: 'stream:start' }, { at: 3 }))
    append(log, normalizer.normalizeAgent({ type: 'stream:thinking_delta', text: '先分析项目' }, { at: 4 }))
    append(log, normalizer.normalizeAgent({ type: 'stream:delta', text: '检查完成' }, { at: 5 }))
    append(log, normalizer.normalizeAgent({ type: 'stream:end' }, { at: 6 }))
    append(log, normalizer.normalizeAgent({ type: 'turn:complete', turn: assistantTurn }, { at: 7 }))
    append(log, normalizer.normalizeAgent({ type: 'session:complete', session }, { at: 8 }))

    expect(log.getEvents().map(event => event.type)).toEqual([
      'run.started',
      'turn.started',
      'step.started',
      'stream.started',
      'stream.delta',
      'stream.started',
      'stream.delta',
      'stream.ended',
      'stream.ended',
      'step.completed',
      'stream.committed',
      'stream.committed',
      'turn.completed',
      'run.state_changed',
      'run.completed',
    ])
    expect(log.getEvents().every((event, index) => event.seq === index + 1)).toBe(true)
    expect(log.getEvents().find(event => event.type === 'step.started')).toMatchObject({ runId: 'run-1', stepId: 'run-1:step:1' })
  })

  it('keeps an edited user turn visible while starting a fresh live run without duplicating the turn fact', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')
    const edited = { ...userTurn, content: '检查整个项目', timestamp: 30 }

    log.appendMany(normalizer.restoreTurns([edited]))
    log.appendMany(normalizer.startRun({ runId: 'run-1', objective: edited.content, at: 31 }))
    append(log, normalizer.normalizeAgent({ type: 'turn:start', turn: edited }, { at: 32 }))

    expect(log.getEvents().map(event => event.type)).toEqual(['turn.started', 'run.started'])
    expect(log.getEvents()[0]).toMatchObject({ provenance: 'restored', turnId: 'user-1' })
    expect(log.getEvents()[1]).toMatchObject({ provenance: 'live', runId: 'run-1' })
  })

  it('assigns stable step ids across a tool continuation', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')
    const toolCall: ToolCall = { id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } }
    const toolResult: ToolResult = { toolCallId: 'tool-1', name: 'read_file', output: 'ok', isError: false }

    log.appendMany(normalizer.startRun({ runId: 'run-1', at: 1 }))
    for (const event of [
      { type: 'stream:start' },
      { type: 'stream:delta', text: '先读取' },
      { type: 'stream:end' },
      { type: 'tool:call', toolCall },
      { type: 'tool:result', toolResult },
      { type: 'stream:start' },
      { type: 'stream:delta', text: '最终答案' },
      { type: 'stream:end' },
    ] satisfies AgentEventType[]) append(log, normalizer.normalizeAgent(event))

    const events = log.getEvents()
    expect(events.filter(event => event.type === 'step.started').map(event => event.stepId)).toEqual(['run-1:step:1', 'run-1:step:2'])
    expect(events.find(event => event.type === 'tool.proposed')).toMatchObject({ stepId: 'run-1:step:1', itemId: 'tool-1' })
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({ stepId: 'run-1:step:1', itemId: 'tool-1' })
  })

  it('preserves approval identity from request through resolution', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    normalizer.startRun({ runId: 'run-1' })
    const requested = normalizer.normalizeAgent({
      type: 'approval:state',
      requestId: 'approval-1',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow write?',
      toolName: 'write_file',
      path: 'a.ts',
    })
    const resolved = normalizer.normalizeAgent({
      type: 'approval:state',
      requestId: 'approval-1',
      requestKind: 'permission',
      state: 'resolved',
      decision: 'allow-once',
      question: 'Allow write?',
      toolName: 'write_file',
      path: 'a.ts',
    })

    expect([...requested, ...resolved]).toMatchObject([
      { type: 'approval.requested', itemId: 'approval-1', runId: 'run-1' },
      { type: 'approval.resolved', itemId: 'approval-1', runId: 'run-1' },
    ])
  })

  it('settles an open step and run as interrupted after pause and stop', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')
    log.appendMany(normalizer.startRun({ runId: 'run-1' }))
    append(log, normalizer.normalizeAgent({ type: 'stream:start' }))
    append(log, normalizer.normalizeAgent({ type: 'stream:thinking_delta', text: '处理中' }))
    append(log, normalizer.normalizeAgent({ type: 'run:state', state: { phase: 'paused', updatedAt: 4 } }))
    log.appendMany(normalizer.finishRun({ outcome: 'interrupted', at: 5 }))

    expect(log.getEvents().find(event => event.type === 'step.completed')?.payload).toEqual({ index: 1, outcome: 'interrupted' })
    expect(log.getEvents().at(-1)).toMatchObject({ type: 'run.completed', payload: { outcome: 'interrupted' } })
  })

  it('turns an agent error into one failed terminal event', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')
    log.appendMany(normalizer.startRun({ runId: 'run-1' }))
    append(log, normalizer.normalizeAgent({ type: 'error', error: 'network failed' }))
    append(log, normalizer.normalizeAgent({ type: 'error', error: 'duplicate failure' }))

    expect(log.getEvents().filter(event => event.type === 'run.completed')).toEqual([
      expect.objectContaining({ payload: { outcome: 'failed', error: 'network failed' } }),
    ])
  })

  it('never regresses a completed run back to a running phase', () => {
    const normalizer = new ConversationEventNormalizer('conversation-1')
    const log = new ConversationEventLog('conversation-1')
    log.appendMany(normalizer.startRun({ runId: 'run-1' }))
    append(log, normalizer.normalizeAgent({ type: 'session:complete', session }))
    append(log, normalizer.normalizeAgent({ type: 'run:state', state: { phase: 'completed', updatedAt: 10 } }))

    expect(log.getEvents().map(event => event.type)).toEqual(['run.started', 'run.state_changed', 'run.completed'])
  })

  it('restores deterministic facts with explicit restored provenance', () => {
    const toolCall: ToolCall = { id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } }
    const toolResult: ToolResult = { toolCallId: 'tool-1', name: 'read_file', output: 'ok', isError: false }
    const turns: AgentTurn[] = [
      userTurn,
      { ...assistantTurn, toolCalls: [toolCall] },
      { id: 'result-1', role: 'tool_result', content: 'ok', timestamp: 30, toolResults: [toolResult], metadata: { workRunId: 'run-1' } },
    ]
    const first = new ConversationEventNormalizer('conversation-1').restoreTurns(turns)
    const second = new ConversationEventNormalizer('conversation-1').restoreTurns(turns)

    expect(first).toEqual(second)
    expect(first.every(event => event.provenance === 'restored')).toBe(true)
    expect(first.map(event => event.type)).toContain('tool.completed')
  })
})
