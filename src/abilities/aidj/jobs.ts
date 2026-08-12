import {
  registerJobHandler,
  type JobControl,
  startJobByName
} from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'
import {
  loadAidjConfig,
  ensureAidjDir,
  loadLibrary,
  scanMusicFiles,
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  initDbusManager,
  setPersistentSession,
  PersistentSession,
  SessionManager,
  DBusManager,
  LoudnessCache,
  bumpFrequency,
  getCurrentPlayerKey
} from './service'
import OpenAI from 'openai'
import type { SongMeta, PlaylistEntry, ChatMessage, LoudnessInfo } from './types'
import { SEPARATOR } from './types'

const log = makeLogger('aidj-persistent')

registerJobHandler('aidj.persistent', async (control, args) => {
  const initialPrompt = (args.prompt as string) || ''
  const anchorValue = args.anchor !== undefined ? Number(args.anchor) : null
  if (!initialPrompt) {
    control.pushLine('错误: 需要初始提示词', 'stderr')
    control.finish('error')
    return
  }

  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  setNcmBaseUrl(config.ncm_base_url)
  await ensureAidjDir()

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  const lib = await loadLibrary()
  const musicPaths = lib.musicPaths
  let metadata: Map<string, SongMeta> = lib.metadata
  const missing = await findMissingSongs(musicPaths, metadata)
  if (missing.size > 0) {
    control.pushLine(`发现 ${missing.size} 首新歌曲，同步元数据中...`)
    metadata = (
      await syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      )
    ).metadata
  }

  control.pushLine(`曲库已加载: ${metadata.size} 首歌曲`)
  control.pushLine(`初始提示: "${initialPrompt}"`)

  const dbus = await initDbusManager(config)
  if (!dbus) {
    control.pushLine('错误: DBus 连接失败', 'stderr')
    control.finish('error')
    return
  }
  control.pushLine('DBus 已连接')

  const session = new PersistentSession(
    client,
    metadata,
    musicPaths,
    config,
    dbus,
    initialPrompt,
    anchorValue
  )
  const sessionId = await SessionManager.createSession({
    title: initialPrompt.slice(0, 40),
    type: 'chat'
  })
  session.sessionId = sessionId
  setPersistentSession(session)

  const ac = new AbortController()
  control.setCancel(() => {
    ac.abort()
    session.stop()
    setPersistentSession(null)
  })

  control.pushLine('持久模式 AI DJ 已启动')
  control.push({ data: { type: 'status', message: 'started', prompt: initialPrompt } })

  let lastStatusUpdate = 0
  let lastStatus: string | null = null

  while (!ac.signal.aborted) {
    try {
      if (await session.needsNextBatch()) {
        control.pushLine('AI 思考中...', 'stderr')
        control.push({ data: { type: 'status', message: 'thinking' } })
        await session.fetchBatch(undefined, (attempt, waitMs) => {
          control.pushLine(
            `网络不可用，第 ${attempt} 次重试中… (${Math.round(waitMs / 1000)}s)`,
            'stderr'
          )
        })
        control.push({ data: { type: 'status', message: 'idle' } })
      }

      await session.ensureNextBatchInQueue()

      if (session.hasReadyTrack()) {
        const status = await dbus.getStatus()
        if (status.status === 'Stopped' || status.status === 'Unknown') {
          const track = session.dequeue()
          if (track) {
            await session.adjustVolume(track)
            await dbus.sendFiles([track.path])
            control.push({ data: { type: 'now_playing', track: track.name, path: track.path } })
            control.pushLine(`▶ 播放: ${track.name}`)
          }
        }
      }

      const status = await dbus.getStatus()
      const statusKey = `${status.status}|${status.track}`
      if (statusKey !== lastStatus || Date.now() - lastStatusUpdate > 5000) {
        lastStatus = statusKey
        lastStatusUpdate = Date.now()
        control.push({ data: { type: 'status', message: 'running', playerStatus: status } })
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    } catch (e) {
      if (ac.signal.aborted) break
      log.error('persistent loop error', { error: String(e) })
      control.pushLine(`错误: ${String(e)}`, 'stderr')
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }

  control.pushLine('持久模式已停止')
  control.finish('exited')
})

// ---------------------------------------------------------------------------
// Continuous player — pushes the given ordered song list to an MPRIS player,
// monitoring DBus and sending the next track when the current one stops.
// No AI generation. One task per MPRIS object. VolBal applied.
// ---------------------------------------------------------------------------

export interface ContinuousTaskState {
  dbus: DBusManager
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

// ---------------------------------------------------------------------------
// Live session switches — these mutate the RUNNING task (no restart needed).
// The view's bottom status bar maps directly onto them.
// ---------------------------------------------------------------------------

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
  if (!track) return
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
  if (!st) return null
  return st.dbus.getVolume()
}

export async function setContinuousVolume(
  taskId: string,
  vol: number
): Promise<{ ok: boolean; error?: string }> {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在或已结束' }
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

export function switchContinuousPlayer(
  taskId: string,
  playerKey: string
): { ok: boolean; error?: string } {
  const st = continuousTasks.get(taskId)
  if (!st) return { ok: false, error: '任务不存在' }
  if (playerBindings.get(playerKey) && playerBindings.get(playerKey) !== taskId) {
    return { ok: false, error: `播放器 ${playerKey} 已被其他连续播放任务绑定` }
  }
  playerBindings.delete(st.playerKey)
  playerBindings.set(playerKey, taskId)
  st.playerKey = playerKey
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

registerJobHandler('aidj.continuous', async (control, args) => {
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
  const dbus = new DBusManager(target)
  await dbus.connect()
  if (!(await dbus.getStatus()).player) {
    control.pushLine('错误: 无法连接 MPRIS 播放器', 'stderr')
    control.finish('error')
    return
  }

  const playerKey = dbus.resolvedPlayerName
  if (!playerKey) {
    control.pushLine('错误: 无法解析 MPRIS 播放器', 'stderr')
    control.finish('error')
    return
  }
  if (playerBindings.has(playerKey)) {
    control.pushLine(`播放器 ${playerKey} 已有连续播放任务`, 'stderr')
    control.finish('error')
    return
  }

  const queue = [...songs]
  const st: ContinuousTaskState = {
    dbus,
    control,
    queue,
    current: null,
    index: 0,
    playerKey,
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
  playerBindings.set(playerKey, control.id)

  // Pin the manager to the resolved player (exit auto-detect) so the loop
  // tracks ONE MPRIS object, not whichever happens to be playing.
  await dbus.switchToPlayer(playerKey)

  const ac = new AbortController()

  const release = (): void => {
    continuousTasks.delete(control.id)
    playerBindings.delete(st.playerKey)
    try {
      dbus.disconnect()
    } catch {
      /* noop */
    }
  }

  control.setCancel(() => {
    ac.abort()
    release()
  })

  control.pushLine(`连续播放已启动 → ${st.playerKey} (${st.total} 首)`)
  control.push({
    data: { type: 'state', message: 'started', player: st.playerKey, total: st.total }
  })

  try {
    const reconnectMinutes = config.preferences.reconnect_minutes ?? 0
    let lastStateKey = ''
    let lastSendAt = 0
    let disconnectSince: number | null = null

    while (!ac.signal.aborted) {
      try {
        const status = await dbus.getStatus()

        // Bound player disappeared → reconnect per config, or exit.
        if (!status.player) {
          const now = Date.now()
          if (disconnectSince === null) {
            disconnectSince = now
            control.pushLine(`播放器 ${st.playerKey} 已断开，尝试重连...`, 'stderr')
          }
          if (reconnectMinutes === 0) {
            control.pushLine(`播放器 ${st.playerKey} 已断开，任务结束`, 'stderr')
            control.finish('error')
            break
          }
          if (reconnectMinutes > 0 && now - disconnectSince > reconnectMinutes * 60_000) {
            control.pushLine(
              `播放器 ${st.playerKey} 断开超过 ${reconnectMinutes} 分钟，任务结束`,
              'stderr'
            )
            control.finish('error')
            break
          }
          // reconnectMinutes < 0 → retry forever; > 0 → within the window
          const rebound = await dbus.switchToPlayer(st.playerKey).catch(() => false)
          if (rebound) {
            disconnectSince = null
            control.pushLine('播放器已恢复', 'stdout')
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
})

// ---------------------------------------------------------------------------
// Persistent AI-DJ chat task — generates batches and pushes them to a
// continuous player (create if none, enqueue if exists). The chat view lives
// in the bt dialog; the task itself does NOT own a dbus player (song switching
// is handled by aidj.continuous). User messages are injected via aidj.chat.
// ---------------------------------------------------------------------------

export interface ChatTaskState {
  session: PersistentSession
  player: string
  control: JobControl
  abortFetch?: () => void
  /** Set by /discard_follows — force the loop to refetch even while the queue is full. */
  forceFetch?: boolean
  /** Set by /discard_follows — the next generated batch REPLACES the continuous queue. */
  replaceQueueOnNext?: boolean
}

const chatTasks = new Map<string, ChatTaskState>()

export function getChatTask(taskId: string): ChatTaskState | undefined {
  return chatTasks.get(taskId)
}

export function getChatTasks(): ChatTaskState[] {
  return [...chatTasks.values()]
}

/** Live-switch the player a chat session pushes songs to. `__auto__` resolves
 *  to the currently active/bound player so the chat keeps pushing to the same
 *  continuous task. */
export async function setChatPlayer(
  taskId: string,
  player: string
): Promise<{ ok: boolean; error?: string }> {
  const st = chatTasks.get(taskId)
  if (!st) return { ok: false, error: '持续会话未运行' }
  st.player = !player || player === '__auto__' ? await getCurrentPlayerKey() : player
  return { ok: true }
}

/** Resend a playlist to the chat session's continuous player. */
export function chatResendPlaylist(
  chatTaskId: string,
  songs: PlaylistEntry[]
): { ok: boolean; error?: string; total?: number } {
  const st = chatTasks.get(chatTaskId)
  if (!st) return { ok: false, error: '持续会话未运行' }
  return ensureContinuousPlayer(st.player, songs)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Player identity is expressed two ways across the codebase: the short
 * configured name (`vlc`, `config.preferences.dbus_target`) and the resolved
 * MPRIS bus name (`org.mpris.MediaPlayer2.vlc`). Continuous tasks are keyed by
 * the resolved name, but chat's `st.player` may carry either form (or the
 * `__auto__` sentinel) — so every player→task lookup must compare both.
 */
function samePlayer(a: string, b: string): boolean {
  if (!a || !b) return a === b
  if (a === b) return true
  const short = (n: string): string => n.replace(/^org\.mpris\.MediaPlayer2\./, '')
  return short(a) === short(b)
}

/** Immediate lookup of a continuous task bound to `player`. */
function findContinuousByPlayer(player: string): ContinuousTaskState | undefined {
  return [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
}

/** Push a playlist to the player: enqueue to an existing continuous task, else create one. */
function ensureContinuousPlayer(
  player: string,
  songs: PlaylistEntry[]
): { ok: boolean; taskId?: string; queueLen?: number; error?: string } {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  const existing = [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
  if (existing) {
    const r = enqueueContinuousSongs(existing.control.id, songs)
    return r.ok ? { ok: true, taskId: existing.control.id, queueLen: r.queueLen } : r
  }
  const task = startJobByName('aidj.continuous', { songs, player, view: 'continuous' })
  if (!task) return { ok: false, error: '创建连续播放任务失败' }
  return { ok: true, taskId: task.id, queueLen: songs.length }
}

/** /discard_follows: drop queued-but-unplayed songs; keep the current track playing. */
export function clearContinuousPending(player: string): void {
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
export function replaceContinuousQueue(
  player: string,
  songs: PlaylistEntry[]
): { ok: boolean; error?: string; taskId?: string; queueLen?: number } {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  const existing = [...continuousTasks.values()].find((s) => samePlayer(s.playerKey, player))
  if (existing) {
    existing.queue = songs
    existing.index = 0
    existing.total = songs.length
    pushContinuousState(existing)
    return { ok: true, taskId: existing.control.id, queueLen: songs.length }
  }
  const task = startJobByName('aidj.continuous', { songs, player, view: 'continuous' })
  if (!task) return { ok: false, error: '创建连续播放任务失败' }
  return { ok: true, taskId: task.id, queueLen: songs.length }
}

registerJobHandler('aidj.chat', async (control, args) => {
  const initialPrompt = (args.prompt as string) || ''
  const history = (args.history ?? []) as ChatMessage[]
  const rollingHistoryArg = (args.rollingHistory ?? []) as string[]
  const playerArg = (args.player as string) || ''
  if (!initialPrompt) {
    control.pushLine('错误: 需要初始提示词', 'stderr')
    control.finish('error')
    return
  }

  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  setNcmBaseUrl(config.ncm_base_url)
  await ensureAidjDir()

  const lib = await loadLibrary()
  const missing = await findMissingSongs(lib.musicPaths, lib.metadata)
  if (missing.size > 0) {
    control.pushLine(`发现 ${missing.size} 首新歌曲，同步元数据中...`)
    const syncClient = new OpenAI({
      apiKey: config.secrets.api_key,
      baseURL: config.ai_settings.base_url
    })
    await syncMetadata(
      syncClient,
      missing,
      lib.metadata,
      config.ai_settings.metadata_model,
      config.preferences.metadata_concurrency
    )
  }

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })
  // Resolve __auto__ / empty to the currently active player so the push
  // matches the existing continuous task (which is keyed by the concrete name).
  const player =
    playerArg && playerArg !== '__auto__'
      ? playerArg
      : await getCurrentPlayerKey().catch(() => config.preferences.dbus_target || 'vlc')

  const sessionId = await SessionManager.createSession({
    title: initialPrompt.slice(0, 40),
    type: 'chat'
  })
  const session = new PersistentSession(
    client,
    lib.metadata,
    lib.musicPaths,
    config,
    null,
    initialPrompt
  )
  session.sessionId = sessionId
  if (Array.isArray(history) && history.length) {
    session.chatHistory = history.map((m) => ({ ...m }))
    // Persist seeded history as raw lines (user → type='user', assistant → type='both' with playlist).
    await SessionManager.appendMessages(
      sessionId,
      history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          content: m.content,
          ts: m.timestamp,
          type: m.role === 'assistant' ? 'both' : 'user',
          playlist: m.playlist
        }))
    )
  }
  if (Array.isArray(rollingHistoryArg) && rollingHistoryArg.length) {
    session.rollingHistory = rollingHistoryArg.slice(0, 100)
  }

  const ac = new AbortController()
  const st: ChatTaskState = { session, player, control }
  chatTasks.set(control.id, st)
  control.setCancel(() => {
    ac.abort()
    chatTasks.delete(control.id)
    session.stop()
  })

  // Replay seeded history into the view.
  for (const m of session.chatHistory) {
    const t = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'
    control.push({
      data: {
        type: t,
        content: m.content,
        history: true
      }
    })
    if (m.playlist && m.playlist.length > 0) {
      control.push({ data: { type: 'playlist', songs: m.playlist, history: true } })
    }
  }

  control.push({ data: { type: 'state', message: 'started', player, prompt: initialPrompt } })
  control.pushLine(`持续会话已启动 → ${player}`)
  control.push({
    data: {
      type: 'chat_status',
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      context: 0,
      contextCompletion: 0,
      memory: session.rollingHistory.length
    }
  })

  const REFILL = 8
  const FETCH_TIMEOUT = 180_000
  let fetchAc = new AbortController()
  st.abortFetch = () => fetchAc.abort()
  let lastErrorShown = ''
  let lastIntroShown = ''

  const fetchWithTimeout = async (): Promise<void> => {
    fetchAc.abort()
    fetchAc = new AbortController()
    const t = setTimeout(() => fetchAc.abort(), FETCH_TIMEOUT)
    let retryStart = 0
    try {
      await session.fetchBatch(
        AbortSignal.any([ac.signal, fetchAc.signal]),
        (attempt, _waitMs, err) => {
          retryStart = retryStart || Date.now()
          const elapsed = Math.round((Date.now() - retryStart) / 1000)
          const errMsg = err ? String(err instanceof Error ? err.message : err) : ''
          control.push({
            data: {
              type: 'retry',
              attempt,
              elapsed,
              content: `重试中(${attempt}: 已经${elapsed}s)${errMsg ? `\n⚠️ ${errMsg}` : ''}`
            }
          })
        }
      )
    } finally {
      clearTimeout(t)
    }
  }

  try {
    while (!ac.signal.aborted) {
      try {
        const cont = findContinuousByPlayer(st.player)
        const queueLen = cont ? cont.total - cont.index : 0

        // Refill when the queue is low — or immediately when the user sent a
        // new message (/discard_follows), regardless of the batch threshold.
        if ((queueLen < REFILL || st.forceFetch) && !session.working) {
          st.forceFetch = false
          control.push({ data: { type: 'thinking' } })
          try {
            await fetchWithTimeout()
          } finally {
            control.push({ data: { type: 'idle' } })
            control.push({ data: { type: 'retry_clear' } })
            control.push({
              data: {
                type: 'chat_status',
                promptTokens: session.promptTokens,
                completionTokens: session.completionTokens,
                tokens: session.promptTokens + session.completionTokens,
                context: session.lastPromptTokens,
                contextCompletion: session.lastCompletionTokens,
                memory: session.rollingHistory.length
              }
            })
          }

          const batch = session.buffer.shift()
          if (batch && batch.length) {
            if (session.lastIntro) {
              if (session.lastIntro.startsWith('⚠️')) {
                if (session.lastIntro !== lastErrorShown) {
                  lastErrorShown = session.lastIntro
                  control.push({ data: { type: 'system', content: session.lastIntro } })
                }
              } else if (session.lastIntro !== lastIntroShown) {
                lastIntroShown = session.lastIntro
                control.push({ data: { type: 'assistant', content: session.lastIntro } })
              }
            }
            control.push({ data: { type: 'playlist', songs: batch } })
            // A user-directed /discard_follows generation REPLACES the pending
            // queue once the new songs are ready (never clears it beforehand).
            const r = st.replaceQueueOnNext
              ? replaceContinuousQueue(st.player, batch)
              : ensureContinuousPlayer(st.player, batch)
            st.replaceQueueOnNext = false
            if (r.ok) {
              control.pushLine(`推送 ${batch.length} 首到连续播放`)
            } else {
              control.push({
                data: { type: 'system', content: `推送歌单失败: ${r.error ?? '未知错误'}` }
              })
              control.pushLine(`推送歌单失败: ${r.error ?? ''}`, 'stderr')
              break
            }
          } else if (session.lastIntro) {
            if (session.lastIntro.startsWith('⚠️')) {
              if (session.lastIntro !== lastErrorShown) {
                lastErrorShown = session.lastIntro
                control.push({ data: { type: 'system', content: session.lastIntro } })
              }
            } else if (session.lastIntro !== lastIntroShown) {
              lastIntroShown = session.lastIntro
              control.push({ data: { type: 'assistant', content: session.lastIntro } })
            }
          }
        }

        await sleep(1000)
      } catch (e) {
        if (ac.signal.aborted) break
        log.error('chat loop error', { error: String(e) })
        const errMsg = `⚠️ API 错误: ${String(e)}`
        if (errMsg !== lastErrorShown) {
          lastErrorShown = errMsg
          control.push({ data: { type: 'system', content: errMsg } })
        }
        control.pushLine(`错误: ${String(e)}`, 'stderr')
        await sleep(5000)
      }
    }
  } finally {
    chatTasks.delete(control.id)
  }

  control.pushLine('持续会话已结束')
  control.finish('exited')
})

// ---------------------------------------------------------------------------
// aidj.title — 异步自动生成会话标题（后台作业，不阻塞 IPC）。
// 前台经 background.job / btJob('aidj.title', { sessionId }) 触发。
// 完成时 push({ data: { type: 'title', sessionId, title } })，
// 渲染端监听 cockpit:bt 的 output 消息即可收到新标题。
// ---------------------------------------------------------------------------
registerJobHandler('aidj.title', async (control, args) => {
  const sessionId = (args.sessionId as string) || ''
  if (!sessionId) {
    control.pushLine('错误: 缺少 sessionId', 'stderr')
    control.finish('error')
    return
  }

  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  const raw = await SessionManager.readRawHistory(sessionId)
  if (!raw.length) {
    control.pushLine('会话为空或不存在', 'stderr')
    control.finish('error')
    return
  }

  control.pushLine(`正在为会话生成标题 (${raw.length} 条记录)...`)

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  // 只取“用户说了什么”作为命名依据，AI DJ 的推荐内容仅作背景。
  const transcript = raw
    .filter((m) => m.type === 'user' || m.type === 'both')
    .map((m) => {
      const content = m.content.split(SEPARATOR)[0].trim()
      return m.type === 'both' ? `AI DJ: ${content}` : `用户: ${content}`
    })
    .join('\n')
    .slice(0, 3000)

  let title = ''
  try {
    const resp = await client.chat.completions.create(
      {
        model: config.preferences.model,
        messages: [
          {
            role: 'system',
            content:
              '你是 AI 音乐电台 (AIDJ) 的会话标题命名助手。AI DJ 会接收用户的点歌/氛围需求，用一段引入语推荐一组歌曲歌单。\n' +
              '你的任务：只根据【用户】发送的内容理解其核心意图/话题来命名，不要用 AI DJ 推荐的歌单内容命名。\n' +
              '要求：长度不超过 20 字；不要引号、句号等标点；直接输出标题本身。'
          },
          {
            role: 'user',
            content:
              `以下是该 AIDJ 会话的对话记录（"用户"是点歌/氛围需求，"AI DJ"是歌单推荐与播音）：\n\n` +
              `${transcript || '(空)'}\n\n请输出标题：`
          }
        ],
        max_tokens: 60,
        temperature: 0.7
      },
      { timeout: 30_000 }
    )
    title = (resp.choices[0]?.message?.content ?? '')
      .replace(/^["'「『【《]+|["'」』】》\s]+$/g, '')
      .trim()
  } catch (e) {
    log.warn('Session title generation failed', { sessionId, error: String(e) })
    control.pushLine(`标题生成失败: ${e instanceof Error ? e.message : String(e)}`, 'stderr')
    control.finish('error')
    return
  }

  if (!title) {
    control.pushLine('AI 未能生成标题', 'stderr')
    control.finish('error')
    return
  }

  const changed = await SessionManager.renameSession(sessionId, title.slice(0, 40))
  if (changed === null) {
    control.pushLine('会话不存在', 'stderr')
    control.finish('error')
    return
  }
  log.info('Session title generated', { sessionId, title })
  control.pushLine(`标题已生成: ${title}`)
  control.push({ data: { type: 'title', sessionId, title } })
  control.finish('exited')
})

// ---------------------------------------------------------------------------
// aidj.metadata-sync — 后台扫描曲库，为缺失元数据的歌曲生成元数据并写入
// music_metadata.jsonl。与 AIDJ 参考实现的 sync_metadata 逻辑一致
// (NCM 搜索歌词 → AI 提取 language/emotion/genre/loudness/review → 追加 JSONL)。
// 任务 name 固定为 'AIDJ 元数据同步'，用于渲染端/命令的去重检测。
// ---------------------------------------------------------------------------
registerJobHandler('aidj.metadata-sync', async (control) => {
  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }
  setNcmBaseUrl(config.ncm_base_url)
  await ensureAidjDir()

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  control.pushLine('扫描曲库中...')
  const lib = await loadLibrary()
  // loadLibrary 可能返回过期缓存（新文件在缓存建立之后才加入磁盘）。
  // 重新扫描磁盘，并把新歌就地合并进共享的 musicPaths map —— 这样引用同一
  // map 的主会话等所有消费者都能立刻看到新歌，metadata 也保持只增不减。
  const fresh = await scanMusicFiles(config.music_folders ?? [])
  let added = 0
  for (const [name, path] of fresh) {
    if (!lib.musicPaths.has(name)) {
      lib.musicPaths.set(name, path)
      added++
    }
  }
  if (added > 0) control.pushLine(`在磁盘上发现 ${added} 首新歌曲`)
  const missing = await findMissingSongs(lib.musicPaths, lib.metadata)
  if (!missing.size) {
    control.pushLine('没有需要更新的歌曲元数据')
    control.finish('exited')
    return
  }

  const total = missing.size
  const model = config.ai_settings.metadata_model
  const concurrency = config.preferences.metadata_concurrency
  control.pushLine(
    `发现 ${total} 首歌曲缺少元数据，使用 ${model} 开始同步 (并发 ${concurrency})...`
  )

  const { counts } = await syncMetadata(
    client,
    missing,
    lib.metadata,
    model,
    concurrency,
    (p) => {
      control.setProgress(Math.round((p.done / p.total) * 100))
      const marker = `[${p.done}/${p.total}] ${p.name}`
      if (p.status === 'ok') {
        control.pushLine(marker)
        control.pushLine(`    ✓ NCM 命中 id=${p.sid ?? ''}，歌词 ${p.lyricLen ?? 0} 字`)
        control.pushLine(`    ✓ ${JSON.stringify(p.meta)}`)
      } else if (p.status === 'noLyric') {
        control.pushLine(`${marker} ⚠ NCM 未找到匹配`)
      } else if (p.status === 'networkError') {
        control.pushLine(`${marker} ✗ ${p.error ?? 'NCM API 连接失败'}`, 'stderr')
      } else {
        control.pushLine(
          `${marker} ✗ AI 提取失败${p.error ? `: ${p.error}` : ''} (NCM id=${p.sid ?? ''})`,
          'stderr'
        )
      }
    },
    lib.lyrics
  )

  if (counts.networkError > 0) {
    control.pushLine(
      `⚠️ NCM API 不可用 (${counts.networkError} 首请求失败)，请检查 ncm_base_url 或启动 NeteaseCloudMusicApi 服务`,
      'stderr'
    )
  }
  control.pushLine(
    `元数据同步完成: 成功 ${counts.ok}，未找到歌词 ${counts.noLyric}，提取失败 ${counts.failed}` +
      (counts.networkError ? `，网络错误 ${counts.networkError}` : '')
  )
  control.push({ data: { type: 'metadata_sync_done', synced: counts.ok } })
  control.finish('exited')
})
