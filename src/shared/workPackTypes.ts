import type { PluginPermission } from './pluginTypes'

export type WorkPackKind = 'workflow' | 'integration' | 'bundle'

export type WorkPackInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'modified'
  | 'broken'
  | 'local'
  | 'disabled'
  | 'enabled'
  | 'blocked'
  | 'error'

export type WorkPackBackend =
  | { type: 'skill'; marketplaceId: string; skillId: string }
  | { type: 'plugin'; marketplaceId: string; pluginId: string }
  | { type: 'local-skill'; skillId: string }
  | { type: 'local-plugin'; pluginId: string }

export interface WorkPackContributionSummary {
  skills: number
  tools: number
  commands: number
}

export interface WorkPackEmphasis {
  type: 'skill' | 'mcp'
  id: string
  name: string
}

export interface WorkPackExample {
  title: string
  prompt: string
}

export interface WorkPackMarketplaceMetadata {
  featured?: boolean
  sortOrder?: number
  outcomes?: string[]
  examples?: WorkPackExample[]
  worksWith?: string[]
  releaseNotes?: string
  updatedAt?: string
}

export interface WorkPackEntry {
  id: string
  name: string
  description: string
  version: string
  publisher: string
  category: string
  icon: string
  kind: WorkPackKind
  trust: 'verified' | 'community' | 'local'
  sourceId: string
  sourceName: string
  sourceUrl?: string
  license?: string
  requirement?: string
  tags: string[]
  capabilities: string[]
  sortOrder: number
  outcomes: string[]
  examples: WorkPackExample[]
  worksWith: string[]
  releaseNotes?: string
  marketplaceUpdatedAt?: string
  promptTemplate?: string
  featured: boolean
  installed: boolean
  enabled: boolean
  installState: WorkPackInstallState
  installedAt?: string
  updatedAt?: string
  sizeBytes?: number
  permissions: PluginPermission[]
  contributions: WorkPackContributionSummary
  backend: WorkPackBackend
  emphasis?: WorkPackEmphasis
  canUninstall: boolean
  supportsToggle: boolean
  diagnostics: string[]
  error?: string
}
