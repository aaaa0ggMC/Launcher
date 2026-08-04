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

const baseFormat = (): winston.Logform.Format =>
  winston.format.combine(winston.format.timestamp(), fmt)
const fileTransport = (): DailyRotateFile =>
  new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'cockpit-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '14d',
    zippedArchive: true
  })

// Both transports share the file. `fileLogger` is used for merged/repeated
// entries so the console never scrolls with poll noise while the file keeps
// every raw line for audit.
const logger = winston.createLogger({
  level: 'debug',
  format: baseFormat(),
  transports: [new winston.transports.Console(), fileTransport()]
})
const fileLogger = winston.createLogger({
  level: 'debug',
  format: baseFormat(),
  transports: [fileTransport()]
})

let seq = 0
const buffer: LogEntry[] = []
const MAX_BUFFER = 20000

/** Merge window for repeated same-kind entries (periodic poll noise etc.). */
const MERGE_WINDOW_MS = 5000

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

/**
 * Newest buffer entry with the same level/scope/message within the merge
 * window — data is ignored so a changing payload (poll noise) still counts as
 * the same recurring event. Entries are time-ordered, so scanning backwards
 * until the window boundary is correct and cheap.
 */
function findMergeTarget(
  level: LogLevel,
  scope: string,
  message: string,
  now: number
): LogEntry | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i]
    if (e.ts < now - MERGE_WINDOW_MS) break
    if (e.level === level && e.scope === scope && e.message === message) return e
  }
  return null
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const now = Date.now()
  const logInfo = {
    level,
    message,
    scope,
    ...(data !== undefined ? { data } : {})
  }

  const merged = findMergeTarget(level, scope, message, now)
  if (merged) {
    // Repeated within the window: bump the existing entry, refresh ts/data,
    // and only write to the FILE (audit) — not the console, so poll noise
    // doesn't scroll the terminal.
    fileLogger.log(logInfo)
    merged.count = (merged.count ?? 1) + 1
    merged.ts = now
    merged.data = data
    try {
      broadcast(merged)
    } catch {
      // ignore
    }
    return
  }

  // Novel entry: both console + file.
  logger.log(logInfo)

  const entry: LogEntry = {
    id: seq++,
    ts: now,
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
