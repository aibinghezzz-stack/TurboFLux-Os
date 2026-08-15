import { describe, expect, it } from 'vitest'
import { buildWorkPackCatalog } from './workPackCatalog'
import type { PluginSnapshot } from '../plugins/pluginService'

describe('Work Pack catalog', () => {
  it('merges Skill and plugin marketplaces into one product catalog', () => {
    const plugins: PluginSnapshot = {
      schemaVersion: 1,
      warnings: [],
      plugins: [],
      marketplace: [{
        id: 'delivery-pack',
        publisher: 'TurboFlux',
        trust: 'verified',
        description: 'Delivery tools and review workflow',
        marketplace: {
          featured: true,
          sortOrder: 12,
          outcomes: ['Reviewed delivery'],
          examples: [{ title: 'Review this', prompt: 'Review the current delivery' }],
          worksWith: ['Browser'],
          releaseNotes: 'Initial release',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
        installed: false,
        manifest: {
          id: 'turboflux.delivery-pack',
          name: 'Delivery Pack',
          description: 'Delivery tools and review workflow',
          version: '1.0.0',
          author: { name: 'TurboFlux' },
          icon: 'pdf-file',
          permissions: ['filesystem.read'],
          contributes: {
            skills: [{ id: 'delivery-review', name: 'Delivery Review', command: '/delivery-review', description: 'Review delivery quality', category: 'custom' }],
            tools: [{ id: 'render', name: 'Render', description: 'Render output', handler: 'render' }],
          },
        },
      }],
    }
    const snapshot = buildWorkPackCatalog({
      skillEntries: [{
        id: 'frontend-design', skillId: 'frontend-design', name: 'Frontend Design', description: 'Design interfaces', category: '设计', icon: '◇', author: 'Anthropic', sourceId: 'anthropic', repository: 'anthropics/skills', repositoryUrl: 'https://github.com/anthropics/skills', ref: 'main', path: 'skills/frontend-design', license: 'Apache-2.0', promptTemplate: 'Build an interface', featured: true, installState: 'not-installed',
      }],
      skillSources: [{ id: 'anthropic', name: 'Anthropic Skills', description: 'Official skills', repositoryUrl: 'https://github.com/anthropics/skills', kind: 'official' }],
      skillJobs: [],
      installedSkills: [],
      plugins,
    })

    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries.find(entry => entry.id === 'skill:frontend-design')).toMatchObject({ kind: 'workflow', trust: 'verified', contributions: { skills: 1, tools: 0, commands: 0 } })
    expect(snapshot.entries.find(entry => entry.id === 'plugin:delivery-pack')).toMatchObject({
      icon: 'pdf-file',
      kind: 'bundle',
      featured: true,
      sortOrder: 12,
      outcomes: ['Reviewed delivery'],
      examples: [{ title: 'Review this', prompt: 'Review the current delivery' }],
      worksWith: ['Browser'],
      releaseNotes: 'Initial release',
      marketplaceUpdatedAt: '2026-08-13T00:00:00.000Z',
      permissions: ['filesystem.read'],
      contributions: { skills: 1, tools: 1, commands: 0 },
    })
  })

  it('projects enabled plugin capabilities and local Skills as installed Work Packs', () => {
    const now = Date.now()
    const plugins: PluginSnapshot = {
      schemaVersion: 1,
      warnings: [],
      marketplace: [],
      plugins: [{
        id: 'local.tools',
        path: '/tmp/local-tools',
        source: 'local',
        enabled: true,
        state: 'enabled',
        approvedPermissions: [],
        installedAt: now,
        updatedAt: now,
        diagnostics: ['sandboxed'],
        serverName: 'plugin-local-tools',
        manifest: {
          id: 'local.tools',
          name: 'Local Tools',
          description: 'Local integration',
          version: '1.0.0',
          author: { name: 'Local' },
          contributes: {
            skills: [{ id: 'plugin-workflow', name: 'Plugin Workflow', command: '/plugin-workflow', description: 'Packaged workflow', category: 'custom' }],
            tools: [{ id: 'inspect', name: 'Inspect', description: 'Inspect files', handler: 'inspect' }],
          },
        },
      }],
    }
    const snapshot = buildWorkPackCatalog({
      skillEntries: [],
      skillSources: [],
      skillJobs: [],
      installedSkills: [
        { id: 'local-writing', name: 'Local Writing', description: 'Local workflow', category: 'custom' },
        { id: 'plugin-workflow', name: 'Plugin Workflow', description: 'Projected workflow', category: 'custom' },
      ],
      plugins,
    })

    expect(snapshot.installed.map(entry => entry.id)).toEqual(['local-plugin:local.tools', 'local-skill:local-writing'])
    expect(snapshot.entries.find(entry => entry.id === 'local-plugin:local.tools')?.emphasis).toEqual({ type: 'skill', id: 'plugin-workflow', name: 'Plugin Workflow' })
    expect(snapshot.entries.find(entry => entry.id === 'local-skill:plugin-workflow')).toBeUndefined()
    expect(snapshot.entries.find(entry => entry.id === 'local-skill:local-writing')?.canUninstall).toBe(false)
  })
})
