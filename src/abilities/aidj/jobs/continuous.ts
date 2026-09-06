import {
  registerJobHandler,
  type JobControl,
  startJobByName
} from '../../../main/process/background-tasks'
import { makeLogger } from '../../../main/process/logger'
import { t, te } from '../../../main/process/i18n'
import { loadAidjConfig, DBusManager, LoudnessCache, bumpFrequency } from '../service'
import type { PlaylistEntry, LoudnessInfo, PlayerStatus } from '../types'
import { PLAYBACK_TAG, getPlayerMode, getWebPlayerBackend } from '../player-backend'
import { recordSongTimeline } from '../song-timeline'
import {
  withTimeout,
  cancellableWait,
  samePlayer,
  isWebTarget,
  webQueueRemaining,
  pushToWebEngine
} from './shared'

const log = makeLogger('aidj-continuous')

export interface ContinuousTaskState {
  /** null until the MPRIS connection retry succeeds. */
  dbus: DBusManager | null
  control: JobControl
  queue: PlaylistEntry[]
  current: PlaylistEntry | null
  index: number
  playerKey: string
  total: number
  /** Live session switches — toggled from the view without restarting the task. */
  volbalEnabled: boolean
  recordFreq: boolean
  method: string
  curve: number
  sentFirst: boolean
  volCache: LoudnessCache
  /** Real-time VolBal telemetry pushed to the continuous view. */
  volbal: {
    enabled: boolean
    method: string
    curve: number
    anchor: number | null
    baseVolume: number
    targetVolume: number | null
    currentLoudness: {
      peak_db: number | null
      rms_db: number | null
      integrated_lufs: number | null
    } | null
  } | null
}

const continuousTasks = new Map<string, ContinuousTaskState>()
const playerBindings = new Map<string, string>()

type PlayerSwitchListener = (oldKey: string, newKey: string) => void
const switchListeners: PlayerSwitchListener[] = []

export function onContinuousPlayerSwitch(listener: PlayerSwitchListener): void {
  switchListeners.push(listener)
}

function pushContinuousState(st: ContinuousTaskState): void {
  st.control.push({
    data: {
      type: 'state',
      player: st.playerKey,
      current: st.current?.name ?? null,
      currentPath: st.current?.path ?? null,
      next: st.queue[st.index]?.name ?? null,
      played: st.index,
      total: st.total,
      queueLen: st.total - st.index,
      queue: st.queue.slice(st.index).map((s) => ({ name: s.name, path: s.path })),
      volbal: st.volbal,
      recordFreq: st.recordFreq
    }
  })
}

export function getContinuousTasks(): ContinuousTaskState[] {
  return [...continuousTasks.values()]
}

export function getContinuousTask(taskId: string): ContinuousTaskState | undefined {
  return continuousTasks.get(taskId)
}

export function setContinuousVolbal(
  taskId: string,
  enabled: boolean,
  method?: string
): { ok: boolean; error?: string } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  st.volbalEnabled = enabled
  if (method && method !== st.method) {
    st.method = method
    // Rebuild the cache with the new measuring method; anchor resets on next track.
    st.volCache = new LoudnessCache(method, st.curve)
    st.sentFirst = false
  }
  // Keep the telemetry object in sync even before the first track is sent, so
  // the view always sees the live method/enabled (not a stale/null volbal).
  if (!st.volbal) {
    st.volbal = {
      enabled: st.volbalEnabled,
      method: st.method,
      curve: st.curve,
      anchor: null,
      baseVolume: 0.5,
      targetVolume: null,
      currentLoudness: null
    }
  } else {
    st.volbal.enabled = enabled
    st.volbal.method = st.method
  }
  // Re-apply to the CURRENT track immediately (not just on the next one) so a
  // live volbal toggle takes effect right away.
  applyCurrentVolume(st).catch(() => {})
  pushContinuousState(st)
  return { ok: true }
}

/** Re-apply volbal to the currently playing track (anchor if none yet). */
async function applyCurrentVolume(st: ContinuousTaskState): Promise<void> {
  const track = st.current
  if (!track || !st.dbus) return
  if (!st.volbalEnabled) {
    await st.dbus.setVolume(0.5)
    return
  }
  if (st.volCache.anchorVal == null) {
    // No anchor yet — establish it from the current track. If the file can't be
    // measured, skip entirely (keep the volume untouched) instead of guessing.
    const anchor = await st.volCache.setAnchor(track.path, 0.5)
    if (anchor != null) {
      await st.dbus.setVolume(0.5)
      st.sentFirst = true
    }
  } else {
    const v = await st.volCache.targetVolume(track.path)
    if (v != null) await st.dbus.setVolume(v)
  }
}

export function setContinuousRecordFreq(
  taskId: string,
  enabled: boolean
): { ok: boolean; error?: string } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  st.recordFreq = enabled
  return { ok: true }
}

/** Reset the played-memory: rewind the queue to its start (replays from 1). */
export function clearContinuousMemory(taskId: string): { ok: boolean; error?: string } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  st.index = 0
  st.current = null
  st.sentFirst = false
  pushContinuousState(st)
  return { ok: true }
}

export async function getContinuousVolume(taskId: string): Promise<number | null> {
  const st = continuousTasks.get(taskId)
  if (!st || !st.dbus) return null
  return st.dbus.getVolume()
}

export async function setContinuousVolume(
  taskId: string,
  vol: number
): Promise<{ ok: boolean; error?: string }> {
  const st = continuousTasks.get(taskId)
  if (!st || !st.dbus) return { ok: false, error: '任务不存在或尚未连接' }
  const ok = await st.dbus.setVolume(Math.max(0, Math.min(1, vol)))
  return ok ? { ok: true } : { ok: false, error: '设置音量失败' }
}

/** Set the volbal BASE volume (the "50% reference") so the user's preferred
 *  listening level becomes the center of the balance curve. Subsequent songs
 *  adjust relative to this new base (custom anchor). */
export function setContinuousBaseVol(
  taskId: string,
  base: number
): { ok: boolean; error?: string; base?: number } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  const clamped = Math.max(0.05, Math.min(1, base))
  st.volCache.setBaseVol(clamped)
  if (st.volbal) st.volbal.baseVolume = st.volCache.baseVolume
  pushContinuousState(st)
  return { ok: true, base: clamped }
}

export function boundContinuousPlayer(playerKey: string): string | undefined {
  return playerBindings.get(playerKey)
}

export async function switchContinuousPlayer(
  taskId: string,
  playerKey: string
): Promise<{ ok: boolean; error?: string }> {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在' }
  if (playerBindings.get(playerKey) && playerBindings.get(playerKey) !== taskId) {
    return { ok: false, error: `播放器 ${playerKey} 已被其他连续播放任务绑定` }
  }
  const oldKey = st.playerKey
  playerBindings.delete(oldKey)
  playerBindings.set(playerKey, taskId)
  st.playerKey = playerKey
  // Notify listeners (such as chat tasks) that were pushing to old player
  for (const fn of switchListeners) {
    try {
      fn(oldKey, playerKey)
    } catch {
      /* noop */
    }
  }

  if (st.dbus) {
    await st.dbus.switchToPlayer(playerKey)
    // If the task has an active track or is pending first track, send to the new player
    const trackToPlay = st.current || (st.index < st.total ? st.queue[st.index] : null)
    if (trackToPlay) {
      if (!st.current && st.index < st.total) {
        st.current = trackToPlay
        st.index++
      }
      try {
        await st.dbus.sendFiles([trackToPlay.path])
        st.control.push({
          data: { type: 'now_playing', track: trackToPlay.name, path: trackToPlay.path }
        })
        st.control.pushLine(`▶ ${trackToPlay.name} (${st.index}/${st.total})`)
      } catch (e) {
        log.warn('switchContinuousPlayer sendFiles failed', { player: playerKey, error: String(e) })
      }
    }
  }
  pushContinuousState(st)
  return { ok: true }
}

export function enqueueContinuousSongs(
  taskId: string,
  songs: PlaylistEntry[]
): { ok: boolean; error?: string; total?: number; queueLen?: number } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  if (!songs.length) return { ok: false, error: '没有要添加的歌曲' }
  st.queue.push(...songs)
  st.total = st.queue.length
  pushContinuousState(st)
  return { ok: true, total: st.total, queueLen: st.total - st.index }
}

/** Reorder the pending queue by replacing it with the given new order. */
export function reorderContinuousQueue(
  taskId: string,
  songs: PlaylistEntry[]
): { ok: boolean; error?: string } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
  if (!songs.length || !Array.isArray(songs)) return { ok: false, error: '队列为空' }
  const pending = st.queue.slice(st.index)
  if (songs.length !== pending.length) return { ok: false, error: '队列长度不匹配' }
  st.queue.splice(st.index, pending.length, ...songs)
  pushContinuousState(st)
  return { ok: true }
}

/** Immediate lookup of a continuous task bound to `player`. */
export function findContinuousByPlayer(player: string): ContinuousTaskState | undefined {
  return [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
}

/** Tracks still to play for `player` (web engine queue or MPRIS continuous task). */
export function queueRemainingFor(player: string): number {
  if (isWebTarget(player)) return webQueueRemaining()
  const cont = findContinuousByPlayer(player)
  return cont ? cont.total - cont.index : 0
}

/** Push a playlist to the player: web engine / enqueue to an existing
 *  continuous task / else create one. */
export async function ensureContinuousPlayer(
  player: string,
  songs: PlaylistEntry[]
): Promise<{ ok: boolean; taskId?: string; queueLen?: number; error?: string }> {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  // Normal refill/initial push: ENQUEUE — the current track keeps playing and
  // the batch joins the tail (mirrors the dbus enqueue-to-existing-task path).
  if (isWebTarget(player)) return pushToWebEngine(songs, true)
  const existing = [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
  if (existing) {
    const r = enqueueContinuousSongs(existing.control.id, songs)
    return r.ok ? { ok: true, taskId: existing.control.id, queueLen: r.queueLen } : r
  }
  const task = await startJobByName('aidj.continuous', {
    songs,
    player,
    view: 'continuous',
    tags: [PLAYBACK_TAG]
  })
  if (!task) return { ok: false, error: '创建连续播放任务失败' }
  return { ok: true, taskId: task.id, queueLen: songs.length }
}

/** /discard_follows: drop queued-but-unplayed songs; keep the current track playing. */
export function clearContinuousPending(player: string): void {
  if (isWebTarget(player)) {
    // Web engine: trim AFTER the cursor (current + play history stay so prev
    // still works). A chat push is a distinct FULL replace, not a trim.
    void getWebPlayerBackend().trimQueue()
    return
  }
  const st = [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
  if (!st) return
  st.queue = st.current ? [st.current] : []
  st.index = st.queue.length
  st.total = st.queue.length
  pushContinuousState(st)
}

/** /discard_follows generation: swap the queued-but-unplayed songs for the new
 *  batch once it's ready — the currently playing track keeps running, and the
 *  old pending songs are dropped only now (never before the AI answers). */
export async function replaceContinuousQueue(
  player: string,
  songs: PlaylistEntry[]
): Promise<{ ok: boolean; error?: string; taskId?: string; queueLen?: number }> {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  // /discard_follows on web: keep the CURRENT track + play history, drop the
  // old pending (after the cursor), then append the new batch — so it never
  // cuts the playing song or wipes what can be reached via prev.
  if (isWebTarget(player)) {
    await getWebPlayerBackend().trimQueue()
    return pushToWebEngine(songs, true)
  }
  const existing = [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
  if (existing) {
    existing.queue = songs
    existing.index = 0
    existing.total = songs.length
    pushContinuousState(existing)
    return { ok: true, taskId: existing.control.id, queueLen: songs.length }
  }
  const task = await startJobByName('aidj.continuous', {
    songs,
    player,
    view: 'continuous',
    tags: [PLAYBACK_TAG]
  })
  if (!task) return { ok: false, error: '创建连续播放任务失败' }
  return { ok: true, taskId: task.id, queueLen: songs.length }
}

registerJobHandler(
  'aidj.continuous',
  async (control, args) => {
    const songs = (args.songs ?? []) as PlaylistEntry[]
    const playerArg = (args.player as string) || ''
    if (!songs.length) {
      control.pushLine('错误: 没有要播放的歌曲', 'stderr')
      control.finish('error')
      return
    }

    const config = await loadAidjConfig()
    if (!config) {
      control.pushLine('错误: AIDJ 配置未找到', 'stderr')
      control.finish('error')
      return
    }

    const target =
      playerArg && playerArg !== '__auto__' ? playerArg : config.preferences.dbus_target || 'vlc'

    // Register the task IMMEDIATELY (before the connection retry) with the
    // requested target as a provisional key — otherwise every new chat batch
    // during a DBus outage spawns another task because the connecting one can't
    // be found. Once connected, playerKey resolves to the real bus name.
    const queue = [...songs]
    const st: ContinuousTaskState = {
      dbus: null,
      control,
      queue,
      current: null,
      index: 0,
      playerKey: target,
      total: queue.length,
      volbalEnabled: config.preferences.dynamic_balance_volume,
      recordFreq: config.preferences.record_freq,
      method: config.preferences.sound_adjust_method,
      curve: config.preferences.volume_curve,
      sentFirst: false,
      volCache: new LoudnessCache(
        config.preferences.sound_adjust_method,
        config.preferences.volume_curve
      ),
      volbal: null
    }
    continuousTasks.set(control.id, st)

    const ac = new AbortController()
    const release = (): void => {
      continuousTasks.delete(control.id)
      if (st.playerKey) playerBindings.delete(st.playerKey)
      if (st.dbus) {
        try {
          st.dbus.disconnect()
        } catch {
          /* noop */
        }
      }
    }
    control.setCancel(() => {
      ac.abort()
      release()
    })

    // Connect with retry: the MPRIS player (or the DBus daemon itself) may be
    // down — keep retrying every 10s until it comes up, the push lands, or the
    // user cancels. Never die silently and never hand the chat a "pushed OK"
    // that wasn't actually delivered.
    let attempts = 0
    while (!ac.signal.aborted) {
      const currentTarget = st.playerKey || target
      const mgr = new DBusManager(currentTarget)
      const connected = await withTimeout(mgr.connect(), 4000, false)
      let player = ''
      if (connected) {
        if (currentTarget && currentTarget !== '__auto__') {
          await mgr.switchToPlayer(currentTarget)
        }
        const status = await withTimeout<{ player?: string } | null>(mgr.getStatus(), 4000, null)
        player = status?.player ?? ''
      }
      if (connected && player) {
        const playerKey = mgr.resolvedPlayerName || player
        if (playerBindings.has(playerKey)) {
          control.pushLine(te('aidj.continuous.playerBusy', { player: playerKey }), 'stderr')
          release()
          control.finish('error')
          return
        }
        st.dbus = mgr
        st.playerKey = playerKey
        playerBindings.set(playerKey, control.id)
        break
      }
      attempts++
      if (attempts === 1) {
        control.pushLine(t('aidj.continuous.connectRetry'), 'stderr')
      } else {
        control.pushLine(te('aidj.continuous.connectAttempt', { n: String(attempts) }), 'stderr')
      }
      try {
        mgr.disconnect()
      } catch {
        /* noop */
      }
      await cancellableWait(10_000, ac.signal)
    }
    if (ac.signal.aborted || !st.dbus) {
      release()
      control.pushLine(t('aidj.continuous.connectCancelled'), 'stderr')
      control.finish('cancelled')
      return
    }

    // Pin the manager to the resolved player (exit auto-detect) so the loop
    // tracks ONE MPRIS object, not whichever happens to be playing.
    await st.dbus.switchToPlayer(st.playerKey)

    control.pushLine(
      te('aidj.continuous.started', {
        player: st.playerKey,
        total: String(st.total)
      })
    )
    control.push({
      data: { type: 'state', message: 'started', player: st.playerKey, total: st.total }
    })

    try {
      const dbus = st.dbus
      const reconnectMinutes = config.preferences.reconnect_minutes ?? 0
      let lastStateKey = ''
      let lastSendAt = 0
      let disconnectSince: number | null = null

      while (!ac.signal.aborted) {
        try {
          const status = await withTimeout<PlayerStatus | null>(dbus.getStatus(), 4000, null)
          if (!status) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
          }

          // Bound player disappeared → reconnect per config, or exit.
          if (!status.player) {
            const now = Date.now()
            if (disconnectSince === null) {
              disconnectSince = now
              control.pushLine(
                te('aidj.continuous.disconnected', { player: st.playerKey }),
                'stderr'
              )
            }
            if (reconnectMinutes === 0) {
              control.pushLine(
                te('aidj.continuous.disconnectedEnd', { player: st.playerKey }),
                'stderr'
              )
              control.finish('error')
              break
            }
            if (reconnectMinutes > 0 && now - disconnectSince > reconnectMinutes * 60_000) {
              control.pushLine(
                te('aidj.continuous.disconnectedTimeout', {
                  player: st.playerKey,
                  minutes: String(reconnectMinutes)
                }),
                'stderr'
              )
              control.finish('error')
              break
            }
            // reconnectMinutes < 0 → retry forever; > 0 → within the window
            const rebound = await dbus.switchToPlayer(st.playerKey).catch(() => false)
            if (rebound) {
              disconnectSince = null
              control.pushLine(t('aidj.continuous.reconnected'), 'stdout')
            } else {
              await new Promise((resolve) => setTimeout(resolve, 2000))
              continue
            }
          } else {
            disconnectSince = null
          }

          // All songs played and player idle → job finished.
          if (
            st.index >= st.total &&
            Date.now() - lastSendAt > 3000 &&
            (status.status === 'Stopped' || status.status === 'Unknown')
          ) {
            break
          }

          if ((status.status === 'Stopped' || status.status === 'Unknown') && st.index < st.total) {
            const track = st.queue[st.index]
            st.index++
            st.current = track
            lastSendAt = Date.now()
            let targetVol: number | null = null
            let loudness: LoudnessInfo | null = null
            if (st.volbalEnabled) {
              if (!st.sentFirst) {
                // Establish the anchor from this track. If the file can't be
                // measured, skip (leave volume untouched); the next track tries
                // again — no guessing, no fabricated 0 dB.
                const anchor = await st.volCache.setAnchor(track.path, 0.5)
                if (anchor != null) {
                  await dbus.setVolume(0.5)
                  st.sentFirst = true
                  targetVol = 0.5
                }
                log.info('volbal first-track', {
                  track: track.name,
                  method: st.method,
                  anchor,
                  volSet: anchor != null
                })
              } else {
                const v = await st.volCache.targetVolume(track.path)
                if (v != null) {
                  await dbus.setVolume(v)
                  targetVol = v
                }
                log.info('volbal adjust', {
                  track: track.name,
                  method: st.method,
                  anchorVal: st.volCache.anchorVal,
                  target: v,
                  volSet: v != null
                })
              }
              const li = await st.volCache.get(track.path)
              if (li) {
                loudness = {
                  peak_db: li.peak_db,
                  rms_db: li.rms_db,
                  integrated_lufs: li.integrated_lufs
                }
              } else {
                log.warn('volbal no-loudness', { track: track.name })
              }
              if (st.queue[st.index]) st.volCache.preAnalyze(st.queue[st.index].path)
            }
            if (st.recordFreq) {
              await bumpFrequency([track.name])
            }
            st.volbal = {
              enabled: st.volbalEnabled,
              method: st.method,
              curve: st.curve,
              anchor: st.volCache.anchorVal,
              baseVolume: st.volCache.baseVolume,
              targetVolume: targetVol,
              currentLoudness: loudness
            }
            await dbus.sendFiles([track.path])
            void recordSongTimeline(track.name).catch(() => {})
            control.push({
              data: { type: 'now_playing', track: track.name, path: track.path }
            })
            control.pushLine(`▶ ${track.name} (${st.index}/${st.total})`)
            pushContinuousState(st)
          }

          const stateKey = `${st.playerKey}|${st.current?.name ?? ''}|${st.index}/${st.total}`
          if (stateKey !== lastStateKey) {
            lastStateKey = stateKey
            pushContinuousState(st)
          }

          await new Promise((resolve) => setTimeout(resolve, 1000))
        } catch (e) {
          if (ac.signal.aborted) break
          log.error('continuous loop error', { error: String(e) })
          control.pushLine(`错误: ${String(e)}`, 'stderr')
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    } finally {
      release()
    }

    control.pushLine('连续播放已结束')
    control.finish('exited')
  },
  // dbus-exclusive: not startable in web-player mode (MAddition gating)
  () => getPlayerMode().then((m) => m === 'dbus')
)
