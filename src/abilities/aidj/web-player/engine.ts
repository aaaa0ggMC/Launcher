/**
 * Renderer-side web player engine — the HTML5 half of the aidj built-in
 * player (player-backend-plan.md M2, M4). The main-process `WebPlayerBackend`
 * is its control+state half: it receives `cockpit:aidj-webplayer` broadcasts
 * and reports playback state up via `aidj.web-player-report`.
 *
 * Playback is a hidden `<audio>` element routed through a Web Audio graph
 * (`MediaElementAudioSourceNode → EQ biquads → master gain → analyser →
 * destination`). Routing through the graph unlocks the M4 audio pipeline:
 * crossfade (fade out/in between tracks, emotion-aware duration), EQ presets,
 * real-time spectrum, while `<audio>.volume` keeps software volume (volbal).
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
  /** `emotion` metadata of the song — drives emotion-aware crossfade duration. */
  emotion?: string | null
}

type EngineCommand =
  | { type: 'playlist'; songs: WebPlayerSong[] }
  | { type: 'enqueue'; songs: WebPlayerSong[] }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'trim' }
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'seek'; positionMs: number }
  | { type: 'volume'; volume: number }
  | { type: 'rate'; rate: number }
  | { type: 'abloop'; a?: number | null; b?: number | null }
  | { type: 'sleep'; minutes: number }
  | { type: 'crossfade'; enabled: boolean; seconds?: number }
  | { type: 'eq'; preset: string }

type PlayerStatus = 'Playing' | 'Paused' | 'Stopped' | 'Unknown'

export type EqPreset = 'flat' | 'pop' | 'rock' | 'classical' | 'vocal'

const REPORT_THROTTLE_MS = 300
const RATE_MIN = 0.0625
/** Chromium's `HTMLMediaElement.playbackRate` caps at 16 — beyond that we fall
 *  back to a silent "turbo seek" fast-forward (see startTurbo). */
const TURBO_THRESHOLD = 16
const TURBO_TICK_MS = 50

/** Renderer→main debug logging (lands in the cockpit log pipeline, visible in
 *  the Logs ability). Debug only — remove once the audio issues are resolved. */
function dbg(...args: unknown[]): void {
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    window.cockpit
      ?.command('logs.post', { level: 'info', scope: 'web-player', message: msg })
      .catch(() => {})
  } catch {
    /* noop */
  }
}

/** Biquad EQ chain: low shelf + 3 peak + high shelf. Preset = per-band gain dB. */
const EQ_BANDS = [
  { type: 'lowshelf' as BiquadFilterType, frequency: 120, Q: 0.8 },
  { type: 'peaking' as BiquadFilterType, frequency: 350, Q: 1.0 },
  { type: 'peaking' as BiquadFilterType, frequency: 1000, Q: 1.0 },
  { type: 'peaking' as BiquadFilterType, frequency: 3000, Q: 1.0 },
  { type: 'highshelf' as BiquadFilterType, frequency: 8000, Q: 0.8 }
]

const EQ_PRESETS: Record<EqPreset, number[]> = {
  flat: [0, 0, 0, 0, 0],
  pop: [-1, 2, 1, 2, 1],
  rock: [3, 1, -1, 2, 3],
  classical: [2, 0, 0, 0, 2],
  vocal: [-1, 1, 3, 2, 0]
}

class WebPlayerEngine {
  private audio: HTMLAudioElement

  private queue: WebPlayerSong[] = []
  private index = -1
  /** Recently played songs (most-recent first) — survives queue replacement, so
   *  prev can still step back even after a new playlist/refill replaced the
   *  queue (the queue itself is never spliced, it's only swapped wholesale). */
  private history: WebPlayerSong[] = []
  private volume = 0.8
  private status: PlayerStatus = 'Unknown'
  private lengthMs = 0
  private lastReportAt = 0

  // -- M4 audio pipeline -----------------------------------------------------
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private eqFilters: BiquadFilterNode[] = []
  private eqPreset: EqPreset = 'flat'

  // -- M4 playback features --------------------------------------------------
  private playbackRate = 1.0
  /** AB-loop points in SECONDS (null = unset on that side). */
  private loopA: number | null = null
  private loopB: number | null = null
  /** Sleep timer: epoch ms when playback should pause (null = off). */
  private sleepUntil: number | null = null
  private sleepTimer: ReturnType<typeof setInterval> | null = null
  /** Crossfade: fade out → switch → fade in between tracks. */
  private crossfadeEnabled = false
  private crossfadeSeconds = 2.5
  /** Guard against re-entrant track switches during a fade. */
  private transitioning = false
  private pendingIndex: number | null = null

  constructor() {
    this.audio = document.createElement('audio')
    this.audio.preload = 'auto'
    this.audio.style.display = 'none'
    // Origin-clean fetch: the element is routed through a Web Audio
    // MediaElementAudioSourceNode, which outputs SILENCE unless the media is
    // CORS-opted-in. The cockpit-audio:// handler answers with ACAO:*.
    this.audio.crossOrigin = 'anonymous'
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
    this.audio.addEventListener('timeupdate', () => {
      this.checkAbloop()
      this.checkSleep()
      this.watchCtxState()
      this.scheduleReport()
    })
    this.audio.addEventListener('play', () => {
      this.status = 'Playing'
      dbg('audio play event, ctx.state=', this.ctx?.state, 'gain=', this.masterGain?.gain.value)
      void this.ctx?.resume()
      this.report()
    })
    this.audio.addEventListener('pause', () => {
      // Turbo fast-forward pauses the element on purpose — don't clobber the
      // 'Playing' state that startTurbo set.
      if (this.turboActive) return
      this.status = this.audio.ended ? 'Stopped' : 'Paused'
      dbg('audio pause event, ctx.state=', this.ctx?.state, 'gain=', this.masterGain?.gain.value)
      this.report()
    })
    this.audio.addEventListener('ended', () => {
      dbg('audio ended event')
      // AB loop with only the A point set → loop A..end on the same track.
      if (this.loopA != null && this.loopB == null && this.audio.duration) {
        this.audio.currentTime = this.loopA
        void this.resume()
        return
      }
      void this.next({ fade: true })
    })
    this.audio.addEventListener('loadedmetadata', () => {
      this.lengthMs = Number.isFinite(this.audio.duration)
        ? Math.round(this.audio.duration * 1000)
        : 0
      dbg('loadedmetadata, dur=', this.lengthMs, 'ctx.state=', this.ctx?.state)
      void this.updateMediaMetadata()
      this.report()
    })
    this.audio.addEventListener('error', () => {
      this.status = 'Stopped'
      dbg('audio ERROR event', {
        code: this.audio.error?.code,
        message: this.audio.error?.message,
        src: this.audio.src
      })
      this.report()
    })
  }

  // -------------------------------------------------------------------------
  // Web Audio graph (lazy — created on first play; autoplay is allowed so
  // resume() works without a gesture)
  // -------------------------------------------------------------------------
  private ensureGraph(): void {
    if (this.ctx) return
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const source = ctx.createMediaElementSource(this.audio)
    const master = ctx.createGain()
    master.gain.value = 1
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7

    // Build the EQ chain (all filters start at 0 dB → flat by default).
    const filters: BiquadFilterNode[] = []
    let node: AudioNode = source
    for (const band of EQ_BANDS) {
      const f = ctx.createBiquadFilter()
      f.type = band.type
      f.frequency.value = band.frequency
      f.Q.value = band.Q
      f.gain.value = 0
      node.connect(f)
      node = f
      filters.push(f)
    }
    node.connect(master)
    master.connect(analyser)
    analyser.connect(ctx.destination)

    this.ctx = ctx
    this.masterGain = master
    this.analyser = analyser
    this.eqFilters = filters
    this.applyEQ(this.eqPreset)
    dbg('graph created, ctx.state=', ctx.state)
    // A freshly created context can start suspended — kick it into 'running'
    // so first playback (which awaits the resume) isn't delayed.
    if (ctx.state === 'suspended') {
      void ctx.resume().then(
        () => dbg('graph created → resume() resolved, state=', ctx.state),
        (e) => dbg('graph created → resume() rejected', String(e))
      )
    }
  }

  /** Apply an EQ preset — each band's BiquadFilter gain is set in dB. */
  private applyEQ(preset: string): void {
    const p = (EQ_PRESETS[preset as EqPreset] ? preset : 'flat') as EqPreset
    this.eqPreset = p
    const gains = EQ_PRESETS[p]
    this.eqFilters.forEach((f, i) => {
      f.gain.setTargetAtTime(gains[i], this.ctx?.currentTime ?? 0, 0.02)
    })
  }

  // -------------------------------------------------------------------------
  // Crossfade helpers (fade out → switch → fade in, emotion-aware duration)
  // -------------------------------------------------------------------------
  private songEmotion(song: WebPlayerSong | undefined): string | null {
    const e = song?.emotion
    if (!e) return null
    return Array.isArray(e) ? e.join(',') : e
  }

  /** Emotion-aware fade length (seconds). 0 = no fade. */
  private fadeDurationFor(nextIndex: number): number {
    if (!this.crossfadeEnabled) return 0
    const a = this.songEmotion(this.queue[this.index])
    const b = this.songEmotion(this.queue[nextIndex])
    const base = Math.max(0.5, this.crossfadeSeconds)
    if (a && b) {
      // Same vibe → quick crossfade; mood shift → long, cinematic fade.
      return a === b ? base * 0.6 : base * 1.8
    }
    return base
  }

  private fadeGain(target: number, sec: number): void {
    const mg = this.masterGain
    const ctx = this.ctx
    if (!mg || !ctx) return
    const now = ctx.currentTime
    mg.gain.cancelScheduledValues(now)
    mg.gain.setValueAtTime(mg.gain.value, now)
    mg.gain.linearRampToValueAtTime(target, now + sec)
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Switch to `index`. Crossfade applies ONLY on automatic advancement (the
   * song ended) — a manual next/prev must respond instantly, not wait out a
   * 2.5s fade-out + 2.5s fade-in. Rapid taps coalesce: only the latest
   * requested index is applied (pendingIndex), so the fade isn't torn mid-way.
   */
  private async switchTo(index: number, opts?: { fade?: boolean }): Promise<void> {
    this.pendingIndex = index
    if (this.transitioning) return
    this.transitioning = true
    try {
      let idx: number | null = this.pendingIndex
      while (idx != null) {
        this.pendingIndex = null
        const fadeSec = opts?.fade ? this.fadeDurationFor(idx) : 0
        dbg(
          'switchTo idx=',
          idx,
          'fadeSec=',
          fadeSec,
          'crossfadeEnabled=',
          this.crossfadeEnabled,
          'currentIdx=',
          this.index
        )
        // Fade OUT the current track (let it finish ramping to 0 before the
        // src swap), then switch + resume + fade IN the next one.
        if (fadeSec > 0) {
          this.fadeGain(0, fadeSec)
          await this.wait(fadeSec * 1000)
        }
        this.index = idx
        this.loadTrack()
        void this.resume()
        if (fadeSec > 0) {
          this.fadeGain(1, fadeSec)
          await this.wait(fadeSec * 1000)
          void this.ctx?.resume()
        }
        idx = this.pendingIndex
      }
    } finally {
      this.transitioning = false
    }
  }

  // -------------------------------------------------------------------------
  // Command handling (from the main-process backend)
  // -------------------------------------------------------------------------
  private handleCommand(cmd: EngineCommand): void {
    if (!cmd || typeof cmd.type !== 'string') return
    dbg('engine command:', cmd.type, 'index=', this.index, 'paused=', this.audio.paused)
    switch (cmd.type) {
      case 'playlist':
        this.playList(cmd.songs ?? [])
        break
      case 'enqueue':
        this.enqueue(cmd.songs ?? [])
        break
      case 'play':
        void this.resume()
        break
      case 'pause':
        this.pausePlayback()
        break
      case 'toggle':
        // Turbo fast-forward keeps the element paused — treat it as "playing".
        if (this.turboActive || (this.audio.paused && this.queue.length)) void this.resume()
        else this.pausePlayback()
        break
      case 'next':
        void this.next()
        break
      case 'prev':
        void this.prev()
        break
      case 'trim':
        this.trimAfterCurrent()
        break
      case 'clear':
        this.clearQueue()
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
      case 'rate':
        this.setRate(cmd.rate)
        break
      case 'abloop':
        this.setAbloop(cmd.a ?? null, cmd.b ?? null)
        break
      case 'sleep':
        this.setSleep(cmd.minutes)
        break
      case 'crossfade':
        this.setCrossfade(cmd.enabled, cmd.seconds)
        break
      case 'eq':
        this.applyEQ(cmd.preset)
        this.report()
        break
    }
  }

  private playList(songs: WebPlayerSong[]): void {
    if (!songs.length) return
    this.ensureGraph()
    this.queue = songs
    void this.switchTo(0)
  }

  /** Append songs to the END of the queue — the current track keeps playing.
   *  Starts playback when nothing is loaded yet. */
  private enqueue(songs: WebPlayerSong[]): void {
    if (!songs.length) return
    const playing = this.index >= 0 && this.queue.length > 0
    this.queue.push(...songs)
    if (!playing) {
      this.ensureGraph()
      this.index = Math.max(0, this.index)
      this.loadTrack()
      void this.resume()
    }
    this.report()
  }

  private loadTrack(): void {
    const song = this.queue[this.index]
    if (!song) {
      this.stop()
      return
    }
    this.recordHistory(song)
    this.audio.src = song.url
    this.lengthMs = 0
    void this.updateMediaMetadata()
    this.report()
  }

  /** Push a played song to the front of the history stack (dedup by path). */
  private recordHistory(song: WebPlayerSong): void {
    const i = this.history.findIndex((h) => h.path === song.path)
    if (i >= 0) this.history.splice(i, 1)
    this.history.unshift(song)
    if (this.history.length > 50) this.history.length = 50
  }

  private async resume(): Promise<void> {
    if (!this.audio.src && this.queue.length) this.loadTrack()
    this.ensureGraph()
    // Chromium suspends the AudioContext after the element has been silent for
    // a while (long pause / no output). Playback through the graph is silent
    // until the context is running again — so await the resume BEFORE play().
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') {
      try {
        dbg('resume(): ctx suspended → awaiting resume()')
        await ctx.resume()
        dbg('resume(): ctx.resume() done, state=', ctx.state)
      } catch (e) {
        dbg('resume(): ctx.resume() REJECTED', String(e), 'state=', ctx.state)
        /* autoplay policy edge — retry below covers the fallback path */
      }
    }
    // Safety net: a crossfade that got interrupted (pause during fade) must
    // never leave the master gain muted — pull it back to unity on play.
    if (!this.transitioning && this.masterGain && this.masterGain.gain.value < 0.99) {
      dbg('resume(): restoring masterGain ', this.masterGain.gain.value, '→ 1')
      this.masterGain.gain.cancelScheduledValues(ctx?.currentTime ?? 0)
      this.masterGain.gain.value = 1
    }
    // >16x: the element can't play that fast — fast-forward silently instead.
    if (this.playbackRate > TURBO_THRESHOLD) {
      this.startTurbo()
      return
    }
    try {
      await this.audio.play()
      dbg('resume(): audio.play() resolved, paused=', this.audio.paused, 'ctx.state=', ctx?.state)
    } catch (e) {
      dbg('resume(): audio.play() REJECTED', String(e), 'paused=', this.audio.paused)
      // A seek or pause raced this play() (Chromium interrupts play() while
      // it is re-seeking). Retry once shortly after so playback isn't stuck.
      setTimeout(() => {
        if (!this.audio.src || this.audio.paused === false) return
        void this.ctx?.resume()
        this.audio.play().catch(() => {})
      }, 60)
    }
  }

  private async next(opts?: { fade?: boolean }): Promise<void> {
    if (this.index >= 0 && this.index < this.queue.length - 1) {
      await this.switchTo(this.index + 1, opts)
    } else {
      this.stop()
    }
  }

  private async prev(): Promise<void> {
    if (this.audio.currentTime > 3 || this.index <= 0) {
      this.audio.currentTime = 0
      return
    }
    await this.switchTo(this.index - 1)
  }

  /** "Clear the queue" — NOT a full wipe: keep the current track + the play
   *  history (queue[0..index]), drop everything after the cursor so prev keeps
   *  working. A full replace is a separate operation (playlist/playList). */
  private trimAfterCurrent(): void {
    if (this.index >= 0 && this.index < this.queue.length - 1) {
      this.queue = this.queue.slice(0, this.index + 1)
    }
    this.report()
  }

  /** Fully clear the queue — stop playback and drop every track (including the
   *  current one), so the player page's 「清空队列」 empties the whole list. */
  private clearQueue(): void {
    this.stopTurbo()
    this.queue = []
    this.index = -1
    this.history = []
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.lengthMs = 0
    this.status = 'Stopped'
    this.report()
  }

  private stop(): void {
    this.stopTurbo()
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
  // M4: playback speed / AB loop / sleep timer / crossfade config
  // -------------------------------------------------------------------------
  /** Requested rate — any positive number (the UI clamps nothing). */
  private setRate(rate: number): void {
    this.playbackRate = Math.max(RATE_MIN, rate)
    const playing = this.status === 'Playing' || this.turboActive
    if (this.playbackRate > TURBO_THRESHOLD) {
      // Beyond the element's native cap → silent turbo fast-forward.
      this.audio.playbackRate = TURBO_THRESHOLD
      if (playing) this.startTurbo()
      else this.stopTurbo()
    } else {
      this.audio.playbackRate = this.playbackRate
      if (this.turboActive) {
        this.stopTurbo()
        if (this.status === 'Playing') void this.resume()
      }
    }
    this.updatePositionState()
    this.report()
  }

  private turboTimer: ReturnType<typeof setInterval> | null = null
  private turboActive = false

  /** >16x: the element can't actually play that fast, so we scrub currentTime
   *  forward at `rate × realtime` — a silent fast-forward (nobody wants 100x
   *  chipmunk audio). Reaching the end auto-advances to the next track. */
  private startTurbo(): void {
    this.stopTurbo()
    this.turboActive = true
    this.audio.pause()
    this.turboTimer = setInterval(() => {
      const d = this.audio.duration
      if (!d || !Number.isFinite(d)) return
      const next = this.audio.currentTime + this.playbackRate * (TURBO_TICK_MS / 1000)
      if (next >= d) {
        this.audio.currentTime = d
        this.stopTurbo()
        void this.next()
        return
      }
      this.audio.currentTime = next
      // Unthrottled: at 100x the throttled report would lag by tens of seconds.
      this.report()
    }, TURBO_TICK_MS)
    this.status = 'Playing'
    this.report()
  }

  private stopTurbo(): void {
    this.turboActive = false
    if (this.turboTimer) {
      clearInterval(this.turboTimer)
      this.turboTimer = null
    }
  }

  /** Pause — also halts an active turbo fast-forward. */
  private pausePlayback(): void {
    if (this.turboActive) {
      this.stopTurbo()
      this.status = 'Paused'
    }
    this.audio.pause()
    this.report()
  }

  private setAbloop(a: number | null, b: number | null): void {
    const dur = this.audio.duration
    const clamp = (v: number | null): number | null =>
      v == null ? null : Math.min(Math.max(0, v), dur && dur > 0 ? dur : v)
    this.loopA = a == null ? null : clamp(a)
    this.loopB = b == null ? null : clamp(b)
    this.report()
  }

  private setSleep(minutes: number): void {
    if (this.sleepTimer) {
      clearInterval(this.sleepTimer)
      this.sleepTimer = null
    }
    if (minutes > 0) {
      this.sleepUntil = Date.now() + minutes * 60_000
      this.sleepTimer = setInterval(() => this.checkSleep(), 1000)
    } else {
      this.sleepUntil = null
    }
    this.report()
  }

  /** Sleep timer fired → pause playback and clear the timer. */
  private checkSleep(): void {
    if (this.sleepUntil == null) return
    if (Date.now() >= this.sleepUntil) {
      this.sleepUntil = null
      this.pausePlayback()
      this.report()
    }
  }

  /** AB loop: when B is reached, jump back to A (or 0). */
  private checkAbloop(): void {
    if (this.loopB == null) return
    const t = this.audio.currentTime
    if (t >= this.loopB) {
      this.audio.currentTime = this.loopA ?? 0
      this.scheduleReport()
    }
  }

  private setCrossfade(enabled: boolean, seconds?: number): void {
    this.crossfadeEnabled = enabled
    if (seconds != null && seconds > 0) this.crossfadeSeconds = seconds
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
    playbackRate: number
    loopA: number | null
    loopB: number | null
    sleepRemainMs: number | null
    crossfade: boolean
    crossfadeSeconds: number
    eqPreset: string
    /** Debug diagnostics — AudioContext state + master gain (silence hunter). */
    ctxState?: string
    masterGain?: number
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
      queueTracks: this.queue.map((s) => s.name),
      playbackRate: this.playbackRate,
      loopA: this.loopA,
      loopB: this.loopB,
      sleepRemainMs: this.sleepUntil ? Math.max(0, this.sleepUntil - Date.now()) : null,
      crossfade: this.crossfadeEnabled,
      crossfadeSeconds: this.crossfadeSeconds,
      eqPreset: this.eqPreset,
      ctxState: this.ctx?.state,
      masterGain: this.masterGain?.gain.value
    }
  }

  private report(): void {
    this.updatePositionState()
    window.cockpit.command('aidj.web-player-report', this.currentState()).catch(() => {})
  }

  /**
   * Watchdog: log every AudioContext state transition and auto-resume if it
   * silently drops to suspended while the element is playing (Chromium does
   * this after long silence; the graph then outputs nothing). Debug logging
   * also makes the state visible in the Logs ability.
   */
  private watchCtxState(): void {
    const ctx = this.ctx
    if (!ctx) return
    const prev = ctx.state
    if (prev !== this._lastCtxState) {
      this._lastCtxState = prev
      dbg('ctx.state →', prev, '(playing=', this.status === 'Playing', ')')
    }
    if (prev === 'suspended' && this.status === 'Playing') {
      dbg('ctx suspended while Playing — auto-resuming')
      void ctx.resume().then(
        () => dbg('watchdog resume() resolved, state=', ctx.state),
        (e) => dbg('watchdog resume() rejected', String(e))
      )
    }
  }
  private _lastCtxState: AudioContextState | '' = ''

  /** Keep the OS media card (SMTC / Now Playing / MPRIS) position in sync. */
  private updatePositionState(): void {
    if (!('mediaSession' in navigator)) return
    if (!this.queue[this.index]) return
    const d = this.audio.duration
    if (!d || !Number.isFinite(d)) return
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: this.playbackRate,
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
      ms.setActionHandler('play', () => void this.resume())
      ms.setActionHandler('pause', () => this.audio.pause())
      ms.setActionHandler('previoustrack', () => void this.prev())
      ms.setActionHandler('nexttrack', () => void this.next())
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
          playbackRate: this.playbackRate,
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

  // -------------------------------------------------------------------------
  // M4: spectrum — renderer UI reads the analyser to draw real-time bars.
  // -------------------------------------------------------------------------
  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }
}

let _engine: WebPlayerEngine | null = null

/** Create (once) and return the renderer web-player engine. */
export function ensureWebPlayerEngine(): WebPlayerEngine {
  if (!_engine) _engine = new WebPlayerEngine()
  return _engine
}
