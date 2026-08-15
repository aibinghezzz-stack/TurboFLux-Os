import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installMarketplaceSkill,
  listSkillMarketplace,
  recoverSkillMarketplaceInstallations,
  SKILL_MARKETPLACE,
  SKILL_MARKETPLACE_SOURCES,
  uninstallMarketplaceSkill,
} from './marketplace'

const temporaryDirectories: string[] = []

const frontendSkill = '---\nname: frontend-design\ndescription: Test skill\n---\n\nUse strong visual direction.'

function stubFrontendDownload(skill = frontendSkill): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify([{
        type: 'file',
        path: 'skills/frontend-design/SKILL.md',
        size: Buffer.byteLength(skill),
        download_url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(skill, { status: 200 })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('skill marketplace catalog', () => {
  it('keeps curated entries installable and uniquely addressable', () => {
    expect(SKILL_MARKETPLACE.length).toBeGreaterThanOrEqual(10)
    expect(new Set(SKILL_MARKETPLACE.map(entry => entry.id)).size).toBe(SKILL_MARKETPLACE.length)
    expect(new Set(SKILL_MARKETPLACE.map(entry => entry.skillId)).size).toBe(SKILL_MARKETPLACE.length)
    expect(SKILL_MARKETPLACE.every(entry => entry.repositoryUrl.startsWith('https://github.com/'))).toBe(true)
    expect(SKILL_MARKETPLACE.every(entry => entry.path && entry.ref && entry.promptTemplate.length > 30)).toBe(true)
  })

  it('links every entry to a visible source collection', () => {
    const sourceIds = new Set(SKILL_MARKETPLACE_SOURCES.map(source => source.id))

    expect(SKILL_MARKETPLACE.every(entry => sourceIds.has(entry.sourceId))).toBe(true)
    expect(SKILL_MARKETPLACE_SOURCES.some(source => source.kind === 'official')).toBe(true)
    expect(SKILL_MARKETPLACE_SOURCES.some(source => source.kind === 'community')).toBe(true)
  })

  it('marks locally available skills without mutating the catalog', () => {
    const entries = listSkillMarketplace(['pptx', 'security-review'])

    expect(entries.find(entry => entry.skillId === 'pptx')?.installed).toBe(true)
    expect(entries.find(entry => entry.skillId === 'security-review')?.installed).toBe(true)
    expect(entries.find(entry => entry.skillId === 'frontend-design')?.installed).toBe(false)
    expect(SKILL_MARKETPLACE.some(entry => entry.installed !== undefined)).toBe(false)
  })

  it('downloads a curated skill folder into an isolated target', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()

    const installed = await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })

    expect(installed.installed).toBe(true)
    expect(installed.installState).toBe('installed')
    expect(readFileSync(join(targetRoot, 'frontend-design', 'SKILL.md'), 'utf8')).toBe(frontendSkill)
    expect(readFileSync(join(targetRoot, 'frontend-design', '.turboflux-market.json'), 'utf8')).toContain('anthropic-frontend-design')
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')).toMatchObject({
      installed: true,
      installState: 'installed',
      installedVersion: '1.0.0',
      fileCount: 1,
      canUninstall: true,
    })
  })

  it('accepts valid skills with more than 160 files and reports real progress', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    const files = Array.from({ length: 161 }, (_, index) => ({
      type: 'file',
      path: index === 0 ? 'skills/frontend-design/SKILL.md' : `skills/frontend-design/examples/example-${index}.txt`,
      size: Buffer.byteLength(index === 0 ? frontendSkill : `example ${index}`),
      download_url: `https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/${index === 0 ? 'SKILL.md' : `examples/example-${index}.txt`}`,
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/')) return new Response(JSON.stringify(files), { status: 200 })
      const index = href.endsWith('/SKILL.md') ? 0 : Number(href.match(/example-(\d+)\.txt$/)?.[1] || 0)
      return new Response(index === 0 ? frontendSkill : `example ${index}`, { status: 200 })
    }))
    const progress: Array<{ phase: string; filesCompleted: number; filesTotal: number }> = []

    const installed = await installMarketplaceSkill('anthropic-frontend-design', {
      targetRoot,
      onProgress: event => progress.push({ phase: event.phase, filesCompleted: event.filesCompleted, filesTotal: event.filesTotal }),
    })

    expect(installed.fileCount).toBe(161)
    expect(progress.some(event => event.phase === 'downloading' && event.filesTotal === 161)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', filesCompleted: 161, filesTotal: 161 })
  })

  it('detects modified and broken managed installations', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })
    const skillPath = join(targetRoot, 'frontend-design', 'SKILL.md')

    writeFileSync(skillPath, `${frontendSkill}\nLocal change`)
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installState).toBe('modified')

    rmSync(skillPath)
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installState).toBe('broken')
  })

  it('detects catalog updates and malformed install records', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })
    const markerPath = join(targetRoot, 'frontend-design', '.turboflux-market.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...marker, catalogVersion: '0.9.0' }))
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installState).toBe('update-available')

    writeFileSync(markerPath, '{invalid')
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installState).toBe('broken')
    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot })).rejects.toThrow('安装记录异常')
    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot, allowOverwrite: true })).resolves.toMatchObject({ installState: 'installed' })
  })

  it('does not overwrite local changes without explicit confirmation', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })
    const skillPath = join(targetRoot, 'frontend-design', 'SKILL.md')
    writeFileSync(skillPath, 'local edit')

    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot })).rejects.toThrow('本地修改')
    expect(readFileSync(skillPath, 'utf8')).toBe('local edit')
    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot, allowOverwrite: true })).resolves.toMatchObject({ installState: 'installed' })
    expect(readFileSync(skillPath, 'utf8')).toBe(frontendSkill)
  })

  it('only uninstalls marketplace-managed skills', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })

    await expect(uninstallMarketplaceSkill('anthropic-frontend-design', { targetRoot })).resolves.toMatchObject({ installState: 'not-installed' })
    expect(listSkillMarketplace([], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installed).toBe(false)

    const localDirectory = join(targetRoot, 'frontend-design')
    mkdirSync(localDirectory, { recursive: true })
    writeFileSync(join(localDirectory, 'SKILL.md'), frontendSkill)
    await expect(uninstallMarketplaceSkill('anthropic-frontend-design', { targetRoot })).rejects.toThrow('不是由 Skills 市场管理')
  })

  it('keeps the previous installation when an update download fails', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })
    const skillPath = join(targetRoot, 'frontend-design', 'SKILL.md')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify([{
          type: 'file',
          path: 'skills/frontend-design/SKILL.md',
          size: Buffer.byteLength(frontendSkill),
          download_url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
        }]), { status: 200 })
      }
      return new Response('upstream unavailable', { status: 503 })
    }))

    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot })).rejects.toThrow()
    expect(readFileSync(skillPath, 'utf8')).toBe(frontendSkill)
    expect(listSkillMarketplace(['frontend-design'], { targetRoot }).find(entry => entry.id === 'anthropic-frontend-design')?.installState).toBe('installed')
  })

  it('falls back to the GitHub Contents API when raw downloads fail', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    let fileAttempts = 0
    let apiFileAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/') && apiFileAttempts === 0 && !href.includes('SKILL.md')) {
        return new Response(JSON.stringify([{
          type: 'file',
          path: 'skills/frontend-design/SKILL.md',
          size: Buffer.byteLength(frontendSkill),
          download_url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
        }]), { status: 200 })
      }
      if (href.startsWith('https://api.github.com/')) {
        apiFileAttempts += 1
        return new Response(frontendSkill, { status: 200 })
      }
      fileAttempts += 1
      return new Response('retry', { status: 503 })
    }))

    await expect(installMarketplaceSkill('anthropic-frontend-design', { targetRoot })).resolves.toMatchObject({ installState: 'installed' })
    expect(fileAttempts).toBe(3)
    expect(apiFileAttempts).toBe(1)
  })

  it('cleans interrupted staging and restores the last valid backup', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'turboflux-market-'))
    temporaryDirectories.push(targetRoot)
    stubFrontendDownload()
    await installMarketplaceSkill('anthropic-frontend-design', { targetRoot })
    const target = join(targetRoot, 'frontend-design')
    renameSync(target, join(targetRoot, '.backup-frontend-design-zvalid'))
    mkdirSync(join(targetRoot, '.install-frontend-design-stale'), { recursive: true })

    const recovery = await recoverSkillMarketplaceInstallations(targetRoot)

    expect(recovery.removedTemporaryDirectories).toBe(1)
    expect(recovery.restoredBackups).toEqual(['frontend-design'])
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(frontendSkill)
  })
})
