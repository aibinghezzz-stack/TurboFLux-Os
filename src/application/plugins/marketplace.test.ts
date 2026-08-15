import { describe, expect, it } from 'vitest'
import { PLUGIN_MARKETPLACE } from './marketplace'

describe('official plugin marketplace', () => {
  it('leaves product-specific catalogs to downstream applications', () => {
    expect(PLUGIN_MARKETPLACE).toEqual([])
  })
})
