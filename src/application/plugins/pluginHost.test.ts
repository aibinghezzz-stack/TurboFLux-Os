import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginHostProcess } from './pluginHost'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'darwin')('PluginHostProcess', () => {
  it('invokes a code plugin through the sandbox host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    const storagePath = join(root, 'storage')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), 'export async function echo(args) { return { echoed: args.value } }\n')
    const host = new PluginHostProcess({
      manifest: { id: 'host.test', name: 'Host test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      pluginDirectory,
      workspacePath,
      storagePath,
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('echo', { value: 'ok' })).resolves.toEqual({ echoed: 'ok' })
    await host.stop()
  })

  it('contains a crashing plugin without terminating the parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), 'export function crash() { process.exit(17) }\n')
    const host = new PluginHostProcess({
      manifest: { id: 'host.crash', name: 'Crash test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      pluginDirectory,
      workspacePath,
      storagePath: join(root, 'storage'),
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('crash', {})).rejects.toThrow('Plugin host exited')
    expect(process.pid).toBeGreaterThan(0)
  })
})
