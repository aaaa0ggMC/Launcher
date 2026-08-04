// Mirror ability domain types.

export interface MirrorEntry {
  name: string
  url: string
  enabled: boolean
}

export interface MirrorInfo {
  mirrors: MirrorEntry[]
  lastError?: string
}

export interface MirrorTestResult {
  name: string
  url: string
  ok: boolean
  latency?: number
  speed?: number
  error?: string
}
