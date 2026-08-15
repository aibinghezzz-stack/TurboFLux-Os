import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const privatePrefixes = [
  'src/desktop/',
  'control-plane/',
  'apps/desktop/generated/',
  '.turboflux/',
  '.turboflux-e2e/',
  'release/',
]

function gitFiles(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

const tracked = gitFiles(['ls-files'])
const staged = gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
const exposed = [...new Set([...tracked, ...staged])].filter(file => privatePrefixes.some(prefix => file === prefix || file.startsWith(prefix)))

const failures = []
if (exposed.length) failures.push(`private product paths are tracked or staged:\n${exposed.map(file => `  - ${file}`).join('\n')}`)

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packedFiles = Array.isArray(packageJson.files) ? packageJson.files : []
const unsafePackEntry = packedFiles.filter(file => privatePrefixes.some(prefix => file === prefix || file.startsWith(prefix)))
if (unsafePackEntry.length) failures.push(`package.json files exposes private paths: ${unsafePackEntry.join(', ')}`)

const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
const productDependencies = dependencyNames.filter(name => ['electron', 'electron-builder', 'fastify', '@fastify/static', 'better-sqlite3', 'pg'].includes(name))
if (productDependencies.length) failures.push(`public package contains product-only dependencies: ${productDependencies.join(', ')}`)

const openSourceConfig = readFileSync(new URL('../tsconfig.open-source.json', import.meta.url), 'utf8')
if (!openSourceConfig.includes('src/desktop/**/*')) failures.push('tsconfig.open-source.json must exclude src/desktop/**/*')
if (!openSourceConfig.includes('src/kernel/**/*')) failures.push('tsconfig.open-source.json must include src/kernel/**/*')

const corePackage = JSON.parse(readFileSync(new URL('../packages/agent-core/package.json', import.meta.url), 'utf8'))
const expectedCoreExports = ['.', './contracts', './runtime', './renderer', './tui', './workbench', './extensions']
if (corePackage.name !== '@turboflux/agent-core') failures.push('shared kernel package must be named @turboflux/agent-core')
if (corePackage.private === true) failures.push('@turboflux/agent-core must be publishable')
if (corePackage.version !== packageJson.version) failures.push('TUI and Agent kernel versions must stay aligned')
if (JSON.stringify(Object.keys(corePackage.exports)) !== JSON.stringify(expectedCoreExports)) {
  failures.push(`Agent kernel exports changed without an explicit boundary update: ${Object.keys(corePackage.exports).join(', ')}`)
}
const coreDependencies = Object.keys({ ...corePackage.dependencies, ...corePackage.devDependencies })
const forbiddenCoreDependencies = coreDependencies.filter(name => ['electron', 'electron-builder', 'fastify', '@fastify/static', 'better-sqlite3', 'pg', 'react', 'ink'].includes(name))
if (forbiddenCoreDependencies.length) failures.push(`Agent kernel contains shell or product dependencies: ${forbiddenCoreDependencies.join(', ')}`)

const publicSourceRoots = ['application', 'cli', 'core', 'kernel', 'platform', 'server', 'shared', 'state', 'tools']
const publicSourceFiles = []
function collectSourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(path)
    else if (/\.(?:ts|tsx|mjs|cjs)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) publicSourceFiles.push(path)
  }
}
for (const root of publicSourceRoots) collectSourceFiles(new URL(`../src/${root}/`, import.meta.url).pathname)
for (const file of publicSourceFiles) {
  const source = readFileSync(file, 'utf8')
  if (/from ['"][^'"]*desktop\//.test(source) || /import\(['"][^'"]*desktop\//.test(source)) {
    failures.push(`public source imports Desktop product code: ${file}`)
  }
  if (/controlPlane|productAccount|safeStorage|@turboflux\/desktop-product/.test(source)) {
    failures.push(`public source contains private product coupling: ${file}`)
  }
}

if (failures.length) {
  process.stderr.write(`TurboFlux public boundary check failed:\n\n${failures.join('\n\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('TurboFlux public boundary check passed.\n')
}
