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
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  initDbusManager,
  setPersistentSession,
  PersistentSession,
  DBusManager,
  LoudnessCache,
  bumpFrequency
} from './service'
import OpenAI from 'openai'
import type { SongMeta, PlaylistEntry, ChatMessage, LoudnessInfo } from './types'

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
    metadata = await syncMetadata(
      client,
      missing,
      metadata,
      config.ai_settings.metadata_model,
      config.preferences.metadata_concurrency
    )
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
}

const chatTasks = new Map<string, ChatTaskState>()

export function getChatTask(taskId: string): ChatTaskState | undefined {
  return chatTasks.get(taskId)
}

export function getChatTasks(): ChatTaskState[] {
  return [...chatTasks.values()]
}

/** Live-switch the player a chat session pushes songs to. */
export function setChatPlayer(taskId: string, player: string): { ok: boolean; error?: string } {
  const st = chatTasks.get(taskId)
  if (!st) return { ok: false, error: '持续会话未运行' }
  if (!player || player === '__auto__') {
    st.player = '__auto__'
  } else {
    st.player = player
  }
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

/** Immediate lookup of a continuous task bound to `player`. */
function findContinuousByPlayer(player: string): ContinuousTaskState | undefined {
  return [...continuousTasks.values()].find((s) => s.playerKey === player)
}

/** Push a playlist to the player: enqueue to an existing continuous task, else create one. */
function ensureContinuousPlayer(
  player: string,
  songs: PlaylistEntry[]
): { ok: boolean; taskId?: string; queueLen?: number; error?: string } {
  if (!songs.length) return { ok: false, error: '没有歌曲可推送' }
  const existing = [...continuousTasks.values()].find((s) => s.playerKey === player)
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
  const st = [...continuousTasks.values()].find((s) => s.playerKey === player)
  if (!st) return
  st.queue = st.current ? [st.current] : []
  st.index = st.queue.length
  st.total = st.queue.length
  pushContinuousState(st)
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
  const player =
    playerArg && playerArg !== '__auto__' ? playerArg : config.preferences.dbus_target || 'vlc'

  const session = new PersistentSession(
    client,
    lib.metadata,
    lib.musicPaths,
    config,
    null,
    initialPrompt
  )
  if (Array.isArray(history) && history.length) {
    session.chatHistory = history.map((m) => ({ ...m }))
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
      memory: session.rollingHistory.length
    }
  })

  const REFILL = 8
  const FETCH_TIMEOUT = 180_000
  let fetchAc = new AbortController()
  let lastErrorShown = ''

  const fetchWithTimeout = async (): Promise<void> => {
    fetchAc.abort()
    fetchAc = new AbortController()
    const t = setTimeout(() => fetchAc.abort(), FETCH_TIMEOUT)
    let retryStart = 0
    try {
      await session.fetchBatch(AbortSignal.any([ac.signal, fetchAc.signal]), (attempt, _waitMs, err) => {
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
      })
    } finally {
      clearTimeout(t)
    }
  }

  try {
    while (!ac.signal.aborted) {
      try {
        const cont = findContinuousByPlayer(st.player)
        const queueLen = cont ? cont.total - cont.index : 0

        if (queueLen < REFILL && !session.working) {
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
memory: session.rollingHistory.length
              }
            })
          }

          const batch = session.buffer.shift()
          if (batch && batch.length) {
            if (session.lastIntro) {
              control.push({ data: { type: 'assistant', content: session.lastIntro } })
            }
            control.push({ data: { type: 'playlist', songs: batch } })
            const r = ensureContinuousPlayer(st.player, batch)
            if (r.ok) {
              control.pushLine(`推送 ${batch.length} 首到连续播放`)
            } else {
              control.push({
                data: { type: 'system', content: `推送歌单失败: ${r.error ?? '未知错误'}` }
              })
              control.pushLine(`推送歌单失败: ${r.error ?? ''}`, 'stderr')
              break
            }
          } else if (session.lastIntro && session.lastIntro.startsWith('⚠️')) {
            if (session.lastIntro !== lastErrorShown) {
              lastErrorShown = session.lastIntro
              control.push({ data: { type: 'system', content: session.lastIntro } })
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
