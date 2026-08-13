/**
 * Renderer-side web player engine — the HTML5 half of the aidj built-in
 * player (player-backend-plan.md M2). The main-process `WebPlayerBackend` is
 * its control+state half: it receives `cockpit:aidj-webplayer` broadcasts and
 * reports playback state up via `aidj.web-player-report`.
 *
 * Playback is a plain hidden `<audio>` element (volume = software `audio.volume`).
 * The Web Audio graph (MediaElementAudioSourceNode → Gain → Analyser) is NOT
 * wired in yet: routing the element into a suspended/blocked AudioContext made
 * playback run silent (position advanced, no sound). Crossfade / EQ / spectrum
 * (M4) will re-route the element into the graph with proper `ctx.resume()`.
 *
 * Media keys: `navigator.mediaSession` — Chromium bridges it to the OS media
 * layer (Windows SMTC / macOS Now Playing / Linux MPRIS), so system media keys
 * and lock-screen controls work without per-platform code.
 *
 * The engine is a singleton created lazily by the AI DJ page (ChatView, which
 * is keep-alive). Once mounted it survives page switches and keeps playing.
 */

export interface WebPlayerSong {
  name: string
  path: string
  url: string
}

type EngineCommand =
  | { type: 'playlist'; songs: WebPlayerSong[] }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'stop' }
  | { type: 'seek'; positionMs: number }
  | { type: 'volume'; volume: number }

type PlayerStatus = 'Playing' | 'Paused' | 'Stopped' | 'Unknown'

const REPORT_THROTTLE_MS = 300

class WebPlayerEngine {
  private audio: HTMLAudioElement

  private queue: WebPlayerSong[] = []
  private index = -1
  private volume = 0.8
  private status: PlayerStatus = 'Unknown'
  private lengthMs = 0
  private lastReportAt = 0

  constructor() {
    this.audio = document.createElement('audio')
    this.audio.preload = 'auto'
    this.audio.style.display = 'none'
    this.audio.volume = this.volume
    document.body.appendChild(this.audio)
    this.bindEvents()
    this.setupMediaSession()
    // The engine is a module singleton that lives for the whole session — the
    // subscription is never torn down (unsubscribe reference intentionally
    // dropped; the instance outlives every page switch).
    window.cockpit?.on('cockpit:aidj-webplayer', (ev) => this.handleCommand(ev as EngineCommand))
  }

  // -------------------------------------------------------------------------
  // Media element events
  // -------------------------------------------------------------------------
  private bindEvents(): void {
    this.audio.addEventListener('timeupdate', () => this.scheduleReport())
    this.audio.addEventListener('play', () => {
      this.status = 'Playing'
      this.report()
    })
    this.audio.addEventListener('pause', () => {
      this.status = this.audio.ended ? 'Stopped' : 'Paused'
      this.report()
    })
    this.audio.addEventListener('ended', () => this.next())
    this.audio.addEventListener('loadedmetadata', () => {
      this.lengthMs = Number.isFinite(this.audio.duration)
        ? Math.round(this.audio.duration * 1000)
        : 0
      void this.updateMediaMetadata()
      this.report()
    })
    this.audio.addEventListener('error', () => {
      this.status = 'Stopped'
      this.report()
    })
  }

  // -------------------------------------------------------------------------
  // Command handling (from the main-process backend)
  // -------------------------------------------------------------------------
  private handleCommand(cmd: EngineCommand): void {
    if (!cmd || typeof cmd.type !== 'string') return
    switch (cmd.type) {
      case 'playlist':
        this.playList(cmd.songs ?? [])
        break
      case 'play':
        this.resume()
        break
      case 'pause':
        this.audio.pause()
        break
      case 'toggle':
        if (this.audio.paused && this.queue.length) this.resume()
        else this.audio.pause()
        break
      case 'next':
        this.next()
        break
      case 'prev':
        this.prev()
        break
      case 'stop':
        this.stop()
        break
      case 'seek':
        if (this.audio.duration && cmd.positionMs != null) {
          this.audio.currentTime = cmd.positionMs / 1000
          this.scheduleReport()
        }
        break
      case 'volume':
        this.setVolume(cmd.volume)
        break
    }
  }

  private playList(songs: WebPlayerSong[]): void {
    if (!songs.length) return
    this.queue = songs
    this.index = 0
    this.loadTrack()
    this.resume()
  }

  private loadTrack(): void {
    const song = this.queue[this.index]
    if (!song) {
      this.stop()
      return
    }
    this.audio.src = song.url
    this.lengthMs = 0
    void this.updateMediaMetadata()
    this.report()
  }

  private resume(): void {
    if (!this.audio.src && this.queue.length) this.loadTrack()
    this.audio.play().catch(() => {
      // A seek or pause raced this play() (Chromium interrupts play() while
      // it is re-seeking). Retry once shortly after so playback isn't stuck.
      setTimeout(() => {
        if (!this.audio.src || this.audio.paused === false) return
        this.audio.play().catch(() => {})
      }, 60)
    })
  }

  private next(): void {
    if (this.index >= 0 && this.index < this.queue.length - 1) {
      this.index++
      this.loadTrack()
      this.resume()
    } else {
      this.stop()
    }
  }

  private prev(): void {
    if (this.audio.currentTime > 3 || this.index <= 0) {
      this.audio.currentTime = 0
      return
    }
    this.index--
    this.loadTrack()
    this.resume()
  }

  private stop(): void {
    this.audio.pause()
    this.audio.currentTime = 0
    this.status = 'Stopped'
    this.report()
  }

  private setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    this.audio.volume = this.volume
    this.report()
  }

  // -------------------------------------------------------------------------
  // State reporting (renderer → main)
  // -------------------------------------------------------------------------
  private currentState(): {
    status: PlayerStatus
    track: string
    path: string | null
    positionMs: number
    lengthMs: number
    volume: number
    queueIndex: number
    queueTotal: number
    queueTracks: string[]
  } {
    const song = this.queue[this.index]
    return {
      status: this.status,
      track: song?.name ?? '',
      path: song?.path ?? null,
      positionMs: this.audio.currentTime ? Math.round(this.audio.currentTime * 1000) : 0,
      lengthMs: this.lengthMs,
      volume: this.volume,
      queueIndex: this.queue.length ? this.index : -1,
      queueTotal: this.queue.length,
      queueTracks: this.queue.map((s) => s.name)
    }
  }

  private report(): void {
    this.updatePositionState()
    window.cockpit.command('aidj.web-player-report', this.currentState()).catch(() => {})
  }

  /** Keep the OS media card (SMTC / Now Playing / MPRIS) position in sync. */
  private updatePositionState(): void {
    if (!('mediaSession' in navigator)) return
    if (!this.queue[this.index]) return
    const d = this.audio.duration
    if (!d || !Number.isFinite(d)) return
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: this.audio.playbackRate || 1,
        position: this.audio.currentTime || 0
      })
    } catch {
      /* noop */
    }
  }

  private scheduleReport(): void {
    const now = Date.now()
    if (now - this.lastReportAt < REPORT_THROTTLE_MS) return
    this.lastReportAt = now
    this.report()
  }

  // -------------------------------------------------------------------------
  // System media keys (navigator.mediaSession → SMTC / Now Playing / MPRIS)
  // -------------------------------------------------------------------------
  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    try {
      ms.setActionHandler('play', () => this.resume())
      ms.setActionHandler('pause', () => this.audio.pause())
      ms.setActionHandler('previoustrack', () => this.prev())
      ms.setActionHandler('nexttrack', () => this.next())
      ms.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) this.audio.currentTime = details.seekTime
      })
    } catch {
      /* some platforms reject some handlers — best effort */
    }
  }

  private async updateMediaMetadata(): Promise<void> {
    if (!('mediaSession' in navigator)) return
    const song = this.queue[this.index]
    let artwork: { src: string }[] = []
    if (song?.path) {
      const cover = await this.fetchCover(song.path)
      if (cover) artwork = [{ src: cover }]
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song?.name ?? '',
        artist: '',
        album: '',
        artwork
      })
      if (song && this.audio.duration && Number.isFinite(this.audio.duration)) {
        navigator.mediaSession.setPositionState({
          duration: this.audio.duration,
          playbackRate: this.audio.playbackRate || 1,
          position: this.audio.currentTime || 0
        })
      }
    } catch {
      /* noop */
    }
  }

  /** Local cover art (same-directory / embedded) resolved by the main process. */
  private async fetchCover(path: string): Promise<string | null> {
    const r = (await window.cockpit.command('aidj.get-cover', { path }).catch(() => null)) as {
      ok?: boolean
      url?: string
    } | null
    return r?.ok && r.url ? r.url : null
  }
}

let _engine: WebPlayerEngine | null = null

/** Create (once) and return the renderer web-player engine. */
export function ensureWebPlayerEngine(): WebPlayerEngine {
  if (!_engine) _engine = new WebPlayerEngine()
  return _engine
}
