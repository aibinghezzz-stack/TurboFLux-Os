import type { SkillMarketplaceEntry, SkillMarketplaceSource } from '../../core/skills/marketplace'
import type { SkillMarketplaceInstallJob, SkillMarketplaceInstallManagerSnapshot } from '../../core/skills/marketplaceInstallManager'
import type { PluginRecord, PluginSnapshot } from '../plugins/pluginService'
import type { PluginMarketplaceEntry } from '../plugins/marketplace'
import type { WorkPackEntry, WorkPackKind } from '../../shared/workPackTypes'

export interface WorkPackCatalogSnapshot {
  schemaVersion: 1
  entries: WorkPackEntry[]
  installed: WorkPackEntry[]
  jobs: SkillMarketplaceInstallJob[]
  recovery?: SkillMarketplaceInstallManagerSnapshot['recovery']
  warnings: string[]
}

export interface WorkPackCatalogInput {
  skillEntries: SkillMarketplaceEntry[]
  skillSources: SkillMarketplaceSource[]
  skillJobs: SkillMarketplaceInstallJob[]
  skillRecovery?: SkillMarketplaceInstallManagerSnapshot['recovery']
  installedSkills: Array<{ id: string; name: string; description: string; category: string }>
  plugins: PluginSnapshot
}

function pluginKind(entry: PluginMarketplaceEntry | PluginRecord): WorkPackKind {
  const manifest = 'manifest' in entry ? entry.manifest : entry
  const skills = manifest.contributes?.skills?.length || 0
  const tools = manifest.contributes?.tools?.length || 0
  const commands = manifest.contributes?.commands?.length || 0
  if (skills > 1 || (skills > 0 && (tools > 0 || commands > 0))) return 'bundle'
  return tools > 0 || commands > 0 || Boolean(manifest.main) ? 'integration' : 'workflow'
}

function pluginCapabilities(record: PluginMarketplaceEntry | PluginRecord): string[] {
  const manifest = record.manifest
  const values = [
    ...(manifest.contributes?.skills || []).map(item => item.name || item.description),
    ...(manifest.contributes?.tools || []).map(item => item.name || item.description),
    ...(manifest.contributes?.commands || []).map(item => item.title),
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value))
  return [...new Set(values)].slice(0, 8)
}

function pluginContributions(manifest: PluginRecord['manifest']) {
  return {
    skills: manifest.contributes?.skills?.length || 0,
    tools: manifest.contributes?.tools?.length || 0,
    commands: manifest.contributes?.commands?.length || 0,
  }
}

function pluginEmphasis(plugin?: PluginRecord) {
  if (!plugin?.enabled || plugin.state !== 'enabled') return undefined
  const skill = plugin.manifest.contributes?.skills?.[0]
  if (skill) return { type: 'skill' as const, id: skill.id, name: skill.name }
  if (plugin.serverName) return { type: 'mcp' as const, id: plugin.serverName, name: plugin.manifest.name }
  return undefined
}

export function buildWorkPackCatalog(input: WorkPackCatalogInput): WorkPackCatalogSnapshot {
  const sourceById = new Map(input.skillSources.map(source => [source.id, source]))
  const installedSkillById = new Map(input.installedSkills.map(skill => [skill.id, skill]))
  const pluginById = new Map(input.plugins.plugins.map(plugin => [plugin.id, plugin]))
  const entries: WorkPackEntry[] = input.skillEntries.map(entry => {
    const source = sourceById.get(entry.sourceId)
    const installedSkill = installedSkillById.get(entry.skillId)
    return {
      id: `skill:${entry.id}`,
      name: entry.name,
      description: entry.description,
      version: entry.version || '1.0.0',
      publisher: entry.author,
      category: entry.category,
      icon: entry.icon,
      kind: 'workflow',
      trust: source?.kind === 'official' ? 'verified' : 'community',
      sourceId: entry.sourceId,
      sourceName: source?.name || entry.author,
      sourceUrl: entry.repositoryUrl,
      license: entry.license,
      requirement: entry.requirement,
      tags: [...(entry.tags || [])],
      capabilities: [...(entry.capabilities || [])],
      sortOrder: 0,
      outcomes: [],
      examples: [],
      worksWith: [],
      promptTemplate: entry.promptTemplate,
      featured: entry.featured,
      installed: Boolean(entry.installed || installedSkill),
      enabled: Boolean(entry.installed || installedSkill),
      installState: entry.installState || (installedSkill ? 'local' : 'not-installed'),
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      sizeBytes: entry.sizeBytes,
      permissions: [],
      contributions: { skills: 1, tools: 0, commands: 0 },
      backend: { type: 'skill', marketplaceId: entry.id, skillId: entry.skillId },
      emphasis: installedSkill ? { type: 'skill', id: installedSkill.id, name: installedSkill.name } : undefined,
      canUninstall: Boolean(entry.canUninstall),
      supportsToggle: false,
      diagnostics: ['工作流始终向 Agent 可用', '在输入框选择只会强调本轮使用'],
    }
  })

  const marketplacePluginIds = new Set<string>()
  for (const marketplace of input.plugins.marketplace) {
    const installed = pluginById.get(marketplace.manifest.id)
    marketplacePluginIds.add(marketplace.manifest.id)
    const contributions = pluginContributions(marketplace.manifest)
    entries.push({
      id: `plugin:${marketplace.id}`,
      name: marketplace.manifest.name,
      description: marketplace.description || marketplace.manifest.description,
      version: marketplace.manifest.version,
      publisher: marketplace.publisher,
      category: marketplace.manifest.categories?.[0] || '集成',
      icon: marketplace.manifest.icon || (contributions.tools || marketplace.manifest.main ? 'integration' : 'workflow'),
      kind: pluginKind(marketplace),
      trust: marketplace.trust,
      sourceId: 'turboflux-packs',
      sourceName: marketplace.publisher,
      sourceUrl: marketplace.manifest.repository || marketplace.manifest.homepage,
      license: marketplace.manifest.license,
      tags: [...(marketplace.manifest.keywords || [])],
      capabilities: pluginCapabilities(marketplace),
      sortOrder: marketplace.marketplace?.sortOrder || 0,
      outcomes: [...(marketplace.marketplace?.outcomes || [])],
      examples: (marketplace.marketplace?.examples || []).map(example => ({ ...example })),
      worksWith: [...(marketplace.marketplace?.worksWith || [])],
      releaseNotes: marketplace.marketplace?.releaseNotes,
      marketplaceUpdatedAt: marketplace.marketplace?.updatedAt,
      featured: marketplace.marketplace?.featured === true,
      installed: Boolean(installed),
      enabled: Boolean(installed?.enabled),
      installState: installed ? (installed.state === 'enabled' ? 'enabled' : installed.state) : 'not-installed',
      installedAt: installed ? new Date(installed.installedAt).toISOString() : undefined,
      updatedAt: installed ? new Date(installed.updatedAt).toISOString() : undefined,
      permissions: [...(marketplace.manifest.permissions || [])],
      contributions,
      backend: { type: 'plugin', marketplaceId: marketplace.id, pluginId: marketplace.manifest.id },
      emphasis: pluginEmphasis(installed),
      canUninstall: Boolean(installed && installed.source !== 'bundled'),
      supportsToggle: Boolean(installed),
      diagnostics: installed ? [...installed.diagnostics] : [marketplace.manifest.main ? '代码在独立沙箱进程运行' : '声明式能力包，不执行代码'],
      error: installed?.error,
    })
  }

  const marketplaceSkillIds = new Set(input.skillEntries.map(entry => entry.skillId))
  const pluginSkillIds = new Set(input.plugins.plugins.flatMap(plugin => (plugin.manifest.contributes?.skills || []).map(skill => skill.id)))
  for (const skill of input.installedSkills) {
    if (marketplaceSkillIds.has(skill.id) || pluginSkillIds.has(skill.id)) continue
    entries.push({
      id: `local-skill:${skill.id}`,
      name: skill.name,
      description: skill.description,
      version: 'local',
      publisher: '本地',
      category: skill.category,
      icon: '◇',
      kind: 'workflow',
      trust: 'local',
      sourceId: 'local',
      sourceName: '本地导入',
      tags: [],
      capabilities: [],
      sortOrder: 0,
      outcomes: [],
      examples: [],
      worksWith: [],
      featured: false,
      installed: true,
      enabled: true,
      installState: 'local',
      permissions: [],
      contributions: { skills: 1, tools: 0, commands: 0 },
      backend: { type: 'local-skill', skillId: skill.id },
      emphasis: { type: 'skill', id: skill.id, name: skill.name },
      canUninstall: false,
      supportsToggle: false,
      diagnostics: ['由本机目录管理', '不会被市场覆盖或卸载'],
    })
  }

  for (const plugin of input.plugins.plugins) {
    if (marketplacePluginIds.has(plugin.id)) continue
    const contributions = pluginContributions(plugin.manifest)
    entries.push({
      id: `local-plugin:${plugin.id}`,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      publisher: plugin.manifest.author.name,
      category: plugin.manifest.categories?.[0] || '集成',
      icon: plugin.manifest.icon || (contributions.tools || plugin.manifest.main ? 'integration' : 'workflow'),
      kind: pluginKind(plugin),
      trust: 'local',
      sourceId: 'local',
      sourceName: '本地导入',
      sourceUrl: plugin.manifest.repository || plugin.manifest.homepage,
      license: plugin.manifest.license,
      tags: [...(plugin.manifest.keywords || [])],
      capabilities: pluginCapabilities(plugin),
      sortOrder: 0,
      outcomes: [],
      examples: [],
      worksWith: [],
      featured: false,
      installed: true,
      enabled: plugin.enabled,
      installState: plugin.state,
      installedAt: new Date(plugin.installedAt).toISOString(),
      updatedAt: new Date(plugin.updatedAt).toISOString(),
      permissions: [...(plugin.manifest.permissions || [])],
      contributions,
      backend: { type: 'local-plugin', pluginId: plugin.id },
      emphasis: pluginEmphasis(plugin),
      canUninstall: true,
      supportsToggle: true,
      diagnostics: [...plugin.diagnostics],
      error: plugin.error,
    })
  }

  entries.sort((left, right) => Number(right.featured) - Number(left.featured) || left.sortOrder - right.sortOrder || Number(right.installed) - Number(left.installed) || left.name.localeCompare(right.name, 'zh-CN'))
  return {
    schemaVersion: 1,
    entries,
    installed: entries.filter(entry => entry.installed),
    jobs: input.skillJobs.map(job => ({ ...job })),
    recovery: input.skillRecovery,
    warnings: [...input.plugins.warnings, ...(input.skillRecovery?.warnings || [])],
  }
}
