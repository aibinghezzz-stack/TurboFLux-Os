import type { PluginManifest } from '../../shared/pluginTypes'
import type { WorkPackMarketplaceMetadata } from '../../shared/workPackTypes'

export interface PluginMarketplaceEntry {
  id: string
  manifest: PluginManifest
  publisher: string
  trust: 'verified' | 'community'
  description: string
  marketplace?: WorkPackMarketplaceMetadata
  promptFiles?: Record<string, string>
}

export const PLUGIN_MARKETPLACE: PluginMarketplaceEntry[] = []
