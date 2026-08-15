import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient } from '../../core/mcp/client'
import { PluginService } from './pluginService'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(root: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const directory = join(root, 'fixture')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest))
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return directory
}

describe('PluginService', () => {
  it('installs, enables, projects Skills, disables, and persists metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, {
      id: 'example.workflow', name: 'Example', description: 'Example plugin', version: '1.0.0', author: { name: 'Test' }, permissions: [],
      contributes: { skills: [{ id: 'review', name: 'Review', command: '/review', description: 'Review work', category: 'custom', promptPath: 'skills/review/SKILL.md' }] },
    }, { 'skills/review/SKILL.md': '# Review\nCheck the result.' })
    const store = join(root, 'plugins.json')
    const pluginsRoot = join(root, 'plugins')
    const service = new PluginService(store, pluginsRoot, workspace)
    await service.initialize(new McpClient())
    await service.installFromDirectory(source, [])
    await service.setEnabled('example.workflow', true)
    const projected = service.list().plugins[0]
    expect(projected.state).toBe('enabled')
    const skillPath = join(workspace, '.turboflux', 'skills', `plugin-${await import('node:crypto').then(({ createHash }) => createHash('sha256').update('example.workflow').digest('hex').slice(0, 10))}-review`, 'SKILL.md')
    expect(readFileSync(skillPath, 'utf8')).toContain('name: review')
    await service.setEnabled('example.workflow', false)
    expect(() => readFileSync(skillPath, 'utf8')).toThrow()
    expect(new PluginService(store, pluginsRoot, workspace).list().plugins[0].enabled).toBe(false)
  })

  it('rejects traversal entries and unapproved permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, { id: 'bad.plugin', name: 'Bad', description: '', version: '1.0.0', author: { name: 'Test' }, main: '../escape.mjs', permissions: ['network'] })
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await expect(service.inspectDirectory(source)).rejects.toThrow('unsafe path')
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'permission.plugin', name: 'Permission', description: '', version: '1.0.0', author: { name: 'Test' }, permissions: ['network'] }))
    await expect(service.installFromDirectory(source, [])).rejects.toThrow('must be approved')
  })

  it('does not bundle product marketplace content into the open-source core', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await expect(service.installMarketplace('turboflux-office-workagent')).rejects.toThrow('Marketplace plugin not found')
    expect(service.list().marketplace).toEqual([])
  })
})
