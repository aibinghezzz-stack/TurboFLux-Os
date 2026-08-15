import { describe, expect, it } from 'vitest'
import { PLUGIN_MARKETPLACE } from './marketplace'

describe('official plugin marketplace', () => {
  it('ships the local office suite as a declarative bundled plugin', () => {
    expect(PLUGIN_MARKETPLACE).toHaveLength(1)
    expect(PLUGIN_MARKETPLACE[0]).toMatchObject({
      id: 'turboflux-office-workagent',
      bundled: true,
      trust: 'verified',
      manifest: {
        id: 'turboflux.office-workagent',
        name: '全能办公 WorkAgent',
        permissions: [],
      },
    })
    expect(PLUGIN_MARKETPLACE[0].manifest.main).toBeUndefined()
    expect(PLUGIN_MARKETPLACE[0].manifest.contributes?.skills).toHaveLength(7)
    expect(Object.keys(PLUGIN_MARKETPLACE[0].promptFiles || {})).toHaveLength(7)
  })
})
