import { readFile, readdir, mkdir, appendFile, writeFile, rename, rm } from 'fs/promises'
import { join, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import OpenAI from 'openai'
import { makeLogger } from '../../main/process/logger'
import { USER_CONFIG_DIR, abilityConfigPath } from '../../main/process/paths'
import { readJson, writeJsonAtomic, writeTextFile } from '../../main/process/util'
import type {
  AidjConfig,
  SongMeta,
  MetadataSyncCounts,
  MetadataSyncProgress,
  PlaylistEntry,
  PlayerStatus,
  LoudnessInfo,
  ChatMessage,
  RawHistoryMessage,
  SessionMeta,
  LyricPlaybackState,
  AidjLyricsPageConfig
} from './types'
import {
  AIDJ_DATA_DIR,
  METADATA_FILE,
  LYRICS_FILE,
  FREQ_FILE,
  PLAYLISTS_DIR,
  SEPARATOR,
  DEFAULT_PERSONA,
  DEFAULT_LYRICS_PAGE_CFG
} from './types'

const log = makeLogger('aidj')
const execFileAsync = promisify(execFile)
const AIDJ_DIR = join(USER_CONFIG_DIR, AIDJ_DATA_DIR)
const SESSIONS_DIR = join(AIDJ_DIR, 'sessions')
const SESSIONS_INDEX = join(SESSIONS_DIR, 'main.json')

/** True for transport-level failures (offline, refused, timeout) and transient server errors (500-504). */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return false
  const msg = String(e instanceof Error ? e.message : e)
  const status = (e as { status?: unknown } | null)?.status
  if (status != null) {
    const s = String(status)
    if (s === '500' || s === '502' || s === '503' || s === '504') return true
    return false
  }
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket|timeout/i.test(
    msg
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
    onRetry?: (attempt: number, waitMs: number, error: unknown) => void
  }
): Promise<T> {
  const { retryMinutes, signal } = opts
  if (retryMinutes === 0) return fn(signal)
  const deadline = retryMinutes > 0 ? Date.now() + retryMinutes * 60_000 : Infinity
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (Date.now() >= deadline) throw new Error('重试超时')

    const attemptAc = new AbortController()
    const attemptTimer = setTimeout(() => attemptAc.abort(), 30_000)
    try {
      const combined = signal ? AbortSignal.any([signal, attemptAc.signal]) : attemptAc.signal
      const result = await fn(combined)
      clearTimeout(attemptTimer)
      return result
    } catch (e) {
      clearTimeout(attemptTimer)
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const isTimeout = attemptAc.signal.aborted && !signal?.aborted
      if (!isNetworkError(e) && !isTimeout) throw e
      attempt++
      const waitMs = Math.min(2000, 1000 * attempt)
      const errInfo = isTimeout ? 'attempt timeout' : String(e)
      log.warn('AI request retry', {
        attempt,
        waitMs,
        retryMinutes,
        isTimeout,
        error: errInfo
      })
      opts.onRetry?.(attempt, waitMs, isTimeout ? new Error('API 请求超时') : e)
      if (Date.now() >= deadline) throw e
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

// ---------------------------------------------------------------------------
// In-app lyrics page config — `~/.config/LinuxCockpit/aidj-lyrics/config.json`
// (the `aidj-lyrics` ability's own settings; colors are NOT part of it — the
// page always follows the app theme).
// ---------------------------------------------------------------------------
const LYRICS_PAGE_CONFIG_PATH = abilityConfigPath('aidj-lyrics')

export async function loadLyricsPageConfig(): Promise<AidjLyricsPageConfig> {
  const saved = await readJson<Partial<AidjLyricsPageConfig>>(LYRICS_PAGE_CONFIG_PATH)
  return { ...DEFAULT_LYRICS_PAGE_CFG, ...(saved ?? {}) }
}

export async function saveLyricsPageConfig(
  config: AidjLyricsPageConfig
): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeJsonAtomic(LYRICS_PAGE_CONFIG_PATH, config)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('saveLyricsPageConfig failed', { error })
    return { ok: false, error }
  }
}

export function getAidjDir(): string {
  return AIDJ_DIR
}

export function getMetadataPath(): string {
  return join(AIDJ_DIR, METADATA_FILE)
}

export function getLyricsPath(): string {
  return join(AIDJ_DIR, LYRICS_FILE)
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
// Lyrics store — music_lyrics.jsonl (name → LRC text), append-only like the
// metadata file. Filled during metadata sync (the NCM lyric search already
// runs there); consumed by the desktop-lyrics window via `aidj.lyrics`.
// ---------------------------------------------------------------------------

/** Lyrics store — `music_lyrics.jsonl` lines carry the raw LRC (`lyric`) and,
 *  when the NCM hit had enhanced karaoke data, an inline-timestamp LRC built
 *  from YRC (`karaoke`) — the same words with word-level sub-timestamps, so the
 *  in-app lyrics page can do real per-word karaoke fills. The desktop window
 *  keeps using the raw `lyric` (its parser treats multi-timestamp lines as
 *  duplicates), so the two stay decoupled.
 */
export async function loadLyrics(): Promise<{
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> {
  const lyrics = new Map<string, string>()
  const karaoke = new Map<string, string>()
  // 1. NCM-synced lyrics (music_lyrics.jsonl)
  try {
    const raw = await readFile(getLyricsPath(), 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line)
        if (entry.name && typeof entry.lyric === 'string') lyrics.set(entry.name, entry.lyric)
        if (entry.name && typeof entry.karaoke === 'string' && entry.karaoke)
          karaoke.set(entry.name, entry.karaoke)
      } catch {
        /* noop */
      }
    }
  } catch {
    /* noop */
  }
  // 2. Locally curated .lrc files from the configured lyrics folders — these
  //    override the NCM result for the same song name (manual beats auto).
  const config = await loadAidjConfig()
  const folders = config?.lyrics_folders ?? []
  const files = await scanLyricFiles(folders)
  for (const [name, content] of files) {
    if (content) {
      lyrics.set(name, content)
      karaoke.delete(name)
    }
  }
  // 3. Local .yrc karaoke — word-level beats NCM karaoke, and provides the
  //    plain lyric when the song has no .lrc. Handle both the bracket format
  //    and the pure-JSON (NCM API) format.
  for (const [name, yrc] of await scanKaraokeFiles(folders)) {
    if (!yrc) continue
    const inline = localYrcToInlineLrc(yrc) || yrcToInlineLrc(yrc)
    if (inline) karaoke.set(name, inline)
    if (!lyrics.has(name)) {
      const plain = localYrcToLrc(yrc)
      if (plain) lyrics.set(name, plain)
    }
  }
  return { lyrics, karaoke }
}

const LRC_EXT = '.lrc'

/** Recursively scan folders for `.lrc` files, keyed by basename (without ext).
 *  On a same-name collision across folders the LONGEST file wins — a complete
 *  lyric beats a stub/placeholder regardless of folder order. */
export async function scanLyricFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkLyricDir(folder, map)
    } catch (e) {
      log.warn('scan lyric folder failed', { folder, error: String(e) })
    }
  }
  return map
}

const YRC_EXT = '.yrc'

/** Recursively scan folders for `.yrc` karaoke files (same keying as `.lrc`). */
export async function scanKaraokeFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkKaraokeDir(folder, map)
    } catch (e) {
      log.warn('scan karaoke folder failed', { folder, error: String(e) })
    }
  }
  return map
}

async function walkKaraokeDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkKaraokeDir(full, map)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(YRC_EXT)) {
      const name = entry.name.slice(0, -YRC_EXT.length).trim()
      if (!name) continue
      let content = ''
      try {
        content = await readFile(full, 'utf-8')
      } catch {
        continue // skip unreadable
      }
      const prev = map.get(name)
      if (prev === undefined || content.length > prev.length) map.set(name, content)
    }
  }
}

async function walkLyricDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkLyricDir(full, map)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(LRC_EXT)) {
      const name = entry.name.slice(0, -LRC_EXT.length).trim()
      if (!name) continue
      let content = ''
      try {
        content = await readFile(full, 'utf-8')
      } catch {
        continue // skip unreadable
      }
      const prev = map.get(name)
      if (prev === undefined || content.length > prev.length) map.set(name, content)
    }
  }
}

/** `[mm:ss.xx]` LRC tag for a millisecond time (2-digit centiseconds). */
function msToLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const s = Math.floor(total / 1000)
  const m = Math.floor(s / 60)
  const frac = Math.floor((total % 1000) / 10)
  return `${m}:${String(s % 60).padStart(2, '0')}.${String(frac).padStart(2, '0')}`
}

/**
 * Convert Netease's YRC (karaoke) data into an inline-timestamp LRC. YRC is one
 * JSON object per line — `{ "t": <lineStartMs>, "c": [{ "t": <wordStartMs>, "c": "字" }, ...] }`.
 * Each word gets its own `[mm:ss.xx]` tag so the renderer can fill word-by-word.
 * Returns '' when nothing usable (some songs have no enhanced lyrics).
 */
export function yrcToInlineLrc(yrc: string): string {
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let parsed: { t?: unknown; c?: unknown }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const lineMs = Number(parsed.t)
    if (!Number.isFinite(lineMs) || !Array.isArray(parsed.c)) continue
    const words = parsed.c.filter(
      (w): w is { t?: unknown; c?: unknown } => w !== null && typeof w === 'object'
    )
    const text = words.map((w) => (typeof w.c === 'string' ? w.c : '')).join('')
    if (!text) continue
    let buf = `[${msToLrcTime(lineMs)}]`
    for (const w of words) {
      const wt = Number(w.t)
      const ch = typeof w.c === 'string' ? w.c : ''
      if (ch) buf += Number.isFinite(wt) ? `[${msToLrcTime(wt)}]${ch}` : ch
    }
    out.push(buf)
  }
  return out.join('\n')
}

/**
 * Local Netease `.yrc` files use a different (non-JSON) karaoke format:
 * `[lineStart,lineDur](wordStart,wordDur,vol)word (wordStart2,...)word2`
 * (JSON metadata lines starting with `{` are skipped). Convert to the same
 * inline-timestamp LRC the NCM `yrcToInlineLrc` produces, so the lyrics page
 * can render word-by-word karaoke from local files too.
 */
export function localYrcToInlineLrc(yrc: string): string {
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('{')) continue
    const m = line.match(/^\[(\d+),\d+\]([\s\S]*)$/)
    if (!m) continue
    const lineMs = Number(m[1])
    if (!Number.isFinite(lineMs)) continue
    const rest = m[2]
    let buf = `[${msToLrcTime(lineMs)}]`
    const re = /\((\d+),\d+,\d+\)/g
    let last = 0
    let wm: RegExpExecArray | null
    let hasWord = false
    while ((wm = re.exec(rest))) {
      const text = rest.slice(last, wm.index)
      last = wm.index + wm[0].length
      if (text) {
        hasWord = true
        buf += `[${msToLrcTime(Number(wm[1]))}]${text}`
      }
    }
    const tail = rest.slice(last)
    if (tail) {
      hasWord = true
      buf += tail
    }
    if (hasWord) out.push(buf)
  }
  return out.join('\n')
}

/** Plain LRC (line timestamps only) from a local `.yrc` — used when a song has
 *  a `.yrc` but no `.lrc`. */
export function localYrcToLrc(yrc: string): string {
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('{')) continue
    const m = line.match(/^\[(\d+),\d+\]([\s\S]*)$/)
    if (!m) continue
    const text = m[2].replace(/\(\d+,\d+,\d+\)/g, '').trim()
    if (!text) continue
    out.push(`[${msToLrcTime(Number(m[1]))}]${text}`)
  }
  return out.join('\n')
}

export async function appendLyric(
  name: string,
  lyric: string,
  karaoke?: string | null
): Promise<void> {
  if (!lyric) return
  await ensureAidjDir()
  const line = JSON.stringify({ name, lyric, ...(karaoke ? { karaoke } : {}) }) + '\n'
  await appendFile(getLyricsPath(), line, 'utf-8')
}

/**
 * Resolve LRC text for a DBus-reported track title. Exact name first, then a
 * few pragmatic fallbacks (strip trailing " - Artist", strip bracket noise),
 * then a shortest-key substring match so "Song（翻唱）" still finds "Song".
 */
export function resolveLyricForTrack(track: string, lyrics: Map<string, string>): string | null {
  if (!track) return null
  const t = track.trim()
  if (lyrics.has(t)) return lyrics.get(t) ?? null
  const base = t
    .replace(/\s+-\s+.+$/, '')
    .replace(/[（）()【】[\]]/g, ' ')
    .trim()
  if (base && lyrics.has(base)) return lyrics.get(base) ?? null
  // Aggressive fold: drop every non-letter/number (dashes, brackets, full-width
  // punctuation) so "EarnedIt(FiftyShadesOfGrey)" hits
  // "The Weeknd - Earned It (Fifty Shades Of Grey)".
  const compact = base.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  let best: string | null = null
  if (compact) {
    for (const [name, lrc] of lyrics) {
      const key = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      if (key.includes(compact) && (best === null || key.length < best.length)) best = lrc
    }
  }
  return best
}

/**
 * Resolve LRC text by the ON-DISK track path (from MPRIS `xesam:url`) — the
 * lyric scan keys are the `.lrc` basenames, which usually equal the audio
 * basename, so this is an exact hit even when the DBus title drops the artist
 * prefix ("Earned It ..." vs "The Weeknd - Earned It ..."). Falls back to the
 * title-based resolver when the path is unknown.
 */
export function resolveLyricForTrackPath(
  path: string | null,
  track: string,
  lyrics: Map<string, string>
): string | null {
  if (path) {
    const name = basename(path)
      .replace(/\.[^.]+$/, '')
      .trim()
    if (name && lyrics.has(name)) return lyrics.get(name) ?? null
    // "Artist - Title.lrc" names: also try the bare title part.
    const titleOnly = name.replace(/^.+?\s+-\s+/, '').trim()
    if (titleOnly && titleOnly !== name && lyrics.has(titleOnly))
      return lyrics.get(titleOnly) ?? null
  }
  return resolveLyricForTrack(track, lyrics)
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
  lyrics: Map<string, string>
  karaoke: Map<string, string>
} | null = null
let _libraryLoading: Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> | null = null

export function loadLibrary(): Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> {
  if (_libraryCache) return Promise.resolve(_libraryCache)
  if (!_libraryLoading) {
    _libraryLoading = (async () => {
      const config = await loadAidjConfig()
      const folders = config?.music_folders ?? []
      const musicPaths = await scanMusicFiles(folders)
      const metadata = await loadMetadata()
      const { lyrics, karaoke } = await loadLyrics()
      _libraryCache = { metadata, musicPaths, lyrics, karaoke }
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
): Promise<{ sid: number | null; lyric: string; karaoke: string; networkError: boolean }> {
  const started = Date.now()
  try {
    const sRes = await fetch(
      `${ncmBaseUrl}/search?keywords=${encodeURIComponent(keywords)}&limit=1`
    )
    const sData = (await sRes.json()) as {
      code: number
      result: { songCount: number; songs: { id: number }[] }
    }
    if (sData.code !== 200 || !sData.result?.songCount) {
      log.debug('NCM search: no result', {
        keywords,
        code: sData.code,
        latencyMs: Date.now() - started
      })
      return { sid: null, lyric: '', karaoke: '', networkError: false }
    }
    const sid = sData.result.songs[0].id
    const lRes = await fetch(`${ncmBaseUrl}/lyric?id=${sid}`)
    const lData = (await lRes.json()) as {
      code: number
      lrc: { lyric: string }
      yrc?: { lyric: string }
    }
    const lyric = lData.code === 200 ? (lData.lrc?.lyric ?? '') : ''
    const yrc = lData.code === 200 && lData.yrc?.lyric ? lData.yrc.lyric : ''
    const karaoke = yrc ? yrcToInlineLrc(yrc) : ''
    log.debug('NCM search ok', {
      keywords,
      sid,
      songCount: sData.result.songCount,
      lyricLen: lyric.length,
      karaokeLen: karaoke.length,
      latencyMs: Date.now() - started
    })
    return { sid, lyric, karaoke, networkError: false }
  } catch (e) {
    log.warn('NCM search failed', { keywords, error: String(e) })
    return { sid: null, lyric: '', karaoke: '', networkError: true }
  }
}

export async function extractMetadataAi(
  client: OpenAI,
  name: string,
  lyric: string,
  model: string
): Promise<{ meta: SongMeta | null; error?: string }> {
  const started = Date.now()
  try {
    const info = { title: name, lyrics: lyric.slice(0, 500) }
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content: `You are a music metadata annotator. Given a song title and its lyrics (which may be partial or missing), return a JSON object with EXACTLY these fields:
- "language": string — the dominant language of the song, e.g. "Chinese", "English", "Japanese", "Cantonese". Use "Unknown" when the lyrics are empty.
- "emotion": string or string[] — one to three concise mood keywords, e.g. "nostalgic", "upbeat", "melancholic".
- "genre": string or string[] — one to three genre tags, e.g. "indie rock", "city pop", "folk".
- "loudness": string — a coarse intensity descriptor: "soft", "medium", or "loud". Infer it from the song style implied by the title and lyrics, never from the lyrics text itself.
- "review": string — a vivid 1-2 sentence review of the song.

RULES:
- Use a string[] for "emotion" and "genre" when there are multiple values; otherwise use a plain string.
- Only infer from the information provided. Never invent facts about the artist, release year, or awards.
- When the lyrics are empty, rely on the title alone and set "language" to "Unknown".`
          },
          { role: 'user', content: JSON.stringify(info) }
        ],
        response_format: { type: 'json_object' }
      },
      { timeout: 30_000 }
    )
    const content = resp.choices[0]?.message?.content
    if (!content) {
      log.debug('Metadata extraction: empty', { name, latencyMs: Date.now() - started })
      return { meta: null, error: 'AI 返回空内容' }
    }
    const parsed = JSON.parse(content) as SongMeta
    log.debug('Metadata extracted', {
      name,
      model,
      lyricLen: lyric.length,
      parsed,
      latencyMs: Date.now() - started
    })
    return { meta: parsed }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.warn('extractMetadataAi failed', { name, error })
    return { meta: null, error }
  }
}

/** Names currently being metadata-synced by some caller — concurrent syncs skip
 *  them so the same (expensive) AI generation + jsonl line never happens twice. */
const _syncing = new Set<string>()

export async function syncMetadata(
  client: OpenAI,
  missing: Map<string, string>,
  metadata: Map<string, SongMeta>,
  model: string,
  concurrency: number,
  onProgress?: (p: MetadataSyncProgress) => void,
  lyrics?: Map<string, string>
): Promise<{ metadata: Map<string, SongMeta>; counts: MetadataSyncCounts }> {
  const counts: MetadataSyncCounts = { ok: 0, noLyric: 0, failed: 0, networkError: 0 }
  if (!missing.size) return { metadata, counts }
  const entries = [...missing.entries()].filter(([name]) => {
    if (_syncing.has(name)) return false
    _syncing.add(name)
    return true
  })
  if (!entries.length) return { metadata, counts }
  log.info(`Syncing ${entries.length} songs... concurrency=${concurrency}`)
  const workers = Math.min(concurrency, entries.length)
  let done = 0
  try {
    await Promise.allSettled(
      Array.from({ length: workers }, async (_, i) => {
        for (let j = i; j < entries.length; j += workers) {
          const [name] = entries[j]
          const { sid, lyric, karaoke, networkError } = await searchNcmApi(name)
          if (sid === null) {
            if (networkError) {
              counts.networkError++
              log.warn('Metadata sync: NCM unreachable', { name })
              onProgress?.({
                done: ++done,
                total: entries.length,
                name,
                status: 'networkError',
                error: 'NCM API 连接失败'
              })
            } else {
              counts.noLyric++
              log.debug('Metadata sync: no result', { name })
              onProgress?.({
                done: ++done,
                total: entries.length,
                name,
                status: 'noLyric'
              })
            }
            continue
          }
          const { meta, error } = await extractMetadataAi(client, name, lyric, model)
          if (meta) {
            metadata.set(name, meta)
            await appendMetadata(name, meta)
            counts.ok++
            onProgress?.({
              done: ++done,
              total: entries.length,
              name,
              status: 'ok',
              sid,
              lyricLen: lyric.length,
              meta
            })
          } else {
            counts.failed++
            log.warn('Metadata sync: extraction failed', { name, sid, error })
            onProgress?.({
              done: ++done,
              total: entries.length,
              name,
              status: 'failed',
              sid,
              lyricLen: lyric.length,
              error
            })
          }
          // Persist the fetched LRC for the desktop-lyrics window regardless of
          // whether AI metadata extraction succeeded. A locally curated .lrc
          // (lyrics_folders) already in the cache wins over the NCM result.
          if (lyric && (!lyrics || !lyrics.has(name))) {
            await appendLyric(name, lyric, karaoke)
            if (lyrics) lyrics.set(name, lyric)
            if (karaoke && _libraryCache?.karaoke) _libraryCache.karaoke.set(name, karaoke)
          }
        }
      })
    )
  } finally {
    for (const [name] of entries) _syncing.delete(name)
  }
  log.info('Metadata sync done', {
    total: entries.length,
    ...counts
  })
  return { metadata, counts }
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
          // A listed bus name can be stale (owner just exited) — Introspect on
          // it would hang forever, so race each probe against a timeout.
          const obj = await withTimeout(
            this.bus!.getProxyObject(name, '/org/mpris/MediaPlayer2'),
            3000,
            null
          )
          if (!obj) continue
          const props = obj.getInterface(
            'org.freedesktop.DBus.Properties'
          ) as unknown as PropertiesInterface
          const statusV = await withTimeout(
            props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus'),
            3000,
            { value: '', signature: '' }
          )
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
      this.playerProxy = await withTimeout(
        this.bus!.getProxyObject(target, '/org/mpris/MediaPlayer2'),
        4000,
        null
      )
      if (!this.playerProxy) return false
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

  /**
   * Richer playback snapshot for the desktop-lyrics window: adds artist /
   * album / position (µs) / length (µs) / media URL. A single DBus round-trip
   * group.
   */
  async getPlaybackDetail(): Promise<{
    ok: boolean
    status: PlayerStatus['status']
    track: string
    artist: string
    album: string
    positionMs: number | null
    lengthMs: number | null
    /** raw `xesam:url` — used to resolve the exact file path for cover art */
    url: string
  }> {
    const unreachable = {
      ok: false,
      status: 'Unknown' as PlayerStatus['status'],
      track: '',
      artist: '',
      album: '',
      positionMs: null as number | null,
      lengthMs: null as number | null,
      url: ''
    }
    try {
      if (this._autoMode) {
        // autoDetectPlayer only returns a NAME — it must be actually bound
        // (playerProxy/propsProxy) before reading properties, otherwise
        // props.Get below throws on null. ensureBound does the binding.
        const ok = await this.ensureBound()
        if (!ok) return unreachable
      } else if (!this.propsProxy) {
        return unreachable
      }
      const props = this.propsProxy as unknown as PropertiesInterface
      const statusV = await props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus')
      const metaV = await props.Get('org.mpris.MediaPlayer2.Player', 'Metadata')
      const posV = await props.Get('org.mpris.MediaPlayer2.Player', 'Position')
      const rawMeta = metaV.value as Record<string, unknown>
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawMeta ?? {})) {
        meta[k] = unwrapVariant(v)
      }
      const artistRaw = meta['xesam:artist']
      const artist = Array.isArray(artistRaw)
        ? (artistRaw as unknown[]).map(String).join(' / ')
        : String(artistRaw ?? '')
      const album = String(meta['xesam:album'] ?? '')
      const length = Number(meta['mpris:length'] ?? 0)
      const position = Number(unwrapVariant(posV.value) ?? 0)
      return {
        ok: true,
        status: statusV.value as string as PlayerStatus['status'],
        track: this.resolveTrackName(meta),
        artist,
        album,
        positionMs: position > 0 ? Math.round(position / 1000) : null,
        lengthMs: length > 0 ? Math.round(length / 1000) : null,
        url: String(meta['xesam:url'] ?? '')
      }
    } catch (e) {
      log.warn('getPlaybackDetail failed', { error: String(e) })
      return unreachable
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
      // dbus-next's Properties.Set requires an actual Variant instance — a plain
      // {signature, value} object throws "Expected a Variant() argument", which
      // previously made every setVolume silently fail (caught → false), so the
      // volume never changed.
      const { Variant } = await import('dbus-next')
      await props.Set(
        'org.mpris.MediaPlayer2.Player',
        'Volume',
        new Variant('d', Math.max(0, Math.min(1, vol)))
      )
      return true
    } catch (e) {
      log.warn('setVolume failed', { vol, error: String(e) })
      return false
    }
  }

  async getVolume(): Promise<number | null> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return null
      if (!this.propsProxy) return null
      const props = this.propsProxy as unknown as PropertiesInterface
      const v = await props.Get('org.mpris.MediaPlayer2.Player', 'Volume')
      const val = unwrapVariant(v?.value)
      return typeof val === 'number' ? val : null
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
    let name = clean.split('/').pop() || clean
    // URL path segments are percent-encoded (e.g. `%E5%AE%89%E9%9D%99%20-%20...`
    // = "安静 - ..."); strip any query string, drop the extension, then decode
    // so the UI shows the real track name instead of the raw encoding.
    const noQuery = name.split('?')[0]
    const ext = noQuery.lastIndexOf('.')
    name = ext > 0 ? noQuery.slice(0, ext) : noQuery
    try {
      return decodeURIComponent(name)
    } catch {
      return name
    }
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
    // ffprobe's -show_streams almost never includes max_peak/max_rms side data
    // (so the old code read 0 dB for every file → all songs "identical"). Use
    // ffmpeg -af filter graphs and parse their stderr instead:
    //   ebur128      → integrated LUFS (Summary block) + true peak
    //   volumedetect → mean/max dB (RMS + peak fallback)
    // -vn drops cover-art video streams, which would otherwise be picked as the
    // output stream (volumedetect then measures nothing); -af maps the audio
    // stream automatically (unlike -filter_complex + -map, which errors on
    // files with attached-pic video streams).
    try {
      const [lufsOut, volOut] = await Promise.all([
        this.runFfmpeg(filepath, ['-af', 'ebur128=peak=true', '-f', 'null', '-']),
        this.runFfmpeg(filepath, ['-af', 'volumedetect', '-f', 'null', '-'])
      ])

      // ebur128 prints per-0.1s progress lines then a "Summary:" block whose
      // "I:" is the FINAL integrated loudness. Match only inside the summary,
      // otherwise the first progress line's starting value (-70) is picked up.
      const summary = lufsOut.slice(lufsOut.lastIndexOf('Summary:'))
      const lufsMatch = summary.match(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
      const peakMatch = summary.match(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/)
      const integratedLufs = lufsMatch ? Number(lufsMatch[1]) : null
      const truePeak = peakMatch ? Number(peakMatch[1]) : null

      // volumedetect stderr: "mean_volume: -16.4 dB" / "max_volume: -2.1 dB"
      const meanMatch = volOut.match(/mean_volume:\s+(-?\d+(?:\.\d+)?)\s+dB/)
      const maxMatch = volOut.match(/max_volume:\s+(-?\d+(?:\.\d+)?)\s+dB/)
      const meanDb = meanMatch ? Number(meanMatch[1]) : null
      const maxDb = maxMatch ? Number(maxMatch[1]) : null

      // peak_db: prefer the ebur128 true peak, else volumedetect max.
      const peakDb = truePeak ?? maxDb
      // Require at least one USABLE loudness value (RMS or LUFS). A missing
      // measurement is never fabricated into 0 dB — that would read as "full
      // scale" and blow the volume up when compared to a negative anchor.
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

  /** Run ffmpeg and return combined stderr (filter graphs report there). */
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
   * no anchor or no usable measurement — callers must SKIP (leave the volume
   * untouched) rather than apply a bogus value.
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

  /**
   * Establish the loudness anchor from `filepath`. Returns the anchor value on
   * success, or null when the file can't be measured — in which case the caller
   * must skip (no anchor is set, so later tracks keep retrying).
   */
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

  /** Change only the base volume (the "50% reference"), keeping the current
   *  anchor unchanged. Used when the user manually adjusts volume and wants
   *  that level to become the center of the balance curve. */
  setBaseVol(base: number): void {
    this._baseVol = base
  }

  /** Target volume for `filepath`, or null when it can't be measured (skip). */
  async targetVolume(filepath: string): Promise<number | null> {
    if (this._anchorVal == null) return null
    const info = await this.get(filepath)
    const songVal = this.loudnessKey(info)
    return this.computeVolume(songVal)
  }
}

/** Tokenize a song name the same way tokenSortRatio compares (punctuation →
 *  whitespace, then words). Used to build bestMatch's candidate index. */
function splitNameTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of text
    .toLowerCase()
    .split(/[\s,，、。.\-()（）]+/)
    .filter(Boolean)) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

export class DJSession {
  client: OpenAI
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  config: AidjConfig
  chatHistory: ChatMessage[]
  turnCount: number
  playedSongs: Set<string>
  /** Cumulative prompt tokens across all requests in this session. */
  promptTokens: number
  /** Cumulative completion tokens across all requests in this session. */
  completionTokens: number
  /** Per-request context: the prompt (input) tokens of the most recent request. */
  lastPromptTokens: number
  /** Per-request context: the completion (output) tokens of the most recent request. */
  lastCompletionTokens: number
  /** Memoized validKeys() result + its library-size signature. */
  private _validKeysCache: string[] | null = null
  private _validKeysSig = ''
  /** Token index for bestMatch: lowercased-name → canonical, token → names. */
  private _nameMap: Map<string, string> = new Map()
  private _tokenIndex: Map<string, string[]> = new Map()
  private _tokenSig = ''

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
    this.lastPromptTokens = 0
    this.lastCompletionTokens = 0
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
    // Rebuilding the filtered key list per parseRawPlaylist call re-allocates a
    // 3k+ array on every message — during sessions.open that's ~30×. Memoize by
    // library size (additions always change the size) to keep session loads fast.
    const sig = `${this.musicPaths.size}:${this.metadata.size}`
    if (this._validKeysCache && this._validKeysSig === sig) return this._validKeysCache
    this._validKeysCache = [...this.metadata.keys()].filter((k) => this.musicPaths.has(k))
    this._validKeysSig = sig
    return this._validKeysCache
  }

  /** (Re)build the name/token index used by bestMatch when the library grows. */
  private ensureTokenIndex(): void {
    const sig = `${this.musicPaths.size}:${this.metadata.size}`
    if (this._tokenSig === sig) return
    this._nameMap = new Map()
    this._tokenIndex = new Map()
    for (const name of this.validKeys()) {
      this._nameMap.set(name.toLowerCase(), name)
      for (const tok of splitNameTokens(name)) {
        const list = this._tokenIndex.get(tok)
        if (list) list.push(name)
        else this._tokenIndex.set(tok, [name])
      }
    }
    this._tokenSig = sig
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

  /** Find best match for `query` among `candidates`. Fast path: exact
   *  lowercased lookup, then a shared-token candidate pool (usually a handful
   *  of names) instead of scoring every library key — a session load with
   *  hundreds of playlist lines otherwise blocks the main process for seconds. */
  private bestMatch(query: string, candidates: string[]): string | null {
    this.ensureTokenIndex()
    const ql = query.toLowerCase().trim()
    const exact = this._nameMap.get(ql)
    if (exact) return exact

    const pool = new Set<string>()
    for (const tok of splitNameTokens(ql)) {
      const list = this._tokenIndex.get(tok)
      if (!list) continue
      for (const n of list) pool.add(n)
    }
    const scope = pool.size > 0 ? [...pool] : candidates

    let best: string | null = null
    let bestScore = 0
    for (const c of scope) {
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
    const keys = this.validKeys()

    if (rawText.includes(SEPARATOR)) {
      const parts = rawText.split(SEPARATOR)
      introText = parts[0].trim()
      const rawListBlock = parts.slice(1).join(SEPARATOR)
      log.debug('Separator found, parsing list')
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
          log.debug(`Matched: ${clean} -> ${match}`)
          playlistNames.push(match)
        } else {
          log.debug(`Ignored line: ${clean}`)
        }
      }
    } else {
      introText = rawText.trim()
      if (source === 'AI') {
        log.debug('No separator found. Treating as pure conversation.')
      }
    }

    const unique = [...new Set(playlistNames)]
    const playlist: PlaylistEntry[] = []
    for (const name of unique) {
      if (source === 'AI') this.playedSongs.add(name)
      const path = this.musicPaths.get(name)
      if (path) playlist.push({ name, path })
    }
    log.debug('Playlist parsed', {
      source,
      hasSeparator: rawText.includes(SEPARATOR),
      rawLines: rawText.split('\n').filter((l) => l.trim()).length,
      matched: playlistNames.length,
      unique: unique.length,
      resolved: playlist.length,
      names: playlist.map((s) => s.name)
    })
    return { playlist, intro: introText }
  }

  /** Compact old conversation messages into a summary via the AI. Never includes the library prompt. */
  private async compactConversation(messages: ChatMessage[]): Promise<string> {
    if (!messages.length) return ''
    try {
      const instruction = `You are a context compactor for an AI music DJ chat session.
Your ONLY job is to summarize the conversation history.
RULES:
- DO NOT mention any specific song names, track titles, or library keys.
- Summarize what the user talked about and the general types, genres, and moods of music they played or requested.
- Preserve any persistent user constraints or preferences stated during the conversation (e.g. disliked genres, desired mood direction).
- Keep the summary concise (at most 200 words), written in the dominant language of the conversation.
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
      log.debug('Compacted conversation', {
        messagesIn: messages.length,
        summaryLength: content.length,
        summary: content
      })
      return content
    } catch (e) {
      log.warn('compactConversation failed', { error: String(e) })
      return ''
    }
  }

  /**
   * Keep the chat history balanced. The library/system prompt (index 0) is always kept and
   * never sent for compaction.
   * - drop (discard): keep [0] + last (max-1); insert an empty `updated` marker so raw
   *   history replay knows everything before it is dropped.
   * - compact: send all conversation messages (except index 0) to the AI for a summary;
   *   replace with [0] + `[Context Summary]` marker.
   * Returns the marker to persist to history.jsonl, or null if nothing changed.
   */
  private async manageContext(): Promise<RawHistoryMessage | null> {
    const max = Math.max(2, this.config.preferences.max_history_length || 10)
    if (this.chatHistory.length <= max) return null
    const previous = this.chatHistory.length
    const mode = this.config.preferences.context_mode || 'discard'
    const keep = this.chatHistory[0]
    const now = Date.now()

    let updatedContent = ''
    if (mode === 'compact') {
      const toCompact = this.chatHistory.slice(1)
      if (toCompact.length > 0) {
        const summary = await this.compactConversation(toCompact)
        if (summary) {
          updatedContent = `[Context Summary] ${summary}`
        }
      }
    }

    const marker: RawHistoryMessage = {
      role: 'system',
      content: updatedContent,
      ts: now,
      type: 'updated'
    }

    if (updatedContent) {
      this.chatHistory = [keep, { role: 'system', content: updatedContent, timestamp: now }]
    } else {
      this.chatHistory = [
        keep,
        { role: 'system', content: '', timestamp: now },
        ...this.chatHistory.slice(-(max - 1))
      ]
    }
    log.debug('Context trimmed', {
      mode,
      max,
      previous,
      kept: this.chatHistory.length,
      summaryChars: updatedContent.length
    })
    return marker
  }

  /**
   * Build the full system prompt (role + rules + music library) injected at the
   * front of chatHistory. Reused by nextStep (first turn) and when loading a
   * saved session — the persisted history.jsonl never stores the system prompt.
   */
  buildSystemPrompt(): string {
    const persona = (this.config.preferences.persona || '').trim() || DEFAULT_PERSONA
    const extraRules = (this.config.preferences.extra_rules || '').trim()
    const extraRulesBlock = extraRules
      ? `### ADDITIONAL USER RULES
${extraRules}

`
      : ''

    const basePrompt = `### ROLE DEFINITION
${persona}

### DATA SOURCE (CRITICAL)
You are provided with a **Music Library**.
- **RESTRICTION:** You can ONLY select songs that exist EXACTLY in the provided Library.
- **PROHIBITION:** Do NOT hallucinate songs. Do NOT translate song titles. Do NOT fix typos in the library keys. Do NOT split or recombine keys.
- If no songs in the library fit the mood, just chat and DO NOT output the separator.

${extraRulesBlock}### OUTPUT PROTOCOL (STRICT)
Your output is parsed by a script. Follow this structure exactly:

**Part 1 — The Intro**
A rich, paragraph-length DJ commentary. Use Markdown bolding for emphasis.

**Part 2 — The Payload** (only if at least one matching song exists)
${SEPARATOR} (on its own line)
Exact song keys from the Library, one per line.

**FORMATTING RULES:**
1. Place ${SEPARATOR} on its own line, surrounded by blank lines.
2. After the separator, list ONLY library keys — one key per line.
3. NEVER add numbering, bullets, quotes, colons, or any other decoration to key lines.
4. Use the keys EXACTLY as they appear in the Library. Never invent, rename, or "clean up" a key.
5. Stop immediately after the last key. No trailing commentary, no summary after the list.`

    const libraryStr = this.formatLibrary()
    return `${basePrompt}\n\n### CURRENT MUSIC LIBRARY (Exact Keys Only):\n${libraryStr}`
  }

  async nextStep(
    userRequest: string,
    onStream?: (text: string) => void,
    signal?: AbortSignal,
    onRetry?: (attempt: number, waitMs: number, error?: unknown) => void
  ): Promise<{
    playlist: PlaylistEntry[]
    intro: string
    /** Full raw assistant text (may contain the SONG_LIST separator). */
    raw: string
    updated?: RawHistoryMessage | null
  }> {
    this.turnCount++
    const model = this.config.preferences.model

    log.debug(`Thinking with ${model}...`)

    // Inject the library/system prompt at the FRONT before manageContext runs,
    // so manageContext's `keep = chatHistory[0]` always preserves it.
    if (this.turnCount === 1) {
      this.chatHistory.unshift({
        role: 'system',
        content: this.buildSystemPrompt(),
        timestamp: Date.now()
      })
      log.debug('Library injected once')
    }

    const updated = await this.manageContext()

    const forbiddenList = this.playedSongs.size > 0 ? [...this.playedSongs].join(', ') : 'None'
    const fullReq = `User Request: "${userRequest}"

Constraints:
1. Language: The 'User Request' block above is a system instruction, NOT the user's own words — do not match its language. Write the [Intro] in the language the user actually writes in (their original request and earlier chat messages in this session).
2. No repeats: Do NOT reuse any song from the forbidden list: [${forbiddenList}].
3. Matching: Look up songs in the Music Library from the first System message. If at least one matches, output Intro + ${SEPARATOR} + SongKeys. If none match, output ONLY the Intro.`

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
          onRetry: (attempt, waitMs, err) => {
            log.warn('AI network retry', { attempt, waitMs, error: String(err) })
            onRetry?.(attempt, waitMs, err)
          }
        }
      )

      let fullContent = ''
      for await (const chunk of stream) {
        if (chunk.usage) {
          this.lastPromptTokens = chunk.usage.prompt_tokens ?? 0
          this.lastCompletionTokens = chunk.usage.completion_tokens ?? 0
          this.promptTokens += this.lastPromptTokens
          this.completionTokens += this.lastCompletionTokens
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

      log.debug('AI raw output', {
        model,
        turnCount: this.turnCount,
        rawContent: cleanContent,
        playedSongsCount: this.playedSongs.size
      })

      this.chatHistory.push({ role: 'assistant', content: cleanContent, timestamp: Date.now() })
      return { ...this.parseRawPlaylist(cleanContent, 'AI'), raw: cleanContent, updated }
    } catch (e) {
      if (signal?.aborted) {
        this.chatHistory.pop()
        return { playlist: [], intro: '', raw: '', updated }
      }
      const errMsg = String(e)
      log.error('AI API error', { error: errMsg })
      this.chatHistory.pop()
      return { playlist: [], intro: `⚠️ API 错误: ${errMsg}`, raw: '', updated }
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
  promptTokens = 0
  completionTokens = 0
  /** Per-request context: the prompt (input) tokens of the most recent batch. */
  lastPromptTokens = 0
  /** Per-request context: the completion (output) tokens of the most recent batch. */
  lastCompletionTokens = 0
  /** Latest user chat message awaiting the next batch — it becomes a
   *  USER DIRECTED phase (highest priority) instead of autonomous radio. */
  pendingUserPrompt: string | null = null
  /** Optional persistent session id — raw history is appended to history.jsonl when set. */
  sessionId = ''
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
    this.rollingHistory = []
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
    onRetry?: (attempt: number, waitMs: number, error?: unknown) => void
  ): Promise<PlaylistEntry[]> {
    if (this.working) return []
    this.working = true
    try {
      let phaseInstruction: string
      if (this.pendingUserPrompt) {
        const dir = this.pendingUserPrompt
        this.pendingUserPrompt = null
        phaseInstruction = `### USER DIRECTED REQUEST
New User Goal: '${dir}'
Priority: This is the user's LATEST direction — follow it over any earlier goal or the autonomous flow.
Target: Curate at least 8 tracks from the Library that match this new goal.
Language: Write the Intro in the same language as the New User Goal.`
      } else if (this.fetchCount === 0) {
        phaseInstruction = `### PHASE 1: INITIAL REQUEST
User Goal: '${this.initialPrompt}'
Target: Curate at least 8 tracks that match this goal.
Language: Write the Intro in the same language as the User Goal.`
      } else {
        const lastTracks = this.rollingHistory.slice(-15)
        const negativeHint =
          this.fetchCount < 3
            ? 'Keep honoring the original exclusions from the User Goal. '
            : 'You may gradually relax the original exclusions. '
        phaseInstruction = `### PHASE ${this.fetchCount + 1}: AUTONOMOUS RADIO FLOW
Recent Sequence: [${lastTracks.join(', ')}]
Task: Step beyond the original request — ignore its positive part. ${negativeHint}Based on the Recent Sequence, predict and curate the next logical musical chapter (at least 8 tracks).
Language: Write the Intro in the language of the user's original request ("${this.initialPrompt}") — match its language. Do NOT write in English unless that request is English.`
      }

      const fullPrompt = `${phaseInstruction}

**STRICT RULES:**
1. Output AT LEAST 8 tracks, all from the Library (exact keys).
2. Do NOT reuse any of these already-played keys: [${this.rollingHistory.join(', ')}].
3. If good matches run out, gradually shift to a complementary vibe (genre/emotion) instead of repeating.
4. Use EXACT library keys. NEVER hallucinate, translate, or modify a key.`

      const session = new DJSession(this.client, this.metadata, this.musicPaths, this.config)
      session.chatHistory = this.chatHistory.map((m) => ({ ...m }))
      session.playedSongs = new Set(this.rollingHistory)
      session.turnCount = this.fetchCount

      const { playlist, intro, raw, updated } = await session.nextStep(
        fullPrompt,
        undefined,
        signal,
        onRetry
      )
      if (signal?.aborted) {
        this.lastIntro = ''
        return []
      }
      this.chatHistory = session.chatHistory
      this.lastIntro = intro || ''
      this.lastPromptTokens = session.lastPromptTokens
      this.lastCompletionTokens = session.lastCompletionTokens
      this.promptTokens += session.promptTokens
      this.completionTokens += session.completionTokens

      if (this.sessionId) {
        const rawMsgs: RawHistoryMessage[] = []
        if (updated) rawMsgs.push(updated)
        rawMsgs.push(
          { role: 'user', content: fullPrompt, ts: Date.now(), type: 'model' },
          { role: 'assistant', content: raw || intro || '', ts: Date.now(), type: 'both', playlist }
        )
        await SessionManager.appendMessages(this.sessionId, rawMsgs)
      }

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
      this.lastIntro = ''
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
    onRetry?: (attempt: number, waitMs: number, error?: unknown) => void
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
      // Establish the anchor from this track. If it can't be measured, skip
      // (leave volume untouched); the next track retries. Never guess a value.
      const anchor = await this.volCache.setAnchor(track.path, 0.5)
      if (anchor != null) {
        await this.dbus.setVolume(0.5)
        this._anchorValue = anchor
      }
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
    this.pendingUserPrompt = content
    this.chatHistory.push({ role: 'user', content, timestamp: Date.now() })
    if (this.sessionId) {
      void SessionManager.appendMessage(this.sessionId, {
        role: 'user',
        content,
        ts: Date.now(),
        type: 'user'
      }).catch((e) => log.warn('persist user message failed', { error: String(e) }))
    }
  }

  clearMemory(): void {
    this.rollingHistory = []
    this.fetchCount = 0
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

/**
 * Lightweight AIDJ activation — initializes the SHARED DBus manager (the same
 * one the main AIDJ page uses) from config, so the lyrics page can bind to a
 * player without the user first starting an AIDJ session. No OpenAI client /
 * library scan, just the player binding. Idempotent: reuses an existing
 * session manager (the main AIDJ page is keep-alive, so once bound it stays).
 */
export async function activateAidjDbus(): Promise<{ ok: boolean; error?: string }> {
  const config = await loadAidjConfig()
  if (!config) return { ok: false, error: 'AIDJ 配置未找到，请先在设置里配置' }
  try {
    if (!getDbusManager()) {
      await initDbusManager(config)
    }
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.warn('activateAidjDbus failed', { error })
    return { ok: false, error }
  }
}

// ---------------------------------------------------------------------------
// Desktop-lyrics playback probe — binds to the AIDJ session's CURRENTLY SET
// DBus player (the one the user selected / configured), so the lyrics window
// follows exactly what AIDJ is bound to. The lyrics window polls `aidj.lyrics`
// (≈1 Hz) and this resolves the LRC text for the current track.
// ---------------------------------------------------------------------------
let _lyricsDbus: DBusManager | null = null

/** Race a promise against a timeout — DBus calls (Introspect etc.) can hang
 *  forever when the target bus name is stale; never block the caller. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }).catch(() => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

async function getLyricsDbus(): Promise<DBusManager | null> {
  // Prefer the session manager — it carries the user's current DBus binding
  // (switchPlayer / config.preferences.dbus_target).
  const session = getDbusManager()
  if (session) return session
  if (!_lyricsDbus) {
    const config = await loadAidjConfig()
    const dbus = new DBusManager(config?.preferences?.dbus_target ?? 'vlc')
    const ok = await withTimeout(dbus.connect(), 4000, false)
    if (!ok) return null
    _lyricsDbus = dbus
  }
  return _lyricsDbus
}

/**
 * Resolve the on-disk path of the currently playing track. Prefers the exact
 * `file://` URL reported by MPRIS (players usually expose `xesam:url`); falls
 * back to an exact (then " - artist"-stripped) match against the library's
 * name→path map, which is keyed by file name.
 */
function resolveTrackPath(
  detail: { url: string; track: string },
  musicPaths: Map<string, string>
): string | null {
  const url = detail.url
  if (url.startsWith('file://')) {
    let p = url.slice('file://'.length)
    if (p.startsWith('localhost/')) p = p.slice('localhost/'.length)
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  }
  if (!detail.track) return null
  if (musicPaths.has(detail.track)) return musicPaths.get(detail.track) ?? null
  const base = detail.track
    .replace(/\s+-\s+.+$/, '')
    .replace(/[（）()【】[\]]/g, ' ')
    .trim()
  if (base && base !== detail.track && musicPaths.has(base)) return musicPaths.get(base) ?? null
  return null
}

/** Current binding of the effective lyrics DBus (AIDJ session preferred). */
export async function getLyricPlayerBinding(): Promise<{ current: string; auto: boolean }> {
  const dbus = await getLyricsDbus()
  if (!dbus) return { current: '', auto: true }
  return { current: dbus.getPlayerName(), auto: dbus.autoMode }
}

/** Bind the lyrics source to a specific MPRIS player (or `__auto__`). Works even
 *  without an initialized AIDJ session — manages the lyrics-only DBus directly.
 *  DBus calls (Introspect) can hang indefinitely when the target bus name is
 *  stale (owner just exited), so both steps are raced against a timeout. */
export async function switchLyricsPlayer(playerName: string): Promise<boolean> {
  const session = getDbusManager()
  const mgr = session ?? (await getLyricsDbus())
  if (!mgr) return false
  return withTimeout(mgr.switchToPlayer(playerName), 4000, false)
}

export async function getLyricPlayback(): Promise<LyricPlaybackState> {
  const empty: LyricPlaybackState = {
    ok: false,
    status: 'Unknown',
    track: '',
    artist: '',
    album: '',
    player: '',
    positionMs: null,
    lengthMs: null,
    lyric: null
  }
  try {
    const dbus = await getLyricsDbus()
    if (!dbus) return empty
    const detail = await dbus.getPlaybackDetail()
    // `ok: false` → the bound DBus player is unreachable (closed the window /
    // AIDJ never bound). The lyrics window watches this and closes itself.
    if (!detail.ok) return empty
    // Player reachable but nothing loaded yet — keep the window, show "waiting".
    if (!detail.track) {
      return {
        ...empty,
        ok: true,
        status: detail.status,
        player: dbus.resolvedPlayerName,
        positionMs: detail.positionMs,
        lengthMs: detail.lengthMs
      }
    }
    const lib = await loadLibrary()
    const path = resolveTrackPath(detail, lib.musicPaths)
    const lyric = resolveLyricForTrackPath(path, detail.track, lib.lyrics)
    const karaokeLyric = resolveLyricForTrackPath(path, detail.track, lib.karaoke) ?? null
    return {
      ok: true,
      status: detail.status,
      track: detail.track,
      artist: detail.artist,
      album: detail.album,
      player: dbus.resolvedPlayerName,
      positionMs: detail.positionMs,
      lengthMs: detail.lengthMs,
      path,
      lyric,
      karaokeLyric
    }
  } catch (e) {
    log.warn('getLyricPlayback failed', { error: e instanceof Error ? e.message : String(e) })
    return empty
  }
}

/**
 * Stable key for the desktop-lyrics window per DBus instance: the session's
 * currently bound player (forces auto mode to resolve once so the key doesn't
 * flip between polls), else the configured dbus_target. Two players → two
 * independent lyrics windows, each single-instance.
 */
export async function getCurrentPlayerKey(): Promise<string> {
  const dbus = getDbusManager()
  if (dbus) {
    if (dbus.resolvedPlayerName) return dbus.resolvedPlayerName
    if (dbus.autoMode) {
      // Bind auto mode once so the key is stable from now on.
      await dbus.getStatus()
      if (dbus.resolvedPlayerName) return dbus.resolvedPlayerName
    }
    const name = dbus.getPlayerName()
    if (name && name !== '__auto__') return name
  }
  const config = await loadAidjConfig()
  return config?.preferences?.dbus_target || 'auto'
}

// ---------------------------------------------------------------------------
// Shared player-list cache — every view (main page, continuous, chat) polls
// aidj.list-players every few seconds, and each listPlayers() call spins up a
// fresh session bus just to ListNames. Cache the result across all consumers
// for a short TTL so we scan the bus once and everyone else reuses it. The
// list changes slowly (players start/stop), so 2s staleness is imperceptible
// while cutting dozens of bus round-trips.
// ---------------------------------------------------------------------------
let _playersCache: { list: string[]; at: number } | null = null
const PLAYERS_TTL = 2000

/** List MPRIS players, cached for PLAYERS_TTL across all callers. */
export async function listAvailablePlayers(force = false): Promise<string[]> {
  if (!force && _playersCache && Date.now() - _playersCache.at < PLAYERS_TTL) {
    return _playersCache.list
  }
  let list: string[]
  if (_dbusManager) {
    list = await _dbusManager.listPlayers()
  } else {
    try {
      const dbus = await import('dbus-next')
      const bus = dbus.sessionBus()
      const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
      const iface = obj.getInterface('org.freedesktop.DBus') as unknown as DBusDaemon
      const names: string[] = await iface.ListNames()
      bus.disconnect()
      list = names.filter((n: string) => n.startsWith('org.mpris.MediaPlayer2'))
    } catch (e) {
      log.warn('listAvailablePlayers failed', { error: String(e) })
      list = []
    }
  }
  _playersCache = { list, at: Date.now() }
  return list
}

/** Invalidate the player-list cache (e.g. after a player switch). */
export function invalidatePlayersCache(): void {
  _playersCache = null
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

// ---------------------------------------------------------------------------
// SessionManager — persist raw chat history per session (Stories-style).
//   ~/.config/LinuxCockpit/aidj/sessions/
//     main.json              # index: [{id, title, type, initialPrompt, created_at, updated_at}]
//     <session-id>/history.jsonl  # raw messages, append-only JSONL
//
// The system prompt (library injection) is NEVER stored here — it is always
// rebuilt from the current library when replaying context.
//
// All history.jsonl mutations are serialized via a per-session promise chain
// so an append during a truncateTail cannot lose data.
// ---------------------------------------------------------------------------
const historyLocks = new Map<string, Promise<void>>()

async function withHistoryLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = historyLocks.get(sessionId) ?? Promise.resolve()
  let resolve!: () => void
  const tail = new Promise<void>((r) => (resolve = r))
  const tailPromise = prev.then(() => tail)
  historyLocks.set(sessionId, tailPromise)
  await prev
  try {
    return await fn()
  } finally {
    resolve()
    if (historyLocks.get(sessionId) === tailPromise) historyLocks.delete(sessionId)
  }
}

export class SessionManager {
  static sessionsDir(): string {
    return SESSIONS_DIR
  }

  static async ensureIndex(): Promise<void> {
    await mkdir(SESSIONS_DIR, { recursive: true })
  }

  static async createSession(opts: {
    title: string
    type: 'chat' | 'generate'
    initialPrompt?: string
  }): Promise<string> {
    await this.ensureIndex()
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    const suffix = opts.type === 'chat' ? ' [持续]' : ' [生成]'
    const meta: SessionMeta = {
      id,
      title: `${opts.title}${suffix}`.slice(0, 60),
      type: opts.type,
      initialPrompt: opts.initialPrompt,
      created_at: now,
      updated_at: now
    }
    await withHistoryLock('__index__', async () => {
      const idx = (await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)) ?? { sessions: [] }
      idx.sessions.push(meta)
      await writeJsonAtomic(SESSIONS_INDEX, idx)
    })
    await mkdir(join(SESSIONS_DIR, id), { recursive: true })
    log.info('Session created', { id, title: meta.title, type: meta.type })
    return id
  }

  static async appendMessage(sessionId: string, msg: RawHistoryMessage): Promise<void> {
    return withHistoryLock(sessionId, async () => {
      await this.ensureIndex()
      const line = JSON.stringify(msg) + '\n'
      const p = join(SESSIONS_DIR, sessionId, 'history.jsonl')
      await appendFile(p, line, 'utf-8')
      await this.touchSession(sessionId)
    })
  }

  static async appendMessages(sessionId: string, msgs: RawHistoryMessage[]): Promise<void> {
    if (!msgs.length) return
    return withHistoryLock(sessionId, async () => {
      await this.ensureIndex()
      const p = join(SESSIONS_DIR, sessionId, 'history.jsonl')
      const data = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n'
      await appendFile(p, data, 'utf-8')
      await this.touchSession(sessionId)
    })
  }

  /** Read all raw history lines for a session. */
  static async readRawHistory(sessionId: string): Promise<RawHistoryMessage[]> {
    try {
      const text = await readFile(join(SESSIONS_DIR, sessionId, 'history.jsonl'), 'utf-8')
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as RawHistoryMessage
          } catch {
            return null
          }
        })
        .filter((m): m is RawHistoryMessage => m !== null)
    } catch {
      return []
    }
  }

  /** Truncate the last `n` lines from history.jsonl (revert support). Atomic write under lock. */
  static async truncateTail(sessionId: string, n: number): Promise<void> {
    if (n <= 0) return
    await withHistoryLock(sessionId, async () => {
      const all = await this.readRawHistory(sessionId)
      const keep = Math.max(0, all.length - n)
      const p = join(SESSIONS_DIR, sessionId, 'history.jsonl')
      await mkdir(SESSIONS_DIR, { recursive: true })
      const tmp = `${p}.tmp-${process.pid}`
      const text =
        all
          .slice(0, keep)
          .map((m) => JSON.stringify(m))
          .join('\n') + (keep > 0 ? '\n' : '')
      await writeFile(tmp, text, 'utf-8')
      await rename(tmp, p)
      await this.touchSession(sessionId)
      log.info('Session truncated (revert)', { sessionId, removed: n, kept: keep })
    })
  }

  static async listSessions(): Promise<SessionMeta[]> {
    const idx = await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)
    return idx?.sessions ?? []
  }

  static async getSession(sessionId: string): Promise<SessionMeta | null> {
    const all = await this.listSessions()
    return all.find((s) => s.id === sessionId) ?? null
  }

  static async touchSession(sessionId: string): Promise<void> {
    await withHistoryLock('__index__', async () => {
      const idx = (await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)) ?? { sessions: [] }
      const s = idx.sessions.find((x) => x.id === sessionId)
      if (s) {
        s.updated_at = Date.now()
        await writeJsonAtomic(SESSIONS_INDEX, idx)
      }
    })
  }

  /**
   * Fork a session into a new one, named `(Copy) <original>`. Optionally keep
   * only the first `n` raw history lines (branch-from-message). Returns the new
   * session id, or null when the source doesn't exist.
   */
  static async forkSession(
    sessionId: string,
    opts?: { keep?: number; title?: string }
  ): Promise<string | null> {
    const src = await this.getSession(sessionId)
    if (!src) return null
    const raw = await this.readRawHistory(sessionId)
    // keep is explicit when given: 0 = empty branch, N = first N raw lines.
    // Absent = copy everything.
    const kept = opts?.keep !== undefined && opts.keep >= 0 ? raw.slice(0, opts.keep) : raw
    const base = (src.title || '')
      .replace(/^\s*\(Copy\)\s*/, '')
      .replace(/\s+\[(持续|生成)\]$/, '')
      .trim()
    const newId = await this.createSession({
      title: opts?.title ?? `(Copy) ${base}`.trim(),
      type: src.type
    })
    if (kept.length) await this.appendMessages(newId, kept)
    log.info('Session forked', { from: sessionId, id: newId, kept: kept.length })
    return newId
  }

  /** Remove a session from the index and delete its history directory. */
  static async deleteSession(sessionId: string): Promise<boolean> {
    return withHistoryLock('__index__', async () => {
      const idx = (await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)) ?? { sessions: [] }
      const before = idx.sessions.length
      idx.sessions = idx.sessions.filter((s) => s.id !== sessionId)
      if (idx.sessions.length === before) return false
      await writeJsonAtomic(SESSIONS_INDEX, idx)
      await rm(join(SESSIONS_DIR, sessionId), { recursive: true, force: true }).catch(() => {})
      log.info('Session deleted', { sessionId })
      return true
    })
  }

  /** Update a session's title. Empty/whitespace titles keep the current title.
   *  Returns `true` when renamed, `false` when left unchanged (empty), `null` when not found. */
  static async renameSession(sessionId: string, title: string): Promise<boolean | null> {
    const clean = title.trim()
    let result: boolean | null = null
    await withHistoryLock('__index__', async () => {
      const idx = (await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)) ?? { sessions: [] }
      const s = idx.sessions.find((x) => x.id === sessionId)
      if (s) {
        if (clean) {
          s.title = clean.slice(0, 60)
          result = true
          await writeJsonAtomic(SESSIONS_INDEX, idx)
        } else {
          result = false
        }
      }
    })
    return result
  }

  /** Toggle the pinned flag of a session; returns the new state. */
  static async togglePin(sessionId: string): Promise<boolean | null> {
    let result: boolean | null = null
    await withHistoryLock('__index__', async () => {
      const idx = (await readJson<{ sessions: SessionMeta[] }>(SESSIONS_INDEX)) ?? { sessions: [] }
      const s = idx.sessions.find((x) => x.id === sessionId)
      if (s) {
        s.pinned = !s.pinned
        result = s.pinned
        await writeJsonAtomic(SESSIONS_INDEX, idx)
      }
    })
    return result
  }
}
