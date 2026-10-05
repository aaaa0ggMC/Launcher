import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { readJson, writeJsonAtomicSerialized } from '../../../main/process/util'
import type { LoudnessInfo } from '../types'
import { analyzeLoudness } from './loudness'

interface Entry {
  /** `size:mtime` of the file when measured — a changed file is re-measured. */
  sig: string
  info: LoudnessInfo
}

/**
 * Persistent loudness measurements for the built-in player's volume balance.
 *
 * Measuring is a full ffmpeg decode — seconds per song on a desktop, far more
 * on a phone (Termux) — and the player used to re-measure every track on every
 * play, so the balanced volume landed long after the song started (or never,
 * when the user skipped on). Results are kept on disk; measurements run one at
 * a time (parallel decodes only make each of them slower) and concurrent
 * requests for the same file share one run, so prefetching the next track is
 * cheap.
 */
export class LoudnessStore {
  private entries = new Map<string, Entry>()
  private inflight = new Map<string, Promise<LoudnessInfo | null>>()
  private chain: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly file: string,
    private readonly measure: (path: string) => Promise<LoudnessInfo | null> = analyzeLoudness
  ) {}

  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        if (!existsSync(this.file)) return
        const raw = await readJson<Record<string, Entry>>(this.file)
        for (const [path, e] of Object.entries(raw ?? {})) {
          if (e && typeof e.sig === 'string' && e.info) this.entries.set(path, e)
        }
      })().catch(() => {})
    }
    return this.loading
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void writeJsonAtomicSerialized(this.file, Object.fromEntries(this.entries)).catch(() => {})
    }, 2000)
  }

  private static async signature(path: string): Promise<string | null> {
    const st = await stat(path).catch(() => null)
    return st ? `${st.size}:${Math.floor(st.mtimeMs)}` : null
  }

  /** Cached (instant) result, or null when the file still needs measuring. */
  async cached(path: string): Promise<LoudnessInfo | null> {
    await this.load()
    const e = this.entries.get(path)
    if (!e) return null
    return e.sig === (await LoudnessStore.signature(path)) ? e.info : null
  }

  async get(path: string): Promise<LoudnessInfo | null> {
    const hit = await this.cached(path)
    if (hit) return hit
    const running = this.inflight.get(path)
    if (running) return running
    const run = (async () => {
      const sig = await LoudnessStore.signature(path)
      if (!sig) return null
      // Serialized behind any measurement already running.
      const job = this.chain.then(() => this.measure(path))
      this.chain = job.catch(() => {})
      const info = await job.catch(() => null)
      if (info) {
        this.entries.set(path, { sig, info })
        this.scheduleSave()
      }
      return info
    })()
    this.inflight.set(path, run)
    try {
      return await run
    } finally {
      this.inflight.delete(path)
    }
  }

  /** Measure in the background (e.g. the next queued track) — no-op when cached. */
  prefetch(path: string): void {
    void this.get(path).catch(() => {})
  }
}
