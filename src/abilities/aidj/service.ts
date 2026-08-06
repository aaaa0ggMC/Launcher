import { readFile, readdir, mkdir, appendFile } from 'fs/promises'
import { join, extname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import OpenAI from 'openai'
import { makeLogger } from '../../main/process/logger'
import { USER_CONFIG_DIR, abilityConfigPath } from '../../main/process/paths'
import { readJson, writeJsonAtomic, writeTextFile } from '../../main/process/util'
import type {
  AidjConfig,
  SongMeta,
  PlaylistEntry,
  PlayerStatus,
  LoudnessInfo,
  ChatMessage
} from './types'
import { AIDJ_DATA_DIR, METADATA_FILE, FREQ_FILE, PLAYLISTS_DIR, SEPARATOR } from './types'

const log = makeLogger('aidj')
const execFileAsync = promisify(execFile)
const AIDJ_DIR = join(USER_CONFIG_DIR, AIDJ_DATA_DIR)

/** True for transport-level failures (offline, refused, timeout) — never for HTTP errors like 401/404. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return false
  const msg = String(e instanceof Error ? e.message : e)
  const s = String((e as { status?: unknown } | null)?.status)
  if (s && s !== 'undefined' && !['502', '503', '504'].includes(s)) return false
  return (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket|timeout/i.test(
      msg
    ) ||
    s === '502' ||
    s === '503' ||
    s === '504'
  )
}

/**
 * Retry `fn` while it fails with a transport error, mirroring reconnect_minutes:
 *   0 → fail fast; >0 → retry within N minutes; <0 → retry forever.
 * AbortSignal aborts the wait loop. `onRetry` fires before each wait so callers
 * can surface "retrying…" to the user.
 */
export async function withNetworkRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: {
    retryMinutes: number
    signal?: AbortSignal
    onRetry?: (attempt: number, waitMs: number) => void
  }
): Promise<T> {
  const { retryMinutes, signal } = opts
  if (retryMinutes === 0) return fn(signal)
  const deadline = retryMinutes > 0 ? Date.now() + retryMinutes * 60_000 : Infinity
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await fn(signal)
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!isNetworkError(e)) throw e
      attempt++
      if (Date.now() >= deadline) throw e
      const waitMs = Math.min(30_000, 2000 * attempt)
      opts.onRetry?.(attempt, waitMs)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

export async function loadAidjConfig(): Promise<AidjConfig | null> {
  return readJson<AidjConfig>(abilityConfigPath('aidj'))
}

/** Persist the current AIDJ config to ~/.config/LinuxCockpit/aidj/config.json. */
export async function saveAidjConfig(config: AidjConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeJsonAtomic(abilityConfigPath('aidj'), config)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('saveAidjConfig failed', { error })
    return { ok: false, error }
  }
}

export function getAidjDir(): string {
  return AIDJ_DIR
}

export function getMetadataPath(): string {
  return join(AIDJ_DIR, METADATA_FILE)
}

export function getFreqPath(): string {
  return join(AIDJ_DIR, FREQ_FILE)
}

export function getPlaylistsDir(): string {
  return join(AIDJ_DIR, PLAYLISTS_DIR)
}

// ---------------------------------------------------------------------------
// Play frequency recording (record_freq). A simple CSV of `name,times` sorted
// descending, mirroring the reference AIDJ implementation. Recording is pushed
// by the player itself: `aidj.send` (immediate play-all bumps every sent track)
// and the continuous loop (each track bumped exactly when it starts playing).
// ---------------------------------------------------------------------------

let _freqCache: Map<string, number> | null = null

export async function loadFrequency(): Promise<Map<string, number>> {
  if (_freqCache) return _freqCache
  const freq = new Map<string, number>()
  try {
    const raw = await readFile(getFreqPath(), 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      const idx = line.lastIndexOf(',')
      if (idx > 0) {
        const name = line.slice(0, idx)
        const times = Number(line.slice(idx + 1))
        if (name && Number.isFinite(times)) freq.set(name, times)
      }
    }
  } catch {
    /* noop */
  }
  _freqCache = freq
  return freq
}

export async function saveFrequency(freq: Map<string, number>): Promise<void> {
  _freqCache = freq
  await ensureAidjDir()
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const lines = ['name,times', ...sorted.map(([name, times]) => `${name},${times}`)]
  await writeTextFile(getFreqPath(), lines.join('\n') + '\n')
}

/** Bump play count for the given song names, persisted when changed. */
export async function bumpFrequency(names: string[]): Promise<void> {
  if (!names.length) return
  const freq = await loadFrequency()
  let changed = false
  for (const name of names) {
    if (!name) continue
    freq.set(name, (freq.get(name) ?? 0) + 1)
    changed = true
  }
  if (changed) await saveFrequency(freq)
}

export function ensureAidjDir(): Promise<void> {
  return mkdir(AIDJ_DIR, { recursive: true }).then(() =>
    mkdir(getPlaylistsDir(), { recursive: true }).then(() => {})
  )
}

const MUSIC_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus'])

export async function scanMusicFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkDir(folder, map)
    } catch (e) {
      log.warn('scan folder failed', { folder, error: String(e) })
    }
  }
  return map
}

async function walkDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(full, map)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (MUSIC_EXTS.has(ext)) {
        const name = entry.name.slice(0, -ext.length)
        if (!map.has(name)) {
          map.set(name, full)
        }
      }
    }
  }
}

export async function loadMetadata(): Promise<Map<string, SongMeta>> {
  const map = new Map<string, SongMeta>()
  try {
    const raw = await readFile(getMetadataPath(), 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line)
        if (entry.name && entry.metadata) {
          map.set(entry.name, entry.metadata as SongMeta)
        }
      } catch {
        /* noop */
      }
    }
  } catch {
    /* noop */
  }
  return map
}

// ---------------------------------------------------------------------------
// Shared library cache — metadata + music paths are near-constant; every
// session/job (main page, persistent, chat, ...) should reuse ONE copy instead
// of scanning + re-reading per session. syncMetadata mutates the cached map in
// place, so newly-synced entries are visible to all consumers. `aidj.reload`
// invalidates it to force a rescan.
// ---------------------------------------------------------------------------

let _libraryCache: {
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
} | null = null
let _libraryLoading: Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
}> | null = null

export function loadLibrary(): Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
}> {
  if (_libraryCache) return Promise.resolve(_libraryCache)
  if (!_libraryLoading) {
    _libraryLoading = (async () => {
      const config = await loadAidjConfig()
      const folders = config?.music_folders ?? []
      const musicPaths = await scanMusicFiles(folders)
      const metadata = await loadMetadata()
      _libraryCache = { metadata, musicPaths }
      return _libraryCache
    })().finally(() => {
      _libraryLoading = null
    })
  }
  return _libraryLoading
}

export function invalidateLibrary(): void {
  _libraryCache = null
}

export async function appendMetadata(name: string, meta: SongMeta): Promise<void> {
  await ensureAidjDir()
  const line = JSON.stringify({ name, metadata: meta }) + '\n'
  await appendFile(getMetadataPath(), line, 'utf-8')
}

export async function findMissingSongs(
  musicPaths: Map<string, string>,
  metadata: Map<string, SongMeta>
): Promise<Map<string, string>> {
  const missing = new Map<string, string>()
  for (const [name, path] of musicPaths) {
    if (!metadata.has(name)) {
      missing.set(name, path)
    }
  }
  return missing
}

let ncmBaseUrl = 'http://localhost:3000'

export function setNcmBaseUrl(url: string): void {
  ncmBaseUrl = url
}

export async function searchNcmApi(
  keywords: string
): Promise<{ sid: number | null; lyric: string }> {
  try {
    const sRes = await fetch(
      `${ncmBaseUrl}/search?keywords=${encodeURIComponent(keywords)}&limit=1`
    )
    const sData = (await sRes.json()) as {
      code: number
      result: { songCount: number; songs: { id: number }[] }
    }
    if (sData.code !== 200 || !sData.result?.songCount) return { sid: null, lyric: '' }
    const sid = sData.result.songs[0].id
    const lRes = await fetch(`${ncmBaseUrl}/lyric?id=${sid}`)
    const lData = (await lRes.json()) as { code: number; lrc: { lyric: string } }
    const lyric = lData.code === 200 ? (lData.lrc?.lyric ?? '') : ''
    return { sid, lyric }
  } catch {
    return { sid: null, lyric: '' }
  }
}

export async function extractMetadataAi(
  client: OpenAI,
  name: string,
  lyric: string,
  model: string
): Promise<SongMeta | null> {
  try {
    const info = { title: name, lyrics: lyric.slice(0, 500) }
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content: '提取歌曲信息JSON: language, emotion, genre, loudness, review'
          },
          { role: 'user', content: JSON.stringify(info) }
        ],
        response_format: { type: 'json_object' }
      },
      { timeout: 30_000 }
    )
    const content = resp.choices[0]?.message?.content
    if (!content) return null
    return JSON.parse(content) as SongMeta
  } catch (e) {
    log.warn('extractMetadataAi failed', { name, error: String(e) })
    return null
  }
}

export async function syncMetadata(
  client: OpenAI,
  missing: Map<string, string>,
  metadata: Map<string, SongMeta>,
  model: string,
  concurrency: number
): Promise<Map<string, SongMeta>> {
  if (!missing.size) return metadata
  log.info(`Syncing ${missing.size} songs... concurrency=${concurrency}`)
  const entries = [...missing.entries()]
  const workers = Math.min(concurrency, entries.length)
  await Promise.allSettled(
    Array.from({ length: workers }, async (_, i) => {
      for (let j = i; j < entries.length; j += workers) {
        const [name] = entries[j]
        const { sid, lyric } = await searchNcmApi(name)
        if (sid === null) continue
        const meta = await extractMetadataAi(client, name, lyric, model)
        if (meta) {
          metadata.set(name, meta)
          await appendMetadata(name, meta)
        }
      }
    })
  )
  return metadata
}

interface DbusBus {
  getProxyObject: (name: string, path: string) => Promise<DbusProxyObject>
  disconnect: () => void
}
interface DbusProxyObject {
  getInterface: (name: string) => Record<string, unknown>
}
interface DbusVariant {
  signature: string
  value: unknown
}
interface PropertiesInterface {
  Get: (iface: string, prop: string) => Promise<DbusVariant>
  Set: (iface: string, prop: string, value: DbusVariant) => Promise<void>
}
interface PlayerInterface {
  Next: () => Promise<void>
  Previous: () => Promise<void>
  Play: () => Promise<void>
  Pause: () => Promise<void>
  PlayPause: () => Promise<void>
  Stop: () => Promise<void>
  OpenUri: (uri: string) => Promise<void>
}
interface TrackListInterface {
  AddTrack: (uri: string, afterTrack: string, setAsCurrent: boolean) => Promise<void>
}
interface DBusDaemon {
  ListNames: () => Promise<string[]>
}

function unwrapVariant(v: unknown): unknown {
  if (v && typeof v === 'object' && 'signature' in v && 'value' in v) {
    return unwrapVariant((v as DbusVariant).value)
  }
  return v
}

export class DBusManager {
  private bus: DbusBus | null = null
  private playerProxy: DbusProxyObject | null = null
  private propsProxy: Record<string, unknown> | null = null
  private playerName: string = ''
  private preferredTarget: string
  private _autoMode = true

  constructor(preferredTarget = 'vlc') {
    this.preferredTarget = preferredTarget
  }

  get autoMode(): boolean {
    return this._autoMode
  }

  async connect(): Promise<boolean> {
    try {
      const dbus = await import('dbus-next')
      this.bus = dbus.sessionBus()
      if (!this._autoMode) {
        const players = await this.listPlayers()
        const target = this.resolvePlayer(players)
        if (!target) return false
        this.playerName = target
        this.playerProxy = await this.bus.getProxyObject(target, '/org/mpris/MediaPlayer2')
        this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      }
      return true
    } catch (e) {
      log.warn('dbus connect failed', { error: String(e) })
      return false
    }
  }

  private async autoDetectPlayer(): Promise<string | null> {
    try {
      const players = await this.listPlayers()
      if (!players.length) return null
      for (const name of players) {
        try {
          const obj = await this.bus!.getProxyObject(name, '/org/mpris/MediaPlayer2')
          const props = obj.getInterface(
            'org.freedesktop.DBus.Properties'
          ) as unknown as PropertiesInterface
          const statusV = await props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus')
          if (statusV.value === 'Playing') return name
        } catch {
          /* skip */
        }
      }
      const preferred = players.find((p) =>
        p.toLowerCase().includes(this.preferredTarget.toLowerCase())
      )
      if (preferred) return preferred
      return players[0]
    } catch {
      return null
    }
  }

  private async ensureBound(): Promise<boolean> {
    if (!this._autoMode && this.propsProxy) return true
    const target = await this.autoDetectPlayer()
    if (!target) return false
    if (this.playerName === target && this.propsProxy) return true
    try {
      this.playerName = target
      this.playerProxy = await this.bus!.getProxyObject(target, '/org/mpris/MediaPlayer2')
      this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      return true
    } catch {
      return false
    }
  }

  private resolvePlayer(players: string[]): string | null {
    if (!players.length) return null
    const preferred = players.find((p) =>
      p.toLowerCase().includes(this.preferredTarget.toLowerCase())
    )
    if (preferred) return preferred
    const mpv = players.find((p) => p.toLowerCase().includes('mpv'))
    if (mpv) return mpv
    return players[0]
  }

  async getStatus(): Promise<PlayerStatus> {
    try {
      if (this._autoMode) {
        const target = await this.autoDetectPlayer()
        if (!target) return { status: 'Unknown', track: '', volume: null, player: '' }
        if (target !== this.playerName || !this.propsProxy) {
          try {
            this.playerName = target
            this.playerProxy = await this.bus!.getProxyObject(target, '/org/mpris/MediaPlayer2')
            this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
          } catch {
            return { status: 'Unknown', track: '', volume: null, player: '' }
          }
        }
      } else if (!this.propsProxy) {
        log.warn('getStatus: propsProxy is null')
        return { status: 'Unknown', track: '', volume: null, player: '' }
      }
      const props = this.propsProxy as unknown as PropertiesInterface
      const statusV = await props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus')
      const status = statusV.value as string
      const metaV = await props.Get('org.mpris.MediaPlayer2.Player', 'Metadata')
      const rawMeta = metaV.value as Record<string, unknown>
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawMeta ?? {})) {
        meta[k] = unwrapVariant(v)
      }
      const volV = await props.Get('org.mpris.MediaPlayer2.Player', 'Volume')
      const vol = volV.value as number
      const track = this.resolveTrackName(meta)
      log.info('getStatus ok', { status, track, player: this.playerName })
      return {
        status: status as PlayerStatus['status'],
        track,
        volume: vol ?? null,
        player: this.playerName
      }
    } catch (e) {
      log.warn('getStatus failed', { error: String(e) })
      return { status: 'Unknown', track: '', volume: null, player: '' }
    }
  }

  async control(command: string): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.playerProxy) return false
      const iface = this.playerProxy.getInterface(
        'org.mpris.MediaPlayer2.Player'
      ) as unknown as PlayerInterface
      const methodMap: Record<string, keyof PlayerInterface> = {
        next: 'Next',
        prev: 'Previous',
        play: 'Play',
        pause: 'Pause',
        toggle: 'PlayPause',
        stop: 'Stop'
      }
      const method = methodMap[command] as keyof PlayerInterface
      if (!method) return false
      await (iface[method] as () => Promise<void>)()
      return true
    } catch (e) {
      log.warn('control failed', { command, error: String(e) })
      return false
    }
  }

  async sendFiles(paths: string[]): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.playerProxy) return false
      if (!paths.length) return true
      const iface = this.playerProxy.getInterface(
        'org.mpris.MediaPlayer2.Player'
      ) as unknown as PlayerInterface
      if (paths.length === 1) {
        // Single track: replace current and play immediately (OpenUri semantics)
        await iface.OpenUri(`file://${paths[0]}`)
        return true
      }
      // Multiple tracks: queue via TrackList.AddTrack, first becomes current, then play
      try {
        const tl = this.playerProxy.getInterface(
          'org.mpris.MediaPlayer2.TrackList'
        ) as unknown as TrackListInterface
        for (let i = 0; i < paths.length; i++) {
          await tl.AddTrack(`file://${paths[i]}`, '/', i === 0)
        }
        await iface.Play()
        return true
      } catch {
        for (const p of paths) {
          await iface.OpenUri(`file://${p}`)
        }
        return true
      }
    } catch (e) {
      log.warn('sendFiles failed', { error: String(e) })
      return false
    }
  }

  async setVolume(vol: number): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.propsProxy) return false
      const props = this.propsProxy as unknown as PropertiesInterface
      await props.Set('org.mpris.MediaPlayer2.Player', 'Volume', {
        signature: 'd',
        value: Math.max(0, Math.min(1, vol))
      })
      return true
    } catch {
      return false
    }
  }

  async getVolume(): Promise<number | null> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return null
      if (!this.propsProxy) return null
      const props = this.propsProxy as unknown as PropertiesInterface
      const v = await props.Get('org.mpris.MediaPlayer2.Player', 'Volume')
      return v.value as number
    } catch {
      return null
    }
  }

  disconnect(): void {
    if (this.bus) {
      try {
        this.bus.disconnect()
      } catch {
        /* noop */
      }
      this.bus = null
      this.playerProxy = null
      this.propsProxy = null
    }
  }

  getPlayerName(): string {
    return this._autoMode ? '__auto__' : this.playerName
  }

  /**
   * Resolve a human-friendly track label from MPRIS Metadata. Some players
   * (VLC, mpv) leave `xesam:title` empty and only expose `xesam:url`; fall back
   * to the file name without extension so the UI never shows a bare "—".
   */
  resolveTrackName(meta: Record<string, unknown>): string {
    const title = String(meta?.['xesam:title'] ?? '').trim()
    if (title) return title
    const url = String(meta?.['xesam:url'] ?? '').trim()
    if (!url) return ''
    const clean = url.replace(/^file:\/\//, '')
    const name = clean.split('/').pop() || clean
    const ext = name.lastIndexOf('.')
    return ext > 0 ? name.slice(0, ext) : name
  }

  /** The actually-bound MPRIS bus name (resolves auto mode to a concrete player). */
  get resolvedPlayerName(): string {
    return this.playerName || ''
  }

  async listPlayers(): Promise<string[]> {
    try {
      const dbus = await import('dbus-next')
      const bus = dbus.sessionBus()
      const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
      const iface = obj.getInterface('org.freedesktop.DBus') as unknown as DBusDaemon
      const names: string[] = await iface.ListNames()
      bus.disconnect()
      return names.filter((n: string) => n.startsWith('org.mpris.MediaPlayer2'))
    } catch (e) {
      log.warn('listPlayers failed', { error: String(e) })
      return []
    }
  }

  async switchToPlayer(playerName: string): Promise<boolean> {
    try {
      if (!playerName || playerName === '__auto__') {
        this._autoMode = true
        this.playerName = ''
        this.playerProxy = null
        this.propsProxy = null
        log.info('switched to auto mode')
        return true
      }
      this._autoMode = false
      if (this.playerName === playerName && this.propsProxy) return true
      const dbus = await import('dbus-next')
      const bus = this.bus || dbus.sessionBus()
      this.playerName = playerName
      this.playerProxy = await bus.getProxyObject(playerName, '/org/mpris/MediaPlayer2')
      this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      if (!this.bus) this.bus = bus
      log.info('switched to player', { player: playerName })
      return true
    } catch (e) {
      log.warn('switchToPlayer failed', { player: playerName, error: String(e) })
      return false
    }
  }
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
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_streams',
        '-of',
        'json',
        filepath
      ])
      const data = JSON.parse(stdout)
      const stream = data.streams?.[0]
      if (!stream) return null

      const peakDb = 20 * Math.log10(Math.max(stream.max_peak ?? 1, 1e-10))
      const rmsDb = 20 * Math.log10(Math.max(stream.max_rms ?? 1, 1e-10))

      let integratedLufs: number | null = null
      try {
        const { stdout: lufsOut } = await execFileAsync(
          'ffprobe',
          [
            '-v',
            'quiet',
            '-print_format',
            'json',
            '-show_frames',
            '-read_intervals',
            '%+3',
            '-f',
            'lavfi',
            `amovie=${filepath},ebur128=metadata=1`,
            filepath
          ],
          { timeout: 10000 }
        )
        const lufsData = JSON.parse(lufsOut)
        const frames = lufsData.frames ?? []
        for (const f of frames) {
          if (f?.pts_time && f?.lavfi?.ebur128?.integrated) {
            integratedLufs = f.lavfi.ebur128.integrated
            break
          }
        }
      } catch {
        /* noop */
      }

      return { peak_db: peakDb, rms_db: rmsDb, integrated_lufs: integratedLufs }
    } catch {
      return null
    }
  }

  loudnessKey(info: LoudnessInfo | null): number | null {
    if (!info) return null
    if (this.method === 'lufs' && info.integrated_lufs != null) {
      return info.integrated_lufs
    }
    return info.rms_db
  }

  computeVolume(songVal: number | null): number {
    if (this._anchorVal == null || songVal == null) return this._baseVol
    const dbDiff = this._anchorVal - songVal
    const gain = 10 ** (dbDiff / 20)
    const anchorAmp = this._baseVol ** this.curve
    const linearTarget = anchorAmp * gain
    const compensated = linearTarget ** (1 / Math.max(this.curve, 0.1))
    return Math.max(0.05, Math.min(1.0, compensated))
  }

  async setAnchor(filepath: string, baseVol = 0.5): Promise<number> {
    this._baseVol = baseVol
    const info = await this.get(filepath)
    const val = this.loudnessKey(info)
    if (val != null) this._anchorVal = val
    return baseVol
  }

  setAnchorValue(val: number, baseVol = 0.5): void {
    this._anchorVal = val
    this._baseVol = baseVol
  }

  async targetVolume(filepath: string): Promise<number> {
    if (this._anchorVal == null) return this._baseVol
    const info = await this.get(filepath)
    const songVal = this.loudnessKey(info)
    return this.computeVolume(songVal)
  }
}

export class DJSession {
  client: OpenAI
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  config: AidjConfig
  chatHistory: ChatMessage[]
  turnCount: number
  playedSongs: Set<string>
  promptTokens: number
  completionTokens: number

  constructor(
    client: OpenAI,
    metadata: Map<string, SongMeta>,
    musicPaths: Map<string, string>,
    config: AidjConfig
  ) {
    this.client = client
    this.metadata = metadata
    this.musicPaths = musicPaths
    this.config = config
    this.chatHistory = []
    this.turnCount = 0
    this.playedSongs = new Set()
    this.promptTokens = 0
    this.completionTokens = 0
  }

  refresh(clearHistory = false): void {
    this.playedSongs.clear()
    if (clearHistory) {
      this.chatHistory = []
      this.turnCount = 0
    }
  }

  formatLibrary(): string {
    const injects = this.config.preferences.library_injects
    const lines: string[] = []
    const available = [...this.metadata.keys()].filter((k) => this.musicPaths.has(k)).sort()
    for (const name of available) {
      const info = this.metadata.get(name)
      if (!info || typeof info !== 'object') {
        lines.push(`- ${name}`)
        continue
      }
      const parts = [name]
      for (const field of ['genre', 'emotion', 'language', 'loudness', 'review'] as const) {
        if (injects[field] && info[field]) {
          const val = Array.isArray(info[field]) ? info[field].join(', ') : info[field]
          parts.push(String(val))
        }
      }
      lines.push(parts.join(' | '))
    }
    return lines.join('\n')
  }

  private validKeys(): string[] {
    return [...this.metadata.keys()].filter((k) => this.musicPaths.has(k))
  }

  /** token_sort_ratio: split+sort tokens, then Levenshtein ratio 0-100. */
  tokenSortRatio(a: string, b: string): number {
    const ta = a
      .split(/[\s,，、。.\-()（）]+/)
      .filter(Boolean)
      .sort()
      .join(' ')
    const tb = b
      .split(/[\s,，、。.\-()（）]+/)
      .filter(Boolean)
      .sort()
      .join(' ')
    const maxLen = Math.max(ta.length, tb.length)
    if (maxLen === 0) return 100
    const dist = this.levenshtein(ta, tb)
    return Math.round((1 - dist / maxLen) * 100)
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length,
      n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1
      }
    }
    return dp[m][n]
  }

  /** Find best fuzzy match for `query` among `candidates`, returns matched name or null. */
  private bestMatch(query: string, candidates: string[]): string | null {
    let best: string | null = null
    let bestScore = 0
    for (const c of candidates) {
      const score = this.tokenSortRatio(query, c)
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    return bestScore >= 80 ? best : null
  }

  parseRawPlaylist(
    rawText: string,
    source: 'AI' | 'user' = 'AI'
  ): { playlist: PlaylistEntry[]; intro: string } {
    const playlistNames: string[] = []
    let introText = ''
    const isVerbose = this.config.preferences.verbose
    const keys = this.validKeys()

    if (rawText.includes(SEPARATOR)) {
      const parts = rawText.split(SEPARATOR)
      introText = parts[0].trim()
      const rawListBlock = parts.slice(1).join(SEPARATOR)
      if (isVerbose) log.info('Separator found, parsing list')
      const lines = rawListBlock
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

      for (const line of lines) {
        if (line.startsWith('#')) continue
        const clean = line.replace(/["']/g, '').trim()
        if (clean.length < 2) continue
        const match = this.bestMatch(clean, keys)
        if (match) {
          if (isVerbose) log.info(`Matched: ${clean} -> ${match}`)
          playlistNames.push(match)
        } else if (isVerbose) {
          log.info(`Ignored line: ${clean}`)
        }
      }
    } else {
      introText = rawText.trim()
      if (isVerbose && source === 'AI') {
        log.info('No separator found. Treating as pure conversation.')
      }
    }

    const unique = [...new Set(playlistNames)]
    const playlist: PlaylistEntry[] = []
    for (const name of unique) {
      if (source === 'AI') this.playedSongs.add(name)
      const path = this.musicPaths.get(name)
      if (path) playlist.push({ name, path })
    }
    return { playlist, intro: introText }
  }

  /** Compact old conversation messages into a summary via the AI. Never includes the library prompt. */
  private async compactConversation(messages: ChatMessage[]): Promise<string> {
    if (!messages.length) return ''
    const isVerbose = this.config.preferences.verbose
    try {
      const instruction = `You are a context compactor for an AI music DJ chat session.
Your ONLY job is to summarize the conversation history.
RULES:
- DO NOT mention any specific song names, track titles, or library keys.
- Instead, summarize what the user has talked about and the general types, genres, and moods of music they have listened to or requested.
- Keep the summary concise (at most 200 words), written in the same language as the conversation.
- Output ONLY the summary text. No preamble, no markdown, no song lists.`
      const resp = await this.client.chat.completions.create(
        {
          model: this.config.preferences.model,
          messages: [
            { role: 'system', content: instruction },
            ...messages.map((m) => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content
            }))
          ],
          max_tokens: 400,
          temperature: 0.3
        },
        { timeout: 30_000 }
      )
      const content = resp.choices?.[0]?.message?.content?.trim() || ''
      if (isVerbose) log.info(`compacted ${messages.length} messages into summary`)
      return content
    } catch (e) {
      log.warn('compactConversation failed', { error: String(e) })
      return ''
    }
  }

  /**
   * Keep the chat history balanced. The library/system prompt (index 0) is always kept and
   * never sent for compaction.
   * - discard: drop the oldest messages, keep [0] + last (max-1).
   * - compact: send all conversation messages (except index 0) to the AI for a summary.
   */
  private async manageContext(): Promise<void> {
    const max = Math.max(2, this.config.preferences.max_history_length || 10)
    if (this.chatHistory.length <= max) return
    const mode = this.config.preferences.context_mode || 'discard'
    const keep = this.chatHistory[0]

    if (mode === 'compact') {
      const toCompact = this.chatHistory.slice(1)
      if (toCompact.length > 0) {
        const summary = await this.compactConversation(toCompact)
        if (summary) {
          this.chatHistory = [
            keep,
            { role: 'system', content: `[Context Summary] ${summary}`, timestamp: Date.now() }
          ]
          return
        }
      }
    }
    this.chatHistory = [keep, ...this.chatHistory.slice(-(max - 1))]
  }

  async nextStep(
    userRequest: string,
    onStream?: (text: string) => void,
    signal?: AbortSignal,
    onRetry?: (attempt: number, waitMs: number) => void
  ): Promise<{ playlist: PlaylistEntry[]; intro: string }> {
    this.turnCount++
    const model = this.config.preferences.model
    const isVerbose = this.config.preferences.verbose

    if (isVerbose) log.info(`Thinking with ${model}...`)

    await this.manageContext()

    const basePrompt = `### ROLE DEFINITION
You are a **charismatic, knowledgeable, and expressive AI Radio Host**.
Your goal is not just to list songs, but to **curate an experience**.
- **Personality:** Passionate, poetic, slightly "hyped" or "deep" (depending on the mood), and vibe-focused.
- **Rule:** BE EXPRESSIVE. Do NOT give short, robotic responses like "Here is your list."
- **Method:** Weave a narrative. Talk about the *texture* of the sound, the *emotion* of the artists, and *why* these songs fit the moment.

### DATA SOURCE (CRITICAL)
You are provided with a **Music Library**.
- **RESTRICTION:** You can ONLY select songs that exist EXACTLY in the provided Library.
- **PROHIBITION:** Do NOT hallucinate songs. Do NOT translate song titles. Do NOT fix typos in the library keys.
- If no songs in the library fit the mood, just chat and DO NOT output the separator.

### OUTPUT PROTOCOL
Your output is parsed by a script. You must strictly follow this structure:

[Part 1: The Intro]
(Content: A rich, paragraph-length DJ commentary. Use Markdown bolding for emphasis.)

${SEPARATOR}

[Part 2: The Payload]
(Content: Exact song keys from the Library. One key per line. NO numbering. NO markdown bullets. NO extra text.)`

    if (this.turnCount === 1) {
      const libraryStr = this.formatLibrary()
      const systemContent = `${basePrompt}\n\n### CURRENT MUSIC LIBRARY (Exact Keys Only):\n${libraryStr}`
      this.chatHistory.push({ role: 'system', content: systemContent, timestamp: Date.now() })
      if (isVerbose) log.info('Library injected once')
    }

    const forbiddenList = this.playedSongs.size > 0 ? [...this.playedSongs].join(', ') : 'None'
    const fullReq = `User Request: "${userRequest}"
Constraint: Don't repeat these songs: [${forbiddenList}]
Language Rule: Detect the language used in the 'User Request'. The [Intro] section MUST be written in that EXACT SAME language.
Instruction: Check the Library in the first System message. If matches found, output Intro + ${SEPARATOR} + SongKeys. If no matches, just Intro.`

    this.chatHistory.push({ role: 'user', content: fullReq, timestamp: Date.now() })

    try {
      const stream = await withNetworkRetry(
        async (sig) =>
          this.client.chat.completions.create(
            {
              model,
              messages: this.chatHistory.map((m) => ({
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content
              })),
              stream: true,
              stream_options: { include_usage: true }
            },
            { timeout: 180_000, signal: sig }
          ),
        {
          retryMinutes: this.config.preferences.network_retry_minutes ?? 0,
          signal,
          onRetry: (attempt, waitMs) => {
            if (isVerbose) log.warn('AI network retry', { attempt, waitMs })
            onRetry?.(attempt, waitMs)
          }
        }
      )

      let fullContent = ''
      for await (const chunk of stream) {
        if (chunk.usage) {
          this.promptTokens += chunk.usage.prompt_tokens ?? 0
          this.completionTokens += chunk.usage.completion_tokens ?? 0
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          fullContent += delta
          onStream?.(fullContent)
        }
      }

      const cleanContent = fullContent
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*/g, '')
        .trim()

      if (isVerbose) log.info(`Raw AI output (${cleanContent.length} chars)`)

      this.chatHistory.push({ role: 'assistant', content: cleanContent, timestamp: Date.now() })
      return this.parseRawPlaylist(cleanContent, 'AI')
    } catch (e) {
      if (signal?.aborted) {
        this.chatHistory.pop()
        return { playlist: [], intro: '' }
      }
      const errMsg = String(e)
      log.error('AI API error', { error: errMsg })
      this.chatHistory.pop()
      return { playlist: [], intro: `⚠️ API 错误: ${errMsg}` }
    }
  }
}

export class PersistentSession {
  config: AidjConfig
  /** Optional — null for chat-only sessions that never touch a player. */
  dbus: DBusManager | null
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  chatHistory: ChatMessage[]
  rollingHistory: string[]
  currentQueue: PlaylistEntry[]
  buffer: PlaylistEntry[][]
  fetchCount: number
  working: boolean
  /** DJ commentary (intro) of the most recent batch — shown by chat views. */
  lastIntro = ''
  private client: OpenAI
  private volCache: LoudnessCache
  private initialPrompt: string
  private _anchorValue: number | null

  constructor(
    client: OpenAI,
    metadata: Map<string, SongMeta>,
    musicPaths: Map<string, string>,
    config: AidjConfig,
    dbus: DBusManager | null,
    initialPrompt: string,
    anchorValue?: number | null
  ) {
    this.client = client
    this.metadata = metadata
    this.musicPaths = musicPaths
    this.config = config
    this.dbus = dbus
    this.initialPrompt = initialPrompt
    this._anchorValue = anchorValue ?? null
    this.chatHistory = []
    this.rollingHistory = [...metadata.keys()].slice(0, 100)
    this.currentQueue = []
    this.buffer = []
    this.fetchCount = 0
    this.working = false
    this.volCache = new LoudnessCache(
      config.preferences.sound_adjust_method,
      config.preferences.volume_curve
    )
    if (anchorValue != null) {
      this.volCache.setAnchorValue(anchorValue, 0.5)
    }
  }

  get anchorValue(): number | null {
    return this._anchorValue
  }
  set anchorValue(v: number | null) {
    this._anchorValue = v
  }

  private async fetchNextBatch(
    signal?: AbortSignal,
    onRetry?: (attempt: number, waitMs: number) => void
  ): Promise<PlaylistEntry[]> {
    if (this.working) return []
    this.working = true
    try {
      let phaseInstruction: string
      if (this.fetchCount === 0) {
        phaseInstruction = `### PHASE 1: INITIAL REQUEST\nUser Goal: '${this.initialPrompt}'\nTarget: At least 8 tracks matching this mood.`
      } else {
        const lastTracks = this.rollingHistory.slice(-15)
        const negativeHint =
          this.fetchCount < 3
            ? 'but DO follow the negative part of the initial prompt. '
            : 'and gradually relax any original exclusions. '
        phaseInstruction = `### PHASE ${this.fetchCount + 1}: AUTONOMOUS RADIO FLOW\nRecent Sequence: [${lastTracks.join(', ')}]\nTask: Ignore the positive part of the initial prompt ${negativeHint}Based on the sequence above, predict and curate the next logical musical chapter (at least 8 tracks).`
      }

      const fullPrompt = `${phaseInstruction}\n\n**STRICT RULES:**\n1. OUTPUT AT LEAST 8 TRACKS FROM THE LIBRARY.\n2. Forbidden (Rolling 100): [${this.rollingHistory.join(', ')}].\n3. Genre Shifting: If matches run out, gradually transition to a complementary vibe.\n4. Use EXACT library keys. NO hallucination.`

      const session = new DJSession(this.client, this.metadata, this.musicPaths, this.config)
      session.chatHistory = this.chatHistory.map((m) => ({ ...m }))
      session.playedSongs = new Set(this.rollingHistory)
      session.turnCount = this.fetchCount

      const { playlist, intro } = await session.nextStep(fullPrompt, undefined, signal, onRetry)
      this.chatHistory = session.chatHistory
      this.lastIntro = intro || ''

      if (playlist.length > 0) {
        for (const s of playlist) {
          this.rollingHistory.push(s.name)
          if (this.rollingHistory.length > 100) this.rollingHistory.shift()
        }
        this.fetchCount++
      }
      return playlist
    } catch (e) {
      log.error('fetch batch failed', { error: String(e) })
      return []
    } finally {
      this.working = false
    }
  }

  async needsNextBatch(): Promise<boolean> {
    return this.buffer.length < 2 && !this.working
  }

  async fetchBatch(
    signal?: AbortSignal,
    onRetry?: (attempt: number, waitMs: number) => void
  ): Promise<void> {
    const batch = await this.fetchNextBatch(signal, onRetry)
    if (batch.length > 0) this.buffer.push(batch)
  }

  hasReadyTrack(): boolean {
    return this.currentQueue.length > 0
  }

  dequeue(): PlaylistEntry | null {
    return this.currentQueue.shift() ?? null
  }

  async ensureNextBatchInQueue(): Promise<void> {
    if (this.currentQueue.length === 0 && this.buffer.length > 0) {
      this.currentQueue = this.buffer.shift()!
    }
  }

  async adjustVolume(track: PlaylistEntry): Promise<void> {
    if (!this.config.preferences.dynamic_balance_volume || !this.dbus) return
    const isFirst = this.fetchCount === 1 && this._anchorValue == null
    if (isFirst) {
      await this.dbus.setVolume(0.5)
      await this.volCache.setAnchor(track.path, 0.5)
      this._anchorValue = this.volCache.anchorVal
    } else {
      const targetVol = await this.volCache.targetVolume(track.path)
      if (targetVol != null) {
        await this.dbus.setVolume(targetVol)
      }
    }
    if (this.currentQueue.length > 0) {
      this.volCache.preAnalyze(this.currentQueue[0].path)
    }
  }

  injectUserMessage(content: string): void {
    this.chatHistory.push({ role: 'user', content, timestamp: Date.now() })
  }

  discardFollows(): void {
    this.buffer = []
    this.currentQueue = []
    this.chatHistory.pop()
  }

  stop(): void {
    this.dbus?.disconnect()
  }
}

let _dbusManager: DBusManager | null = null
let _persistentSession: PersistentSession | null = null

export function getDbusManager(): DBusManager | null {
  return _dbusManager
}

export function setDbusManager(m: DBusManager): void {
  _dbusManager = m
}

export function getPersistentSession(): PersistentSession | null {
  return _persistentSession
}

export function setPersistentSession(s: PersistentSession | null): void {
  _persistentSession = s
}

export async function initDbusManager(config: AidjConfig): Promise<DBusManager> {
  if (_dbusManager) _dbusManager.disconnect()
  const dbus = new DBusManager(config.preferences.dbus_target)
  await dbus.connect()
  setDbusManager(dbus)
  return dbus
}

export async function listAvailablePlayers(): Promise<string[]> {
  if (_dbusManager) {
    return _dbusManager.listPlayers()
  }
  try {
    const dbus = await import('dbus-next')
    const bus = dbus.sessionBus()
    const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
    const iface = obj.getInterface('org.freedesktop.DBus') as unknown as DBusDaemon
    const names: string[] = await iface.ListNames()
    bus.disconnect()
    return names.filter((n: string) => n.startsWith('org.mpris.MediaPlayer2'))
  } catch (e) {
    log.warn('listAvailablePlayers failed', { error: String(e) })
    return []
  }
}

export async function switchPlayer(playerName: string): Promise<boolean> {
  if (!_dbusManager) return false
  return _dbusManager.switchToPlayer(playerName)
}

const _coverCache = new Map<string, string>()

export async function getCoverArt(filepath: string): Promise<string | null> {
  if (_coverCache.has(filepath)) return _coverCache.get(filepath) ?? null
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      filepath
    ])
    const data = JSON.parse(stdout)
    const coverStream = (data.streams ?? []).find(
      (s: Record<string, unknown>) => (s as Record<string, unknown>).codec_type === 'video'
    )
    if (!coverStream) {
      _coverCache.set(filepath, '')
      return null
    }
    const { stdout: raw } = await execFileAsync(
      'ffmpeg',
      ['-i', filepath, '-an', '-vcodec', 'png', '-f', 'image2pipe', '-vframes', '1', 'pipe:1'],
      { maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' } as { encoding: 'buffer' }
    )
    const b64 = (raw as unknown as Buffer).toString('base64')
    const url = `data:image/png;base64,${b64}`
    _coverCache.set(filepath, url)
    return url
  } catch {
    _coverCache.set(filepath, '')
    return null
  }
}
