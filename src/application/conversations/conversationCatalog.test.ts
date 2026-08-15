import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationCatalog } from './conversationCatalog'
import type { PersistedConversation } from './types'

function conversation(id: string, update: Partial<PersistedConversation> = {}): PersistedConversation {
  return {
    id,
    title: 'Indexed task',
    titleSource: 'generated',
    workspacePath: '/workspace/project',
    createdAt: 100,
    updatedAt: 200,
    mode: 'vibe',
    model: 'test-model',
    provider: 'custom',
    turnCount: 1,
    turns: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 100 }],
    ...update,
  }
}

describe('ConversationCatalog', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-catalog-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates a huge snapshot by reading bounded metadata slices only', async () => {
    const huge = conversation('huge', {
      turns: [{ id: 'user-1', role: 'user', content: 'x'.repeat(2 * 1024 * 1024), timestamp: 100 }],
    })
    writeFileSync(join(directory, 'huge.jsonl'), `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: huge })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([expect.objectContaining({ id: 'huge', title: 'Indexed task', turnCount: 1 })])
    expect(catalog.getDiagnostics().bytesRead).toBeLessThanOrEqual(512 * 1024)
  })

  it('keeps empty shells hidden and discovers durable drafts', async () => {
    const meta = conversation('draft', { title: 'Untitled', turnCount: 0, turns: [] })
    writeFileSync(join(directory, 'draft.jsonl'), [
      JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta }),
      JSON.stringify({ version: 2, type: 'draft_state', timestamp: 101, draft: { text: 'Drafted task' } }),
      '',
    ].join('\n'))
    writeFileSync(join(directory, 'empty.jsonl'), `${JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta: { ...meta, id: 'empty' } })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([expect.objectContaining({ id: 'draft', title: 'Drafted task' })])
  })

  it('persists incremental upserts, title changes, and removals', async () => {
    mkdirSync(directory, { recursive: true })
    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()
    catalog.upsert(conversation('active'))
    expect(catalog.updateTitle('active', 'Renamed task', 'custom', 300)).toBe(true)
    await catalog.flush()

    const persisted = readFileSync(join(directory, '.conversation-catalog-v1.json'), 'utf8')
    expect(persisted).toContain('Renamed task')

    catalog.remove('active')
    await catalog.flush()
    const reloaded = new ConversationCatalog(directory)
    await reloaded.initialize()
    expect(reloaded.listAll()).toEqual([])
  })

  it('serves repeated listings without touching conversation history again', async () => {
    writeFileSync(join(directory, 'one.jsonl'), `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: conversation('one') })}\n`)
    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()
    const afterInitialize = catalog.getDiagnostics()

    expect(catalog.listAll()).toHaveLength(1)
    expect(catalog.listAll()).toHaveLength(1)
    expect(catalog.getDiagnostics()).toEqual(afterInitialize)
  })
})
