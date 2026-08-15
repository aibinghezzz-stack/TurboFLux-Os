import { describe, expect, it } from 'vitest'
import type { WorkbenchSettingsSnapshot } from '@turboflux/agent-core/workbench'
import { createSettingsUpdate } from './settingsCenter'

describe('desktop settings draft', () => {
  it('keeps built-in system plugins out of editable MCP settings', () => {
    const snapshot = {
      activeApiConfigId: undefined,
      approvalPolicy: 'agent',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
      mcpServers: [
        {
          name: 'computer',
          displayName: '电脑操控',
          system: true,
          enabled: true,
          envKeys: [],
          headerKeys: [],
          status: 'connected',
          tools: [],
        },
        {
          name: 'documents',
          enabled: true,
          command: 'npx',
          args: ['documents-mcp'],
          envKeys: [],
          headerKeys: [],
          status: 'connected',
          tools: [],
        },
      ],
      apiProfiles: [],
      profile: { enabledPersonaIds: [] },
    } as unknown as WorkbenchSettingsSnapshot

    expect(createSettingsUpdate(snapshot).mcpServers).toEqual([expect.objectContaining({
      name: 'documents',
      command: 'npx',
      args: ['documents-mcp'],
    })])
  })
})
