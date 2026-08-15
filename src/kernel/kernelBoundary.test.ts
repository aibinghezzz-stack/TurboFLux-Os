import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()

describe('published Agent kernel boundary', () => {
  it('publishes only supported consumer entrypoints', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'packages/agent-core/package.json'), 'utf8'))

    expect(manifest.name).toBe('@turboflux/agent-core')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './contracts',
      './runtime',
      './renderer',
      './tui',
      './workbench',
      './extensions',
    ])
    expect(JSON.stringify(manifest)).not.toMatch(/electron|control-plane|account|billing|telemetry/)
  })

  it('routes TUI composition roots through the public kernel facade', () => {
    const roots = [
      'src/cli/index.ts',
      'src/cli/repl.ts',
      'src/cli/setup.ts',
      'src/cli/singleShot.ts',
      'src/cli/components/App.tsx',
      'src/cli/commands/index.ts',
      'src/cli/commands/types.ts',
      'src/cli/commands/registry.ts',
    ]

    for (const relativePath of roots) {
      const source = readFileSync(join(repositoryRoot, relativePath), 'utf8')
      expect(source, relativePath).toContain('kernel/tui')
      expect(source, relativePath).not.toMatch(/from ['"][^'"]*(?:core|application|shared)\//)
      expect(source, relativePath).not.toMatch(/import\(['"][^'"]*(?:core|application|shared)\//)
    }
  })
})
