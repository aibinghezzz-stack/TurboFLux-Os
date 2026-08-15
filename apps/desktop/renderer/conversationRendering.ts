import type { AgentTurn, WorkbenchSnapshot } from '@turboflux/agent-core/workbench'

const LEGACY_RECOVERY_PLACEHOLDERS = new Set([
  'Interrupted: assistant response was not recorded before restart.',
  '上次回复在生成内容前中断。',
])

export interface ConversationFailurePresentation {
  runId: string
  turnId: string
  prompt: string
  kind: 'credits' | 'service'
  title: string
  message: string
}

function isCreditFailure(error: string): boolean {
  return /(?:http\s*402\b[^\n]*insufficient_credits|\binsufficient_credits\b|"error"\s*:\s*"insufficient_credits"|积分不足)/i.test(error)
}

export function isInternalRequestErrorTurn(turn: AgentTurn): boolean {
  return turn.role === 'assistant' && turn.metadata?.internalKind === 'request_error'
}

export function presentFailureMessage(error: string): string {
  const normalized = error.toLowerCase()
  if (isCreditFailure(error)) {
    return '模型服务返回额度不足。你可以切换到自己的 API 连接后重试。'
  }
  if (/\b(401|403)\b|invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|认证失败|密钥无效/.test(normalized)) {
    return '模型服务认证失败，请检查服务配置后重试。'
  }
  if (/\b429\b|rate[_ -]?limit|too many requests|请求过于频繁/.test(normalized)) {
    return '模型服务当前请求过多，请稍后重试。'
  }
  if (/timed? out|timeout|超时/.test(normalized)) return '模型服务响应超时，请稍后重试。'
  if (/\b(500|502|503|504)\b|service unavailable|temporarily unavailable|服务不可用/.test(normalized)) {
    return '模型服务暂时不可用，请稍后重试。'
  }
  if (/^[\u3400-\u9fff]/.test(error.trim())) return error.trim().slice(0, 220)
  return '本次请求未能完成，请稍后重试。'
}

export function isLegacyRecoveryPlaceholder(turn: AgentTurn): boolean {
  return turn.role === 'assistant'
    && turn.id.startsWith('recovered-assistant-')
    && LEGACY_RECOVERY_PLACEHOLDERS.has(turn.content.trim())
}

export function latestConversationFailure(snapshot: WorkbenchSnapshot): ConversationFailurePresentation | undefined {
  const userTurn = [...snapshot.conversation.turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)
  if (!userTurn) return undefined
  const runId = userTurn.metadata?.workRunId || userTurn.id
  const run = [...snapshot.activity.execution.runs].reverse().find(candidate => (
    candidate.id === runId
    && candidate.conversationId === snapshot.conversation.id
  ))
  if (!run?.error || run.status !== 'failed') return undefined
  return {
    runId,
    turnId: userTurn.id,
    prompt: userTurn.content,
    kind: isCreditFailure(run.error) ? 'credits' : 'service',
    title: isCreditFailure(run.error) ? '本次请求未启动' : '请求未完成',
    message: presentFailureMessage(run.error),
  }
}

export function conversationRenderSignature(
  turns: AgentTurn[],
  failure?: ConversationFailurePresentation,
): string {
  const turnSignature = turns
    .filter(turn => !isLegacyRecoveryPlaceholder(turn))
    .filter(turn => !isInternalRequestErrorTurn(turn))
    .map(turn => {
      const calls = (turn.toolCalls || []).map(call => `${call.id}:${call.name}`).join(',')
      const results = (turn.toolResults || []).map(result => (
        `${result.toolCallId}:${result.name}:${result.isError ? 1 : 0}:${result.output.length}`
      )).join(',')
      return [
        turn.id,
        turn.role,
        turn.timestamp,
        turn.content.length,
        turn.metadata?.thinking?.content.length || 0,
        turn.metadata?.thinking?.status || '',
        turn.metadata?.attachments?.length || 0,
        turn.metadata?.capabilities?.items.length || 0,
        calls,
        results,
      ].join(':')
    })
    .join('|')
  const failureSignature = failure
    ? `${failure.runId}:${failure.turnId}:${failure.kind}:${failure.message.length}`
    : ''
  return `${turnSignature}#${failureSignature}`
}

export function preferCompletedAssistantContent(
  turn: AgentTurn,
  streamedContent: string,
  completedVisibleContent: string,
): AgentTurn {
  if (turn.role !== 'assistant' || streamedContent.length <= completedVisibleContent.length) return turn
  return { ...turn, content: streamedContent }
}

export function hasRenderableTurnPayload(input: {
  visibleContent: string
  hasThinking: boolean
  attachmentCount: number
  capabilityCount: number
  visibleToolCount: number
}): boolean {
  return Boolean(
    input.visibleContent
    || input.hasThinking
    || input.attachmentCount
    || input.capabilityCount
    || input.visibleToolCount,
  )
}

export function shouldPresentWorkMetadata(input: {
  visibleToolCount?: number
  explicitTaskSignal?: boolean
}): boolean {
  return Boolean(input.explicitTaskSignal || (input.visibleToolCount || 0) > 0)
}

export function shouldDeferWorkDelivery(input: {
  turnRunId?: string
  activeRunId?: string
  runTerminal: boolean
  hasLiveWork: boolean
}): boolean {
  return Boolean(
    input.hasLiveWork
    && input.turnRunId
    && input.activeRunId
    && input.turnRunId === input.activeRunId
    && !input.runTerminal,
  )
}

export function shouldPublishPendingWorkDelivery(outcome: string | undefined): boolean {
  return outcome === 'completed' || outcome === 'partial'
}

export type WorkTurnPresentationRole = 'ordinary' | 'progress' | 'candidate-delivery' | 'delivery'

export function resolveWorkTurnPresentation(input: {
  hasLiveWork: boolean
  visibleToolCount: number
  runTerminal: boolean
  matchesActiveRun: boolean
}): WorkTurnPresentationRole {
  if (!input.hasLiveWork) return 'ordinary'
  if (input.visibleToolCount > 0) return 'progress'
  if (!input.matchesActiveRun || input.runTerminal) return 'delivery'
  return 'candidate-delivery'
}

export function latestUserTurnId(turns: readonly AgentTurn[]): string | undefined {
  return [...turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)?.id
}

export interface RequestStatusTerminalFence {
  conversationId: string
  latestUserTurnId?: string
}

export function requestStatusTerminalFenceApplies(input: {
  fence: RequestStatusTerminalFence | null
  conversationId?: string
  latestUserTurnId?: string
}): boolean {
  if (!input.fence || !input.conversationId || input.fence.conversationId !== input.conversationId) return false
  return !input.fence.latestUserTurnId
    || !input.latestUserTurnId
    || input.fence.latestUserTurnId === input.latestUserTurnId
}

export function shouldIgnoreSnapshotAfterRequestTerminal(input: {
  fence: RequestStatusTerminalFence | null
  conversationId: string
  latestUserTurnId?: string
  runtimeStatus?: WorkbenchSnapshot['runtime']['status']
  runPhase?: WorkbenchSnapshot['runtime']['runState']['phase']
  activeRunId?: string | null
}): boolean {
  if (!requestStatusTerminalFenceApplies(input)) return false
  return Boolean(
    input.activeRunId
    || input.runtimeStatus === 'running'
    || input.runtimeStatus === 'paused'
    || input.runtimeStatus === 'awaiting-action'
    || ['thinking', 'compacting', 'tool_running', 'awaiting_approval', 'awaiting_input', 'paused', 'aborting'].includes(input.runPhase || ''),
  )
}

export function shouldRestoreRequestStatus(input: {
  terminalFenceApplies: boolean
  activeTask: boolean
  activeRunId?: string | null
  runtimeStatus?: WorkbenchSnapshot['runtime']['status']
  runPhase?: WorkbenchSnapshot['runtime']['runState']['phase']
  startedAt?: number
}): boolean {
  return Boolean(
    !input.terminalFenceApplies
    && input.activeTask
    && input.activeRunId
    && input.runtimeStatus === 'running'
    && input.runPhase === 'thinking'
    && input.startedAt,
  )
}

export function isHistoryRewriteUserTurn(input: {
  resendingTurnId: string
  eventType: string
  turnId?: string
  turnRole?: string
}): boolean {
  return Boolean(
    input.resendingTurnId
    && input.eventType === 'turn.started'
    && input.turnRole === 'user'
    && input.turnId === input.resendingTurnId,
  )
}

export function shouldAttachUserAnswerToLiveWork(input: {
  role: string
  turnRunId?: string
  liveRunId?: string
  hasLiveGroup: boolean
}): boolean {
  return Boolean(
    input.role === 'user'
    && input.hasLiveGroup
    && input.turnRunId
    && input.liveRunId
    && input.turnRunId === input.liveRunId,
  )
}
