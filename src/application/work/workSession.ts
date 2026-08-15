import type { AgentEventType } from '../../core/agentEngine'
import type { AgentTurn } from '../../shared/agentTypes'
import {
  ConversationEventLog,
  ConversationEventNormalizer,
  type AnyAppendConversationEventInput,
  type AnyConversationEvent,
  type ConversationEventWindowSnapshot,
  type FinishConversationRunInput,
  type RecordConversationInputState,
  type StartConversationRunInput,
} from '../events/index'
import { WorkProjectionEngine, type WorkProjectionSnapshot } from './workProjection'

export interface WorkSessionSnapshot {
  schemaVersion: 1
  window: ConversationEventWindowSnapshot
  projection: WorkProjectionSnapshot
}

export class WorkSession {
  readonly log: ConversationEventLog
  readonly normalizer: ConversationEventNormalizer
  readonly projection: WorkProjectionEngine

  constructor(sessionId: string, threadId = sessionId) {
    this.log = new ConversationEventLog(sessionId, threadId)
    this.normalizer = new ConversationEventNormalizer(sessionId, threadId)
    this.projection = new WorkProjectionEngine(sessionId, threadId)
  }

  getSnapshot(): WorkSessionSnapshot {
    return {
      schemaVersion: 1,
      window: this.log.getSnapshot(),
      projection: this.projection.getSnapshot(),
    }
  }

  startRun(input: StartConversationRunInput): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.startRun(input))
  }

  finishRun(input: FinishConversationRunInput): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.finishRun(input))
  }

  appendAgent(event: AgentEventType, at = Date.now()): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.normalizeAgent(event, { at }))
  }

  recordInputState(input: RecordConversationInputState): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.recordInputState(input))
  }

  acknowledgeNotification(notificationId: string, at = Date.now()): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.acknowledgeNotification(notificationId, at))
  }

  replaceFromTurns(turns: readonly AgentTurn[]): WorkSessionSnapshot {
    this.log.replay([])
    this.projection.activate(this.log.getSnapshot().conversationId, this.log.getSnapshot().threadId)
    this.append(this.normalizer.restoreTurns(turns))
    return this.getSnapshot()
  }

  replaceFromEvents(events: readonly AnyConversationEvent[]): WorkSessionSnapshot {
    this.log.replay(events)
    this.projection.replace(events)
    return this.getSnapshot()
  }

  activate(sessionId: string, threadId = sessionId, turns: readonly AgentTurn[] = []): WorkSessionSnapshot {
    this.log.activate(sessionId, threadId)
    this.projection.activate(sessionId, threadId)
    return this.replaceFromTurns(turns)
  }

  private append(inputs: readonly AnyAppendConversationEventInput[]): readonly AnyConversationEvent[] {
    const events = this.log.appendMany(inputs)
    for (const event of events) this.projection.apply(event)
    return events
  }
}
