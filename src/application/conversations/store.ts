import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync } from 'fs'
import { mkdir as mkdirAsync, readFile as readFileAsync, readdir as readdirAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { join, resolve } from 'path'
import { homedir } from 'os'
import type { AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import type { ContextCompactionState } from '../../state/types'
import type { ConversationInteractionState, ConversationJournalEntry, ConversationMeta, PersistedConversation } from './types'
import type { AnyConversationEvent } from '../events/index'
import { writeFileAtomicSync } from '../../core/fileIO'
import { presentRequestError } from '../../core/requestErrorPresentation'
import { RECOVERED_TOOL_RESULT_MESSAGE } from './recoveryMessages'
import { redactComputerConversation, redactComputerJournalEntry } from '../privacy/computerPrivacy'

const DEFAULT_CONVERSATIONS_DIR = join(homedir(), '.turboflux', 'conversations')
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const checkedJournalBoundaries = new Set<string>()
const LEGACY_RECOVERED_ASSISTANT_MESSAGES = new Set([
  'Interrupted: assistant response was not recorded before restart.',
  '上次回复在生成内容前中断。',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPendingPaste(value: unknown): boolean {
  return isRecord(value)
    && typeof value.placeholder === 'string'
    && typeof value.text === 'string'
}

function isContextCompactionState(value: unknown): value is ContextCompactionState {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && ['started', 'summarizing', 'fallback', 'committing', 'completed', 'interrupted', 'failed'].includes(String(value.phase))
    && (value.source === 'compact' || value.source === 'manual')
    && Number.isFinite(value.startedAt)
    && Number.isFinite(value.updatedAt)
    && Number.isFinite(value.elapsedMs)
    && typeof value.recoverable === 'boolean'
}

function isJournalEntry(value: unknown): value is ConversationJournalEntry {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || typeof value.type !== 'string' || !Number.isFinite(value.timestamp)) return false

  switch (value.type) {
    case 'meta':
      return isRecord(value.meta)
        && typeof value.meta.id === 'string'
        && typeof value.meta.workspacePath === 'string'
    case 'snapshot':
      return isRecord(value.conversation)
        && typeof value.conversation.id === 'string'
        && Array.isArray(value.conversation.turns)
    case 'canonical_event':
      return value.version === 3
        && isRecord(value.event)
        && value.event.schemaVersion === 1
        && typeof value.event.eventId === 'string'
        && typeof value.event.conversationId === 'string'
        && typeof value.event.threadId === 'string'
        && typeof value.event.type === 'string'
        && Number.isInteger(value.event.seq)
        && Number(value.event.seq) > 0
    case 'turn':
      return isRecord(value.turn)
        && typeof value.turn.id === 'string'
        && typeof value.turn.role === 'string'
        && typeof value.turn.content === 'string'
        && Number.isFinite(value.turn.timestamp)
    case 'stream_start':
    case 'stream_end':
      return value.type !== 'stream_end' || typeof value.interrupted === 'boolean'
    case 'stream_delta':
    case 'stream_thinking_delta':
      return typeof value.text === 'string'
    case 'tool_call':
      return isRecord(value.toolCall)
        && typeof value.toolCall.id === 'string'
        && typeof value.toolCall.name === 'string'
        && isRecord(value.toolCall.arguments)
    case 'tool_result':
      return isRecord(value.toolResult)
        && typeof value.toolResult.toolCallId === 'string'
        && typeof value.toolResult.name === 'string'
        && typeof value.toolResult.output === 'string'
        && typeof value.toolResult.isError === 'boolean'
    case 'state':
      return Array.isArray(value.activeTurns)
        && Array.isArray(value.contextSegments)
        && Array.isArray(value.contextReservoir)
    case 'context_compaction':
      return value.version === 2
        && isContextCompactionState(value.state)
        && (value.activeTurns === undefined || Array.isArray(value.activeTurns))
        && (value.contextSegments === undefined || Array.isArray(value.contextSegments))
        && (value.contextReservoir === undefined || Array.isArray(value.contextReservoir))
    case 'queue_state':
      return value.version === 2 && Array.isArray(value.inputs)
    case 'draft_state':
      return value.version === 2
        && isRecord(value.draft)
        && typeof value.draft.text === 'string'
        && (value.draft.pendingPastes === undefined
          || (Array.isArray(value.draft.pendingPastes) && value.draft.pendingPastes.every(isPendingPaste)))
    case 'input_state':
      return value.version === 2
        && typeof value.inputId === 'string'
        && value.intent === 'steer'
        && ['accepted', 'committed', 'rejected'].includes(String(value.state))
        && typeof value.text === 'string'
    case 'approval_state':
      return value.version === 2
        && typeof value.requestId === 'string'
        && (value.requestKind === 'permission' || value.requestKind === 'input')
        && ['requested', 'resolved', 'cancelled'].includes(String(value.state))
        && typeof value.question === 'string'
    default:
      return false
  }
}

function retainJournalEntry(entries: ConversationJournalEntry[], entry: ConversationJournalEntry): boolean {
  const resetTruncation = entry.type === 'snapshot'
  if (resetTruncation) entries.length = 0
  entries.push(entry)
  return resetTruncation
}

function findLatestValidSnapshot(lines: string[]): { index: number; entry: Extract<ConversationJournalEntry, { type: 'snapshot' }> } | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!/"type"\s*:\s*"snapshot"/.test(line)) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (isJournalEntry(entry) && entry.type === 'snapshot') return { index, entry }
    } catch {}
  }
  return null
}

function conversationsDir(): string {
  return process.env.TURBOFLUX_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR
}

function ensureDir(): string {
  const directory = conversationsDir()
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

async function ensureDirAsync(): Promise<string> {
  const directory = conversationsDir()
  await mkdirAsync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function conversationPath(id: string, extension: 'json' | 'jsonl'): string {
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`Invalid conversation id: ${id}`)
  return join(ensureDir(), `${id}.${extension}`)
}

async function conversationPathAsync(id: string, extension: 'json' | 'jsonl'): Promise<string> {
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`Invalid conversation id: ${id}`)
  return join(await ensureDirAsync(), `${id}.${extension}`)
}

function cloneConversation(conversation: PersistedConversation): PersistedConversation {
  return JSON.parse(JSON.stringify(conversation)) as PersistedConversation
}

function readLegacyConversation(id: string): PersistedConversation | null {
  let filePath: string
  try {
    filePath = conversationPath(id, 'json')
  } catch {
    return null
  }
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedConversation
  } catch {
    return null
  }
}

async function readLegacyConversationAsync(id: string): Promise<PersistedConversation | null> {
  let filePath: string
  try {
    filePath = await conversationPathAsync(id, 'json')
  } catch {
    return null
  }
  try {
    return JSON.parse(await readFileAsync(filePath, 'utf-8')) as PersistedConversation
  } catch {
    return null
  }
}

function parseJournal(content: string): { entries: ConversationJournalEntry[]; truncated: boolean } {
  const entries: ConversationJournalEntry[] = []
  let truncated = false
  const lines = content.split(/\r?\n/)
  const latestSnapshot = findLatestValidSnapshot(lines)
  let startIndex = 0
  if (latestSnapshot) {
    entries.push(latestSnapshot.entry)
    startIndex = latestSnapshot.index + 1
  }
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.trim()) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (!isJournalEntry(entry)) throw new Error('Invalid journal entry')
      if (retainJournalEntry(entries, entry)) truncated = false
    } catch {
      truncated = true
    }
  }
  return { entries, truncated }
}

async function parseJournalAsync(content: string): Promise<{ entries: ConversationJournalEntry[]; truncated: boolean }> {
  const entries: ConversationJournalEntry[] = []
  let truncated = false
  const lines = content.split(/\r?\n/)
  const latestSnapshot = findLatestValidSnapshot(lines)
  let startIndex = 0
  if (latestSnapshot) {
    entries.push(latestSnapshot.entry)
    startIndex = latestSnapshot.index + 1
  }
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim()) {
      try {
        const entry: unknown = JSON.parse(line)
        if (!isJournalEntry(entry)) throw new Error('Invalid journal entry')
        if (retainJournalEntry(entries, entry)) truncated = false
      } catch {
        truncated = true
      }
    }
    if (index > startIndex && (index - startIndex) % 250 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { entries, truncated }
}

function readJournal(id: string): { entries: ConversationJournalEntry[]; truncated: boolean } {
  let filePath: string
  try {
    filePath = conversationPath(id, 'jsonl')
  } catch {
    return { entries: [], truncated: false }
  }
  if (!existsSync(filePath)) return { entries: [], truncated: false }

  return parseJournal(readFileSync(filePath, 'utf-8'))
}

async function readJournalAsync(id: string): Promise<{ entries: ConversationJournalEntry[]; truncated: boolean }> {
  let filePath: string
  try {
    filePath = await conversationPathAsync(id, 'jsonl')
  } catch {
    return { entries: [], truncated: false }
  }
  try {
    return parseJournalAsync(await readFileAsync(filePath, 'utf-8'))
  } catch {
    return { entries: [], truncated: false }
  }
}

function createConversation(meta: ConversationMeta): PersistedConversation {
  return {
    ...meta,
    turnCount: 0,
    turns: [],
    activeTurns: [],
    contextSegments: [],
    contextReservoir: [],
  }
}

function createInteractionState(conversation?: PersistedConversation | null): NonNullable<PersistedConversation['interactionState']> {
  return {
    queuedInputs: (conversation?.interactionState?.queuedInputs || []).map(input => ({
      ...input,
      attachments: input.attachments ? input.attachments.map(attachment => ({ ...attachment })) : undefined,
      capabilities: input.capabilities
        ? { items: input.capabilities.items.map(item => ({ ...item })) }
        : undefined,
    })),
    draft: {
      text: conversation?.interactionState?.draft.text || '',
      attachments: conversation?.interactionState?.draft.attachments
        ? [...conversation.interactionState.draft.attachments]
        : undefined,
      files: conversation?.interactionState?.draft.files
        ? conversation.interactionState.draft.files.map(file => ({ ...file }))
        : undefined,
      pendingPastes: conversation?.interactionState?.draft.pendingPastes
        ? conversation.interactionState.draft.pendingPastes.map(pending => ({ ...pending }))
        : undefined,
      capabilities: conversation?.interactionState?.draft.capabilities
        ? { items: conversation.interactionState.draft.capabilities.items.map(item => ({ ...item })) }
        : undefined,
    },
    pendingSteering: [...(conversation?.interactionState?.pendingSteering || [])],
    pendingApprovals: [...(conversation?.interactionState?.pendingApprovals || [])],
  }
}

function hasMeaningfulInteractionState(state?: ConversationInteractionState): boolean {
  if (!state) return false
  return state.queuedInputs.length > 0
    || Boolean(state.draft.text.trim())
    || Boolean(state.draft.attachments?.length)
    || Boolean(state.draft.capabilities?.items.length)
    || Boolean(state.draft.pendingPastes?.length)
    || state.pendingSteering.length > 0
    || state.pendingApprovals.length > 0
}

function interactionStateTitle(state: ConversationInteractionState): string {
  const source = state.queuedInputs[0]?.prompt
    || state.draft.text
    || state.pendingSteering[0]?.text
    || ''
  return source.trim().slice(0, 60).replace(/\n/g, ' ')
}

function hasVisibleConversationContent(conversation: PersistedConversation): boolean {
  return conversation.turns.length > 0 || hasMeaningfulInteractionState(conversation.interactionState)
}

function isLegacyRecoveredAssistantPlaceholder(turn: AgentTurn): boolean {
  return turn.role === 'assistant'
    && turn.id.startsWith('recovered-assistant-')
    && LEGACY_RECOVERED_ASSISTANT_MESSAGES.has(turn.content.trim())
}

function removeLegacyRecoveredAssistantPlaceholders(conversation: PersistedConversation): void {
  conversation.turns = conversation.turns.filter(turn => !isLegacyRecoveredAssistantPlaceholder(turn))
  if (conversation.activeTurns) {
    conversation.activeTurns = conversation.activeTurns.filter(turn => !isLegacyRecoveredAssistantPlaceholder(turn))
  }
  if (conversation.contextReservoir) {
    conversation.contextReservoir = conversation.contextReservoir.map(entry => ({
      ...entry,
      turns: entry.turns.filter(turn => !isLegacyRecoveredAssistantPlaceholder(turn)),
    }))
  }
}

function looksLikeProviderFailure(error: string): boolean {
  return /all compatible model protocols failed|openai chat completions|responses api|\bhttp\s+[45]\d\d\b|insufficient balance|insufficient[_ -]?(quota|credit)|invalid[_ -]?api[_ -]?key|rate[_ -]?limit|service unavailable/i.test(error)
}

function normalizeRecoveredRunErrors(conversation: PersistedConversation): void {
  for (const run of conversation.workExecution?.runs || []) {
    if (run.error && looksLikeProviderFailure(run.error)) run.error = presentRequestError(run.error)
  }
}

function shouldMarkUnansweredTurnInterrupted(conversation: PersistedConversation, turn: AgentTurn): boolean {
  const runId = turn.metadata?.workRunId || turn.id
  const run = conversation.workExecution?.runs.find(candidate => candidate.id === runId)
  if (!run) return true
  return ['pending', 'running', 'waiting', 'paused', 'partial'].includes(run.status)
}

function upsertTurn(turns: AgentTurn[], turn: AgentTurn): void {
  const index = turns.findIndex(existing => (
    existing.id === turn.id
    && existing.role === turn.role
    && existing.timestamp === turn.timestamp
  ))
  if (index >= 0) turns[index] = turn
  else turns.push(turn)
}

function turnIdentityKey(turn: AgentTurn): string {
  return `${turn.id}\u0000${turn.role}\u0000${turn.timestamp}`
}

interface ConversationTurnRecord {
  originalId: string
  timestamp: number
  firstSeen: number
  turn: AgentTurn
}

function normalizeConversationTurns(conversation: PersistedConversation): void {
  const reservoirTurns = conversation.contextReservoir?.flatMap(entry => entry.turns) || []
  const activeTurns = conversation.activeTurns ?? conversation.turns
  const allSequences = [reservoirTurns, conversation.turns, activeTurns]
  const records = new Map<string, ConversationTurnRecord>()
  let firstSeen = 0

  for (const turns of allSequences) {
    for (const turn of turns) {
      const key = turnIdentityKey(turn)
      const existing = records.get(key)
      if (existing) {
        existing.turn = turn
        continue
      }
      records.set(key, {
        originalId: turn.id,
        timestamp: turn.timestamp,
        firstSeen: firstSeen++,
        turn,
      })
    }
  }

  const recordsByOriginalId = new Map<string, Array<[string, ConversationTurnRecord]>>()
  for (const entry of records.entries()) {
    const list = recordsByOriginalId.get(entry[1].originalId) || []
    list.push(entry)
    recordsByOriginalId.set(entry[1].originalId, list)
  }

  const reservedIds = new Set(recordsByOriginalId.keys())
  const assignedIds = new Set<string>()
  const canonicalIdByKey = new Map<string, string>()
  let turnIdsChanged = false
  for (const [originalId, entries] of recordsByOriginalId) {
    entries.sort((left, right) => (
      left[1].timestamp - right[1].timestamp
      || left[1].firstSeen - right[1].firstSeen
    ))
    entries.forEach(([key, record], index) => {
      if (index === 0 && !assignedIds.has(originalId)) {
        canonicalIdByKey.set(key, originalId)
        assignedIds.add(originalId)
        return
      }
      const suffix = Math.max(0, Math.trunc(record.timestamp)).toString(36)
      const baseCandidate = `${originalId}~${suffix}`
      let candidate = baseCandidate
      let ordinal = 2
      while (reservedIds.has(candidate) || assignedIds.has(candidate)) {
        candidate = `${baseCandidate}-${ordinal}`
        ordinal += 1
      }
      canonicalIdByKey.set(key, candidate)
      if (candidate !== record.turn.id) turnIdsChanged = true
      assignedIds.add(candidate)
    })
  }

  const normalizeSequence = (turns: AgentTurn[]): AgentTurn[] => {
    const normalized: AgentTurn[] = []
    const seen = new Set<string>()
    for (const turn of turns) {
      const key = turnIdentityKey(turn)
      if (seen.has(key)) continue
      seen.add(key)
      const record = records.get(key)
      if (!record) continue
      normalized.push({ ...record.turn, id: canonicalIdByKey.get(key) || record.turn.id })
    }
    return normalized
  }

  conversation.turns = [...records.entries()]
    .sort((left, right) => (
      left[1].timestamp - right[1].timestamp
      || left[1].firstSeen - right[1].firstSeen
    ))
    .map(([key, record]) => ({ ...record.turn, id: canonicalIdByKey.get(key) || record.turn.id }))
  conversation.activeTurns = normalizeSequence(activeTurns)
  if (conversation.contextReservoir) {
    conversation.contextReservoir = conversation.contextReservoir.map(entry => {
      const turns = normalizeSequence(entry.turns)
      return {
        ...entry,
        turns,
        startMessageId: turns[0]?.id ?? entry.startMessageId,
        endMessageId: turns.at(-1)?.id ?? entry.endMessageId,
      }
    })
  }
  conversation.turnCount = conversation.turns.length
  if (turnIdsChanged) conversation.modelSurface = undefined
}

function createRecoveredAssistantTurn(timestamp: number, content: string, toolCalls?: ToolCall[], thinking = ''): AgentTurn {
  return {
    id: `recovered-assistant-${timestamp}`,
    role: 'assistant',
    content,
    timestamp,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      interrupted: true,
      interruption: { kind: 'stop', resumable: false },
      thinking: thinking ? {
        content: thinking,
        source: 'provider',
        status: 'interrupted',
        tokenCount: Math.max(1, Math.ceil(thinking.length / 4)),
      } : undefined,
    },
  }
}

function createRecoveredToolResultTurn(timestamp: number, results: ToolResult[], sourceTurnId = ''): AgentTurn {
  return {
    id: `recovered-tools-${timestamp}${sourceTurnId ? `-${sourceTurnId}` : ''}`,
    role: 'tool_result',
    content: results.map(result => `${result.name}: ${result.isError ? '[failed]' : '[ok]'} ${result.output.slice(0, 500)}`).join('\n\n'),
    timestamp,
    toolResults: results,
    metadata: {
      interrupted: results.some(result => result.errorKind === 'abort'),
      interruption: results.find(result => result.interruption)?.interruption,
    },
  }
}

interface PendingStreamReplay {
  startedAt: number
  contentChunks: string[]
  thinkingChunks: string[]
  interrupted: boolean
}

function createPendingStream(startedAt: number): PendingStreamReplay {
  return { startedAt, contentChunks: [], thinkingChunks: [], interrupted: false }
}

function hasPendingStreamContent(pendingStream: PendingStreamReplay): boolean {
  return pendingStream.contentChunks.length > 0 || pendingStream.thinkingChunks.length > 0
}

function replayConversation(id: string, legacy: PersistedConversation | null, entries: ConversationJournalEntry[], truncatedJournal: boolean): PersistedConversation | null {
  let conversation = legacy ? cloneConversation(legacy) : null
  let pendingStream: PendingStreamReplay | null = null
  const pendingToolCalls = new Map<string, ToolCall>()
  const journalToolResults = new Map<string, ToolResult>()
  let latestTimestamp = conversation?.updatedAt || 0
  let interrupted = false
  let replayTruncated = truncatedJournal
  let canonicalLastSeq = 0
  let canonicalReplayBlocked = false
  const canonicalEventIds = new Set<string>()
  let interactionState = createInteractionState(conversation)

  const resetCanonicalReplay = (events: readonly AnyConversationEvent[] = []): void => {
    canonicalLastSeq = 0
    canonicalReplayBlocked = false
    canonicalEventIds.clear()
    const validEvents: AnyConversationEvent[] = []
    for (const event of events) {
      if (!acceptCanonicalEvent(event)) {
        if (canonicalReplayBlocked) break
        continue
      }
      validEvents.push(event)
    }
    if (conversation) conversation.canonicalEvents = validEvents
  }

  const acceptCanonicalEvent = (event: AnyConversationEvent): boolean => {
    if (canonicalReplayBlocked) return false
    if (
      event.schemaVersion !== 1
      || event.conversationId !== conversation?.id
      || event.threadId !== conversation?.id
      || !Number.isInteger(event.seq)
      || event.seq < 1
    ) {
      replayTruncated = true
      canonicalReplayBlocked = true
      return false
    }
    if (canonicalEventIds.has(event.eventId)) return false
    if (event.seq !== canonicalLastSeq + 1) {
      replayTruncated = true
      canonicalReplayBlocked = true
      return false
    }
    canonicalEventIds.add(event.eventId)
    canonicalLastSeq = event.seq
    return true
  }

  for (const entry of entries) {
    latestTimestamp = Math.max(latestTimestamp, entry.timestamp)
    switch (entry.type) {
      case 'meta':
        if (
          conversation
          && Number.isFinite(conversation.createdAt)
          && Number.isFinite(entry.meta.createdAt)
          && conversation.createdAt !== entry.meta.createdAt
        ) {
          conversation = createConversation(entry.meta)
          interactionState = createInteractionState(conversation)
          pendingStream = null
          pendingToolCalls.clear()
          journalToolResults.clear()
          interrupted = false
        } else {
          conversation = conversation || createConversation(entry.meta)
          Object.assign(conversation, entry.meta)
        }
        resetCanonicalReplay(conversation.canonicalEvents || [])
        break
      case 'snapshot':
        conversation = cloneConversation(entry.conversation)
        resetCanonicalReplay(conversation.canonicalEvents || [])
        interactionState = createInteractionState(conversation)
        pendingStream = null
        pendingToolCalls.clear()
        journalToolResults.clear()
        break
      case 'canonical_event':
        if (!conversation) break
        if (acceptCanonicalEvent(entry.event)) {
          conversation.canonicalEvents = [...(conversation.canonicalEvents || []), entry.event]
        }
        break
      case 'context_compaction':
        if (!conversation) break
        conversation.contextCompactionState = { ...entry.state }
        if (entry.activeTurns) conversation.activeTurns = entry.activeTurns
        if (entry.contextSegments) conversation.contextSegments = entry.contextSegments
        if (entry.contextReservoir) conversation.contextReservoir = entry.contextReservoir
        break
      case 'turn':
        if (!conversation) break
        upsertTurn(conversation.turns, entry.turn)
        conversation.activeTurns = conversation.activeTurns || []
        upsertTurn(conversation.activeTurns, entry.turn)
        if (entry.turn.role === 'assistant') pendingStream = null
        if (entry.turn.toolResults) {
          for (const result of entry.turn.toolResults) journalToolResults.delete(result.toolCallId)
        }
        break
      case 'stream_start':
        if (pendingStream && (hasPendingStreamContent(pendingStream) || pendingToolCalls.size > 0)) interrupted = true
        pendingToolCalls.clear()
        pendingStream = createPendingStream(entry.timestamp)
        break
      case 'stream_delta':
        pendingStream = pendingStream || createPendingStream(entry.timestamp)
        pendingStream.contentChunks.push(entry.text)
        break
      case 'stream_thinking_delta':
        pendingStream = pendingStream || createPendingStream(entry.timestamp)
        pendingStream.thinkingChunks.push(entry.text)
        break
      case 'stream_end':
        if (pendingStream) pendingStream.interrupted = entry.interrupted
        break
      case 'tool_call':
        pendingToolCalls.set(entry.toolCall.id, entry.toolCall)
        break
      case 'tool_result':
        journalToolResults.set(entry.toolResult.toolCallId, entry.toolResult)
        pendingToolCalls.delete(entry.toolResult.toolCallId)
        break
      case 'state':
        if (!conversation) break
        conversation.activeTurns = entry.activeTurns
        conversation.contextSegments = entry.contextSegments
        conversation.contextReservoir = entry.contextReservoir
        break
      case 'queue_state':
        interactionState.queuedInputs = entry.inputs.map(input => ({
          ...input,
          attachments: input.attachments ? [...input.attachments] : undefined,
          capabilities: input.capabilities
            ? { items: input.capabilities.items.map(item => ({ ...item })) }
            : undefined,
        }))
        break
      case 'draft_state':
        interactionState.draft = {
          ...entry.draft,
          attachments: entry.draft.attachments ? [...entry.draft.attachments] : undefined,
          pendingPastes: entry.draft.pendingPastes
            ? entry.draft.pendingPastes.map(pending => ({ ...pending }))
            : undefined,
          capabilities: entry.draft.capabilities
            ? { items: entry.draft.capabilities.items.map(item => ({ ...item })) }
            : undefined,
        }
        break
      case 'input_state': {
        const index = interactionState.pendingSteering.findIndex(input => input.id === entry.inputId)
        if (entry.state === 'accepted') {
          const pending = { id: entry.inputId, text: entry.text }
          if (index >= 0) interactionState.pendingSteering[index] = pending
          else interactionState.pendingSteering.push(pending)
        } else if (index >= 0) {
          interactionState.pendingSteering.splice(index, 1)
        }
        break
      }
      case 'approval_state': {
        const index = interactionState.pendingApprovals.findIndex(request => request.requestId === entry.requestId)
        if (entry.state === 'requested') {
          const pending = {
            requestId: entry.requestId,
            requestKind: entry.requestKind,
            question: entry.question,
            toolName: entry.toolName,
            path: entry.path,
          }
          if (index >= 0) interactionState.pendingApprovals[index] = pending
          else interactionState.pendingApprovals.push(pending)
        } else if (index >= 0) {
          interactionState.pendingApprovals.splice(index, 1)
        }
        break
      }
    }
  }

  if (!conversation) return null
  removeLegacyRecoveredAssistantPlaceholders(conversation)
  normalizeRecoveredRunErrors(conversation)
  conversation.activeTurns = conversation.activeTurns || [...conversation.turns]
  normalizeConversationTurns(conversation)

  if (pendingStream && (hasPendingStreamContent(pendingStream) || pendingToolCalls.size > 0)) {
    const calls = Array.from(pendingToolCalls.values())
    const recovered = createRecoveredAssistantTurn(
      Math.max(latestTimestamp, pendingStream.startedAt),
      pendingStream.contentChunks.join(''),
      calls,
      pendingStream.thinkingChunks.join(''),
    )
    upsertTurn(conversation.turns, recovered)
    upsertTurn(conversation.activeTurns, recovered)
    interrupted = true
  }

  const existingResultIds = new Set(conversation.turns.flatMap(turn => turn.toolResults?.map(result => result.toolCallId) || []))
  const unresolvedGroups = conversation.turns
    .map((turn, index) => ({
      turn,
      index,
      calls: (turn.toolCalls || []).filter(call => !existingResultIds.has(call.id)),
    }))
    .filter(group => group.calls.length > 0)
  const missingToolResults = unresolvedGroups.flatMap(group => group.calls).filter(call => !journalToolResults.has(call.id))
  for (const group of [...unresolvedGroups].reverse()) {
    const recoveredResults = group.calls.map(call => journalToolResults.get(call.id) || {
      toolCallId: call.id,
      name: call.name,
      output: RECOVERED_TOOL_RESULT_MESSAGE,
      isError: true,
      errorKind: 'abort' as const,
      interruption: { kind: 'stop' as const, resumable: false },
    })
    const resultTimestamp = group.turn.timestamp + 1
    const resultTurn = createRecoveredToolResultTurn(resultTimestamp, recoveredResults, group.turn.id)
    conversation.turns.splice(group.index + 1, 0, resultTurn)
    const activeIndex = conversation.activeTurns.findIndex(turn => turn.id === group.turn.id)
    if (activeIndex >= 0) conversation.activeTurns.splice(activeIndex + 1, 0, resultTurn)
    latestTimestamp = Math.max(latestTimestamp, resultTimestamp)
    interrupted = interrupted || recoveredResults.some(result => result.errorKind === 'abort')
  }

  const lastTurn = conversation.turns[conversation.turns.length - 1]
  if (lastTurn?.role === 'user' && shouldMarkUnansweredTurnInterrupted(conversation, lastTurn)) {
    interrupted = true
  }

  conversation.id = id
  const firstUserTurn = conversation.turns.find(turn => turn.role === 'user')
  const firstUserTitle = firstUserTurn?.content.trim().slice(0, 60).replace(/\n/g, ' ')
  const provisionalTitle = interactionStateTitle(interactionState)
  const titleNeedsFirstPrompt = !conversation.title
    || conversation.title === 'Untitled'
    || (conversation.titleSource !== 'custom' && Boolean(provisionalTitle) && conversation.title === provisionalTitle)
  if (firstUserTitle && titleNeedsFirstPrompt) conversation.title = firstUserTitle
  else if (!conversation.title || conversation.title === 'Untitled') {
    const title = interactionStateTitle(interactionState)
    if (title) conversation.title = title
  }
  conversation.turnCount = conversation.turns.length
  conversation.interactionState = interactionState
  conversation.updatedAt = Math.max(conversation.updatedAt, latestTimestamp)
  conversation.recovery = {
    interrupted,
    truncatedJournal: replayTruncated,
    unresolvedToolCalls: missingToolResults.length,
  }
  const compaction = conversation.contextCompactionState
  if (compaction && ['started', 'summarizing', 'fallback', 'committing'].includes(compaction.phase)) {
    const recoveredAt = Math.max(latestTimestamp, Date.now())
    conversation.contextCompactionState = {
      ...compaction,
      phase: 'interrupted',
      updatedAt: recoveredAt,
      elapsedMs: Math.max(compaction.elapsedMs, recoveredAt - compaction.startedAt),
      detail: '上次上下文整理被中断，原始对话已完整保留。',
      recoverable: true,
    }
    conversation.recovery.interrupted = true
  }
  normalizeConversationTurns(conversation)
  return redactComputerConversation(conversation)
}

export function appendConversationJournal(id: string, entry: ConversationJournalEntry): void {
  appendConversationJournalBatch(id, [entry])
}

export function appendConversationJournalBatch(id: string, entries: ConversationJournalEntry[]): void {
  if (entries.length === 0) return
  const persistedEntries = entries.map(redactComputerJournalEntry)
  const filePath = conversationPath(id, 'jsonl')
  if (!checkedJournalBoundaries.has(filePath) && existsSync(filePath)) {
    const descriptor = openSync(filePath, 'r')
    let needsBoundary = false
    try {
      const size = fstatSync(descriptor).size
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1)
        readSync(descriptor, lastByte, 0, 1, size - 1)
        needsBoundary = lastByte[0] !== 0x0a
      }
    } finally {
      closeSync(descriptor)
    }
    if (needsBoundary) appendFileSync(filePath, '\n', 'utf-8')
  }
  appendFileSync(filePath, persistedEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
  checkedJournalBoundaries.add(filePath)
  try { chmodSync(filePath, 0o600) } catch {}
}

export function updateConversationMetadata(meta: ConversationMeta): boolean {
  let legacyPath: string
  let journalPath: string
  try {
    legacyPath = conversationPath(meta.id, 'json')
    journalPath = conversationPath(meta.id, 'jsonl')
  } catch {
    return false
  }
  if (!existsSync(legacyPath) && !existsSync(journalPath)) return false
  appendConversationJournal(meta.id, {
    version: 1,
    type: 'meta',
    timestamp: meta.updatedAt,
    meta: { ...meta },
  })
  return true
}

export function saveConversation(conv: PersistedConversation, options: { compact?: boolean } = {}): void {
  const persistedConversation = redactComputerConversation(conv)
  const entry: ConversationJournalEntry = {
    version: 1,
    type: 'snapshot',
    timestamp: Date.now(),
    conversation: persistedConversation,
  }
  if (!options.compact) {
    appendConversationJournal(conv.id, entry)
    return
  }

  const filePath = conversationPath(conv.id, 'jsonl')
  writeFileAtomicSync(filePath, `${JSON.stringify(entry)}\n`, 0o600)
  checkedJournalBoundaries.add(filePath)
}

export function loadConversation(id: string): PersistedConversation | null {
  const legacy = readLegacyConversation(id)
  const journal = readJournal(id)
  if (!legacy && journal.entries.length === 0) return null
  return replayConversation(id, legacy, journal.entries, journal.truncated)
}

export async function loadConversationAsync(id: string): Promise<PersistedConversation | null> {
  const [legacy, journal] = await Promise.all([
    readLegacyConversationAsync(id),
    readJournalAsync(id),
  ])
  if (!legacy && journal.entries.length === 0) return null
  return replayConversation(id, legacy, journal.entries, journal.truncated)
}

export function deleteConversation(id: string): boolean {
  let deleted = false
  for (const extension of ['json', 'jsonl'] as const) {
    let filePath: string
    try {
      filePath = conversationPath(id, extension)
    } catch {
      return false
    }
    if (!existsSync(filePath)) continue
    unlinkSync(filePath)
    checkedJournalBoundaries.delete(filePath)
    deleted = true
  }
  return deleted
}

export async function deleteConversationAsync(id: string): Promise<boolean> {
  let deleted = false
  for (const extension of ['json', 'jsonl'] as const) {
    let filePath: string
    try {
      filePath = await conversationPathAsync(id, extension)
    } catch {
      return false
    }
    try {
      await unlinkAsync(filePath)
      checkedJournalBoundaries.delete(filePath)
      deleted = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return deleted
}

export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value).replace(/\\/g, '/')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

export function listConversations(workspacePath?: string): ConversationMeta[] {
  const files = readdirSync(ensureDir()).filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
  const ids = new Set(files.map(file => file.replace(/\.(json|jsonl)$/, '')))
  const metas: ConversationMeta[] = []

  for (const id of ids) {
    const conv = loadConversation(id)
    if (!conv) continue
    if (!hasVisibleConversationContent(conv)) continue
    if (workspacePath && !sameWorkspacePath(conv.workspacePath, workspacePath)) continue
    metas.push({
      id: conv.id,
      title: conv.title,
      titleSource: conv.titleSource,
      workspacePath: conv.workspacePath,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      mode: conv.mode,
      model: conv.model,
      provider: conv.provider,
      turnCount: conv.turnCount || conv.turns.length,
    })
  }

  return metas.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function listConversationsAsync(workspacePath?: string): Promise<ConversationMeta[]> {
  const files = (await readdirAsync(await ensureDirAsync()))
    .filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
  const ids = [...new Set(files.map(file => file.replace(/\.(json|jsonl)$/, '')))]
  const metas: ConversationMeta[] = []

  for (const id of ids) {
    const conv = await loadConversationAsync(id)
    if (!conv) continue
    if (!hasVisibleConversationContent(conv)) continue
    if (workspacePath && !sameWorkspacePath(conv.workspacePath, workspacePath)) continue
    metas.push({
      id: conv.id,
      title: conv.title,
      titleSource: conv.titleSource,
      workspacePath: conv.workspacePath,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      mode: conv.mode,
      model: conv.model,
      provider: conv.provider,
      turnCount: conv.turnCount || conv.turns.length,
    })
  }

  return metas.sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getConversationsDir(): string {
  return conversationsDir()
}
