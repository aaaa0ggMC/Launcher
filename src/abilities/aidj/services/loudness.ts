import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LoudnessInfo } from '../types'

const execFileAsync = promisify(execFile)

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
    const info = await this.analyzeLoudness(filepath)
    this.cache.set(filepath, info)
    return info
  }

  preAnalyze(filepath: string): void {
    if (!this.cache.has(filepath)) {
      this.get(filepath).catch(() => {})
    }
  }

  async analyzeLoudness(filepath: string): Promise<LoudnessInfo | null> {
    try {
      const [lufsOut, volOut] = await Promise.all([
        this.runFfmpeg(filepath, ['-af', 'ebur128=peak=true', '-f', 'null', '-']),
        this.runFfmpeg(filepath, ['-af', 'volumedetect', '-f', 'null', '-'])
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

  private async runFfmpeg(filepath: string, args: string[]): Promise<string> {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-vn', '-i', filepath, ...args],
      {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      }
    )
    return stderr || ''
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

  async setAnchor(filepath: string, baseVol = 0.5): Promise<number | null> {
    this._baseVol = baseVol
    const info = await this.get(filepath)
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
