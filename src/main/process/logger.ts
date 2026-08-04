import { mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import type { LogEntry, LogLevel } from '../../abilities/logs/types'
import { LOG_DIR } from './paths'

/**
 * Framework logging pipeline.
 *
 *  - winston + winston-daily-rotate-file write to `logs/cockpit-YYYY-MM-DD.log`,
 *    rotating daily with size cap + retention + .gz archiving.
 *  - A bounded in-memory ring buffer keeps the current session's entries so the
 *    Logs ability can page/query them without touching the filesystem.
 *  - New entries are broadcast to every window (`cockpit:log`) for live tailing.
 *
 * Modules get a scoped logger via `makeLogger('scope')` and never touch winston
 * directly, so scope/level/message stay consistent and queryable.
 */

mkdirSync(LOG_DIR, { recursive: true })

const fmt = winston.format.printf((info) => {
  const ts = typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString()
  const scope = info.scope ? ` [${info.scope}]` : ''
  const data = info.data !== undefined ? ` ${JSON.stringify(info.data)}` : ''
  return `${ts} [${String(info.level).toUpperCase()}]${scope} ${info.message}${data}`
})

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(winston.format.timestamp(), fmt),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'cockpit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '14d',
      zippedArchive: true
    })
  ]
})

let seq = 0
const buffer: LogEntry[] = []
const MAX_BUFFER = 20000

type LogBroadcast = (entry: LogEntry) => void
let broadcast: LogBroadcast = () => {}

export function setLogBroadcast(fn: LogBroadcast): void {
  broadcast = fn
}

/**
 * Whether an entry belongs to the logs ability's own operations (scope `logs`,
 * or the `logs.*` command lines logged by the ipc dispatcher). The file ALWAYS
 * keeps these for audit — the UI just filters them when "hide logs self" is on.
 */
export function isLogsSelfEntry(e: Pick<LogEntry, 'scope' | 'message'>): boolean {
  return e.scope === 'logs' || (e.scope === 'ipc' && e.message.startsWith('logs.'))
}

/** Two entries are "duplicates" when the renderer-relevant payload matches. */
function samePayload(
  a: LogEntry,
  b: Pick<LogEntry, 'level' | 'scope' | 'message' | 'data'>
): boolean {
  if (a.level !== b.level || a.scope !== b.scope || a.message !== b.message) return false
  const da = a.data
  const db = b.data
  if (da === undefined || db === undefined) return da === db
  return JSON.stringify(da) === JSON.stringify(db)
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  // The on-disk file keeps every raw line (complete audit trail)…
  logger.log({
    level,
    message,
    scope,
    ...(data !== undefined ? { data } : {})
  })

  // …but the in-memory buffer (and thus the UI + export) merges consecutive
  // duplicates into one entry with an incrementing count.
  const last = buffer[buffer.length - 1]
  if (last && samePayload(last, { level, scope, message, data })) {
    last.count = (last.count ?? 1) + 1
    try {
      broadcast(last)
    } catch {
      // ignore
    }
    return
  }

  const entry: LogEntry = {
    id: seq++,
    ts: Date.now(),
    level,
    scope,
    message,
    data,
    count: 1
  }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  try {
    broadcast(entry)
  } catch {
    // broadcasting must never break the log pipeline
  }
}

export interface ScopedLogger {
  debug: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
}

/** Build a logger bound to a module scope (e.g. `mirror`, `launcher`). */
export function makeLogger(scope: string): ScopedLogger {
  return {
    debug: (message, data) => emit('debug', scope, message, data),
    info: (message, data) => emit('info', scope, message, data),
    warn: (message, data) => emit('warn', scope, message, data),
    error: (message, data) => emit('error', scope, message, data)
  }
}

/** Default framework logger. */
export const log = makeLogger('cockpit')

/** Log with an arbitrary scope (used by the `logs.post` command). */
export function logAt(level: LogLevel, scope: string, message: string, data?: unknown): void {
  emit(level, scope, message, data)
}

export interface LogQueryOptions {
  /** Exact level to match (omit for all). */
  level?: LogLevel
  /** Only entries with id < `before` (older than a given id). */
  before?: number
  limit?: number
  /** Restrict to one scope. */
  scope?: string
  /** Exclude these scopes entirely. */
  excludeScopes?: string[]
  /** Hide the logs ability's own entries (display-only; the file keeps them). */
  excludeSelf?: boolean
}

/** Query the current session's buffer, newest-first paging via `before`. */
export function queryLogs(opts: LogQueryOptions = {}): { entries: LogEntry[]; total: number } {
  const before = opts.before ?? Number.POSITIVE_INFINITY
  const limit = Math.min(opts.limit ?? 500, 5000)
  const excluded = new Set(opts.excludeScopes ?? [])
  const matched = buffer.filter(
    (e) =>
      e.id < before &&
      (!opts.level || e.level === opts.level) &&
      !excluded.has(e.scope) &&
      !(opts.excludeSelf && isLogsSelfEntry(e)) &&
      (!opts.scope || e.scope === opts.scope)
  )
  return { entries: matched.slice(-limit), total: matched.length }
}

function formatEntry(e: LogEntry): string {
  const iso = new Date(e.ts).toISOString()
  const data = e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ''
  const count = e.count && e.count > 1 ? ` *${e.count}` : ''
  return `${iso} [${e.level.toUpperCase().padEnd(5)}] [${e.scope}] ${e.message}${data}${count}`
}

/** Export the current session's logs to a text file (respects optional level). */
export async function exportLogs(
  path: string,
  opts: { level?: LogLevel } = {}
): Promise<{ ok: boolean; count: number; error?: string }> {
  const { entries } = queryLogs({ level: opts.level, limit: MAX_BUFFER })
  const body = entries.map(formatEntry).join('\n')
  try {
    await writeFile(path, entries.length ? body + '\n' : body, 'utf-8')
    return { ok: true, count: entries.length }
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Absolute path of the log directory (e.g. for display in the UI). */
export function getLogDir(): string {
  return LOG_DIR
}
