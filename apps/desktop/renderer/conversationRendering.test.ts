import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'
import {
  conversationRenderSignature,
  isHistoryRewriteUserTurn,
  isLegacyRecoveryPlaceholder,
  isInternalRequestErrorTurn,
  latestUserTurnId,
  latestConversationFailure,
  presentFailureMessage,
  requestStatusTerminalFenceApplies,
  resolveWorkTurnPresentation,
  shouldDeferWorkDelivery,
  shouldIgnoreSnapshotAfterRequestTerminal,
  shouldAttachUserAnswerToLiveWork,
  shouldPublishPendingWorkDelivery,
  shouldPresentWorkMetadata,
  shouldRestoreRequestStatus,
} from './conversationRendering'

describe('conversation presentation', () => {
  it('keeps ordinary answers free of work metadata', () => {
    expect(shouldPresentWorkMetadata({ visibleToolCount: 0, explicitTaskSignal: false })).toBe(false)
  })

  it('shows work metadata when the model starts operational work', () => {
    expect(shouldPresentWorkMetadata({ visibleToolCount: 1 })).toBe(true)
    expect(shouldPresentWorkMetadata({ explicitTaskSignal: true })).toBe(true)
  })

  it('holds a task conclusion until the matching run reaches a terminal state', () => {
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-1',
      activeRunId: 'run-1',
      runTerminal: false,
      hasLiveWork: true,
    })).toBe(true)
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-1',
      activeRunId: 'run-1',
      runTerminal: true,
      hasLiveWork: true,
    })).toBe(false)
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-2',
      activeRunId: 'run-1',
      runTerminal: false,
      hasLiveWork: true,
    })).toBe(false)
  })

  it('only publishes a pending conclusion for completed or partial work', () => {
    expect(shouldPublishPendingWorkDelivery('completed')).toBe(true)
    expect(shouldPublishPendingWorkDelivery('partial')).toBe(true)
    expect(shouldPublishPendingWorkDelivery('failed')).toBe(false)
    expect(shouldPublishPendingWorkDelivery('cancelled')).toBe(false)
  })

  it('keeps work prose in one stable semantic lane across model loops', () => {
    expect(resolveWorkTurnPresentation({
      hasLiveWork: false,
      visibleToolCount: 0,
      runTerminal: false,
      matchesActiveRun: false,
    })).toBe('ordinary')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 1,
      runTerminal: false,
      matchesActiveRun: true,
    })).toBe('progress')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 0,
      runTerminal: false,
      matchesActiveRun: true,
    })).toBe('candidate-delivery')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 0,
      runTerminal: true,
      matchesActiveRun: true,
    })).toBe('delivery')
  })

  it('recognizes the canonical user turn that commits a history rewrite', () => {
    expect(isHistoryRewriteUserTurn({
      resendingTurnId: 'turn-2',
      eventType: 'turn.started',
      turnRole: 'user',
      turnId: 'turn-2',
    })).toBe(true)
  })

  it('fences late active snapshots after the current run is terminal', () => {
    const fence = { conversationId: 'conversation-1', latestUserTurnId: 'turn-2' }
    expect(requestStatusTerminalFenceApplies({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
    })).toBe(true)
    expect(requestStatusTerminalFenceApplies({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-3',
    })).toBe(false)
    expect(shouldIgnoreSnapshotAfterRequestTerminal({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      activeRunId: 'run-2',
    })).toBe(true)
    expect(shouldIgnoreSnapshotAfterRequestTerminal({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
      runtimeStatus: 'ready',
      runPhase: 'completed',
      activeRunId: null,
    })).toBe(false)
  })

  it('restores request progress only for a genuinely active run', () => {
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: false,
      activeTask: true,
      activeRunId: 'run-1',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(true)
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: false,
      activeTask: true,
      activeRunId: null,
      runtimeStatus: 'ready',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(false)
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: true,
      activeTask: true,
      activeRunId: 'run-1',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(false)
    expect(latestUserTurnId([
      { id: 'turn-1', role: 'user', content: 'one', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 2 },
      { id: 'turn-2', role: 'user', content: 'two', timestamp: 3 },
    ])).toBe('turn-2')
  })

  it('keeps an interactive answer inside its active work run', () => {
    expect(shouldAttachUserAnswerToLiveWork({
      role: 'user',
      turnRunId: 'run-1',
      liveRunId: 'run-1',
      hasLiveGroup: true,
    })).toBe(true)
    expect(shouldAttachUserAnswerToLiveWork({
      role: 'user',
      turnRunId: 'run-2',
      liveRunId: 'run-1',
      hasLiveGroup: true,
    })).toBe(false)
  })

  it('hides placeholders produced by older recovery versions', () => {
    const placeholder = {
      id: 'recovered-assistant-101',
      role: 'assistant' as const,
      content: 'Interrupted: assistant response was not recorded before restart.',
      timestamp: 101,
    }
    expect(isLegacyRecoveryPlaceholder(placeholder)).toBe(true)
    expect(conversationRenderSignature([placeholder])).not.toContain('Interrupted:')
  })

  it('restores a failed request as a Chinese retryable state', () => {
    const snapshot = {
      conversation: {
        id: 'conversation-1',
        turns: [{
          id: 'input-1',
          role: 'user',
          content: '继续完成任务',
          timestamp: 100,
          metadata: { workRunId: 'run-1' },
        }],
      },
      activity: {
        execution: {
          runs: [{
            id: 'run-1',
            conversationId: 'conversation-1',
            status: 'failed',
            error: 'HTTP 402: {"error":"insufficient_credits"}',
          }],
        },
      },
    } as unknown as WorkbenchSnapshot

    expect(latestConversationFailure(snapshot)).toEqual({
      runId: 'run-1',
      turnId: 'input-1',
      prompt: '继续完成任务',
      kind: 'credits',
      title: '本次请求未启动',
      message: '模型服务返回额度不足。你可以切换到自己的 API 连接后重试。',
    })
  })

  it('presents an immediate provider failure without raw English errors', () => {
    expect(presentFailureMessage('HTTP 503 service unavailable')).toBe('模型服务暂时不可用，请稍后重试。')
  })

  it('does not confuse an upstream provider quota error with TurboFlux credits', () => {
    expect(presentFailureMessage('HTTP 502 upstream billing quota exceeded')).toBe('模型服务暂时不可用，请稍后重试。')
    expect(presentFailureMessage('HTTP 402 {"error":"insufficient_credits"}')).toBe('模型服务返回额度不足。你可以切换到自己的 API 连接后重试。')
  })

  it('hides the transient internal request-error turn', () => {
    expect(isInternalRequestErrorTurn({
      id: 'request-error-1', role: 'assistant', content: '**Request Error**', timestamp: 100,
      metadata: { internal: true, internalKind: 'request_error', internalError: 'HTTP 502' },
    })).toBe(true)
  })

  it('builds a bounded signature without copying large tool payloads', () => {
    const largePayload = 'private-payload-'.repeat(80_000)
    const signature = conversationRenderSignature([{
      id: 'tool-result-1',
      role: 'tool_result',
      content: largePayload,
      timestamp: 100,
      toolResults: [{
        toolCallId: 'write-1',
        name: 'write_file',
        output: largePayload,
        isError: false,
      }],
    }])

    expect(signature).not.toContain('private-payload')
    expect(signature.length).toBeLessThan(160)
    expect(signature).toContain(String(largePayload.length))
  })
})
