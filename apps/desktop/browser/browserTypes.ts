import type { WebContentsView } from 'electron'

export interface BrowserConsoleEntry {
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  source?: string
  line?: number
  timestamp: number
}

export interface BrowserNetworkIssue {
  method: string
  url: string
  resourceType: string
  status?: number
  error?: string
  timestamp: number
}

export interface BrowserTab {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  crashed: boolean
  consoleEntries: BrowserConsoleEntry[]
  networkIssues: BrowserNetworkIssue[]
  observationEpoch: number
}
