export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabSnapshot {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed?: boolean
}

export type BrowserActivityPhase = 'opening' | 'navigating' | 'observing' | 'acting' | 'capturing' | 'recovering'

export interface BrowserActivitySnapshot {
  phase: BrowserActivityPhase
  operation?: string
  tabId?: string
  description: string
  startedAt: number
}

export interface BrowserDownloadSnapshot {
  id: string
  filename: string
  path?: string
  status: 'started' | 'completed' | 'cancelled' | 'failed'
  receivedBytes?: number
  totalBytes?: number
  error?: string
  startedAt: number
  updatedAt: number
}

export interface BrowserErrorSnapshot {
  code: 'navigation-blocked' | 'load-failed' | 'renderer-crashed' | 'download-failed' | 'operation-failed'
  message: string
  tabId?: string
  recoverable: boolean
  occurredAt: number
}

export interface BrowserSystemSnapshot {
  visible: boolean
  activeTabId: string | null
  tabs: BrowserTabSnapshot[]
  activity?: BrowserActivitySnapshot
  downloads: BrowserDownloadSnapshot[]
  lastError?: BrowserErrorSnapshot
}

export interface BrowserObservedElement {
  ref: string
  role: string
  name: string
  description?: string
  disabled?: boolean
  checked?: boolean
  value?: string
  options?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface BrowserObservation {
  tabId: string
  title: string
  url: string
  text: string
  elements: BrowserObservedElement[]
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  truncated: boolean
}

export type BrowserSystemEvent =
  | { type: 'state'; snapshot: BrowserSystemSnapshot }
  | { type: 'blocked-navigation'; url: string; reason: string }
  | { type: 'download'; download: BrowserDownloadSnapshot; filename: string; path?: string; status: BrowserDownloadSnapshot['status']; error?: string }
  | { type: 'artifact-ready'; path: string; name: string; mime: string; kind: 'screenshot' | 'download'; tabId?: string; title?: string; url?: string }
