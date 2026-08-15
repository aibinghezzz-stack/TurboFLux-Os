import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpClient } from '../../core/mcp/client'
import type { McpLocalToolDefinition } from '../../core/mcp/types'
import type { PluginManifest, PluginPermission, PluginTool } from '../../shared/pluginTypes'
import { AtomicJsonStore } from '../platform/atomicJsonStore'
import { PLUGIN_MARKETPLACE, type PluginMarketplaceEntry } from './marketplace'
import { PluginHostProcess, unsupportedCodePermissions } from './pluginHost'

export interface PluginRecord {
  id: string
  manifest: PluginManifest
  path: string
  source: 'local' | 'marketplace' | 'bundled'
  enabled: boolean
  state: 'installed' | 'enabled' | 'disabled' | 'error' | 'blocked'
  approvedPermissions: PluginPermission[]
  installedAt: number
  updatedAt: number
  error?: string
  diagnostics: string[]
  serverName?: string
}

export interface PluginSnapshot {
  schemaVersion: 1
  warnings: string[]
  plugins: PluginRecord[]
  marketplace: Array<PluginMarketplaceEntry & { installed: boolean }>
}

interface PluginStoreRecord {
  id: string
  path: string
  source: PluginRecord['source']
  enabled: boolean
  approvedPermissions: PluginPermission[]
  installedAt: number
  updatedAt: number
  error?: string
}

interface PluginStoreFile {
  schemaVersion: 1
  plugins: PluginStoreRecord[]
}

const ALLOWED_PERMISSIONS = new Set<PluginPermission>([
  'filesystem.read', 'filesystem.write', 'network', 'terminal', 'clipboard', 'notifications', 'webview', 'ai', 'storage', 'process', 'unsafe-eval',
])

function validStore(value: unknown): value is PluginStoreFile {
  return Boolean(value && typeof value === 'object' && (value as PluginStoreFile).schemaVersion === 1 && Array.isArray((value as PluginStoreFile).plugins))
}

function safeRelativePath(value: string, label: string): string {
  if (!value || isAbsolute(value)) throw new Error(`${label} must be a relative path`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe path`)
  return normalized
}

function validateManifest(value: unknown): PluginManifest {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('plugin.json must contain an object')
  const manifest = value as PluginManifest
  if (typeof manifest.id !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(manifest.id) || manifest.id.length > 120) throw new Error('Invalid plugin id')
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 120) throw new Error('Invalid plugin name')
  if (typeof manifest.description !== 'string' || manifest.description.length > 1_000) throw new Error('Invalid plugin description')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Plugin version must use SemVer')
  if (!manifest.author || typeof manifest.author.name !== 'string' || !manifest.author.name.trim()) throw new Error('Plugin author is required')
  if (manifest.main) safeRelativePath(manifest.main, 'Plugin main entry')
  const permissions = manifest.permissions || []
  if (!Array.isArray(permissions) || permissions.some(permission => !ALLOWED_PERMISSIONS.has(permission))) throw new Error('Plugin requests an unknown permission')
  if (new Set(permissions).size !== permissions.length) throw new Error('Plugin contains duplicate permissions')
  const tools = manifest.contributes?.tools || []
  if (!Array.isArray(tools) || tools.length > 64) throw new Error('Plugin contributes too many tools')
  for (const tool of tools) {
    if (!tool.id || !/^[\w.-]+$/.test(tool.id) || !tool.handler || !/^[\w.-]+$/.test(tool.handler)) throw new Error(`Invalid plugin tool: ${tool.id || 'unknown'}`)
  }
  for (const skill of manifest.contributes?.skills || []) if (skill.promptPath) safeRelativePath(skill.promptPath, `Skill ${skill.id} promptPath`)
  if (manifest.contributes?.views?.length || manifest.contributes?.viewsContainers?.length || manifest.contributes?.themes?.length) {
    throw new Error('Renderer views and themes are not supported by the sandboxed plugin platform')
  }
  const engine = manifest.engines?.turboflux || manifest.engines?.turboforge
  if (engine && !['*', '>=1.0.0', '^1.0.0', '1.x'].includes(engine)) throw new Error(`Unsupported TurboFlux engine range: ${engine}`)
  return JSON.parse(JSON.stringify(manifest)) as PluginManifest
}

async function inspectTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Plugin packages cannot contain symbolic links: ${relative(root, path)}`)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) {
        files += 1
        bytes += info.size
        if (files > 1_000 || bytes > 50 * 1024 * 1024) throw new Error('Plugin package exceeds the 1,000 file or 50 MB limit')
      } else throw new Error(`Unsupported plugin package entry: ${relative(root, path)}`)
    }
  }
  await visit(root)
}

function serverNameFor(id: string): string {
  return `plugin-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

function toolSchema(tool: PluginTool): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries((tool.parameters || []).map(parameter => [parameter.name, {
      type: parameter.type,
      description: parameter.description,
      ...(parameter.default === undefined ? {} : { default: parameter.default }),
    }])),
    required: (tool.parameters || []).filter(parameter => parameter.required).map(parameter => parameter.name),
    additionalProperties: false,
  }
}

export class PluginService {
  private readonly store: AtomicJsonStore<PluginStoreFile>
  private data: PluginStoreFile
  private warnings: string[]
  private readonly hosts = new Map<string, PluginHostProcess>()
  private readonly mcpClients = new Set<McpClient>()
  private bundledInitialization: Promise<void> | null = null

  constructor(
    storePath: string,
    private readonly pluginsRoot: string,
    private workspacePath: string,
    private readonly onChanged?: () => void,
  ) {
    this.store = new AtomicJsonStore(storePath, () => ({ schemaVersion: 1, plugins: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
  }

  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = resolve(workspacePath)
  }

  async initialize(mcpClient: McpClient): Promise<void> {
    this.mcpClients.add(mcpClient)
    await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 })
    if (!this.bundledInitialization) this.bundledInitialization = this.ensureBundledPlugins()
    await this.bundledInitialization
    for (const record of this.data.plugins.filter(plugin => plugin.enabled)) {
      try { await this.activate(record.id) } catch (error) { this.setError(record.id, error) }
    }
  }

  async inspectDirectory(sourcePath: string): Promise<{ manifest: PluginManifest; path: string }> {
    const path = resolve(sourcePath)
    if (!(await stat(path)).isDirectory()) throw new Error('Choose a plugin folder')
    await inspectTree(path)
    const manifest = validateManifest(JSON.parse(await readFile(join(path, 'plugin.json'), 'utf8')) as unknown)
    if (manifest.main) {
      const mainPath = resolve(path, safeRelativePath(manifest.main, 'Plugin main entry'))
      const child = relative(path, mainPath)
      if (child === '..' || child.startsWith(`..${sep}`) || !(await stat(mainPath)).isFile()) throw new Error('Plugin main entry is missing or outside the package')
    }
    for (const skill of manifest.contributes?.skills || []) {
      if (!skill.promptPath) continue
      const promptPath = resolve(path, safeRelativePath(skill.promptPath, `Skill ${skill.id} promptPath`))
      if (!(await stat(promptPath)).isFile()) throw new Error(`Skill prompt is missing: ${skill.promptPath}`)
    }
    return { manifest, path }
  }

  async installFromDirectory(sourcePath: string, approvedPermissions: PluginPermission[] = []): Promise<PluginSnapshot> {
    const inspected = await this.inspectDirectory(sourcePath)
    return this.installInspected(inspected.path, inspected.manifest, 'local', approvedPermissions)
  }

  async installMarketplace(id: string, approvedPermissions: PluginPermission[] = []): Promise<PluginSnapshot> {
    const entry = PLUGIN_MARKETPLACE.find(item => item.id === id)
    if (!entry) throw new Error(`Marketplace plugin not found: ${id}`)
    return this.installMarketplaceEntry(entry, 'marketplace', approvedPermissions, false)
  }

  private async installMarketplaceEntry(
    entry: PluginMarketplaceEntry,
    source: PluginRecord['source'],
    approvedPermissions: PluginPermission[],
    enabled: boolean,
  ): Promise<PluginSnapshot> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'turboflux-plugin-'))
    try {
      await writeFile(join(temporaryDirectory, 'plugin.json'), `${JSON.stringify(entry.manifest, null, 2)}\n`, { mode: 0o600 })
      for (const [path, content] of Object.entries(entry.promptFiles || {})) {
        const target = resolve(temporaryDirectory, safeRelativePath(path, 'Marketplace file'))
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, content, { mode: 0o600 })
      }
      const snapshot = await this.installInspected(temporaryDirectory, validateManifest(entry.manifest), source, approvedPermissions)
      if (!enabled) return snapshot
      const record = this.requireRecord(entry.manifest.id)
      record.enabled = true
      record.updatedAt = Date.now()
      this.persist()
      return this.list()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private async ensureBundledPlugins(): Promise<void> {
    for (const entry of PLUGIN_MARKETPLACE.filter(candidate => candidate.bundled)) {
      const existing = this.data.plugins.find(plugin => plugin.id === entry.manifest.id)
      if (existing) {
        try {
          const installed = await this.inspectDirectory(existing.path)
          if (installed.manifest.version === entry.manifest.version) {
            if (existing.source !== 'bundled') {
              existing.source = 'bundled'
              existing.updatedAt = Date.now()
              this.persist()
            }
            continue
          }
        } catch {}
        const managedRoot = resolve(this.pluginsRoot)
        const managedPath = resolve(existing.path)
        const child = relative(managedRoot, managedPath)
        if (child && child !== '..' && !child.startsWith(`..${sep}`)) await rm(managedPath, { recursive: true, force: true })
        const enabled = existing.enabled
        this.data.plugins = this.data.plugins.filter(plugin => plugin.id !== existing.id)
        this.persist()
        await this.installMarketplaceEntry(entry, 'bundled', [], enabled)
        continue
      }
      await this.installMarketplaceEntry(entry, 'bundled', [], true)
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSnapshot> {
    const record = this.requireRecord(id)
    if (enabled) {
      record.enabled = true
      record.error = undefined
      record.updatedAt = Date.now()
      this.persist()
      try { await this.activate(id) } catch (error) { this.setError(id, error); throw error }
    } else {
      await this.deactivate(id)
      record.enabled = false
      record.error = undefined
      record.updatedAt = Date.now()
      this.persist()
    }
    return this.list()
  }

  async uninstall(id: string): Promise<PluginSnapshot> {
    const record = this.requireRecord(id)
    if (record.source === 'bundled') throw new Error('Bundled plugins cannot be uninstalled')
    await this.deactivate(id)
    const managedRoot = resolve(this.pluginsRoot)
    const managedPath = resolve(record.path)
    const child = relative(managedRoot, managedPath)
    if (!child || child === '..' || child.startsWith(`..${sep}`)) throw new Error('Refusing to remove a plugin outside the managed directory')
    await rm(managedPath, { recursive: true, force: true })
    this.data.plugins = this.data.plugins.filter(plugin => plugin.id !== id)
    this.persist()
    return this.list()
  }

  list(): PluginSnapshot {
    const records: PluginRecord[] = []
    for (const stored of this.data.plugins) {
      try {
        const manifest = validateManifest(JSON.parse(readFileSync(join(stored.path, 'plugin.json'), 'utf8')) as unknown)
        const unsupported = manifest.main ? unsupportedCodePermissions(manifest.permissions) : []
        const error = stored.error || (unsupported.length ? `未实现的代码权限：${unsupported.join(', ')}` : undefined)
        records.push({
          ...stored,
          manifest,
          approvedPermissions: [...stored.approvedPermissions],
          state: error ? (stored.enabled ? 'error' : 'blocked') : stored.enabled ? 'enabled' : 'disabled',
          error,
          diagnostics: [
            manifest.main ? '代码在独立沙箱进程中运行' : '纯声明式插件，不执行代码',
            ...(manifest.permissions?.length ? [`已声明权限：${manifest.permissions.join(', ')}`] : ['无需额外权限']),
          ],
          serverName: manifest.contributes?.tools?.length ? serverNameFor(stored.id) : undefined,
        })
      } catch (error) {
        records.push({
          ...stored,
          manifest: { id: stored.id, name: stored.id, description: '', version: '0.0.0', author: { name: 'Unknown' } },
          approvedPermissions: [...stored.approvedPermissions],
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          diagnostics: ['插件清单无法读取或验证'],
        })
      }
    }
    return {
      schemaVersion: 1,
      warnings: [...this.warnings],
      plugins: records.sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt),
      marketplace: PLUGIN_MARKETPLACE.map(entry => ({ ...entry, manifest: JSON.parse(JSON.stringify(entry.manifest)) as PluginManifest, installed: records.some(record => record.id === entry.manifest.id) })),
    }
  }

  getByServerName(name: string): PluginRecord | undefined {
    return this.list().plugins.find(plugin => plugin.serverName === name)
  }

  async destroy(): Promise<void> {
    for (const record of this.data.plugins.filter(plugin => plugin.enabled)) await this.deactivate(record.id)
    this.mcpClients.clear()
  }

  listCommands(): Array<{ id: string; title: string; detail: string; pluginId: string }> {
    return this.list().plugins
      .filter(plugin => plugin.enabled && plugin.state === 'enabled' && plugin.manifest.main)
      .flatMap(plugin => (plugin.manifest.contributes?.commands || []).map(command => ({
        id: command.id,
        title: command.title,
        detail: plugin.manifest.name,
        pluginId: plugin.id,
      })))
  }

  async executeCommand(pluginId: string, commandId: string): Promise<unknown> {
    const plugin = this.list().plugins.find(item => item.id === pluginId)
    if (!plugin?.enabled || plugin.state !== 'enabled') throw new Error(`Plugin is not enabled: ${pluginId}`)
    const command = plugin.manifest.contributes?.commands?.find(item => item.id === commandId)
    if (!command) throw new Error(`Plugin command not found: ${commandId}`)
    const host = this.hosts.get(pluginId)
    if (!host) throw new Error('Plugin command requires a running sandbox host')
    return host.invoke(commandId, {})
  }

  private async installInspected(sourcePath: string, manifest: PluginManifest, source: PluginRecord['source'], approvedPermissions: PluginPermission[]): Promise<PluginSnapshot> {
    if (this.data.plugins.some(plugin => plugin.id === manifest.id)) throw new Error(`Plugin is already installed: ${manifest.id}`)
    const requested = new Set(manifest.permissions || [])
    if (approvedPermissions.some(permission => !requested.has(permission))) throw new Error('Approved permissions do not match the plugin manifest')
    if ([...requested].some(permission => !approvedPermissions.includes(permission))) throw new Error('All requested plugin permissions must be approved before installation')
    await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 })
    const directoryName = `${manifest.id.replace(/[^a-z0-9._-]+/gi, '-')}-${createHash('sha256').update(`${manifest.id}@${manifest.version}`).digest('hex').slice(0, 8)}`
    const finalPath = resolve(this.pluginsRoot, directoryName)
    const temporaryPath = `${finalPath}.installing-${Date.now()}`
    await cp(sourcePath, temporaryPath, { recursive: true, errorOnExist: true })
    try { await rename(temporaryPath, finalPath) } catch (error) { await rm(temporaryPath, { recursive: true, force: true }); throw error }
    const now = Date.now()
    this.data.plugins.push({ id: manifest.id, path: finalPath, source, enabled: false, approvedPermissions: [...approvedPermissions], installedAt: now, updatedAt: now })
    this.persist()
    return this.list()
  }

  private async activate(id: string): Promise<void> {
    const record = this.requireRecord(id)
    const inspected = await this.inspectDirectory(record.path)
    const manifest = inspected.manifest
    if (manifest.main && !this.hosts.has(id)) {
      const host = new PluginHostProcess({
        manifest,
        pluginDirectory: record.path,
        workspacePath: this.workspacePath,
        storagePath: join(this.pluginsRoot, '.storage', createHash('sha256').update(id).digest('hex').slice(0, 16)),
        approvedPermissions: record.approvedPermissions,
        onCrash: message => this.setError(id, message),
      })
      await host.start()
      this.hosts.set(id, host)
    }
    const tools = manifest.contributes?.tools || []
    if (tools.length > 0) {
      if (!manifest.main) throw new Error('Plugin tools require a sandboxed main entry')
      const host = this.hosts.get(id)!
      const definitions: McpLocalToolDefinition[] = tools.map(tool => ({ name: tool.id, description: tool.description, inputSchema: toolSchema(tool) }))
      for (const client of this.mcpClients) {
        client.registerLocalServer({
          name: serverNameFor(id),
          instructions: `${manifest.name}: ${manifest.description}`,
          tools: definitions,
          handler: async (toolName, args) => host.invoke(tools.find(tool => tool.id === toolName)?.handler || toolName, args),
        })
      }
    }
    await this.projectSkills(manifest, record.path)
    record.enabled = true
    record.error = undefined
    record.updatedAt = Date.now()
    this.persist()
  }

  private async deactivate(id: string): Promise<void> {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) return
    const serverName = serverNameFor(id)
    await Promise.all([...this.mcpClients].map(async client => {
      if (client.getConnection(serverName)) await client.disconnect(serverName)
    }))
    const host = this.hosts.get(id)
    this.hosts.delete(id)
    await host?.stop()
    await this.removeProjectedSkills(id)
  }

  private async projectSkills(manifest: PluginManifest, pluginPath: string): Promise<void> {
    const skills = manifest.contributes?.skills || []
    if (skills.length === 0) return
    const skillsRoot = join(this.workspacePath, '.turboflux', 'skills')
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
    for (const skill of skills) {
      const body = skill.promptPath
        ? await readFile(resolve(pluginPath, safeRelativePath(skill.promptPath, `Skill ${skill.id} promptPath`)), 'utf8')
        : skill.systemPrompt || ''
      if (!body.trim()) continue
      const directory = join(skillsRoot, `plugin-${createHash('sha256').update(manifest.id).digest('hex').slice(0, 10)}-${skill.id.replace(/[^a-z0-9._-]+/gi, '-')}`)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const content = `---\nname: ${skill.id}\ndescription: ${skill.description.replace(/[\r\n]+/g, ' ').slice(0, 300)}\ncategory: ${skill.category}\n---\n${body.trim()}\n`
      await writeFile(join(directory, 'SKILL.md'), content, { mode: 0o600 })
    }
  }

  private async removeProjectedSkills(pluginId: string): Promise<void> {
    const skillsRoot = join(this.workspacePath, '.turboflux', 'skills')
    const prefix = `plugin-${createHash('sha256').update(pluginId).digest('hex').slice(0, 10)}-`
    let entries: string[] = []
    try { entries = await readdir(skillsRoot) } catch { return }
    await Promise.all(entries.filter(entry => entry.startsWith(prefix)).map(entry => rm(join(skillsRoot, entry), { recursive: true, force: true })))
  }

  private requireRecord(id: string): PluginStoreRecord {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) throw new Error(`Plugin not found: ${id}`)
    return record
  }

  private setError(id: string, error: unknown): void {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) return
    record.error = (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
    record.updatedAt = Date.now()
    this.persist()
    this.onChanged?.()
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
