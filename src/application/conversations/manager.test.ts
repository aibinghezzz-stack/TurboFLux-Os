import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import { WORK_EXECUTION_SCHEMA_VERSION, type WorkExecutionSnapshot } from '../../shared/workExecutionTypes'
import type { AgentEngine } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import { ConversationManager } from './manager'
import { loadConversation, saveConversation } from './store'
import { ModelSurface } from '../../core/modelSurface'
import type { AnyConversationEvent } from '../events/index'

function canonicalEvent(seq: number, eventId = `event-${seq}`, conversationId = 'session-1'): AnyConversationEvent {
  return {
    schemaVersion: 1,
    eventId,
    conversationId,
    threadId: conversationId,
    runId: 'run-1',
    turnId: 'turn-1',
    seq,
    at: 100 + seq,
    source: 'runtime',
    provenance: 'live',
    type: 'run.state_changed',
    payload: { state: { phase: 'running', updatedAt: 100 + seq } },
  }
}

describe.sequential('ConversationManager journal integration', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-conversation-manager-'))
    process.env.TURBOFLUX_CONVERSATIONS_DIR = directory
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.TURBOFLUX_CONVERSATIONS_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  it('records user turns and stream deltas before the debounced snapshot', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const config = { model: 'test-model', provider: 'custom' } as TurboFluxConfig
    const manager = new ConversationManager(engine, config, process.cwd())
    const userTurn: AgentTurn = { id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }
    turns.push(userTurn)

    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.recordEvent({ type: 'stream:start' })
    manager.recordEvent({ type: 'stream:delta', text: 'partial' })
    manager.flushJournal()

    const recovered = loadConversation(manager.getCurrentId())

    expect(recovered?.title).toBe('hello')
    expect(recovered?.turns.map(turn => turn.content)).toEqual(['hello', 'partial'])
    expect(recovered?.recovery?.interrupted).toBe(true)
    expect(manager.getJournalStats().streamingBatchesWritten).toBe(1)
  })

  it('does not materialize an empty startup conversation before the first user turn', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordEvent({ type: 'run:state', state: { phase: 'idle', updatedAt: 100 } })
    manager.recordEvent({ type: 'mode:change', from: 'vibe', to: 'plan' })
    expect(manager.recordQueueState([])).toBe(true)
    expect(manager.recordDraftState({ text: '', attachments: [] })).toBe(true)
    manager.flushJournal()

    expect(readdirSync(directory).filter(file => file.endsWith('.jsonl'))).toEqual([])
    expect(loadConversation(manager.getCurrentId())).toBeNull()

    const userTurn: AgentTurn = { id: 'user-1', role: 'user', content: 'first real prompt', timestamp: 101 }
    turns.push(userTurn)
    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())).toMatchObject({ title: 'first real prompt', turnCount: 1 })
  })

  it('replaces a provisional draft title with the first persisted user prompt', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordDraftState({ text: 'f' })
    manager.flushJournal()
    expect(loadConversation(manager.getCurrentId())?.title).toBe('f')

    const userTurn: AgentTurn = {
      id: 'user-1',
      role: 'user',
      content: 'full prompt after typing',
      timestamp: 101,
    }
    turns.push(userTurn)
    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())?.title).toBe('full prompt after typing')
  })

  it('omits redundant active turns and retains only a snapshot hash', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => [...turns],
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.persist(true)

    const record = JSON.parse(readFileSync(join(directory, `${manager.getCurrentId()}.jsonl`), 'utf8'))
    expect(record.conversation.activeTurns).toBeUndefined()
    expect((manager as any).lastPersistedSnapshotHash).toMatch(/^[a-f0-9]{64}$/)
    expect((manager as any).lastPersistedSnapshotHash).not.toContain('hello')
  })

  it('compacts an unchanged conversation instead of leaving journal history behind', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'stable', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.persist()
    const journalPath = join(directory, `${manager.getCurrentId()}.jsonl`)
    expect(readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).length).toBeGreaterThan(1)

    manager.persist(true)

    const records = readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ type: 'snapshot', conversation: { turnCount: 1 } })
  })

  it('compacts scheduled checkpoints instead of stacking full snapshots', () => {
    vi.useFakeTimers()
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'checkpoint', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordEvent({ type: 'turn:start', turn: turns[0]! })
    manager.scheduleSave()
    vi.advanceTimersByTime(500)

    const journalPath = join(directory, `${manager.getCurrentId()}.jsonl`)
    const records = readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ type: 'snapshot', conversation: { title: 'checkpoint' } })
  })

  it('keeps computer observations and input payloads out of journals and snapshots', () => {
    const toolCall = {
      id: 'computer-call-1',
      name: 'computer__type_text',
      arguments: {
        text: 'PRIVATE_TYPED_TEXT',
        keys: 'PRIVATE_KEYS',
        x: 321.25,
        y: 654.75,
        pid: 424242,
        ref: 'ax-private-ref',
        observation_id: 'observation-private',
      },
    }
    const toolResult = {
      toolCallId: toolCall.id,
      name: toolCall.name,
      output: JSON.stringify({ value: 'PRIVATE_AX_VALUE', pid: 424242, path: '/private/tmp/computer-frame.png' }),
      isError: false,
      attachments: [{
        id: 'computer-frame-1',
        type: 'image' as const,
        path: '/private/tmp/computer-frame.png',
        mime: 'image/png',
        filename: 'computer-frame.png',
        size: 123,
      }],
    }
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'use the app', timestamp: 100 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 101, toolCalls: [toolCall] },
      {
        id: 'result-1',
        role: 'tool_result',
        content: `computer__type_text: [ok] ${toolResult.output}`,
        timestamp: 102,
        toolResults: [toolResult],
      },
    ]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 102 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
      getContextCompactionState: () => null,
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordEvent({ type: 'turn:complete', turn: turns[1]! })
    manager.recordEvent({ type: 'tool:call', toolCall })
    manager.recordEvent({ type: 'tool:result', toolResult })
    manager.recordEvent({ type: 'turn:complete', turn: turns[2]! })
    manager.flushJournal()

    const journalPath = join(directory, `${manager.getCurrentId()}.jsonl`)
    const sensitiveValues = [
      'PRIVATE_TYPED_TEXT',
      'PRIVATE_KEYS',
      'PRIVATE_AX_VALUE',
      '/private/tmp/computer-frame.png',
      'observation-private',
      'ax-private-ref',
      '424242',
      '321.25',
      '654.75',
    ]
    const journal = readFileSync(journalPath, 'utf8')
    for (const sensitive of sensitiveValues) expect(journal).not.toContain(sensitive)

    manager.persist(true)
    const snapshot = readFileSync(journalPath, 'utf8')
    for (const sensitive of sensitiveValues) expect(snapshot).not.toContain(sensitive)

    const recovered = loadConversation(manager.getCurrentId())
    expect(recovered?.turns.find(turn => turn.role === 'assistant')?.toolCalls?.[0]?.arguments).toEqual({})
    const recoveredResult = recovered?.turns.find(turn => turn.role === 'tool_result')?.toolResults?.[0]
    expect(recoveredResult).toMatchObject({ output: expect.stringContaining('ephemeral') })
    expect(recoveredResult).not.toHaveProperty('attachments')
    expect(toolCall.arguments.text).toBe('PRIVATE_TYPED_TEXT')
    expect(toolResult.attachments[0]?.path).toBe('/private/tmp/computer-frame.png')
  })

  it('reports journal persistence failures instead of silently losing recovery data', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const statuses: Array<Error | null> = []
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf-8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
      status => statuses.push(status),
    )

    expect(() => manager.recordEvent({ type: 'turn:start', turn: turns[0]! })).toThrow()

    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toBeInstanceOf(Error)
  })

  it('gates new work until explicit retry succeeds and can export a redacted bundle', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'token sk-abcdefghijklmnop', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    expect(() => manager.recordEvent({ type: 'turn:start', turn: turns[0]! })).toThrow()
    expect(manager.isPersistenceHealthy()).toBe(false)
    expect(() => manager.startNew()).toThrow(/degraded/)

    const exportRoot = mkdtempSync(join(tmpdir(), 'turboflux-conversation-export-'))
    const exportPath = join(exportRoot, 'recovery.json')
    try {
      manager.exportRecoveryBundle(exportPath)
      expect(readFileSync(exportPath, 'utf8')).not.toContain('sk-abcdefghijklmnop')
    } finally {
      rmSync(exportRoot, { recursive: true, force: true })
    }

    rmSync(directory, { force: true })
    mkdirSync(directory)
    expect(manager.retryPersistence().status).toBe('healthy')
    expect(manager.isPersistenceHealthy()).toBe(true)
  })

  it('does not switch sessions when persistence fails during the pre-switch compact', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'keep me', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )
    const currentId = manager.getCurrentId()

    expect(() => manager.startNew()).toThrow(/degraded while saving/)
    expect(manager.getCurrentId()).toBe(currentId)
  })

  it('persists interaction lifecycle state without losing pending user intent', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordQueueState([{ id: 'queue-1', prompt: 'next task' }])
    manager.recordDraftState({
      text: 'unfinished',
      files: [{ id: 'file-1', type: 'file', path: '/tmp/spec.pdf', mime: 'application/pdf', filename: 'spec.pdf', size: 20 }],
      pendingPastes: [{ placeholder: '【paste】', text: 'full pasted text' }],
    })
    manager.recordEvent({ type: 'input:state', inputId: 'steer-1', intent: 'steer', state: 'accepted', text: 'change direction' })
    manager.recordEvent({
      type: 'approval:state',
      requestId: 'approval-1',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow write?',
      toolName: 'write_file',
    })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())?.interactionState).toMatchObject({
      queuedInputs: [{ id: 'queue-1', prompt: 'next task' }],
      draft: {
        text: 'unfinished',
        files: [{ id: 'file-1', filename: 'spec.pdf' }],
        pendingPastes: [{ placeholder: '【paste】', text: 'full pasted text' }],
      },
      pendingSteering: [{ id: 'steer-1', text: 'change direction' }],
      pendingApprovals: [{ requestId: 'approval-1', toolName: 'write_file' }],
    })
  })

  it('lists, switches, and deletes saved conversations asynchronously', async () => {
    const turns: AgentTurn[] = []
    const session = { id: 'session-1', mode: 'vibe' as const, turns, createdAt: 500, updatedAt: 500 }
    let contextSegments: ReturnType<AgentEngine['getContextSegments']> = []
    let contextReservoir: ReturnType<AgentEngine['getContextReservoir']> = []
    const engine = {
      getSession: () => session,
      getFullConversationTurns: () => turns,
      getContextSegments: () => contextSegments,
      getContextReservoir: () => contextReservoir,
      restoreFromTurns: (restored: AgentTurn[]) => {
        turns.splice(0, turns.length, ...restored)
        session.createdAt = restored[0]?.timestamp ?? 500
        session.updatedAt = restored.at(-1)?.timestamp ?? 500
      },
      setContextSegments: (segments: typeof contextSegments) => { contextSegments = segments },
      setContextReservoir: (entries: typeof contextReservoir) => { contextReservoir = entries },
      getMode: () => session.mode,
      setMode: (mode: 'vibe' | 'plan') => { (session as { mode: 'vibe' | 'plan' }).mode = mode },
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )
    saveConversation({
      id: 'saved-async',
      title: 'Saved async conversation',
      workspacePath: process.cwd(),
      createdAt: 50,
      updatedAt: 200,
      mode: 'plan',
      model: 'test-model',
      provider: 'custom',
      turnCount: 2,
      turns: [
        { id: 'user-1', role: 'user', content: 'hello', timestamp: 100 },
        { id: 'assistant-1', role: 'assistant', content: 'hi', timestamp: 101 },
      ],
    })
    saveConversation({
      id: 'other-workspace',
      title: 'Other workspace task',
      workspacePath: join(process.cwd(), 'other-workspace'),
      createdAt: 40,
      updatedAt: 150,
      mode: 'vibe',
      model: 'test-model',
      provider: 'custom',
      turnCount: 1,
      turns: [{ id: 'other-user', role: 'user', content: 'elsewhere', timestamp: 150 }],
    })

    await expect(manager.listAsync()).resolves.toEqual([
      expect.objectContaining({ id: 'saved-async' }),
    ])
    expect(new Set(manager.listAll().map(conversation => conversation.id))).toEqual(new Set(['saved-async', 'other-workspace']))
    await expect(manager.switchToAsync('saved-async')).resolves.toMatchObject({ id: 'saved-async' })
    expect(manager.getCurrentId()).toBe('saved-async')
    expect(session).toMatchObject({ mode: 'plan', createdAt: 50 })
    expect(turns.map(turn => turn.content)).toEqual(['hello', 'hi'])

    await expect(manager.renameAsync('saved-async', 'Renamed task')).resolves.toBe(true)
    expect(loadConversation('saved-async')).toMatchObject({ title: 'Renamed task', titleSource: 'custom' })

    await expect(manager.renameAsync('saved-async', 'Generated task', 'generated')).resolves.toBe(true)
    expect(loadConversation('saved-async')).toMatchObject({ title: 'Generated task', titleSource: 'generated' })

    manager.recordDraftState({ text: 'transient render effect' })
    manager.flushJournal()
    expect(loadConversation('saved-async')).toMatchObject({ createdAt: 50, mode: 'plan', title: 'Generated task', titleSource: 'generated' })

    await expect(manager.deleteAsync('saved-async')).resolves.toBe(false)
    expect(loadConversation('saved-async')).not.toBeNull()

    manager.startNew()
    await expect(manager.deleteAsync('saved-async')).resolves.toBe(true)
    manager.destroy()
  })

  it('persists and restores the versioned work execution snapshot with the conversation', async () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'build it', timestamp: 101 }]
    const execution: WorkExecutionSnapshot = {
      schemaVersion: WORK_EXECUTION_SCHEMA_VERSION,
      currentRunId: null,
      runs: [{
        id: 'run-1',
        conversationId: 'saved-execution',
        objective: 'Build it',
        presentation: 'work',
        status: 'completed',
        phase: 'completed',
        rootStepIds: [],
        steps: {},
        activities: {},
        startedAt: 101,
        updatedAt: 102,
        completedAt: 102,
      }],
    }
    let restoredExecution: WorkExecutionSnapshot | undefined
    const modelSurface = new ModelSurface(undefined, turns).getState()
    let restoredModelSurface = undefined as typeof modelSurface | undefined
    const session = { id: 'session-1', mode: 'vibe' as const, turns, createdAt: 100, updatedAt: 102 }
    const engine = {
      getSession: () => session,
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
      getWorkExecutionSnapshot: () => execution,
      getModelSurfaceState: () => modelSurface,
      restoreFromTurns: (restored: AgentTurn[]) => turns.splice(0, turns.length, ...restored),
      setContextSegments: () => {},
      setContextReservoir: () => {},
      setContextCompactionState: () => {},
      restoreWorkExecutionSnapshot: (snapshot: WorkExecutionSnapshot | undefined) => {
        restoredExecution = snapshot
        return true
      },
      restoreModelSurfaceState: (snapshot: typeof modelSurface | undefined) => {
        restoredModelSurface = snapshot
      },
      getMode: () => session.mode,
      setMode: () => {},
    } as unknown as AgentEngine
    saveConversation({
      id: 'saved-execution',
      title: 'Saved execution',
      workspacePath: process.cwd(),
      createdAt: 100,
      updatedAt: 102,
      mode: 'vibe',
      model: 'test-model',
      provider: 'custom',
      turnCount: turns.length,
      turns,
      workExecution: execution,
      modelSurface,
    })
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    await expect(manager.switchToAsync('saved-execution')).resolves.toMatchObject({ id: 'saved-execution' })
    expect(restoredModelSurface).toEqual(modelSurface)
    expect(restoredExecution).toEqual(execution)
    expect(loadConversation('saved-execution')?.workExecution?.schemaVersion).toBe(WORK_EXECUTION_SCHEMA_VERSION)
    manager.destroy()
  })

  it('persists canonical events, deduplicates stable ids, and restores the next sequence', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'canonical', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(engine, { model: 'test-model', provider: 'custom' } as TurboFluxConfig, process.cwd())

    const conversationId = manager.getCurrentId()
    const first = canonicalEvent(1, 'event-1', conversationId)
    const second = canonicalEvent(2, 'event-2', conversationId)
    expect(manager.recordCanonicalEvent(first)).toBe(true)
    expect(manager.recordCanonicalEvent(first)).toBe(false)
    expect(manager.recordCanonicalEvent(second)).toBe(true)
    manager.flushJournal()

    const recovered = loadConversation(manager.getCurrentId())
    expect(recovered?.canonicalEvents?.map(event => event.eventId)).toEqual(['event-1', 'event-2'])
    expect(manager.getCanonicalEvents()).toHaveLength(2)
    expect(() => manager.recordCanonicalEvent(canonicalEvent(4, 'event-4', conversationId))).toThrow(/expected seq 3/)

    manager.persist(true)
    const compacted = loadConversation(manager.getCurrentId())
    expect(compacted?.canonicalEvents?.map(event => event.seq)).toEqual([1, 2])
    manager.destroy()
  })

  it('restores canonical events after a truncated journal tail and accepts the next sequence', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'truncated', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(engine, { model: 'test-model', provider: 'custom' } as TurboFluxConfig, process.cwd())
    const conversationId = manager.getCurrentId()
    manager.recordCanonicalEvent(canonicalEvent(1, 'event-1', conversationId))
    manager.flushJournal()
    const journalPath = join(directory, `${conversationId}.jsonl`)
    appendFileSync(journalPath, '{"version":3,"type":"canonical_event"\n', 'utf8')
    const recovered = loadConversation(conversationId)
    expect(recovered?.canonicalEvents?.map(event => event.seq)).toEqual([1])
    expect(recovered?.recovery?.truncatedJournal).toBe(true)

    manager.replaceCanonicalEvents(recovered?.canonicalEvents || [])
    expect(manager.recordCanonicalEvent(canonicalEvent(2, 'event-2', conversationId))).toBe(true)
    manager.flushJournal()
    expect(loadConversation(conversationId)?.canonicalEvents?.map(event => event.seq)).toEqual([1, 2])
    manager.destroy()
  })
})
