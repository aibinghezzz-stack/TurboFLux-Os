import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEventType } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { WorkbenchEvent } from './types'
import { saveProjectMcpSettings } from '../../core/mcp/settings'
import { WorkbenchRuntime } from './workbenchRuntime'

const directories: string[] = []

function createConfig(): TurboFluxConfig {
  return {
    provider: 'custom',
    apiKey: '',
    baseUrl: '',
    model: '',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: true,
    apiConfigs: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorkbenchRuntime', () => {
  // 集成级测试：完整 WorkbenchRuntime 初始化与运行较慢，统一 15s 超时

  it('broadcasts ordered canonical envelopes with stable conversation identity', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const conversationId = runtime.getSnapshot().conversation.id
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:thinking_delta', text: '先检查任务边界' })
      handleAgentEvent({
        type: 'tool:call',
        toolCall: { id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } },
      })
      handleAgentEvent({
        type: 'tool:result',
        toolResult: { toolCallId: 'read-1', name: 'read_file', output: 'ok', isError: false },
      })
      handleAgentEvent({ type: 'stream:end' })

      const conversationEvents = events.filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
      expect(conversationEvents.length).toBeGreaterThan(5)
      expect(conversationEvents[0]?.event.seq).toBe(1)
      expect(conversationEvents.every(event => event.conversationId === conversationId)).toBe(true)
      expect(conversationEvents.every(event => event.event.conversationId === conversationId && event.event.threadId === conversationId)).toBe(true)
      expect(conversationEvents.map(event => event.event.seq)).toEqual(
        [...conversationEvents].map(event => event.event.seq).sort((left, right) => left - right),
      )
      expect(new Set(conversationEvents.map(event => event.event.eventId)).size).toBe(conversationEvents.length)
      const toolEvents = conversationEvents.filter(event => event.event.itemId === 'read-1')
      expect(toolEvents.map(event => event.event.type)).toEqual(expect.arrayContaining([
        'tool.proposed',
        'tool.completed',
      ]))
      expect(new Set(toolEvents.map(event => event.event.runId))).toEqual(new Set([expect.any(String)]))
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('keeps background flow envelopes attached to their originating conversation', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const firstConversationId = runtime.getSnapshot().conversation.id
    const firstSlot = (runtime as unknown as {
      conversationRuntimes: Map<string, unknown>
    }).conversationRuntimes.get(firstConversationId)
    const second = await runtime.newConversation()
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as {
        handleAgentEvent(slot: unknown, event: AgentEventType): void
      }).handleAgentEvent.bind(runtime)
      handleAgentEvent(firstSlot, { type: 'stream:start' })
      handleAgentEvent(firstSlot, { type: 'stream:thinking_delta', text: '后台继续分析' })

      const conversationEvents = events.filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
      expect(conversationEvents.length).toBeGreaterThan(0)
      expect(conversationEvents.every(event => event.conversationId === firstConversationId)).toBe(true)
      expect(conversationEvents.every(event => event.event.threadId === firstConversationId)).toBe(true)
      expect(conversationEvents.every(event => event.conversationId !== second.id)).toBe(true)
      expect(events.filter(event => event.type === 'snapshot')).toHaveLength(0)
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('does not attach a full workbench snapshot to high-frequency canonical updates', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      for (let index = 1; index <= 500; index += 1) {
        handleAgentEvent({
          type: 'stream:tool_call_delta',
          toolCallId: 'write-1',
          toolName: 'write_file',
          partialJson: 'x'.repeat(Math.min(index, 2_048)),
        })
      }

      expect(events.filter(event => event.type === 'conversation-event')).toHaveLength(500)
      expect(events.filter(event => event.type === 'snapshot')).toHaveLength(0)
      expect(events.filter(event => event.type === 'conversation-event').every(event => event.type === 'conversation-event' && event.event.type === 'tool.delta')).toBe(true)
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('forwards every streamed tool delta through the canonical spine', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path"' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path":"a"}' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'write-1', toolName: 'write_file', partialJson: '{"path":"b"}' })
      handleAgentEvent({ type: 'stream:end' })
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path":"c"}' })

      const intents = events
        .filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
        .map(event => event.event)
        .filter((event): event is Extract<typeof event, { type: 'tool.delta' }> => event.type === 'tool.delta')
      expect(intents.map(event => event.payload.toolCallId)).toEqual(['read-1', 'read-1', 'write-1', 'read-1'])
      expect(intents.map(event => event.payload.partialJson)).toEqual(['{"path"', '{"path":"a"}', '{"path":"b"}', '{"path":"c"}'])
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('deletes an inactive conversation while another task is running', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const inactiveId = runtime.getSnapshot().conversation.id
      runtime.conversations.recordEvent({
        type: 'turn:start',
        turn: { id: 'inactive-user', role: 'user', content: 'Persist this conversation', timestamp: Date.now() },
      })
      runtime.conversations.flushJournal()
      await runtime.newConversation()
      vi.spyOn(runtime.runtime.engine, 'isRunning').mockReturnValue(true)

      await expect(runtime.deleteConversation(inactiveId)).resolves.toBe(true)
      await expect(runtime.deleteConversation(runtime.getSnapshot().conversation.id)).rejects.toThrow('Cannot delete the active conversation while the agent is running')
    } finally {
      await runtime.destroy()
    }
  })

  it('projects the shared core without exposing provider credentials', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const snapshot = runtime.getSnapshot()
      expect(snapshot.workspace.path).toBe(workspacePath)
      expect(snapshot.runtime).toMatchObject({
        status: 'ready',
        configured: false,
        provider: 'custom',
        approvalPolicy: 'ask',
      })
      expect(snapshot.runtime).not.toHaveProperty('apiKey')
      expect(() => runtime.submitPrompt('hello')).toThrow('No API key is configured')
    } finally {
      await runtime.destroy()
    }
  })

  it('does not project a stale paused run state when the run controller is inactive', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      vi.spyOn(runtime.runtime.engine, 'getRunState').mockReturnValue({ phase: 'paused' } as ReturnType<typeof runtime.runtime.engine.getRunState>)

      expect(runtime.getSnapshot().runtime.status).toBe('ready')
      expect(runtime.resume()).toBe(false)
    } finally {
      await runtime.destroy()
    }
  })

  it('projects subagent evidence and lets Desktop stop one child independently', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    let release: (() => void) | undefined
    const started = runtime.runtime.subAgentTaskManager.startTask({
      kind: 'agent',
      agentType: 'explorer',
      label: 'Explorer',
      objective: 'Inspect the workbench boundary',
      workspacePath,
      run: ({ signal, recordEvent }) => new Promise<{ ok: boolean; finalText?: string; evidence: never[]; turns: number; elapsedMs: number; truncated: boolean; error?: string }>(resolve => {
        recordEvent({ type: 'turn_start', turn: 1, maxTurns: 4 })
        recordEvent({ type: 'evidence', evidence: { path: 'src/example.ts', startLine: 3, endLine: 8, preview: 'runtime boundary', content: 'RAW_SOURCE', reason: 'Shared runtime ownership' } })
        const finish = () => resolve({ ok: false, evidence: [], turns: 1, elapsedMs: 10, truncated: false, error: 'Stopped' })
        release = finish
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }),
      isSuccess: result => result.ok,
      getError: result => result.error,
    })

    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      const snapshot = runtime.getSnapshot()
      expect(snapshot.activity.subagents).toEqual([expect.objectContaining({
        id: started.task.id,
        label: 'Explorer',
        transcriptCount: 3,
        lastEvent: expect.stringContaining('找到关键证据'),
      })])
      const detail = runtime.readSubAgent(started.task.id, 0, 50)
      expect(detail.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'evidence', evidence: expect.objectContaining({ path: 'src/example.ts' }) }),
      ]))
      expect(JSON.stringify(detail)).not.toContain('RAW_SOURCE')

      const stopped = await runtime.stopSubAgent(started.task.id)
      expect(stopped.taskId).toBe(started.task.id)
      await started.promise
      expect(runtime.getSnapshot().activity.subagents[0]).toMatchObject({ status: 'stopped', retryable: true })
    } finally {
      release?.()
      await runtime.destroy()
    }
  })

  it('exposes secure desktop settings with native model controls', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const config: TurboFluxConfig = {
      ...createConfig(),
      provider: 'openai',
      apiKey: 'top-secret-key',
      baseUrl: '',
      model: 'gpt-5.6',
      reasoning: { enabled: true, effort: 'high' },
      activeApiConfigId: 'main',
      apiConfigs: [{
        id: 'main',
        name: 'Main',
        provider: 'openai',
        apiKey: 'top-secret-key',
        baseUrl: '',
        model: 'gpt-5.6',
        contextWindow: 1_050_000,
        maxTokens: 16_384,
        reasoning: { enabled: true, effort: 'high' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }
    const runtime = new WorkbenchRuntime({ workspacePath, config })

    try {
      const settings = await runtime.getSettings()
      expect(settings.apiProfiles[0]).toMatchObject({ id: 'main', hasApiKey: true })
      expect(JSON.stringify(settings)).not.toContain('top-secret-key')
      expect(settings.models.find(model => model.model === 'gpt-5.6')?.reasoningCapabilities?.efforts).toContain('max')
    } finally {
      await runtime.destroy()
    }
  })

  it('projects built-in system plugins without adding editable MCP config', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: createConfig(),
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'browser',
        tools: [{ name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })

    try {
      const settings = await runtime.getSettings()
      expect(settings.mcpServers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'browser', system: true, enabled: true, status: 'connected' }),
      ]))
      expect(runtime.runtime.mcpClient.searchTools('browser').map(tool => tool.name)).toEqual(['browser__observe'])
    } finally {
      await runtime.destroy()
    }
  })

  it('creates, reviews, edits, pins, filters, and forgets memories through the shared writer', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const created = await runtime.rememberMemory({
        text: 'Keep the renderer free of runtime truth.',
        kind: 'rule',
        scope: 'workspace_private',
        confidence: 'asserted',
        tags: ['desktop', 'architecture'],
        pinned: true,
      })
      expect(created.items).toEqual([
        expect.objectContaining({
          text: 'Keep the renderer free of runtime truth.',
          kind: 'rule',
          pinned: true,
          reviewState: 'user_approved',
          status: 'active',
        }),
      ])
      const id = created.items[0]!.id

      const updated = await runtime.updateMemory(id, { text: 'Keep runtime truth in WorkbenchRuntime.', pinned: false })
      expect(updated.items[0]).toMatchObject({ text: 'Keep runtime truth in WorkbenchRuntime.', pinned: false, reviewState: 'user_edited' })
      await expect(runtime.listMemories({ query: 'WorkbenchRuntime' })).resolves.toMatchObject({ items: [expect.objectContaining({ id })] })

      const forgotten = await runtime.forgetMemory(id, 'superseded')
      expect(forgotten.items[0]).toMatchObject({ id, status: 'rejected' })
      await expect(runtime.listMemories()).resolves.toMatchObject({ items: [] })
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps connected system capabilities exposed and treats composer selection as emphasis', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'computer',
        tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })
    let emphasized = false
    vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (_prompt, options) => {
      emphasized = options?.capabilities?.items.some(item => item.type === 'mcp' && item.id === 'computer') === true
      return []
    })

    try {
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).not.toContain('capabilities__request')
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).toContain('computer__observe')
      runtime.submitPrompt('Prepare the native presentation', undefined, {
        items: [{ type: 'mcp', id: 'computer', name: '电脑操控' }],
      })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(emphasized).toBe(true)
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).toContain('computer__observe')
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps raw computer payloads inside the core runtime instead of IPC snapshots and events', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
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
      output: 'PRIVATE_AX_VALUE /private/tmp/computer-frame.png',
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
    runtime.runtime.engine.restoreFromTurns([
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 101, toolCalls: [toolCall] },
      {
        id: 'result-1',
        role: 'tool_result',
        content: `computer__type_text: [ok] ${toolResult.output}`,
        timestamp: 102,
        toolResults: [toolResult],
      },
    ])
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'tool:call', toolCall })
      handleAgentEvent({ type: 'tool:result', toolResult })
      handleAgentEvent({
        type: 'stream:tool_call_delta',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialJson: JSON.stringify(toolCall.arguments),
      })

      const serialized = JSON.stringify({ snapshot: runtime.getSnapshot(), events })
      for (const sensitive of [
        'PRIVATE_TYPED_TEXT',
        'PRIVATE_KEYS',
        'PRIVATE_AX_VALUE',
        '/private/tmp/computer-frame.png',
        'observation-private',
        'ax-private-ref',
        '424242',
        '321.25',
        '654.75',
      ]) expect(serialized).not.toContain(sensitive)
      expect(runtime.getSnapshot().conversation.turns[0]?.toolCalls?.[0]?.arguments).toEqual({})
      expect(toolCall.arguments.text).toBe('PRIVATE_TYPED_TEXT')
      expect(toolResult.attachments[0]?.path).toBe('/private/tmp/computer-frame.png')
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('keeps a built-in plugin authoritative over a same-name editable MCP entry', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    saveProjectMcpSettings(workspacePath, {
      mcpServers: { browser: { enabled: true, command: '/usr/bin/false' } },
    })
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: createConfig(),
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'browser',
        tools: [{ name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })

    try {
      const matches = (await runtime.getSettings()).mcpServers.filter(server => server.name === 'browser')
      expect(matches).toHaveLength(1)
      expect(matches[0]).toMatchObject({ system: true, enabled: true, status: 'connected' })
      expect(matches[0]?.command).toBeUndefined()
    } finally {
      await runtime.destroy()
    }
  })

  it('shares mode and conversation lifecycle with the agent runtime', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      expect(runtime.setMode('plan').runtime.mode).toBe('plan')
      const previousId = runtime.getSnapshot().conversation.id
      const next = await runtime.newConversation()
      expect(next.id).not.toBe(previousId)
      expect(next.snapshot.conversation.turns).toEqual([])
      expect(next.snapshot.runtime.mode).toBe('plan')
    } finally {
      await runtime.destroy()
    }
  })

  it('runs independent main agents in separate conversations', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        model: 'test-model',
      },
    })
    let finishFirst!: () => void
    let finishSecond!: () => void
    const firstRun = new Promise<[]>(resolve => { finishFirst = () => resolve([]) })
    const secondRun = new Promise<[]>(resolve => { finishSecond = () => resolve([]) })
    const lifecycleEvents: Array<{ conversationId: string; status: string }> = []
    runtime.subscribe(event => {
      if (event.type === 'conversation-run') lifecycleEvents.push(event)
    })

    try {
      const firstEngine = runtime.runtime.engine
      const firstConversationId = runtime.getSnapshot().conversation.id
      const firstRunSpy = vi.spyOn(firstEngine, 'run').mockReturnValue(firstRun)
      expect(runtime.submitPrompt('first task').status).toBe('started')

      const second = await runtime.newConversation()
      const secondEngine = runtime.runtime.engine
      const secondRunSpy = vi.spyOn(secondEngine, 'run').mockReturnValue(secondRun)
      expect(secondEngine).not.toBe(firstEngine)
      expect(runtime.submitPrompt('second task').status).toBe('started')

      expect(firstRunSpy).toHaveBeenCalledOnce()
      expect(secondRunSpy).toHaveBeenCalledOnce()
      const firstPause = vi.spyOn(firstEngine, 'pause').mockReturnValue(true)
      const secondPause = vi.spyOn(secondEngine, 'pause')
      const firstResume = vi.spyOn(firstEngine, 'resume').mockReturnValue(true)
      const secondResume = vi.spyOn(secondEngine, 'resume')
      const firstAbort = vi.spyOn(firstEngine, 'abort')
      const secondAbort = vi.spyOn(secondEngine, 'abort')
      vi.spyOn(firstEngine, 'isRunning').mockReturnValue(true)
      vi.spyOn(secondEngine, 'isRunning').mockReturnValue(true)
      expect(runtime.pauseConversation(firstConversationId)).toBe(true)
      expect(firstPause).toHaveBeenCalledOnce()
      expect(secondPause).not.toHaveBeenCalled()
      vi.spyOn(firstEngine, 'getRunState').mockReturnValue({ phase: 'paused' } as ReturnType<typeof firstEngine.getRunState>)
      expect(runtime.resumeConversation(firstConversationId)).toBe(true)
      expect(firstResume).toHaveBeenCalledOnce()
      expect(secondResume).not.toHaveBeenCalled()
      expect(runtime.stopConversation(firstConversationId)).toBe(true)
      expect(firstAbort).toHaveBeenCalledOnce()
      expect(secondAbort).not.toHaveBeenCalled()
      expect(second.snapshot.conversationRuntimes).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: expect.any(String) }),
        expect.objectContaining({ conversationId: second.id }),
      ]))
      finishFirst()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(runtime.getSnapshot().conversation.id).toBe(second.id)
      expect(lifecycleEvents).toContainEqual(expect.objectContaining({ conversationId: firstConversationId, status: 'completed' }))
    } finally {
      finishFirst()
      finishSecond()
      await new Promise(resolve => setTimeout(resolve, 0))
      await runtime.destroy()
    }
  })

  it('exposes shared commands and preserves complete desktop drafts', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      expect(runtime.listCommands()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'mode.plan', slash: '/plan' }),
        expect.objectContaining({ id: 'context.compact', slash: '/compact' }),
        expect.objectContaining({ id: 'mcp.open', slash: '/mcp' }),
      ]))
      await expect(runtime.executeCommand('mode.plan')).resolves.toMatchObject({ snapshot: { runtime: { mode: 'plan' } } })

      runtime.recordDraft({
        text: 'continue later',
        attachments: [{ id: 'image-1', type: 'image', path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 12 }],
        files: [{ id: 'file-1', type: 'file', path: '/tmp/spec.pdf', mime: 'application/pdf', filename: 'spec.pdf', size: 34 }],
        pendingPastes: [{ placeholder: '【paste】', text: 'long text' }],
        capabilities: { items: [{ type: 'mcp', id: 'documents', name: 'Documents' }] },
      })
      expect(runtime.getSnapshot().draft).toMatchObject({
        text: 'continue later',
        attachments: [{ id: 'image-1' }],
        files: [{ id: 'file-1' }],
        pendingPastes: [{ placeholder: '【paste】', text: 'long text' }],
        capabilities: { items: [{ type: 'mcp', id: 'documents', name: 'Documents' }] },
      })
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps a draft-selected Computer capability across consecutive submissions', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'computer',
        requiresSelection: true,
        tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })
    const capabilities = { items: [{ type: 'mcp' as const, id: 'computer', name: '电脑操控' }] }
    runtime.recordDraft({
      text: '',
      attachments: [],
      files: [],
      pendingPastes: [],
      capabilities,
    })
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockResolvedValue()

    try {
      expect(runtime.submitPrompt('first native task')).toMatchObject({ status: 'started' })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.submitPrompt('continue the native task')).toMatchObject({ status: 'started' })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls.map(([, options]) => options?.capabilities)).toEqual([
        capabilities,
        capabilities,
      ])
      expect(runtime.getSnapshot().draft.capabilities).toEqual(capabilities)
    } finally {
      await runtime.destroy()
    }
  })

  it('steers only when an active run keeps the same capability selection', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
      registerSystemPlugins: client => {
        client.registerLocalServer({
          name: 'computer',
          requiresSelection: true,
          tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
          handler: async () => ({ ok: true }),
        })
        client.registerLocalServer({
          name: 'browser',
          tools: [{ name: 'observe', description: 'Observe a page', inputSchema: { type: 'object', properties: {} } }],
          handler: async () => ({ ok: true }),
        })
      },
    })
    const computer = { items: [{ type: 'mcp' as const, id: 'computer', name: '电脑操控' }] }
    const browser = { items: [{ type: 'mcp' as const, id: 'browser', name: '内置浏览器' }] }
    let releaseRun!: () => void
    const activeRun = new Promise<void>(resolve => {
      releaseRun = resolve
    })
    let running = false
    vi.spyOn(runtime.runtime.engine, 'isRunning').mockImplementation(() => running)
    vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async () => {
      running = true
      await activeRun
      running = false
      return []
    })
    const submitSteeringMessage = vi.spyOn(runtime.runtime.engine, 'submitSteeringMessage').mockReturnValue(true)

    try {
      expect(runtime.submitPrompt('start native task', undefined, computer)).toMatchObject({ status: 'started' })
      expect(runtime.submitPrompt('same native task guidance', undefined, computer)).toMatchObject({ status: 'steering' })

      const changed = runtime.submitPrompt('switch to browser work', undefined, browser)
      expect(changed).toMatchObject({ status: 'queued' })
      expect(submitSteeringMessage).toHaveBeenCalledTimes(1)
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
        expect.objectContaining({
          id: changed.inputId,
          prompt: 'switch to browser work',
          capabilities: browser,
        }),
      ])
    } finally {
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('hands queued inputs directly to the next foreground run without overlap', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const gates = new Map<string, () => void>()
    let activeRuns = 0
    let maximumActiveRuns = 0
    const handleAgentEvent = (runtime as unknown as {
      handleAgentEvent(event: AgentEventType): void
    }).handleAgentEvent.bind(runtime)
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      handleAgentEvent({
        type: 'turn:start',
        turn: {
          id: options?.userTurnId || `user-${prompt}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
          metadata: { workRunId: options?.userTurnId },
        },
      })
      activeRuns += 1
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns)
      await new Promise<void>(resolve => gates.set(prompt, resolve))
      activeRuns -= 1
      return []
    })

    try {
      expect(runtime.submitPrompt('first task')).toMatchObject({ status: 'started' })
      const queued = runtime.submitPrompt('second task')
      expect(queued).toMatchObject({ status: 'queued' })
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
        expect.objectContaining({ id: queued.inputId, prompt: 'second task' }),
      ])

      gates.get('first task')?.()
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

      expect(maximumActiveRuns).toBe(1)
      expect(run).toHaveBeenNthCalledWith(2, 'second task', expect.objectContaining({ userTurnId: queued.inputId }))
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    } finally {
      gates.get('first task')?.()
      gates.get('second task')?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('restores durable queued input and drains it after context compaction', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const queuedInput = { id: 'queued-after-restart', prompt: 'continue after compaction' }
    runtime.conversations.recordQueueState([queuedInput])
    const slot = (runtime as unknown as {
      activeConversationRuntime: unknown
      restorePersistedQueue(slot: unknown): void
    }).activeConversationRuntime
    ;(runtime as unknown as { restorePersistedQueue(slot: unknown): void }).restorePersistedQueue(slot)
    const compactContext = vi.spyOn(runtime.runtime.engine, 'compactContext').mockResolvedValue(true)
    const handleAgentEvent = (runtime as unknown as {
      handleAgentEvent(event: AgentEventType): void
    }).handleAgentEvent.bind(runtime)
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      handleAgentEvent({
        type: 'turn:start',
        turn: {
          id: options?.userTurnId || 'restored-user',
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
          metadata: { workRunId: options?.userTurnId },
        },
      })
      return []
    })

    try {
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([queuedInput])
      await runtime.compactContext()
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      expect(compactContext).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith('continue after compaction', expect.objectContaining({
        userTurnId: 'queued-after-restart',
      }))
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    } finally {
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('rejects an explicitly selected plugin when it is unavailable', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockResolvedValue()

    try {
      expect(() => runtime.submitPrompt('control the desktop', undefined, {
        items: [{ type: 'mcp', id: 'computer', name: '电脑操控' }],
      })).toThrow('电脑操控 已不在当前工作区，请从输入框重新选择')
      expect(run).not.toHaveBeenCalled()
    } finally {
      await runtime.destroy()
    }
  })

  it('rewinds conversation history before resending an edited user message', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    const attachment = { id: 'image-1', type: 'image' as const, path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 12 }
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old question', timestamp: 3, metadata: { attachments: [attachment] } },
      { id: 'assistant-2', role: 'assistant', content: 'old answer', timestamp: 4 },
    ])
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      runtime.runtime.engine.restoreFromTurns([
        { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
        {
          id: options?.userTurnId || 'generated-user',
          role: 'user',
          content: prompt,
          timestamp: 5,
          metadata: { attachments: options?.attachments, workRunId: options?.userTurnId },
        },
      ])
      return []
    })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).resolves.toEqual({ status: 'started', inputId: 'user-2' })
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'edited question' }),
      ])
      expect(run).toHaveBeenCalledWith('edited question', {
        attachments: [attachment],
        capabilities: undefined,
        reuseLastUserTurn: true,
        userTurnId: 'user-2',
      })
      await new Promise<void>(resolve => setImmediate(resolve))
    } finally {
      await runtime.destroy()
    }
  })

  it('does not emit a false idle state between history rewrite and the restarted run', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        gitEnabled: false,
      },
    })
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old question', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'old answer', timestamp: 4 },
    ])
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))
    vi.spyOn(runtime.runtime.engine as any, 'initializeGit').mockResolvedValue(true)
    vi.spyOn(runtime.runtime.engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    vi.spyOn(runtime.runtime.engine as any, 'callModel').mockResolvedValue({
      id: 'assistant-edited',
      role: 'assistant',
      content: 'edited answer',
      timestamp: 5,
    })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).resolves.toEqual({ status: 'started', inputId: 'user-2' })
      await runtime.runtime.engine.waitUntilIdle()
      await new Promise<void>(resolve => setImmediate(resolve))

      const conversationEvents = events
        .filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
        .map(event => event.event)
      const phases = conversationEvents
        .filter(event => event.type === 'run.state_changed')
        .map(event => event.payload.state.phase)
      expect(phases[0]).toBe('thinking')
      expect(phases).not.toContain('idle')
      expect(phases).toContain('completed')
      expect(runtime.getSnapshot().work.projection.nodes['input:user-2']).toMatchObject({
        content: 'edited question',
        status: 'completed',
      })
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('fully stops an active run before rewinding and resending an edited message', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old task', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'old progress', timestamp: 4 },
    ])
    let stopActiveRun!: () => void
    const run = vi.spyOn(runtime.runtime.engine, 'run')
      .mockImplementationOnce(() => new Promise(resolve => { stopActiveRun = () => resolve([]) }))
      .mockImplementationOnce(async (prompt, options) => {
        runtime.runtime.engine.restoreFromTurns([
          { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
          {
            id: options?.userTurnId || 'generated-user',
            role: 'user',
            content: prompt,
            timestamp: 5,
            metadata: { workRunId: options?.userTurnId },
          },
        ])
        return []
      })
    const abort = vi.spyOn(runtime.runtime.engine, 'abort').mockImplementation(() => stopActiveRun())

    try {
      runtime.submitPrompt('currently running')
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(runtime.resendFromTurn('user-2', 'edited task')).resolves.toEqual({ status: 'started', inputId: 'user-2' })

      expect(abort).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenNthCalledWith(2, 'edited task', {
        attachments: undefined,
        capabilities: undefined,
        reuseLastUserTurn: true,
        userTurnId: 'user-2',
      })
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'edited task' }),
      ])
      expect(runtime.getSnapshot().work.projection.nodes['input:user-2']).toMatchObject({
        content: 'edited task',
        status: 'completed',
      })
    } finally {
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('restores the original branch when an edited message cannot launch', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    const originalTurns = [
      { id: 'user-1', role: 'user' as const, content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant' as const, content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user' as const, content: 'old question', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant' as const, content: 'old answer', timestamp: 4 },
    ]
    runtime.runtime.engine.restoreFromTurns(originalTurns)
    vi.spyOn(runtime as unknown as { startPrompt: (...args: unknown[]) => void }, 'startPrompt')
      .mockImplementation(() => { throw new Error('run launch failed') })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).rejects.toThrow('run launch failed')
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'old question' }),
        expect.objectContaining({ id: 'assistant-2', content: 'old answer' }),
      ])
    } finally {
      await runtime.destroy()
    }
  })

  it('runs automations with their own approval policy and records completion', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    let releaseRun!: () => void
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(() => new Promise(resolve => {
      releaseRun = () => resolve([])
    }))
    const automation = runtime.createAutomation({
      name: 'Review',
      prompt: 'Review the latest outputs',
      schedule: { kind: 'manual' },
      approvalPolicy: 'agent',
    }).automations[0]

    try {
      const foregroundConversationId = runtime.getSnapshot().conversation.id
      const result = await runtime.runAutomation(automation.id)
      expect(result.status).toBe('started')
      expect(result.conversationId).not.toBe(foregroundConversationId)
      expect(runtime.getSnapshot().conversation.id).toBe(foregroundConversationId)
      const slots = (runtime as unknown as { conversationRuntimes: Map<string, { runtime: WorkbenchRuntime['runtime'] }> }).conversationRuntimes
      expect(slots.get(result.conversationId)?.runtime.engine.getApprovalPolicy()).toBe('agent')
      expect(runtime.automations.get(automation.id)).toMatchObject({
        lastStatus: 'running',
        conversationId: result.conversationId,
        history: [expect.objectContaining({ inputId: result.inputId, conversationId: result.conversationId, status: 'running' })],
      })
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(slots.get(result.conversationId)?.runtime.engine.getApprovalPolicy()).toBe('ask')
      expect(runtime.automations.get(automation.id)).toMatchObject({
        lastStatus: 'completed',
        history: [expect.objectContaining({ inputId: result.inputId, status: 'completed' })],
      })
    } finally {
      releaseRun?.()
      await runtime.destroy()
    }
  })

  it('reuses an automation conversation and records a concise result summary', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockResolvedValue([{
      id: 'automation-result',
      role: 'assistant',
      content: 'Automation finished successfully.\n\nThe report is ready.',
      timestamp: Date.now(),
    }])
    const automation = runtime.createAutomation({
      name: 'Reusable',
      prompt: 'Prepare the report',
      schedule: { kind: 'manual' },
    }).automations[0]

    try {
      const foregroundId = runtime.getSnapshot().conversation.id
      const first = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.automations.getRun(automation.id, first.automationRunId)).toMatchObject({
        status: 'completed',
        conversationId: first.conversationId,
        resultSummary: 'Automation finished successfully. The report is ready.',
      })
      const second = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(second.conversationId).toBe(first.conversationId)
      expect(runtime.getSnapshot().conversation.id).toBe(foregroundId)
      expect(runtime.automations.get(automation.id)?.history).toHaveLength(2)
    } finally {
      await runtime.destroy()
    }
  })

  it('cancels a background automation without overwriting its terminal state', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    let releaseRun!: () => void
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(() => new Promise(resolve => {
      releaseRun = () => resolve([])
    }))
    const automation = runtime.createAutomation({
      name: 'Cancelable',
      prompt: 'Wait for cancellation',
      schedule: { kind: 'manual' },
    }).automations[0]

    try {
      const started = await runtime.runAutomation(automation.id)
      await runtime.cancelAutomationRun(automation.id)
      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({ status: 'canceled' })
      expect((runtime as unknown as { automationRunTimers: Map<string, unknown> }).automationRunTimers.size).toBe(0)
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({ status: 'canceled' })
    } finally {
      releaseRun?.()
      await runtime.destroy()
    }
  })
}, 15_000)
