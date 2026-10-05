import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LoudnessInfo } from '../types'

const execFileAsync = promisify(execFile)

/**
 * Measure one file's loudness (integrated LUFS + true peak via ebur128, mean /
 * max via volumedetect). Module-level so callers outside the player (metadata
 * sync, backfill) can reuse it without a cache instance. Returns null when
 * ffmpeg is missing / fails or nothing could be parsed.
 */
export async function analyzeLoudness(filepath: string): Promise<LoudnessInfo | null> {
  try {
    const [lufsOut, volOut] = await Promise.all([
      runFfmpeg(filepath, ['-af', 'ebur128=peak=true', '-f', 'null', '-']),
      runFfmpeg(filepath, ['-af', 'volumedetect', '-f', 'null', '-'])
    ])

    const summary = lufsOut.slice(lufsOut.lastIndexOf('Summary:'))
    const lufsMatch = summary.match(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
    const peakMatch = summary.match(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/)
    const integratedLufs = lufsMatch ? Number(lufsMatch[1]) : null
    const truePeak = peakMatch ? Number(peakMatch[1]) : null

    const meanMatch = volOut.match(/mean_volume:\s+(-?\d+(?:\.\d+)?)\s+dB/)
    const maxMatch = volOut.match(/max_volume:\s+(-?\d+(?:\.\d+)?)\s+dB/)
    const meanDb = meanMatch ? Number(meanMatch[1]) : null
    const maxDb = maxMatch ? Number(maxMatch[1]) : null

    const peakDb = truePeak ?? maxDb
    if (integratedLufs == null && meanDb == null) return null
    return {
      peak_db: peakDb,
      rms_db: meanDb,
      integrated_lufs: integratedLufs
    }
  } catch {
    return null
  }
}

function runFfmpeg(filepath: string, args: string[]): Promise<string> {
  return execFileAsync('ffmpeg', ['-hide_banner', '-nostats', '-vn', '-i', filepath, ...args], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024
  }).then(({ stderr }) => stderr || '')
}

export class LoudnessCache {
  private cache = new Map<string, LoudnessInfo | null>()
  private _anchorVal: number | null = null
  private _baseVol = 0.5
  private method: string
  private curve: number

  constructor(method = 'lufs', curve = 3.0) {
    this.method = method
    this.curve = curve
  }

  get anchorVal(): number | null {
    return this._anchorVal
  }

  get baseVolume(): number {
    return this._baseVol
  }

  async get(filepath: string): Promise<LoudnessInfo | null> {
    if (this.cache.has(filepath)) return this.cache.get(filepath) ?? null
    const info = await analyzeLoudness(filepath)
    this.cache.set(filepath, info)
    return info
  }

  preAnalyze(filepath: string): void {
    if (!this.cache.has(filepath)) {
      this.get(filepath).catch(() => {})
    }
  }

  /** @deprecated use the module-level `analyzeLoudness` */
  analyzeLoudness(filepath: string): Promise<LoudnessInfo | null> {
    return analyzeLoudness(filepath)
  }

  loudnessKey(info: LoudnessInfo | null): number | null {
    if (!info) return null
    if (this.method === 'lufs' && info.integrated_lufs != null) {
      return info.integrated_lufs
    }
    return info.rms_db
  }

  /**
   * Compute the target MPRIS volume for `songVal`. Returns null when there is
   * no anchor or no usable measurement.
   */
  computeVolume(songVal: number | null): number | null {
    if (this._anchorVal == null || songVal == null) return null
    const dbDiff = this._anchorVal - songVal
    const gain = 10 ** (dbDiff / 20)
    const anchorAmp = this._baseVol ** this.curve
    const linearTarget = anchorAmp * gain
    const compensated = linearTarget ** (1 / Math.max(this.curve, 0.1))
    return Math.max(0.05, Math.min(1.0, compensated))
  }

  /** Establish the anchor from `filepath`. `measure` can be injected (tests). */
  async setAnchor(
    filepath: string,
    baseVol = 0.5,
    measure?: (path: string) => Promise<LoudnessInfo | null>
  ): Promise<number | null> {
    this._baseVol = baseVol
    const info = measure ? await measure(filepath) : await this.get(filepath)
    const val = this.loudnessKey(info)
    if (val == null) return null
    this._anchorVal = val
    return val
  }

  setAnchorValue(val: number, baseVol = 0.5): void {
    this._anchorVal = val
    this._baseVol = baseVol
  }

  setBaseVol(base: number): void {
    this._baseVol = base
  }

  async targetVolume(filepath: string): Promise<number | null> {
    if (this._anchorVal == null) return null
    const info = await this.get(filepath)
    const songVal = this.loudnessKey(info)
    return this.computeVolume(songVal)
  }
}

/** Loudness-balance side effects the state machine needs from its host. */
export interface VolBalHooks {
  /** Measure one track (null when ffprobe is missing / fails). */
  measure: (path: string) => Promise<LoudnessInfo | null>
  /** Push a target volume to the player. */
  setVolume: (vol: number) => Promise<void> | void
  /** Optional diagnostics hook (the host's scoped logger). */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/**
 * Per-track loudness balance state machine (shared by the built-in web player
 * and, through the same semantics, the continuous carousel).
 *
 * Rules:
 * - the FIRST measured track establishes the anchor, at the current base
 *   volume (the user's "50% reference", 0.5 by default, moved by a rebase);
 * - later tracks get `base * 10^((anchor - song)/20)` (with the host's curve);
 * - the base volume lands IMMEDIATELY when no anchor exists yet — measuring
 *   takes seconds, and the player would otherwise start at its own default;
 * - re-reading the persisted config (`configure` with the same method) must
 *   NOT drop the anchor: only a real method change rebuilds the measurement
 *   cache and re-anchors.
 */
export class VolBal {
  private enabled = false
  private method: 'lufs' | 'linear' = 'lufs'
  private cache: LoudnessCache | null = null
  private cacheMethod: 'lufs' | 'linear' | null = null
  private active = false
  private base = 0.5

  constructor(private readonly hooks: VolBalHooks) {}

  get isEnabled(): boolean {
    return this.enabled
  }

  get anchor(): number | null {
    return this.cache?.anchorVal ?? null
  }

  get baseVolume(): number {
    return this.base
  }

  /** Persisted preferences (called on every backend connect / toggle). Same
   *  method → the anchor and any rebase are preserved. */
  configure(enabled: boolean, method?: 'lufs' | 'linear', curve = 1.0): void {
    this.enabled = enabled
    if (method && method !== this.method) {
      this.method = method
      this.cache = null
      this.cacheMethod = null
      this.active = false
    }
    if (!this.cache || this.cacheMethod !== this.method) {
      this.cache = new LoudnessCache(this.method, curve)
      this.cacheMethod = this.method
      this.cache.setBaseVol(this.base)
    }
  }

  /** Make `base` the new reference volume and recompute the CURRENT track. */
  async rebase(base: number): Promise<void> {
    this.base = Math.max(0.05, Math.min(1, base))
    this.cache?.setBaseVol(this.base)
    this.hooks.log?.('info', 'volbal rebase', { base: this.base, anchor: this.anchor })
  }

  /** Apply the balance to `path` (track change / enable / rebase / bring-up). */
  async apply(path: string): Promise<void> {
    if (!this.enabled) return
    const cache = this.cache
    if (!cache) return
    if (!this.active) {
      // Land the reference volume first: the measurement takes seconds.
      await this.hooks.setVolume(this.base)
      const anchor = await cache.setAnchor(path, this.base, this.hooks.measure)
      if (anchor != null) {
        this.active = true
        this.hooks.log?.('info', 'volbal anchor', {
          path,
          anchor,
          method: this.method,
          base: this.base
        })
      } else {
        this.hooks.log?.('warn', 'volbal anchor failed: loudness measurement unavailable', {
          path
        })
      }
      return
    }
    const info = await this.hooks.measure(path)
    const songVal = info ? (this.method === 'lufs' ? info.integrated_lufs : info.rms_db) : null
    const target = songVal == null ? null : cache.computeVolume(songVal)
    if (target != null) {
      await this.hooks.setVolume(target)
      this.hooks.log?.('info', 'volbal adjust', { path, target, base: this.base })
    } else {
      this.hooks.log?.('warn', 'volbal adjust skipped: loudness measurement unavailable', {
        path
      })
    }
  }

  /** Snapshot for the player UI. */
  state(): { enabled: boolean; method: string; anchor: number | null; baseVolume: number } {
    return {
      enabled: this.enabled,
      method: this.method,
      anchor: this.anchor,
      baseVolume: this.base
    }
  }
}
