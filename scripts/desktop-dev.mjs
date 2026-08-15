import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptsDirectory, '..')
const publicRepositoryRoot = repositoryRoot
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const viteBinary = join(desktopRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const electronBinary = join(desktopRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const mainEntry = join(desktopRoot, 'main.mjs')
const preloadEntry = join(desktopRoot, 'preload.cjs')
const runtimeHostEntry = join(desktopRoot, 'runtimeHost.ts')
const builtCoreRoot = join(publicRepositoryRoot, 'packages', 'agent-core')
const installedCoreRoot = join(desktopRoot, 'node_modules', '@turboflux', 'agent-core')
const viteConfig = join(desktopRoot, 'vite.config.mjs')
const desktopUrl = 'http://127.0.0.1:5174'
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'

if (!existsSync(viteBinary) || !existsSync(electronBinary)) {
  throw new Error('Desktop dependencies are missing. Run npm install in the desktop directory.')
}

if (!existsSync(join(publicRepositoryRoot, 'packages', 'agent-core', 'package.json'))) {
  throw new Error(`The agent-core package was not found at ${publicRepositoryRoot}. Run npm install first.`)
}

function buildSharedCore() {
  const result = spawnSync(npmBinary, ['run', 'build:core'], {
    cwd: publicRepositoryRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) throw new Error('Unable to build @turboflux/agent-core before starting Desktop.')
  if (!existsSync(installedCoreRoot)) {
    throw new Error('The Desktop @turboflux/agent-core dependency is missing. Run npm install in apps/desktop.')
  }
  rmSync(join(installedCoreRoot, 'dist'), { recursive: true, force: true })
  cpSync(join(builtCoreRoot, 'dist'), join(installedCoreRoot, 'dist'), { recursive: true, force: true })
}

buildSharedCore()

const viteProcess = spawn(viteBinary, ['--config', viteConfig], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: { ...process.env, BROWSER: 'none' },
})

viteProcess.once('error', error => {
  console.error(`Unable to start Vite: ${error.message}`)
  process.exitCode = 1
})

async function waitForVite() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${desktopUrl}/`)
      if (response.ok) return
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Vite did not become ready in time.')
}

await waitForVite()

let electronProcess
let restartTimer
let coreBuildTimer
let shuttingDown = false
const expectedElectronExits = new WeakSet()

function startElectron() {
  const child = spawn(electronBinary, [mainEntry], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, TURBOFLUX_DESKTOP_URL: desktopUrl },
  })
  electronProcess = child
  child.once('error', error => {
    console.error(`Unable to start Electron: ${error.message}`)
    void shutdown()
    process.exitCode = 1
  })
  child.on('exit', code => {
    if (expectedElectronExits.has(child)) return
    if (!shuttingDown && code !== 0) {
      process.exitCode = code || 1
      void shutdown()
    }
  })
}

function restartElectron() {
  if (shuttingDown) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (electronProcess && !electronProcess.killed) {
      expectedElectronExits.add(electronProcess)
      electronProcess.kill()
    }
    startElectron()
  }, 120)
}

function rebuildCoreAndRestart() {
  if (shuttingDown) return
  clearTimeout(coreBuildTimer)
  coreBuildTimer = setTimeout(() => {
    try {
      buildSharedCore()
      restartElectron()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }, 180)
}

const closeWatchers = [mainEntry, preloadEntry, runtimeHostEntry].map(file => watch(file, restartElectron))
for (const directory of ['browser', 'computer', 'systems']) {
  closeWatchers.push(watch(join(desktopRoot, directory), { recursive: true }, restartElectron))
}
for (const directory of ['application', 'core', 'kernel', 'platform', 'shared', 'state', 'tools']) {
  closeWatchers.push(watch(join(publicRepositoryRoot, 'src', directory), { recursive: true }, rebuildCoreAndRestart))
}
startElectron()

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  closeWatchers.forEach(item => item.close())
  clearTimeout(restartTimer)
  clearTimeout(coreBuildTimer)
  if (electronProcess && !electronProcess.killed) electronProcess.kill()
  if (!viteProcess.killed) viteProcess.kill()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
viteProcess.once('exit', () => { void shutdown() })
