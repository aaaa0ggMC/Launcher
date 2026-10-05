import { makeLogger } from '../../main/process/logger'
import { getBroadcast } from '../../main/process/broadcast'
import { listTasks, stopTask } from '../../main/process/background-tasks'
import { setAbilityEnabled } from '../../main/process/ability-runtime'
import { audioUrl } from '../../main/process/audio-protocol'
import { basename } from 'path'
import {
  DBusManager,
  getDbusManager,
  setDbusManager,
  initDbusManager,
  loadAidjConfig,
  saveAidjConfig,
  loadLibrary,
  analyzeLoudness,
  VolBal,
  bumpFrequency,
  findEqProfile
} from './service'
import { EQ_BAND_COUNT } from './types'
import type { PlayerStatus } from './types'
import { recordSongTimeline } from './song-timeline'

const log = makeLogger('aidj-player')

/**
 * Playback backend abstraction (docs/abilities/aidj/player-backend-plan.md M1).
 *
 * Every backend fills the SAME unified state model (`PlayerStatus` /
 * `PlaybackDetail`) and the same control surface, so the command layer and the
 * UI never branch on `isDbus`. `DBusBackend` wraps the shared MPRIS manager —
 * a thin 1:1 forward, so in dbus mode behavior (and thus the UI) is byte-for-
 * byte identical to the pre-abstraction code. `WebPlayerBackend` is the built-in
 * HTML5-audio backend; its real audio pipeline lands in M2, so for M1 it only
 * fills the empty state model and logs.
 */

export type PlayerBackendMode = 'dbus' | 'web'

export type PlayerControlCommand = 'next' | 'prev' | 'play' | 'pause' | 'toggle' | 'stop'

/** Tag applied to "playback control" background tasks — the mode switch stops
 *  exactly those (persistent carousel / continuous / chat push), while
 *  data-class tasks (metadata sync / downloads) keep running. */
export const PLAYBACK_TAG = 'aidj-playback'

/** Legacy job handler names that are also playback-control (belt & suspenders
 *  for tasks started before tags existed, e.g. via `background.job`). */
const PLAYBACK_JOB_NAMES = ['aidj.persistent', 'aidj.continuous', 'aidj.chat']

/** Unified playback snapshot — the richer form the desktop-lyrics window needs. */
export interface PlaybackDetail {
  ok: boolean
  status: PlayerStatus['status']
  track: string
  artist: string
  album: string
  positionMs: number | null
  lengthMs: number | null
  /** raw media url / `file://` — used to resolve the exact file path */
  url: string
  /** software volume 0–1 (web backend only; MPRIS has its own Volume prop) */
  volume?: number | null
  /** built-in player queue (web backend only) */
  queueIndex?: number
  queueTotal?: number
  queueTracks?: string[]
  /** playback rate 0.5–2 (web only) */
  playbackRate?: number
  /** AB-loop points in seconds, null = unset (web only) */
  loopA?: number | null
  loopB?: number | null
  /** ms until the sleep timer fires (null = off) */
  sleepRemainMs?: number | null
  /** crossfade fade-in/out between tracks */
  crossfade?: boolean
  crossfadeSeconds?: number
  /** EQ preset id (flat/pop/rock/classical/vocal or user profile id) */
  eqPreset?: string
  /** Current per-band EQ gains (dB), length 10. */
  eqGains?: number[]
  /** Volbal state snapshot (web backend or config fallback). */
  volbal?: {
    enabled: boolean
    method: string
    anchor: number | null
    baseVolume: number
  }
}

/** State the renderer web-player engine reports up (extends PlaybackDetail). */
export interface WebPlayerReport {
  ok?: boolean
  status: PlayerStatus['status']
  track: string
  path: string | null
  positionMs: number | null
  lengthMs: number | null
  volume: number | null
  /** 0-based index of the currently-playing track in the engine queue (-1 = none). */
  queueIndex?: number
  queueTotal?: number
  queueTracks?: string[]
  playbackRate?: number
  loopA?: number | null
  loopB?: number | null
  sleepRemainMs?: number | null
  crossfade?: boolean
  crossfadeSeconds?: number
  eqPreset?: string
  eqGains?: number[]
  /** Random id of the reporting engine instance — a new id = a freshly
   *  created engine (page reload / App relaunch) that needs the prefs pushed. */
  engineId?: string
}

/** One queued song as the renderer engine receives it. */
interface WebPlayerSong {
  name: string
  path: string
  url: string
  emotion?: unknown
}

/** Backend-neutral contract every playback mode implements. */
export interface PlayerBackend {
  readonly mode: PlayerBackendMode
  readonly displayName: string
  /** whether this backend is usable on the current platform */
  readonly supported: boolean
  connect(): Promise<boolean>
  disconnect(): void
  getStatus(): Promise<PlayerStatus>
  getPlaybackDetail(): Promise<PlaybackDetail>
  control(command: PlayerControlCommand): Promise<boolean>
  /** absolute seek to a position in ms (MPRIS Seek is relative — computed here) */
  seek(positionMs: number): Promise<boolean>
  /** `append` (web only): push onto the existing queue instead of replacing it. */
  sendFiles(paths: string[], opts?: { append?: boolean }): Promise<boolean>
  getVolume(): Promise<number | null>
  setVolume(vol: number): Promise<boolean>
}

/** MPRIS / session-DBus backend — a 1:1 wrapper over the shared DBusManager. */
export class DBusBackend implements PlayerBackend {
  readonly mode = 'dbus' as const
  readonly displayName = '外部播放器 (MPRIS)'
  readonly supported = process.platform === 'linux'

  constructor(private readonly mgr: DBusManager) {}

  connect(): Promise<boolean> {
    // The manager is already bound by initDbusManager (lazily via ensureInit /
    // the mode switch). connect() is a no-op to keep dbus behavior unchanged.
    return Promise.resolve(true)
  }

  disconnect(): void {
    this.mgr.disconnect()
  }

  getStatus(): Promise<PlayerStatus> {
    return this.mgr.getStatus()
  }

  getPlaybackDetail(): Promise<PlaybackDetail> {
    return this.mgr.getPlaybackDetail()
  }

  control(command: PlayerControlCommand): Promise<boolean> {
    return this.mgr.control(command)
  }

  seek(positionMs: number): Promise<boolean> {
    return this.mgr.seekTo(positionMs)
  }

  sendFiles(paths: string[], _opts?: { append?: boolean }): Promise<boolean> {
    void _opts // dbus MPRIS replaces its playlist; append is web-only
    return this.mgr.sendFiles(paths)
  }

  getVolume(): Promise<number | null> {
    return this.mgr.getVolume()
  }

  setVolume(vol: number): Promise<boolean> {
    return this.mgr.setVolume(vol)
  }
}

/**
 * Built-in HTML5 `<audio>` backend. The actual media element + AudioContext
 * pipeline + `navigator.mediaSession` live in the RENDERER
 * (`web-player/engine.ts`) — this main-process side is its control + state
 * half: it forwards control commands via the `cockpit:aidj-webplayer`
 * broadcast and stores the state the engine reports up (`aidj.web-player-report`).
 */
export class WebPlayerBackend implements PlayerBackend {
  readonly mode = 'web' as const
  readonly displayName = '内置播放器'
  readonly supported = true

  private connected = false
  private lastStatus: PlayerStatus = { status: 'Unknown', track: '', volume: null, player: 'web' }
  private lastDetail: PlaybackDetail = {
    ok: false,
    status: 'Unknown',
    track: '',
    artist: '',
    album: '',
    positionMs: null,
    lengthMs: null,
    url: ''
  }
  private queueIndex = -1
  private queueTotal = 0
  /** Mirror of the engine queue (playlist / enqueue / trim / clear), so a
   *  freshly created engine — the Android App relaunched while the host kept
   *  running — can be handed the queue back instead of showing a stale
   *  "Playing" it can't actually play. */
  private queue: WebPlayerSong[] = []
  /** false once the engine's reported queue length disagrees with the mirror. */
  private queueValid = true
  private lastPositionMs = 0
  /** Engine instances seen so far (each gets the prefs pushed once). */
  private knownEngines = new Set<string>()
  private lastReporter: { id: string; at: number; status: string } | null = null
  /** Last volume we asked the engine for (manual or volbal) — handed to the
   *  next engine instead of resetting it to the default. */
  private intendedVol: number | null = null
  private lastPrefsFixAt = 0

  // -- continuous-playback auxiliaries (mirror `aidj.continuous` semantics) ---
  private volbal = new VolBal({
    measure: (path) => analyzeLoudness(path),
    setVolume: (v) => void this.setVolume(v),
    log: (level, msg, data) => {
      if (level === 'warn') log.warn(msg, data)
      else log.info(msg, data)
    }
  })
  private recordFreq = false
  private lastTrackPath: string | null = null
  /** Persisted default volume — pushed to a freshly created engine (which
   *  starts at its own hardcoded 0.8) when loudness balance is off. */
  private defaultVol = 0.8

  // -- M4 playback features (forwarded to the renderer engine) ---------------
  private crossfadeEnabled = false
  private crossfadeSeconds = 2.5
  private eqPreset = 'flat'
  private playbackRate = 1.0

  async connect(): Promise<boolean> {
    this.connected = true
    await this.syncPrefs()
    log.info('WebPlayerBackend activated')
    return true
  }

  /** Load the shared volbal / recordFreq preferences into the web backend. */
  async syncPrefs(): Promise<void> {
    const config = await loadAidjConfig()
    this.volbal.configure(
      config?.preferences.dynamic_balance_volume ?? false,
      config?.preferences.sound_adjust_method ?? 'lufs'
    )
    this.recordFreq = config?.preferences.record_freq ?? false
    // M4 prefs.
    this.crossfadeEnabled = config?.preferences.crossfade?.enabled ?? false
    this.crossfadeSeconds = config?.preferences.crossfade?.seconds ?? 2.5
    this.eqPreset = config?.preferences.eq_preset ?? 'flat'
    this.playbackRate = config?.preferences.playback_rate ?? 1.0
    const defaultVol = config?.preferences.default_volume ?? 0.8
    this.defaultVol = defaultVol
    if (this.lastStatus.volume == null) this.lastStatus.volume = defaultVol
    if (this.lastDetail.volume == null) this.lastDetail.volume = defaultVol
    // Push the persisted feature prefs into the renderer engine (if any is up —
    // an engine created later gets them in `bringUp`). Volume is NOT re-pushed
    // here: every aidj.save-config lands here and would reset the user's volume.
    await this.pushPrefs()
  }

  /** Push crossfade / EQ / rate to the engine(s). */
  private async pushPrefs(): Promise<void> {
    this.emit({ type: 'crossfade', enabled: this.crossfadeEnabled, seconds: this.crossfadeSeconds })
    this.emit({ type: 'eq', gains: await this.eqGainsFor(this.eqPreset) })
    this.emit({ type: 'rate', rate: this.playbackRate })
  }

  /**
   * A new engine instance came up (first page load, reload, App relaunch).
   * It starts with its own hardcoded defaults (crossfade off, 0.8 volume, flat
   * EQ) and missed every pref broadcast sent before it existed — the old
   * "came back after 75s offline" check never fired for a quick relaunch.
   */
  private bringUp(id: string, path: string | null): void {
    this.knownEngines.add(id)
    log.info('web player engine up', { engineId: id, path })
    void this.pushPrefs()
    // Volume it SHOULD be at, so the first track never starts loud: the volbal
    // target when loudness balance is on, else the last volume we set.
    if (this.volbal.isEnabled && (path ?? this.lastTrackPath)) {
      void this.volbal.apply((path ?? this.lastTrackPath) as string)
    } else {
      void this.setVolume(this.intendedVol ?? this.defaultVol)
    }
  }

  /** Resolve an EQ profile id → gains (unknown id falls back to flat). */
  private async eqGainsFor(id: string): Promise<number[]> {
    const profile = await findEqProfile(id)
    if (profile) return profile.gains
    const flat = await findEqProfile('flat')
    return flat?.gains ?? Array(EQ_BAND_COUNT).fill(0)
  }

  disconnect(): void {
    this.connected = false
    this.lastStatus = { status: 'Unknown', track: '', volume: null, player: 'web' }
    this.lastDetail = { ...this.lastDetail, ok: false, status: 'Unknown', track: '' }
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** Store a state report pushed up by the renderer engine. */
  report(state: WebPlayerReport): void {
    const engineId = typeof state.engineId === 'string' ? state.engineId : null
    // Reports without an id (shouldn't happen) fall back to the old heuristic.
    const engineJustCameUp = engineId ? !this.knownEngines.has(engineId) : !this.engineOnline
    this.lastEngineSeen = Date.now()
    if (engineId) this.lastReporter = { id: engineId, at: Date.now(), status: state.status }
    this.lastStatus = {
      status: state.status,
      track: state.track ?? '',
      volume: typeof state.volume === 'number' ? state.volume : null,
      player: 'web'
    }
    this.lastDetail = {
      ok: true,
      status: state.status,
      track: state.track ?? '',
      artist: '',
      album: '',
      positionMs: state.positionMs,
      lengthMs: state.lengthMs,
      url: state.path ? `file://${state.path}` : '',
      volume: typeof state.volume === 'number' ? state.volume : null,
      queueIndex: state.queueIndex,
      queueTotal: state.queueTotal,
      queueTracks: state.queueTracks,
      playbackRate: state.playbackRate,
      loopA: state.loopA,
      loopB: state.loopB,
      sleepRemainMs: state.sleepRemainMs,
      // The backend owns these prefs (persisted config); the engine only echoes.
      crossfade: this.crossfadeEnabled,
      crossfadeSeconds: this.crossfadeSeconds,
      eqPreset: this.eqPreset,
      eqGains: state.eqGains,
      volbal: this.getVolbalState()
    }
    // An engine that disagrees with the backend's prefs (it was created after
    // they were broadcast, or missed one) gets them again — at most once a second.
    const prefsDrift =
      (typeof state.crossfade === 'boolean' && state.crossfade !== this.crossfadeEnabled) ||
      (typeof state.crossfadeSeconds === 'number' &&
        state.crossfadeSeconds !== this.crossfadeSeconds) ||
      (typeof state.playbackRate === 'number' && state.playbackRate !== this.playbackRate)
    if (prefsDrift && !engineJustCameUp && Date.now() - this.lastPrefsFixAt > 1000) {
      this.lastPrefsFixAt = Date.now()
      this.emit({
        type: 'crossfade',
        enabled: this.crossfadeEnabled,
        seconds: this.crossfadeSeconds
      })
      this.emit({ type: 'rate', rate: this.playbackRate })
    }
    // An empty engine (just created, nothing restored yet) must not wipe the
    // queue mirror's cursor.
    if (typeof state.queueTotal === 'number' && state.queueTotal > 0) {
      if (typeof state.queueIndex === 'number') this.queueIndex = state.queueIndex
      this.queueTotal = state.queueTotal
      if (state.queueTotal !== this.queue.length) this.queueValid = false
      if (typeof state.positionMs === 'number') this.lastPositionMs = state.positionMs
    }
    // Track-change side effects: record play frequency + apply loudness balance
    // (the engine auto-advances, so the backend watches the reported track).
    const path = state.path ?? null
    if (engineJustCameUp) {
      if (engineId) this.bringUp(engineId, path)
      else if (this.volbal.isEnabled) void this.volbal.apply(path ?? this.lastTrackPath ?? '')
      else void this.setVolume(this.intendedVol ?? this.defaultVol)
    }
    if (path && path !== this.lastTrackPath) {
      this.lastTrackPath = path
      if (state.track) {
        void recordSongTimeline(state.track).catch(() => {})
      }
      if (this.recordFreq && state.track) {
        void bumpFrequency([state.track]).catch(() => {})
      }
      if (this.volbal.isEnabled) void this.volbal.apply(path)
    }
  }

  /** Volbal state snapshot for the player page. */
  getVolbalState(): {
    enabled: boolean
    method: string
    anchor: number | null
    baseVolume: number
  } {
    return this.volbal.state()
  }

  /** Live-configure volbal (toggle/method) and re-apply to the current track. */
  async setVolbal(enabled: boolean, method?: 'lufs' | 'linear'): Promise<boolean> {
    this.volbal.configure(enabled, method ?? (this.volbal.state().method as 'lufs' | 'linear'))
    if (!this.volbal.isEnabled) return true
    // Re-apply to the currently playing track right away — enabling used to do
    // nothing until the next track change.
    const path = this.lastTrackPath
    if (path) await this.volbal.apply(path)
    return true
  }

  /** Anchor repositioning: make the given volume the new base of the balance
   *  curve (the "50% reference"), keeping the anchor — mirror of
   *  `aidj.continuous-rebase`'s `setContinuousBaseVol`. The CURRENT track is
   *  recomputed right away (it used to only take effect on the next track). */
  async rebase(baseVol: number): Promise<boolean> {
    await this.volbal.rebase(baseVol)
    if (this.volbal.isEnabled && this.volbal.anchor != null && this.lastTrackPath) {
      await this.volbal.apply(this.lastTrackPath)
    }
    return true
  }

  /** Engine queue snapshot — used by the persistent/continuous chat refill
   *  logic (`total - index` = tracks still to play). */
  getQueueState(): { index: number; total: number } | null {
    if (!this.lastDetail.ok || this.queueTotal <= 0) return null
    return { index: this.queueIndex, total: this.queueTotal }
  }

  async getStatus(): Promise<PlayerStatus> {
    return { ...this.lastStatus }
  }

  async getPlaybackDetail(): Promise<PlaybackDetail> {
    return { ...this.lastDetail }
  }

  private emit(payload: Record<string, unknown>): void {
    getBroadcast()('cockpit:aidj-webplayer', payload)
  }

  // ---- 迟到的播放器引擎也能接上 ----
  // 引擎（渲染端 <audio>）只在打开过播放器 / AIDJ 页面后才存在；之前广播的播放指令没人收就丢了
  // （AI 调 aidj.send 返回 ok，却什么都没放）。没有在线引擎时把最近一次换歌单 / 追加记下来，
  // 引擎创建时（及每 30s 心跳）经 aidj.web-player-hello 取走。
  private lastEngineSeen = 0
  private pending: { type: 'playlist' | 'enqueue'; songs: unknown[] } | null = null
  private static readonly ENGINE_TTL_MS = 75_000

  /** 有引擎在最近 75 秒内打过招呼 / 上报过状态 */
  get engineOnline(): boolean {
    return Date.now() - this.lastEngineSeen < WebPlayerBackend.ENGINE_TTL_MS
  }

  /**
   * 引擎打招呼：记为在线，交出排队中的指令（只交给第一个来取的引擎，避免多个页面一起放）。
   * 新创建、队列为空的引擎（App 退出重进 / 页面刷新，宿主一直在跑）拿回上一次的队列：
   * 停在原来的歌和进度上、暂停，点播放就能接着放——之前页面只显示宿主残留的
   * 「Playing」，新引擎里却什么都没有，点什么都放不出来。
   */
  hello(engineId?: string, empty?: boolean): Record<string, unknown> | null {
    this.lastEngineSeen = Date.now()
    const fresh = !!engineId && !this.knownEngines.has(engineId)
    const p = this.pending
    this.pending = null
    const restore = !p && fresh && empty === true ? this.restoreCommand() : null
    if (fresh) {
      const restorePath = (restore?.songs as WebPlayerSong[] | undefined)?.[
        restore?.index as number
      ]?.path
      this.bringUp(engineId as string, restorePath ?? null)
    }
    if (restore) {
      log.info('web player queue restored into new engine', {
        engineId,
        index: restore.index,
        total: (restore.songs as unknown[]).length,
        positionMs: restore.positionMs
      })
    }
    return p ?? restore
  }

  /** The queue to hand a fresh empty engine, or null when there is nothing
   *  trustworthy to restore / another engine is still actively playing it. */
  private restoreCommand(): Record<string, unknown> | null {
    if (!this.queueValid || !this.queue.length) return null
    const index = this.queueIndex
    const song = this.queue[index]
    if (!song || song.path !== this.lastTrackPath) return null
    // A live engine elsewhere (another tab) is still playing: don't double up.
    const r = this.lastReporter
    if (r && r.status === 'Playing' && Date.now() - r.at < 3000) return null
    return {
      type: 'restore',
      songs: this.queue,
      index,
      positionMs: this.lastPositionMs
    }
  }

  async sendFiles(paths: string[], opts?: { append?: boolean }): Promise<boolean> {
    if (!paths.length) return false
    // Resolve library names for the queue (the engine advances by itself);
    // fall back to the file basename when the path isn't in the library.
    const lib = await loadLibrary().catch(() => null)
    const pathToName = new Map<string, string>()
    if (lib) {
      for (const [name, p] of lib.musicPaths) pathToName.set(p, name)
    }
    const songs = paths.map((p) => {
      const name = pathToName.get(p) ?? basename(p).replace(/\.[^.]+$/, '')
      return {
        name,
        path: p,
        url: audioUrl(p),
        emotion: lib?.metadata.get(name)?.emotion ?? null
      }
    })
    const type = opts?.append ? 'enqueue' : 'playlist'
    if (type === 'playlist') {
      this.queue = [...songs]
      this.queueValid = true
    } else {
      this.queue.push(...songs)
    }
    if (!this.engineOnline) {
      // 没有在线引擎：排队，等播放器页面打开时取走（追加合并进排队中的歌单）
      this.pending =
        type === 'enqueue' && this.pending
          ? { type: this.pending.type, songs: [...this.pending.songs, ...songs] }
          : { type, songs }
    }
    this.emit({ type, songs })
    log.info('WebPlayerBackend.sendFiles', {
      count: songs.length,
      append: opts?.append === true
    })
    return true
  }

  async control(command: PlayerControlCommand): Promise<boolean> {
    this.emit({ type: command })
    return true
  }

  /** Clear queued-but-unplayed songs (trim after the cursor) — the current
   *  track + play history stay so prev keeps working. */
  async trimQueue(): Promise<boolean> {
    if (this.queueIndex >= 0) this.queue = this.queue.slice(0, this.queueIndex + 1)
    this.emit({ type: 'trim' })
    return true
  }

  /** Fully clear the queue (web only): stop playback and drop every track. */
  async clearQueue(): Promise<boolean> {
    this.lastDetail = { ...this.lastDetail, ok: false, status: 'Stopped', track: '' }
    this.queueIndex = -1
    this.queueTotal = 0
    this.queue = []
    this.queueValid = true
    this.emit({ type: 'clear' })
    return true
  }

  async seek(positionMs: number): Promise<boolean> {
    this.emit({ type: 'seek', positionMs })
    return true
  }

  async getVolume(): Promise<number | null> {
    return this.lastStatus.volume
  }

  async setVolume(vol: number): Promise<boolean> {
    const v = Math.max(0, Math.min(1, vol))
    this.lastStatus.volume = v
    this.intendedVol = v
    this.emit({ type: 'volume', volume: v })
    return true
  }

  // -- M4: crossfade / EQ / playback rate / AB loop / sleep timer -------------

  async setCrossfade(enabled: boolean, seconds?: number): Promise<void> {
    this.crossfadeEnabled = enabled
    if (seconds != null && seconds > 0) this.crossfadeSeconds = seconds
    this.emit({ type: 'crossfade', enabled, seconds: this.crossfadeSeconds })
  }

  /** Apply an EQ curve directly (per-band gains, dB). Used for live preview
   *  while editing; the persisted profile id is set separately via `setEqPreset`. */
  async setEQ(gains: number[]): Promise<void> {
    this.emit({ type: 'eq', gains: gains.slice(0, EQ_BAND_COUNT) })
  }

  /** Track which profile id the current curve belongs to (for state/reporting). */
  setEqPreset(id: string): void {
    this.eqPreset = id
  }

  async setRate(rate: number): Promise<void> {
    // Any positive rate — the engine falls back to silent turbo fast-forward
    // beyond the element's native cap (16x).
    this.playbackRate = Math.max(0.0625, rate)
    this.emit({ type: 'rate', rate: this.playbackRate })
  }

  async setAbloop(a?: number | null, b?: number | null): Promise<void> {
    this.emit({ type: 'abloop', a: a ?? null, b: b ?? null })
  }

  async setSleep(minutes: number): Promise<void> {
    this.emit({ type: 'sleep', minutes })
  }
}

// ---------------------------------------------------------------------------
// Mode registry + hot-switch
// ---------------------------------------------------------------------------

let _mode: PlayerBackendMode | null = null
let _activeBackend: PlayerBackend | null = null
let _webBackend: WebPlayerBackend | null = null

/** The web backend singleton (created lazily) — the report command and the
 *  mode registry share it so state never forks between instances. */
export function getWebPlayerBackend(): WebPlayerBackend {
  if (!_webBackend) _webBackend = new WebPlayerBackend()
  return _webBackend
}

/** Platform default: Linux gets the external-player (DBus) toggle; other
 *  platforms are web-only. */
export function defaultPlayerMode(): PlayerBackendMode {
  return process.platform === 'linux' ? 'dbus' : 'web'
}

/** Resolve the active backend mode (persisted in config, cached after first load). */
export async function getPlayerMode(): Promise<PlayerBackendMode> {
  if (_mode) return _mode
  // Non-Linux platforms have no session DBus — always the built-in player,
  // regardless of any stale `player_mode` in a migrated config.
  if (process.platform !== 'linux') {
    _mode = 'web'
    return _mode
  }
  const config = await loadAidjConfig()
  const saved = config?.preferences?.player_mode
  _mode = saved === 'dbus' || saved === 'web' ? saved : defaultPlayerMode()
  return _mode
}

/** Drop the cached mode + active backend wrapper so the next access re-reads
 *  the persisted config (used by `aidj.reload`). The web engine singleton is
 *  kept — its state is independent of the mode cache. */
export function resetPlayerMode(): void {
  _mode = null
  _activeBackend = null
}

/** The built-in player page (`aidj-player`) is MODE-BOUND: hidden from the
 *  sidebar in dbus mode, visible in web mode. Uses the ability-runtime enable
 *  registry so the sidebar + command layer react via the standard broadcast. */
export function reconcilePlayerAbilityVisibility(): void {
  void getPlayerMode().then((m) => {
    setAbilityEnabled('aidj-player', m === 'web')
  })
}

/** Get the backend for the current mode. In dbus mode this wraps the shared
 *  DBusManager singleton — null when no manager exists yet (mirrors the old
 *  "DBus 未连接" semantics). In web mode it lazily activates the WebPlayerBackend. */
export async function getActiveBackend(): Promise<PlayerBackend | null> {
  const mode = await getPlayerMode()
  if (mode === 'web') {
    const web = getWebPlayerBackend()
    if (!_activeBackend) {
      _activeBackend = web
      await _activeBackend.connect()
    }
    return _activeBackend
  }
  const mgr = getDbusManager()
  if (!mgr) return null
  _activeBackend = new DBusBackend(mgr)
  return _activeBackend
}

async function createBackend(mode: PlayerBackendMode): Promise<PlayerBackend | null> {
  if (mode === 'web') return getWebPlayerBackend()
  const config = await loadAidjConfig()
  if (!config) return null
  const mgr = await initDbusManager(config)
  return new DBusBackend(mgr)
}

/** Stop every running playback-control background task (tagged or legacy name). */
async function stopPlaybackTasks(): Promise<string[]> {
  const targets = listTasks().filter(
    (t) =>
      t.status === 'running' &&
      ((t.tags ?? []).includes(PLAYBACK_TAG) || PLAYBACK_JOB_NAMES.includes(t.name))
  )
  const stopped: string[] = []
  for (const t of targets) {
    try {
      if (await stopTask(t.id)) stopped.push(t.id)
    } catch (e) {
      log.warn('stop playback task failed', { id: t.id, error: String(e) })
    }
  }
  return stopped
}

/**
 * Hot-switch the playback backend without restarting the app:
 *   1. stop playback-control aidj background tasks (persistent/continuous/chat)
 *   2. release the old backend (DBusManager.disconnect() / WebPlayer teardown)
 *   3. activate the new backend
 *   4. persist the mode + broadcast `cockpit:aidj-mode` (UI updates mode ref)
 */
export async function setPlayerMode(target: PlayerBackendMode): Promise<{
  ok: boolean
  mode?: PlayerBackendMode
  stoppedTasks?: string[]
  error?: string
}> {
  if (target !== 'dbus' && target !== 'web') {
    return { ok: false, error: 'mode 必须是 dbus 或 web' }
  }
  if (target === 'dbus' && process.platform !== 'linux') {
    return { ok: false, error: '当前平台不支持 DBus 播放后端' }
  }
  const current = await getPlayerMode()
  if (current === target) return { ok: true, mode: target }

  // 1. tear down playback-control tasks
  const stoppedTasks = await stopPlaybackTasks()

  // 2. release the old backend
  if (_activeBackend) {
    try {
      _activeBackend.disconnect()
    } catch (e) {
      log.warn('old backend disconnect failed', { error: String(e) })
    }
    _activeBackend = null
  }
  if (current === 'dbus') {
    const mgr = getDbusManager()
    if (mgr) {
      try {
        mgr.disconnect()
      } catch (e) {
        log.warn('dbus manager disconnect failed', { error: String(e) })
      }
    }
    setDbusManager(null as unknown as DBusManager)
  }
  _mode = target

  // 3. activate the new backend
  const backend = await createBackend(target)
  if (backend) {
    _activeBackend = backend
    await backend.connect()
  }

  // 4. persist
  try {
    const config = await loadAidjConfig()
    if (config) {
      config.preferences.player_mode = target
      await saveAidjConfig(config)
    }
  } catch (e) {
    log.warn('persist player mode failed', { error: String(e) })
  }

  // 5. notify the UI
  getBroadcast()('cockpit:aidj-mode', { mode: target, stoppedTasks })
  // 6. built-in player page is mode-bound — show/hide it via the ability registry
  setAbilityEnabled('aidj-player', target === 'web')
  log.info('player backend switched', { from: current, to: target, stoppedTasks })
  return { ok: true, mode: target, stoppedTasks }
}
