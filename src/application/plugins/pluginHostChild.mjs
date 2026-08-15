import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'

const [pluginId, pluginDirectory, mainPath, workspacePath, storagePath, permissionJson] = process.argv.slice(2)
const permissions = new Set(JSON.parse(permissionJson || '[]'))
const handlers = new Map()
let deactivate

function within(root, value) {
  const normalizedRoot = resolve(root)
  const normalizedValue = resolve(root, value)
  const child = relative(normalizedRoot, normalizedValue)
  if (child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Path escapes the allowed root')
  return normalizedValue
}

function requirePermission(permission) {
  if (!permissions.has(permission)) throw new Error(`Plugin permission is not approved: ${permission}`)
}

async function loadStorage() {
  requirePermission('storage')
  try { return JSON.parse(await readFile(join(storagePath, 'storage.json'), 'utf8')) } catch { return {} }
}

async function saveStorage(value) {
  requirePermission('storage')
  await mkdir(storagePath, { recursive: true })
  await writeFile(join(storagePath, 'storage.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

const context = Object.freeze({
  id: pluginId,
  path: pluginDirectory,
  api: Object.freeze({
    storage: Object.freeze({
      async get(key) { return (await loadStorage())[key] },
      async set(key, value) { const state = await loadStorage(); state[key] = value; await saveStorage(state) },
      async remove(key) { const state = await loadStorage(); delete state[key]; await saveStorage(state) },
    }),
    filesystem: Object.freeze({
      async readFile(path) { requirePermission('filesystem.read'); return readFile(within(workspacePath, path), 'utf8') },
      async writeFile(path, content) { requirePermission('filesystem.write'); const target = within(workspacePath, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, String(content)) },
      async readDirectory(path = '.') { requirePermission('filesystem.read'); return readdir(within(workspacePath, path)) },
      async delete(path) { requirePermission('filesystem.write'); return rm(within(workspacePath, path), { recursive: true, force: true }) },
      async mkdir(path) { requirePermission('filesystem.write'); return mkdir(within(workspacePath, path), { recursive: true }) },
    }),
    tools: Object.freeze({
      registerTool(tool, handler) {
        if (!tool?.id || typeof handler !== 'function') throw new Error('Invalid tool registration')
        handlers.set(String(tool.id), handler)
      },
    }),
    commands: Object.freeze({
      registerCommand(id, handler) {
        if (!id || typeof handler !== 'function') throw new Error('Invalid command registration')
        handlers.set(String(id), handler)
      },
    }),
  }),
  logger: Object.freeze({
    info: (...values) => process.stderr.write(`[${pluginId}] ${values.map(String).join(' ')}\n`),
    warn: (...values) => process.stderr.write(`[${pluginId}] WARN ${values.map(String).join(' ')}\n`),
    error: (...values) => process.stderr.write(`[${pluginId}] ERROR ${values.map(String).join(' ')}\n`),
    debug: () => {},
  }),
})

function send(message) {
  const serialized = JSON.stringify(message)
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Plugin response exceeds 1 MB')
  process.stdout.write(`${serialized}\n`)
}

try {
  const pluginModule = await import(pathToFileURL(mainPath).href)
  for (const [name, value] of Object.entries(pluginModule)) {
    if (typeof value === 'function' && name !== 'activate' && name !== 'deactivate') handlers.set(name, value)
  }
  const activated = typeof pluginModule.activate === 'function' ? await pluginModule.activate(context) : undefined
  if (activated && typeof activated === 'object') {
    for (const [name, value] of Object.entries(activated)) if (typeof value === 'function') handlers.set(name, value)
  }
  deactivate = pluginModule.deactivate
  send({ type: 'ready', handlers: [...handlers.keys()] })
} catch (error) {
  send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', async line => {
  if (Buffer.byteLength(line) > 1024 * 1024) return send({ type: 'error', error: 'Plugin request exceeds 1 MB' })
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'deactivate') {
    try { if (typeof deactivate === 'function') await deactivate(); send({ type: 'deactivated' }) } catch (error) { send({ type: 'deactivated', error: error instanceof Error ? error.message : String(error) }) }
    process.exit(0)
    return
  }
  if (message.type !== 'invoke' || typeof message.requestId !== 'string') return
  const handler = handlers.get(message.handler)
  if (!handler) return send({ type: 'result', requestId: message.requestId, ok: false, error: `Handler not found: ${message.handler}` })
  try {
    const result = await handler(message.args || {})
    send({ type: 'result', requestId: message.requestId, ok: true, result })
  } catch (error) {
    send({ type: 'result', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
