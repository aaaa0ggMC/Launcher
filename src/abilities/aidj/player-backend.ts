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
  LoudnessCache,
  bumpFrequency
} from './service'
import type { PlayerStatus } from './types'

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

  // -- continuous-playback auxiliaries (mirror `aidj.continuous` semantics) ---
  private volbalEnabled = false
  private volbalMethod: 'lufs' | 'linear' = 'lufs'
  private volbalCurve = 3.0
  private volCache: LoudnessCache | null = null
  /** volbal anchor established (first track measured). */
  private volbalActive = false
  private recordFreq = false
  private lastTrackPath: string | null = null

  async connect(): Promise<boolean> {
    this.connected = true
    await this.syncPrefs()
    log.info('WebPlayerBackend activated')
    return true
  }

  /** Load the shared volbal / recordFreq preferences into the web backend. */
  async syncPrefs(): Promise<void> {
    const config = await loadAidjConfig()
    this.volbalEnabled = config?.preferences.dynamic_balance_volume ?? false
    this.volbalMethod = config?.preferences.sound_adjust_method ?? 'lufs'
    // HTML5 <audio>.volume is LINEAR amplitude (f(v) = v), so the volume_curve
    // knob — tuned for external MPRIS players' non-linear (≈cubic) response —
    // must be neutralized here: curve 1.0 → computeVolume = baseVol * gain,
    // i.e. true linear loudness balance.
    this.volbalCurve = 1.0
    this.recordFreq = config?.preferences.record_freq ?? false
    this.volCache = new LoudnessCache(this.volbalMethod, this.volbalCurve)
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
      queueTracks: state.queueTracks
    }
    if (typeof state.queueIndex === 'number') this.queueIndex = state.queueIndex
    if (typeof state.queueTotal === 'number') this.queueTotal = state.queueTotal
    // Track-change side effects: record play frequency + apply loudness balance
    // (the engine auto-advances, so the backend watches the reported track).
    const path = state.path ?? null
    if (path && path !== this.lastTrackPath) {
      this.lastTrackPath = path
      if (this.recordFreq && state.track) {
        void bumpFrequency([state.track]).catch(() => {})
      }
      if (this.volbalEnabled) void this.applyVolbal(path)
    }
  }

  /** Per-track loudness balance: first track establishes the anchor at 0.5,
   *  subsequent tracks adjust relative to it (LoudnessCache via ffprobe). */
  private async applyVolbal(path: string): Promise<void> {
    const cache = this.volCache
    if (!cache) return
    if (!this.volbalActive) {
      const anchor = await cache.setAnchor(path, 0.5)
      if (anchor != null) {
        this.volbalActive = true
        await this.setVolume(0.5)
        log.info('web volbal anchor', { path, anchor, method: this.volbalMethod })
      }
    } else {
      const v = await cache.targetVolume(path)
      if (v != null) {
        await this.setVolume(v)
        log.debug('web volbal adjust', { path, target: v })
      }
    }
  }

  /** Live-configure volbal (toggle/method) and re-apply to the current track. */
  async setVolbal(enabled: boolean, method?: 'lufs' | 'linear'): Promise<boolean> {
    this.volbalEnabled = enabled
    if (method && method !== this.volbalMethod) {
      this.volbalMethod = method
      this.volCache = new LoudnessCache(method, this.volbalCurve)
      this.volbalActive = false
    }
    if (!this.volbalEnabled) return true
    // Re-apply immediately to the currently playing track.
    const current = this.lastDetail.track
    const path = this.lastTrackPath
    if (path && current) {
      if (!this.volbalActive) {
        const anchor = await this.volCache?.setAnchor(path, 0.5)
        if (anchor != null) {
          this.volbalActive = true
          await this.setVolume(0.5)
        }
      } else {
        const v = await this.volCache?.targetVolume(path)
        if (v != null) await this.setVolume(v)
      }
    }
    return true
  }

  /** Volbal state snapshot for the player page. */
  getVolbalState(): {
    enabled: boolean
    method: string
    anchor: number | null
    baseVolume: number
  } {
    return {
      enabled: this.volbalEnabled,
      method: this.volbalMethod,
      anchor: this.volCache?.anchorVal ?? null,
      baseVolume: this.volCache?.baseVolume ?? 0.5
    }
  }

  /** Anchor repositioning: make the given volume the new base of the balance
   *  curve (the "50% reference"), keeping the anchor — mirror of
   *  `aidj.continuous-rebase`'s `setContinuousBaseVol`. */
  async rebase(baseVol: number): Promise<boolean> {
    this.volCache?.setBaseVol(Math.max(0.05, Math.min(1, baseVol)))
    log.info('web volbal rebase', { baseVol, anchor: this.volCache?.anchorVal ?? null })
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

  async sendFiles(paths: string[], opts?: { append?: boolean }): Promise<boolean> {
    if (!paths.length) return false
    // Resolve library names for the queue (the engine advances by itself);
    // fall back to the file basename when the path isn't in the library.
    const lib = await loadLibrary().catch(() => null)
    const pathToName = new Map<string, string>()
    if (lib) {
      for (const [name, p] of lib.musicPaths) pathToName.set(p, name)
    }
    const songs = paths.map((p) => ({
      name: pathToName.get(p) ?? basename(p).replace(/\.[^.]+$/, ''),
      path: p,
      url: audioUrl(p)
    }))
    this.emit({ type: opts?.append ? 'enqueue' : 'playlist', songs })
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
    this.emit({ type: 'trim' })
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
    this.emit({ type: 'volume', volume: v })
    return true
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
