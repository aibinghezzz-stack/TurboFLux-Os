import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplaceRequestController } from './marketplaceNetwork'

afterEach(() => vi.unstubAllGlobals())

describe('SkillMarketplaceRequestController', () => {
  it('opens, fast-fails, and half-opens a failing source circuit', async () => {
    let now = 1_000
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new SkillMarketplaceRequestController({ failureThreshold: 3, cooldownMs: 1_000, now: () => now, random: () => 0 })
    const request = () => controller.request('https://raw.githubusercontent.com/test', {}, {
      transport: 'github-raw',
      attempts: 1,
      timeoutMs: 1_000,
      consume: response => response.text(),
    })

    await expect(request()).rejects.toThrow('503')
    await expect(request()).rejects.toThrow('503')
    await expect(request()).rejects.toThrow('503')
    await expect(request()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_CIRCUIT_OPEN' })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    now += 1_001
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await expect(request()).resolves.toBe('ok')
    expect(controller.snapshots().find(item => item.transport === 'github-raw')).toMatchObject({ state: 'closed', failures: 0 })
  })

  it('honors Retry-After when scheduling a retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const notices: Array<{ delayMs: number }> = []
    const controller = new SkillMarketplaceRequestController()

    const result = await controller.request('https://api.github.com/test', {}, {
      transport: 'github-api',
      attempts: 2,
      timeoutMs: 1_000,
      onRetry: notice => notices.push(notice),
      consume: response => response.json(),
    })

    expect(result).toEqual({ ok: true })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ delayMs: 0 })
  })
})
