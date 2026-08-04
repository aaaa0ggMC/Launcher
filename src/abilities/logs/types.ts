// Logs ability domain types — the framework log pipeline contract.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One structured log entry (produced by the main-process logger). */
export interface LogEntry {
  /** Monotonic sequence id — the renderer uses it for paging ("before"). */
  id: number
  /** Epoch milliseconds. */
  ts: number
  level: LogLevel
  /** Owning module scope, e.g. `mirror`, `launcher`, `renderer`. */
  scope: string
  message: string
  data?: unknown
  /**
   * Consecutive duplicates merged into this entry (1 = unique). The UI shows
   * `*N` for counts > 1; the on-disk file still keeps every raw line.
   */
  count?: number
}

export interface LogQueryResult {
  entries: LogEntry[]
  total: number
}
