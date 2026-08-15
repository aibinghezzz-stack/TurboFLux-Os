import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_MARKETPLACE } from './marketplace'
import { SkillMarketplaceInstallManager } from './marketplaceInstallManager'

const temporaryDirectories: string[] = []
const frontendSkill = '---\nname: frontend-design\ndescription: Test skill\n---\n\nTest.'

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function frontendEntry() {
  return SKILL_MARKETPLACE.find(entry => entry.id === 'anthropic-frontend-design')!
}

describe('SkillMarketplaceInstallManager', () => {
  it('deduplicates repeated installs and persists the completed job', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-manager-'))
    temporaryDirectories.push(targetRoot)
    let rawRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([{
          type: 'file',
          path: 'skills/frontend-design/SKILL.md',
          size: Buffer.byteLength(frontendSkill),
          download_url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
        }]), { status: 200 })
      }
      rawRequests += 1
      return new Response(frontendSkill, { status: 200 })
    }))
    const manager = new SkillMarketplaceInstallManager({
      targetRoot,
      statePath: join(targetRoot, 'state', 'jobs.json'),
      concurrency: 1,
    })
    await manager.initialize()

    const first = manager.install(frontendEntry())
    const duplicate = manager.install(frontendEntry())

    expect(duplicate).toBe(first)
    await expect(first).resolves.toMatchObject({ installState: 'installed' })
    expect(rawRequests).toBe(1)
    expect(manager.latestJob(frontendEntry().id)).toMatchObject({ status: 'completed', progress: 1 })
  })

  it('cancels an active streaming download', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-manager-'))
    temporaryDirectories.push(targetRoot)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([{
          type: 'file',
          path: 'skills/frontend-design/SKILL.md',
          size: Buffer.byteLength(frontendSkill),
          download_url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
        }]), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }))
    const manager = new SkillMarketplaceInstallManager({ targetRoot, concurrency: 1 })
    await manager.initialize()
    const install = manager.install(frontendEntry())
    await vi.waitFor(() => expect(manager.latestJob(frontendEntry().id)?.status).toBe('running'))

    manager.cancel(frontendEntry().id)

    await expect(install).rejects.toMatchObject({ code: 'SKILL_INSTALL_CANCELED' })
    expect(manager.latestJob(frontendEntry().id)).toMatchObject({ status: 'canceled', retryable: true })
  })
})
