import type { AgentEventType } from '../../core/agentEngine'
import type { AgentTurn } from '../../shared/agentTypes'
import type { AnyFlowEvent } from '../../shared/flowEvents'

export const WORK_SESSION_EVENT_SCHEMA_VERSION = 1 as const
export const WORK_SESSION_EVENT_WINDOW_LIMIT = 2_048

export type WorkSessionEventSource =
  | { kind: 'agent'; event: AgentEventType; restored?: boolean }
  | { kind: 'flow'; event: AnyFlowEvent }

export interface WorkSessionEvent {
  schemaVersion: typeof WORK_SESSION_EVENT_SCHEMA_VERSION
  eventId: string
  sessionId: string
  threadId: string
  seq: number
  at: number
  source: WorkSessionEventSource
}

export interface WorkSessionEventWindowSnapshot {
  schemaVersion: typeof WORK_SESSION_EVENT_SCHEMA_VERSION
  sessionId: string
  threadId: string
  baseSeq: number
  lastSeq: number
  eventCount: number
  hasMore: boolean
}

function restoredAgentEvents(turns: readonly AgentTurn[]): AgentEventType[] {
  const events: AgentEventType[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      events.push({ type: 'turn:start', turn })
      continue
    }
    if (turn.role === 'assistant') {
      events.push({ type: 'stream:start' })
      const thinking = turn.metadata?.thinking?.content
      if (thinking) events.push({ type: 'stream:thinking_delta', text: thinking })
      if (turn.content) events.push({ type: 'stream:delta', text: turn.content })
      events.push({ type: 'stream:end', interrupted: turn.metadata?.interrupted === true || turn.metadata?.thinking?.status === 'interrupted' })
      events.push({ type: 'turn:complete', turn })
      for (const toolCall of turn.toolCalls || []) events.push({ type: 'tool:call', toolCall })
      continue
    }
    for (const toolResult of turn.toolResults || []) events.push({ type: 'tool:result', toolResult })
  }
  return events
}

function restoredEventTime(event: AgentEventType, fallback: number): number {
  switch (event.type) {
    case 'turn:start':
    case 'turn:complete':
      return event.turn.timestamp
    default:
      return fallback
  }
}

export class WorkSessionEventLog {
  private events: WorkSessionEvent[] = []
  private eventStart = 0
  private eventCount = 0
  private nextSeq = 0
  private droppedEventCount = 0
  private readonly observedFlowEventIds = new Set<string>()

  constructor(
    private sessionId: string,
    private threadId = sessionId,
  ) {}

  getSnapshot(): WorkSessionEventWindowSnapshot {
    const firstEvent = this.eventAt(0)
    const lastEvent = this.eventAt(this.eventCount - 1)
    return {
      schemaVersion: WORK_SESSION_EVENT_SCHEMA_VERSION,
      sessionId: this.sessionId,
      threadId: this.threadId,
      baseSeq: firstEvent?.seq ?? this.nextSeq + 1,
      lastSeq: lastEvent?.seq ?? this.nextSeq,
      eventCount: this.eventCount,
      hasMore: this.droppedEventCount > 0,
    }
  }

  getEvents(): readonly WorkSessionEvent[] {
    if (this.eventCount === 0) return []
    const end = this.eventStart + this.eventCount
    if (end <= this.events.length) return this.events.slice(this.eventStart, end)
    return [
      ...this.events.slice(this.eventStart),
      ...this.events.slice(0, end - this.events.length),
    ]
  }

  appendAgent(event: AgentEventType, at = Date.now()): WorkSessionEvent {
    return this.append({ kind: 'agent', event }, at)
  }

  appendFlow(event: AnyFlowEvent): WorkSessionEvent | null {
    if (this.observedFlowEventIds.has(event.eventId)) return null
    this.observedFlowEventIds.add(event.eventId)
    return this.append({ kind: 'flow', event }, event.at)
  }

  replaceFromTurns(turns: readonly AgentTurn[]): readonly WorkSessionEvent[] {
    this.events = []
    this.eventStart = 0
    this.eventCount = 0
    this.nextSeq = 0
    this.droppedEventCount = 0
    this.observedFlowEventIds.clear()
    const restored: WorkSessionEvent[] = []
    let fallback = turns[0]?.timestamp ?? Date.now()
    for (const event of restoredAgentEvents(turns)) {
      const at = restoredEventTime(event, fallback)
      restored.push(this.append({ kind: 'agent', event, restored: true }, at))
      fallback = Math.max(fallback, at)
    }
    return restored
  }

  activate(sessionId: string, threadId = sessionId): void {
    if (sessionId === this.sessionId && threadId === this.threadId) return
    this.sessionId = sessionId
    this.threadId = threadId
    this.events = []
    this.eventStart = 0
    this.eventCount = 0
    this.nextSeq = 0
    this.droppedEventCount = 0
    this.observedFlowEventIds.clear()
  }

  private append(source: WorkSessionEventSource, at: number): WorkSessionEvent {
    this.nextSeq += 1
    const event: WorkSessionEvent = {
      schemaVersion: WORK_SESSION_EVENT_SCHEMA_VERSION,
      eventId: `${this.threadId}:work:${this.nextSeq}`,
      sessionId: this.sessionId,
      threadId: this.threadId,
      seq: this.nextSeq,
      at,
      source,
    }
    if (this.eventCount < WORK_SESSION_EVENT_WINDOW_LIMIT) {
      const insertAt = (this.eventStart + this.eventCount) % WORK_SESSION_EVENT_WINDOW_LIMIT
      if (insertAt === this.events.length) this.events.push(event)
      else this.events[insertAt] = event
      this.eventCount += 1
    } else {
      const stale = this.events[this.eventStart]
      if (stale?.source.kind === 'flow') this.observedFlowEventIds.delete(stale.source.event.eventId)
      this.events[this.eventStart] = event
      this.eventStart = (this.eventStart + 1) % WORK_SESSION_EVENT_WINDOW_LIMIT
      this.droppedEventCount += 1
    }
    return event
  }

  private eventAt(offset: number): WorkSessionEvent | undefined {
    if (offset < 0 || offset >= this.eventCount) return undefined
    return this.events[(this.eventStart + offset) % WORK_SESSION_EVENT_WINDOW_LIMIT]
  }
}
