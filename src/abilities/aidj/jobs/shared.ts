import { getWebPlayerBackend } from '../player-backend'
import type { PlaylistEntry } from '../types'

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Sleep that resolves early (aborting the wait) when the signal aborts. */
export function cancellableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolve a promise to a fallback after `ms` — dbus-next can hang forever
 *  when the session bus is gone, so every DBus probe must be raced. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }).catch(() => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

/**
 * Player identity is expressed two ways across the codebase: the short
 * configured name (`vlc`, `config.preferences.dbus_target`) and the resolved
 * MPRIS bus name (`org.mpris.MediaPlayer2.vlc`). Continuous tasks are keyed by
 * the resolved name, but chat's `st.player` may carry either form (or the
 * `__auto__` sentinel) — so every player→task lookup must compare both.
 */
export function samePlayer(a: string, b: string): boolean {
  if (!a || !b) return a === b
  if (a === b) return true
  const short = (n: string): string => n.replace(/^org\.mpris\.MediaPlayer2\./, '')
  return short(a) === short(b)
}

/** Whether `player` denotes the built-in engine ('web' / '__auto__' resolved
 *  to web by the chat job). */
export function isWebTarget(player: string): boolean {
  return player === 'web' || player === '__auto__'
}

/** Tracks still to play in the engine queue (0 when idle / drained). */
export function webQueueRemaining(): number {
  const q = getWebPlayerBackend().getQueueState()
  if (!q || q.total <= 0) return 0
  return Math.max(0, q.total - q.index)
}

/** Push a playlist to the engine. `append` (default) ENQUEUES onto the existing
 *  queue so the current track keeps playing; `append:false` replaces it (used by
 *  /discard_follows). */
export async function pushToWebEngine(
  songs: PlaylistEntry[],
  append = true
): Promise<{
  ok: boolean
  queueLen?: number
  error?: string
}> {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  const ok = await getWebPlayerBackend().sendFiles(
    songs.map((s) => s.path),
    { append }
  )
  return ok ? { ok: true, queueLen: songs.length } : { ok: false, error: '内置播放器未就绪' }
}
