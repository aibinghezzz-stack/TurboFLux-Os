import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurboFluxConfig } from '../../core/config'

const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Workbench settings', () => {
  it('persists shared settings, hot-applies them, and never returns credential text', async () => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'turboflux-settings-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(configDirectory, workspacePath)
    vi.stubEnv('TURBOFLUX_CONFIG_DIR', configDirectory)
    vi.resetModules()

    const { WorkbenchRuntime } = await import('./workbenchRuntime')
    const { loadConfig } = await import('../../core/config')
    const { loadProfile } = await import('../../core/profile')
    const initialConfig: TurboFluxConfig = {
      provider: 'custom',
      apiKey: '',
      baseUrl: '',
      model: '',
      contextWindow: 200_000,
      maxTokens: 16_384,
      approvalPolicy: 'ask',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
      apiConfigs: [],
    }
    const runtime = new WorkbenchRuntime({ workspacePath, config: initialConfig })

    try {
      const result = await runtime.saveSettings({
        activeApiConfigId: 'main',
        approvalPolicy: 'agent',
        capabilityProfile: 'workspace-write',
        gitEnabled: false,
        apiProfiles: [{
          id: 'main',
          name: 'Local gateway',
          provider: 'custom',
          apiKey: 'desktop-secret',
          baseUrl: '',
          model: 'gpt-5.6',
          contextWindow: 1_050_000,
          maxTokens: 16_384,
          maxOutputTokens: 128_000,
          reasoning: { enabled: true, effort: 'xhigh' },
        }],
        profile: {
          defaultPersonaId: 'product-builder',
          customInstructions: 'Keep desktop and TUI behavior aligned.',
        },
      })

      expect(result.snapshot.runtime).toMatchObject({
        configured: false,
        model: 'gpt-5.6',
        approvalPolicy: 'agent',
        reasoning: { enabled: true, effort: 'xhigh' },
      })
      expect(runtime.runtime.engine.getApprovalPolicy()).toBe('agent')
      expect(JSON.stringify(result.settings)).not.toContain('desktop-secret')
      expect(result.settings.apiProfiles[0].hasApiKey).toBe(true)

      const reloadedConfig = await loadConfig()
      expect(reloadedConfig).toMatchObject({
        apiKey: 'desktop-secret',
        model: 'gpt-5.6',
        approvalPolicy: 'agent',
        gitEnabled: false,
      })
      expect(loadProfile()).toMatchObject({
        defaultPersonaId: 'product-builder',
        customInstructions: 'Keep desktop and TUI behavior aligned.',
      })
    } finally {
      await runtime.destroy()
    }
  })
})
