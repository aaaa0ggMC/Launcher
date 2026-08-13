import type { CommandSpec } from '../../main/process/commands/types'
import { makeLogger } from '../../main/process/logger'
import { t } from '../../main/process/i18n'
import { getBroadcast } from '../../main/process/broadcast'
import {
  loadAidjConfig,
  saveAidjConfig,
  ensureAidjDir,
  loadLibrary,
  scanMusicFiles,
  invalidateLibrary,
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  getPlaylistsDir,
  DBusManager,
  DJSession,
  initDbusManager,
  getDbusManager,
  setDbusManager,
  getPersistentSession,
  setPersistentSession,
  PersistentSession,
  SessionManager,
  listAvailablePlayers,
  switchPlayer,
  getCoverArt,
  bumpFrequency,
  loadFrequency,
  getLyricPlayback,
  getCurrentPlayerKey,
  resolveLyricForTrackPath,
  loadLyricsPageConfig,
  saveLyricsPageConfig,
  getLyricPlayerBinding,
  switchLyricsPlayer,
  activateAidjDbus
} from './service'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { screen } from 'electron'
import OpenAI from 'openai'
import { startJobByName, listTasks } from '../../main/process/background-tasks'
import { parseFilterCommand, evaluateFilter, FilterParseError } from './parser/filterGrammar'
import { cachedVariantHaystack, setVariantCacheCapacity } from './parser/chineseVariants'
import { createChildWindow, destroyChildWindow, listChildWindows } from '../../main/process/windows'
import type { WindowSpec } from '../../main/process/windows'
import type {
  AidjConfig,
  SongMeta,
  ChatMessage,
  RawHistoryMessage,
  PlaylistEntry,
  LyricsDisplayConfig,
  AidjLyricsPageConfig,
  LyricPlaybackState
} from './types'
import { SEPARATOR, LYRICS_WINDOW_ID, DEFAULT_LYRICS_CFG, DEFAULT_AIDJ_CONFIG } from './types'
import './jobs'
import {
  getContinuousTasks,
  getContinuousTask,
  switchContinuousPlayer,
  enqueueContinuousSongs,
  reorderContinuousQueue,
  setContinuousVolbal,
  setContinuousRecordFreq,
  clearContinuousMemory,
  getContinuousVolume,
  setContinuousVolume,
  setContinuousBaseVol,
  getChatTask,
  setChatPlayer,
  chatResendPlaylist,
  clearContinuousPending
} from './jobs'
import {
  getActiveBackend,
  getPlayerMode,
  setPlayerMode,
  getWebPlayerBackend,
  resetPlayerMode,
  reconcilePlayerAbilityVisibility
} from './player-backend'
import type { WebPlayerReport } from './player-backend'
import { registerStartupHook } from '../../main/process/startup'

const log = makeLogger('aidj')

/** Mode-exclusive command gates (MAddition) — commands that only make sense in
 *  one playback mode are NOT exposed in the other, so the UI never sees a
 *  "only supports MPRIS" style guard. Shared commands (next/toggle/send/...) use
 *  the normal backend dispatch instead of a gate. */
const dbusMode = (): Promise<boolean> => getPlayerMode().then((m) => m === 'dbus')
const webMode = (): Promise<boolean> => getPlayerMode().then((m) => m === 'web')

// Startup: the built-in player page is mode-bound — hide it from the sidebar
// when the app boots into dbus mode (Linux default), show it in web mode.
registerStartupHook(() => reconcilePlayerAbilityVisibility())

/** Variant-cache sizing for `aidj.filter` — one entry ≈ 2× lyric text + title.
 *  Budget ~80MB of resident haystacks; beyond that the cache can't fit the
 *  whole library, so it's disabled instead of build+clear-thrashing. */
const MAX_VARIANT_CACHE_BYTES = 80 * 1024 * 1024
const AVG_VARIANT_ENTRY_BYTES = 4500

/** Per-DBus lyric window id: multiple players → one window each (single-instance
 *  per player). Keeps the configured dbus_target as a readable suffix. */
function lyricWindowId(playerKey: string): string {
  return `${LYRICS_WINDOW_ID}-${playerKey.replace(/[^\w.-]/g, '_')}`
}

/** Fixed lyrics-window width — overridden by `preferences.lyrics.width`. */
const LYRICS_WINDOW_W = 560

/** Height sized to the display config: exactly lines_before + current + lines_after. */
function lyricWindowHeight(cfg: LyricsDisplayConfig): number {
  const before = Math.max(0, cfg.lines_before ?? 0)
  const after = Math.max(0, cfg.lines_after ?? 0)
  const lines = before + 1 + after
  const unit =
    Math.max(cfg.font_size, cfg.candidate_size ?? 0) * (cfg.line_height ?? 1.3) +
    Math.max(2, cfg.line_gap ?? 6)
  const titleH = cfg.show_title !== false ? (cfg.header_size ?? 13) + 8 : 0
  return Math.max(140, Math.round(24 + titleH + lines * unit))
}

/** Place the lyrics window per the anchor/margin display config, on the primary
 *  display's work area (mirrors `vp wshowlyrics -a <anchor> -m <margin>`). */
function lyricWindowPosition(
  cfg: LyricsDisplayConfig,
  w: number,
  h: number
): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  const x = area.x + Math.round((area.width - w) / 2)
  let y: number
  if (cfg.anchor === 'bottom') y = area.y + area.height - h - cfg.margin
  else if (cfg.anchor === 'top') y = area.y + cfg.margin
  else y = area.y + Math.round((area.height - h) / 2)
  return { x, y }
}

/** Resolve the effective lyrics display config (defaults merged with user prefs). */
async function effectiveLyricsCfg(): Promise<LyricsDisplayConfig> {
  const config = await loadAidjConfig()
  return { ...DEFAULT_LYRICS_CFG, ...(config?.preferences?.lyrics ?? {}) }
}

/** Stable lyrics-window key: `web` for the built-in player, otherwise the bound
 *  MPRIS player (M3 — the lyrics source now follows the active backend). */
async function currentLyricsKey(): Promise<string> {
  return (await getPlayerMode()) === 'web' ? 'web' : getCurrentPlayerKey()
}

/**
 * Lyrics source for the built-in (web) player — fills the same
 * `LyricPlaybackState` model from the WebPlayerBackend's reported state +
 * library lyric resolution, so the desktop window / in-app page are backend-
 * agnostic (M3: 桌面歌词窗口绑定重指向内置播放器).
 */
async function getWebLyricPlayback(): Promise<LyricPlaybackState> {
  const empty: LyricPlaybackState = {
    ok: false,
    status: 'Unknown',
    track: '',
    artist: '',
    album: '',
    player: 'web',
    positionMs: null,
    lengthMs: null,
    lyric: null
  }
  const detail = await getWebPlayerBackend().getPlaybackDetail()
  // No track loaded yet — keep the window open in "waiting" (ok:true, no track).
  if (!detail.ok || !detail.track) {
    return {
      ...empty,
      ok: true,
      status: detail.status,
      positionMs: detail.positionMs,
      lengthMs: detail.lengthMs
    }
  }
  const lib = await loadLibrary()
  const path = detail.url.startsWith('file://')
    ? decodeURIComponent(detail.url.slice('file://'.length))
    : null
  return {
    ok: true,
    status: detail.status,
    track: detail.track,
    artist: detail.artist,
    album: detail.album,
    player: 'web',
    positionMs: detail.positionMs,
    lengthMs: detail.lengthMs,
    path,
    lyric: resolveLyricForTrackPath(path, detail.track, lib.lyrics),
    karaokeLyric: resolveLyricForTrackPath(path, detail.track, lib.karaoke) ?? null
  }
}

async function lyricWindowSpec(): Promise<{ id: string; key: string; spec: WindowSpec }> {
  const key = await currentLyricsKey()
  const id = lyricWindowId(key)
  const cfg = await effectiveLyricsCfg()
  const w = Math.max(240, cfg.width ?? LYRICS_WINDOW_W)
  const h = lyricWindowHeight(cfg)
  const pos = lyricWindowPosition(cfg, w, h)
  return {
    id,
    key,
    spec: {
      id,
      title: `[AIDJ-Lyrics] ${key}`,
      view: 'aidj/LyricsWindow',
      width: w,
      height: h,
      x: pos.x,
      y: pos.y,
      frameless: true,
      rounded: true,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      osd: true
    }
  }
}

let _client: OpenAI | null = null
let _session: DJSession | null = null
let _metadata: Map<string, SongMeta> | null = null
let _musicPaths: Map<string, string> | null = null
let _config: AidjConfig | null = null
let _currentAbort: AbortController | null = null
let _streamingChars = 0
let _retrying = false
let _retryAttempt = 0
let _retryWaitMs = 0
let _retryStart = 0
let _retryLastError = ''
let _sessionId = ''

// ---------------------------------------------------------------------------
// Revert helpers — rebuild chatHistory/rollingHistory from raw history.jsonl.
// type="user"  → original user input  (UI + context)
// type="both"  → assistant response   (UI + context)
// type="updated" → compact/drop marker (context only)
// type="model" → wrapped prompt sent to AI (audit only, excluded from context)
//
// `both` messages now store the FULL raw assistant text (may contain the
// SONG_LIST separator). The optional `parse` callback resolves it back to
// { intro, playlist } using the same code path the live generator uses.
// ---------------------------------------------------------------------------
function rawToChatHistory(
  raw: RawHistoryMessage[],
  parse?: (rawText: string) => { intro: string; playlist: PlaylistEntry[] },
  onProgress?: (done: number, total: number) => void
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < raw.length; i++) {
    if (onProgress) onProgress(i + 1, raw.length)
    const m = raw[i]
    const keep =
      m.type === 'user' || m.type === 'both' || (m.type === 'updated' && m.content !== '')
    if (!keep) continue
    const role: ChatMessage['role'] =
      m.type === 'both' ? 'assistant' : m.type === 'updated' ? 'system' : 'user'

    if (role === 'assistant' && parse && m.content.includes(SEPARATOR)) {
      const parsed = parse(m.content)
      out.push({
        role,
        content: parsed.intro || m.content,
        playlist: parsed.playlist,
        timestamp: m.ts
      })
      // An assistant reply with prose but no resolved songs → surface a hint.
      if (parsed.intro.trim() !== '' && parsed.playlist.length === 0) {
        const next = raw[i + 1]
        const alreadyHint = next?.type === 'updated' && (next.content || '').startsWith('💬')
        if (!alreadyHint) {
          out.push({
            role: 'system',
            content: t('aidj.no_match_hint'),
            timestamp: m.ts
          })
        }
      }
      continue
    }

    out.push({
      role,
      content: m.content,
      playlist: m.playlist,
      timestamp: m.ts
    })
  }
  return out
}

function rawToRollingHistory(raw: RawHistoryMessage[]): string[] {
  const seen = new Set<string>()
  const push = (name: string): void => {
    if (name && !seen.has(name) && seen.size < 100) seen.add(name)
  }
  for (let i = raw.length - 1; i >= 0 && seen.size < 100; i--) {
    const m = raw[i]
    if (m.playlist) {
      for (const s of m.playlist) push(s.name)
      continue
    }
    if (m.type === 'both' && m.content.includes(SEPARATOR)) {
      const listBlock = m.content.split(SEPARATOR).slice(1).join(SEPARATOR)
      for (const line of listBlock.split('\n')) {
        const clean = line.replace(/["']/g, '').trim()
        if (clean && !clean.startsWith('#')) push(clean)
      }
    }
  }
  return [...seen].reverse()
}

/** Return the raw line index (exclusive) that keeps `keepUiMessages` user/assistant messages. */
function computeRawKeep(raw: RawHistoryMessage[], keepUiMessages: number): number {
  if (keepUiMessages <= 0) return 0
  let uiCount = 0
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].type
    if (t === 'user' || t === 'both') {
      uiCount++
      if (uiCount >= keepUiMessages) return i + 1
    }
  }
  return raw.length
}

export function getCurrentAbortSignal(): AbortSignal | null {
  return _currentAbort?.signal ?? null
}

export function abortCurrentRequest(): void {
  _currentAbort?.abort()
  _currentAbort = null
  _streamingChars = 0
  _retrying = false
  _retryAttempt = 0
  _retryWaitMs = 0
  _retryStart = 0
  _retryLastError = ''
}

/** Load config (cached) + shared library (metadata + paths). Does NOT sync/AI — lightweight. */
async function ensureLibraryLoaded(): Promise<AidjConfig | null> {
  let config = _config
  if (!config) {
    config = await loadAidjConfig()
    if (!config) return null
    _config = config
  }
  if (!_musicPaths || !_metadata) {
    const lib = await loadLibrary()
    _metadata = lib.metadata
    _musicPaths = lib.musicPaths
  }
  return config
}

async function ensureInit(): Promise<{
  client: OpenAI
  config: AidjConfig
  session: DJSession
  dbus: DBusManager | null
}> {
  let config = _config
  if (!config) {
    config = await loadAidjConfig()
    if (!config) throw new Error('AIDJ 配置未找到，请先在 aidj/config.json 中配置')
    _config = config
  }

  setNcmBaseUrl(config.ncm_base_url)

  let client = _client
  if (!client) {
    client = new OpenAI({
      apiKey: config.secrets.api_key,
      baseURL: config.ai_settings.base_url
    })
    _client = client
  }

  // Only the external-player (dbus) backend needs a session-bus connection —
  // in web mode NEVER spin up dbus-next (on non-Linux platforms it can't even
  // connect). The generated / session flows don't need a player binding.
  let dbus: DBusManager | null = getDbusManager()
  if (!dbus && (await getPlayerMode()) === 'dbus') {
    dbus = await initDbusManager(config)
  }

  let session = _session
  if (!session) {
    await ensureAidjDir()
    const lib = await loadLibrary()
    const paths = lib.musicPaths
    const metadata = lib.metadata
    // 库缓存可能建于新文件加入之前 —— 重新扫描磁盘并就地合并新歌。
    const fresh = await scanMusicFiles(config.music_folders ?? [])
    for (const [name, path] of fresh) {
      if (!paths.has(name)) paths.set(name, path)
    }
    _musicPaths = paths
    _metadata = metadata
    log.info(`metadata loaded: ${metadata.size} songs`)
    const missing = await findMissingSongs(paths, metadata)
    if (missing.size > 0) {
      log.info(`Found ${missing.size} new songs, syncing metadata...`)
      const synced = await syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      )
      _metadata = synced.metadata
    }
    session = new DJSession(client, _metadata, paths, config)
    _session = session
  }

  return { client, config, session, dbus }
}

/** Push a playlist into the live session (persist + context + memory), like a
 *  DJ push. Used by /random, /explore, /ftop. Does NOT touch turnCount so the
 *  first nextStep still injects the system prompt. */
async function pushPlaylistToSession(
  session: DJSession,
  userText: string,
  intro: string,
  playlist: PlaylistEntry[]
): Promise<string> {
  if (!_sessionId) {
    _sessionId = await SessionManager.createSession({
      title: userText.slice(0, 40),
      type: 'generate'
    })
  }
  const names = playlist.map((s) => s.name)
  const raw = `${intro}\n\n${SEPARATOR}\n${names.join('\n')}`
  const rawMsgs: RawHistoryMessage[] = [
    { role: 'user', content: userText, ts: Date.now(), type: 'user' },
    { role: 'assistant', content: raw, ts: Date.now(), type: 'both', playlist }
  ]
  await SessionManager.appendMessages(_sessionId, rawMsgs)
  session.chatHistory.push(
    { role: 'user', content: userText, timestamp: Date.now() },
    { role: 'assistant', content: raw, timestamp: Date.now() }
  )
  for (const name of names) session.playedSongs.add(name)
  return raw
}

/** Deterministic Fisher-Yates sample without replacement. */
function sampleNames(pool: string[], n: number): string[] {
  const copy = [...pool]
  const out: string[] = []
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
  }
  return out
}

const commands: CommandSpec[] = [
  {
    name: 'aidj.generate',
    description: 'AI 生成歌单',
    usage: 'aidj.generate --prompt <text>',
    run: async (ctx) => {
      const prompt = (ctx.named.prompt as string) || ctx.positional.join(' ')
      const { session, config } = await ensureInit()
      _currentAbort = new AbortController()
      _streamingChars = 0
      _retrying = false
      _retryAttempt = 0
      _retryWaitMs = 0
      _retryStart = 0
      _retryLastError = ''
      try {
        const { playlist, intro, raw, updated } = await session.nextStep(
          prompt,
          (full: string) => {
            if (_retrying) {
              _retrying = false
              _retryLastError = ''
            }
            _streamingChars = full.length
          },
          _currentAbort.signal,
          (attempt, waitMs, err) => {
            _retrying = true
            _retryAttempt = attempt
            _retryWaitMs = waitMs
            _retryStart = _retryStart || Date.now()
            _retryLastError = err ? String(err instanceof Error ? err.message : err) : ''
            _streamingChars = 0
          }
        )
        if (!_currentAbort?.signal.aborted) {
          let wasNewSession = false
          if (!_sessionId) {
            _sessionId = await SessionManager.createSession({
              title: prompt.slice(0, 40),
              type: 'generate'
            })
            wasNewSession = true
          }
          const rawMsgs: RawHistoryMessage[] = []
          if (updated) rawMsgs.push(updated)
          rawMsgs.push(
            { role: 'user', content: prompt, ts: Date.now(), type: 'user' },
            {
              role: 'assistant',
              content: raw || intro || '',
              ts: Date.now(),
              type: 'both',
              playlist
            }
          )
          await SessionManager.appendMessages(_sessionId, rawMsgs)
          // Auto title: after the first AI output of a new session, fire the
          // background title job (if enabled). Otherwise the raw prompt slice stays.
          const produced = playlist.length > 0 || (intro && intro.trim() !== '')
          if (wasNewSession && produced && config.preferences.auto_title) {
            await startJobByName('aidj.title', {
              sessionId: _sessionId,
              name: 'AIDJ 标题生成',
              description: '自动生成会话标题'
            })
            log.info('Auto title job started', { sessionId: _sessionId })
          }
        }
        const enriched = playlist.map((s) => ({
          ...s,
          meta: session.metadata.get(s.name) || null
        }))
        log.info('Generate done', {
          sessionId: _sessionId || '',
          ok: !intro.startsWith('⚠️'),
          playlistCount: playlist.length,
          introLen: intro.length,
          tokens: { prompt: session.promptTokens, completion: session.completionTokens }
        })
        if (intro.startsWith('⚠️')) {
          return { ok: false, error: intro.replace(/^⚠️\s*/, '') }
        }
        return {
          ok: true,
          intro,
          playlist: enriched,
          tokens: { prompt: session.promptTokens, completion: session.completionTokens },
          context: { prompt: session.lastPromptTokens, completion: session.lastCompletionTokens }
        }
      } finally {
        _currentAbort = null
        _streamingChars = 0
        _retrying = false
        _retryAttempt = 0
        _retryWaitMs = 0
        _retryStart = 0
        _retryLastError = ''
      }
    }
  },
  {
    name: 'aidj.curate',
    description: '从随机候选中 AI 精选成连贯歌单（计入上下文）',
    usage: 'aidj.curate --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const keys = [...session.musicPaths.keys()]
      if (!keys.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, keys.length, 50)
      let pool = keys.filter((k) => !session.playedSongs.has(k))
      if (pool.length < n) pool = keys
      const candidates = sampleNames(pool, n)

      _currentAbort = new AbortController()
      _streamingChars = 0
      _retrying = false
      _retryAttempt = 0
      _retryWaitMs = 0
      _retryStart = 0
      _retryLastError = ''
      try {
        const prompt =
          `System Request: I have randomly picked ${candidates.length} candidate songs from the library: ${JSON.stringify(candidates)}.\n` +
          'Task: Curate a coherent playlist from THIS SPECIFIC LIST.\n' +
          `Rules: 1. Sort for flow. 2. Filter clashes. 3. Keep at least ${Math.max(1, Math.floor(candidates.length / 2))} songs. 4. No hallucinations. 5. Write the Intro BEFORE the separator, keys AFTER.`
        const { playlist, intro, raw, updated } = await session.nextStep(
          prompt,
          (full: string) => {
            if (_retrying) {
              _retrying = false
              _retryLastError = ''
            }
            _streamingChars = full.length
          },
          _currentAbort.signal,
          (attempt, waitMs, err) => {
            _retrying = true
            _retryAttempt = attempt
            _retryWaitMs = waitMs
            _retryStart = _retryStart || Date.now()
            _retryLastError = err ? String(err instanceof Error ? err.message : err) : ''
            _streamingChars = 0
          }
        )
        if (!_currentAbort?.signal.aborted) {
          if (!_sessionId) {
            _sessionId = await SessionManager.createSession({
              title: `/pr ${candidates.length}`,
              type: 'generate'
            })
          }
          const rawMsgs: RawHistoryMessage[] = []
          if (updated) rawMsgs.push(updated)
          rawMsgs.push(
            { role: 'user', content: `/pr ${candidates.length}`, ts: Date.now(), type: 'user' },
            {
              role: 'assistant',
              content: raw || intro || '',
              ts: Date.now(),
              type: 'both',
              playlist
            }
          )
          await SessionManager.appendMessages(_sessionId, rawMsgs)
        }
        const enriched = playlist.map((s) => ({
          ...s,
          meta: session.metadata.get(s.name) || null
        }))
        if (intro.startsWith('⚠️')) {
          return { ok: false, error: intro.replace(/^⚠️\s*/, '') }
        }
        return { ok: true, intro, playlist: enriched }
      } finally {
        _currentAbort = null
        _streamingChars = 0
        _retrying = false
        _retryAttempt = 0
        _retryWaitMs = 0
        _retryStart = 0
        _retryLastError = ''
      }
    }
  },
  {
    name: 'aidj.random',
    description: '随机选取 N 首歌曲，作为 AIDJ 推送计入会话上下文',
    usage: 'aidj.random --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const keys = [...session.musicPaths.keys()]
      if (!keys.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, keys.length, 50)

      // Avoid the played-memory (songs the DJ already pushed) when possible;
      // fall back to the whole library if there aren't enough fresh songs.
      let pool = keys.filter((k) => !session.playedSongs.has(k))
      if (pool.length < n) pool = keys

      const picked = sampleNames(pool, n)
      const playlist = picked.map((name) => ({
        name,
        path: session.musicPaths.get(name) || '',
        meta: session.metadata.get(name) || null
      }))
      const intro = `已经找到 ${playlist.length} 首随机歌曲。`
      await pushPlaylistToSession(session, `/random ${playlist.length}`, intro, playlist)
      log.info('Random selection pushed', { sessionId: _sessionId, count: playlist.length })
      return { ok: true, intro, playlist }
    }
  },
  {
    name: 'aidj.explore',
    description: '发现未听过/最少播放的歌曲，作为 AIDJ 推送计入会话上下文',
    usage: 'aidj.explore --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const freq = await loadFrequency()
      const allNames = [...session.musicPaths.keys()]
      if (!allNames.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, allNames.length, 50)

      const heard = new Set(freq.keys())
      let pool = allNames.filter((k) => !heard.has(k) && !session.playedSongs.has(k))
      let label: string
      if (pool.length < n) {
        // All songs have been played (or memory-exhausted) — least-played first.
        pool = allNames
          .filter((k) => !session.playedSongs.has(k))
          .sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0))
        if (pool.length < n) pool = allNames
        const picked = pool.slice(0, n)
        const least = freq.get(picked[0]) ?? 0
        label = `播放最少的 ${picked.length} 首歌曲 (≥${least}x)`
        const playlist = picked.map((name) => ({
          name,
          path: session.musicPaths.get(name) || '',
          meta: session.metadata.get(name) || null
        }))
        await pushPlaylistToSession(session, `/explore ${playlist.length}`, label, playlist)
        log.info('Explore (least-played) pushed', { sessionId: _sessionId, count: picked.length })
        return { ok: true, intro: label, playlist }
      }

      const picked = sampleNames(pool, n)
      label = `发现 ${picked.length} 首尚未听过的歌曲。`
      const playlist = picked.map((name) => ({
        name,
        path: session.musicPaths.get(name) || '',
        meta: session.metadata.get(name) || null
      }))
      await pushPlaylistToSession(session, `/explore ${playlist.length}`, label, playlist)
      log.info('Explore (unheard) pushed', { sessionId: _sessionId, count: picked.length })
      return { ok: true, intro: label, playlist }
    }
  },
  {
    name: 'aidj.filter',
    description:
      '按表达式过滤曲库（--query 完整表达式，compare=title/lyrics/all，支持 [字段:值] 元数据筛选）',
    usage:
      'aidj.filter --query --compare=title ("The Weeknd" and "Justin Bieber") or ("Taylor") [emotion:孤独]',
    run: async (ctx) => {
      const query = String(ctx.named.query ?? '')
      if (!query) return { ok: false, error: '需要 --query 过滤表达式' }
      try {
        const fq = parseFilterCommand(query)
        const lib = await loadLibrary()
        // Size the variant cache to the library (title + lyrics = 2 entries per
        // song). If the whole library fits the memory budget the cache survives
        // the run and every later filter is instant; if it can't fit, caching is
        // disabled (capacity 0) so we never build+clear-thrash — a cache that
        // gets wiped mid-run would waste the conversion CPU and hold memory
        // without ever being reused.
        const songCount = lib.musicPaths.size
        const needed = songCount * 2 + 100
        setVariantCacheCapacity(
          needed * AVG_VARIANT_ENTRY_BYTES <= MAX_VARIANT_CACHE_BYTES ? needed : 0
        )
        const results: { name: string; path: string }[] = []
        for (const [name, path] of lib.musicPaths) {
          // ignorecase ON (default): variant-agnostic, lowercased, cached —
          // 「周杰伦」matches 「周杰倫」, "The Weeknd" matches "the weeknd".
          // OFF: raw exact substring match, no normalization, no cache.
          let haystack: string
          if (fq.ignoreCase) {
            const title = cachedVariantHaystack(`t:${name}`, name)
            if (fq.compare === 'title') {
              haystack = title
            } else {
              const lrc = cachedVariantHaystack(`l:${name}`, lib.lyrics.get(name) ?? '')
              haystack = fq.compare === 'all' ? `${title}\n${lrc}` : lrc
            }
          } else {
            const lrc = lib.lyrics.get(name) ?? ''
            haystack =
              fq.compare === 'title' ? name : fq.compare === 'all' ? `${name}\n${lrc}` : lrc
          }
          if (
            evaluateFilter(
              fq.expr,
              {
                haystack,
                meta: (lib.metadata.get(name) ?? {}) as Record<string, unknown>
              },
              fq.ignoreCase
            )
          ) {
            results.push({ name, path })
            if (fq.count > 0 && results.length >= fq.count) break
          }
        }
        return { ok: true, results, total: results.length, compare: fq.compare }
      } catch (e) {
        if (e instanceof FilterParseError) return { ok: false, error: `语法错误: ${e.message}` }
        log.warn('aidj.filter failed', { error: String(e) })
        return { ok: false, error: String(e) }
      }
    }
  },
  {
    name: 'aidj.ftop',
    description: '推送播放次数 Top N / 倒数 N / 区间 A-B 歌曲',
    usage: 'aidj.ftop [--count N] [--bottom true] [--from A] [--to B]',
    run: async (ctx) => {
      const { session } = await ensureInit()
      const freq = await loadFrequency()
      const ranked = [...freq.entries()]
        .filter(([name]) => session.musicPaths.has(name))
        .sort((a, b) => b[1] - a[1])
        .map(([name, times]) => ({ name, times, path: session.musicPaths.get(name) || '' }))
      if (!ranked.length) return { ok: false, error: '没有可用的播放频率数据' }

      let selected: typeof ranked
      let label: string
      const from = Number(ctx.named.from)
      const to = Number(ctx.named.to)
      if (Number.isFinite(from) && Number.isFinite(to)) {
        const a = Math.max(1, Math.min(from, to))
        const b = Math.max(1, Math.max(from, to))
        selected = ranked.slice(a - 1, b)
        label = `播放频率第 ${a}–${b} 名：`
      } else {
        const count = Math.max(1, Number(ctx.named.count) || 20)
        const c = Math.min(count, ranked.length)
        if (String(ctx.named.bottom) === 'true') {
          selected = ranked.slice(ranked.length - c)
          label = `播放次数最少的 ${c} 首歌曲：`
        } else {
          selected = ranked.slice(0, c)
          label = `播放次数最多的 ${c} 首歌曲：`
        }
      }
      if (!selected.length) return { ok: false, error: '没有可用的播放频率数据' }

      const playlist = selected.map((s) => ({
        name: s.name,
        path: s.path,
        meta: session.metadata.get(s.name) || null
      }))
      await pushPlaylistToSession(
        session,
        (ctx.named.text as string) || `/ftop ${selected.length}`,
        label,
        playlist
      )
      log.info('Ftop pushed', { sessionId: _sessionId, count: selected.length, label })
      return { ok: true, intro: label, playlist }
    }
  },
  {
    name: 'aidj.next',
    description: '下一首',
    run: async () => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      await backend.control('next')
      return { ok: true }
    }
  },
  {
    name: 'aidj.prev',
    description: '上一首',
    run: async () => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      await backend.control('prev')
      return { ok: true }
    }
  },
  {
    name: 'aidj.toggle',
    description: '播放/暂停',
    run: async () => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      await backend.control('toggle')
      return { ok: true }
    }
  },
  {
    name: 'aidj.stop',
    description: '停止播放',
    run: async () => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      await backend.control('stop')
      return { ok: true }
    }
  },
  {
    name: 'aidj.status',
    description: '获取播放器状态',
    run: async () => {
      if (!_config) _config = await loadAidjConfig()
      // Warm the library cache in the BACKGROUND — the first status poll (the
      // player page polls immediately on mount) must NOT block on a full music
      // folder scan + metadata read, which freezes the UI for seconds with a
      // large library. librarySize reflects whatever is already loaded (0 until
      // the warm finishes / a session loads); the next poll picks it up.
      void loadLibrary()
        .then((lib) => {
          if (!_metadata) _metadata = lib.metadata
          if (!_musicPaths) _musicPaths = lib.musicPaths
        })
        .catch(() => {})
      const session = _session
      const librarySize = session
        ? [...session.metadata.keys()].filter((k) => session.musicPaths.has(k)).length
        : _metadata && _musicPaths
          ? [..._metadata.keys()].filter((k) => _musicPaths!.has(k)).length
          : 0
      const base = {
        ok: true,
        tracks: librarySize,
        memory: _session?.playedSongs.size ?? 0,
        volbal: {
          enabled: _config?.preferences.dynamic_balance_volume ?? false,
          method: _config?.preferences.sound_adjust_method ?? 'lufs'
        },
        recordFreq: _config?.preferences.record_freq ?? false,
        statusBar: _config?.preferences.status_bar,
        mode: await getPlayerMode()
      }
      // Web backend: bypass the DBus path entirely — the built-in player fills
      // its own status model.
      const backend = await getActiveBackend()
      if (backend?.mode === 'web') {
        return { ...base, status: await backend.getStatus() }
      }
      let dbus = getDbusManager()
      if (!dbus && _config) dbus = await initDbusManager(_config)
      if (!dbus) {
        return {
          ...base,
          status: { status: 'Unknown', track: '', volume: null, player: '' }
        }
      }
      const status = await dbus.getStatus()
      if (status.status === 'Unknown' && !status.player) {
        dbus.disconnect()
        if (_config) dbus = await initDbusManager(_config)
        return { ...base, status: await dbus.getStatus() }
      }
      return { ...base, status }
    }
  },
  {
    name: 'aidj.send',
    description: '发送歌单到播放器',
    usage: 'aidj.send [--path <filepath>]...',
    run: async (ctx) => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      const paths = ctx.named.path as string[] | string | undefined
      const pathArray = Array.isArray(paths) ? paths : paths ? [paths] : []
      if (pathArray.length === 0) return { ok: false, error: '未指定文件路径' }
      await backend.sendFiles(pathArray)
      // record_freq — immediate mode bumps every sent track.
      if (!_config) _config = await loadAidjConfig()
      if (_config?.preferences.record_freq) {
        const lib = await loadLibrary()
        const pathToName = new Map<string, string>()
        for (const [name, p] of lib.musicPaths) pathToName.set(p, name)
        const names = pathArray.map((p) => pathToName.get(p) ?? '').filter(Boolean)
        await bumpFrequency(names)
      }
      return { ok: true }
    }
  },
  {
    name: 'aidj.volume',
    description: '获取或设置音量',
    usage: 'aidj.volume [--set <0-1>]',
    run: async (ctx) => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      if (ctx.named.set !== undefined) {
        const vol = Number(ctx.named.set)
        if (isNaN(vol) || vol < 0 || vol > 1) return { ok: false, error: '音量需在 0-1 之间' }
        await backend.setVolume(vol)
        return { ok: true, volume: vol }
      }
      const vol = await backend.getVolume()
      return { ok: true, volume: vol }
    }
  },
  {
    name: 'aidj.playlist',
    description: '管理播放队列',
    usage: 'aidj.playlist --action <list|clear|remove|shuffle> [--index <n>]',
    run: async () => {
      return { ok: true, note: '队列管理通过 UI 操作' }
    }
  },
  {
    name: 'aidj.save',
    description: '保存歌单到文件',
    usage: 'aidj.save --name <name> --songs <json>',
    run: async (ctx) => {
      const name = ctx.named.name as string
      const songs = ctx.named.songs as string
      if (!name || !songs) return { ok: false, error: '需要 --name 和 --songs 参数' }
      const dir = getPlaylistsDir()
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${name}.txt`), songs, 'utf-8')
      return { ok: true, path: join(dir, `${name}.txt`) }
    }
  },
  {
    name: 'aidj.load',
    description: '从文件加载歌单',
    usage: 'aidj.load --name <name>',
    run: async (ctx) => {
      const name = ctx.named.name as string
      if (!name) return { ok: false, error: '需要 --name 参数' }
      const dir = getPlaylistsDir()
      const content = await readFile(join(dir, `${name}.txt`), 'utf-8').catch(() => null)
      if (!content) return { ok: false, error: `歌单 ${name} 未找到` }
      return { ok: true, songs: content.split('\n').filter(Boolean) }
    }
  },
  {
    name: 'aidj.search',
    description: '搜索曲库',
    usage: 'aidj.search --q <query>',
    run: async (ctx) => {
      const query = (ctx.named.q as string) || ctx.positional.join(' ')
      if (!query) return { ok: false, error: '需要搜索关键词' }
      const { session } = await ensureInit()
      const keys = [...session.metadata.keys()].filter((k) => session.musicPaths.has(k))
      const results = keys
        .map((name) => ({ name, score: session['tokenSortRatio'](query, name) }))
        .filter((r) => r.score >= 80)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
      return { ok: true, results }
    }
  },
  {
    name: 'aidj.model',
    description: '切换 AI 模型',
    usage: 'aidj.model --set <model>',
    run: async (ctx) => {
      const model = ctx.named.set as string
      if (!model) return { ok: false, error: '需要 --set 参数指定模型名称' }
      if (!_config) _config = await loadAidjConfig()
      const config = _config
      if (!config) return { ok: false, error: '配置未加载' }
      config.preferences.model = model
      return { ok: true, model }
    }
  },
  {
    name: 'aidj.refresh',
    description: '清除已播记录',
    run: async () => {
      const session = _session
      if (session) {
        session.refresh(true)
        _sessionId = ''
        return { ok: true, message: '已清除历史记录和已播歌曲' }
      }
      return { ok: false, error: 'DJSession 未初始化' }
    }
  },
  {
    name: 'aidj.sync',
    description: '同步新歌曲元数据',
    run: async () => {
      const { client, config } = await ensureInit()
      const lib = await loadLibrary()
      _metadata = lib.metadata
      _musicPaths = lib.musicPaths
      const musicPaths = lib.musicPaths
      const metadata = lib.metadata
      // loadLibrary 缓存可能过期：重新扫描磁盘并就地合并新歌（只增不减）。
      const fresh = await scanMusicFiles(config.music_folders ?? [])
      for (const [name, path] of fresh) {
        if (!musicPaths.has(name)) musicPaths.set(name, path)
      }
      const missing = await findMissingSongs(musicPaths, metadata)
      if (missing.size === 0) return { ok: true, synced: 0, message: '无新歌曲需要同步' }
      const synced = await syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      )
      _metadata = synced.metadata
      return { ok: true, synced: synced.counts.ok }
    }
  },
  {
    name: 'aidj.metadata-sync',
    description: '扫描曲库并更新缺失的歌曲元数据（后台任务）',
    usage: 'aidj.metadata-sync',
    run: async () => {
      const already = listTasks().some(
        (tk) => tk.status === 'running' && tk.name === 'AIDJ 元数据同步'
      )
      if (already) return { ok: false, alreadyRunning: true, error: '元数据同步任务正在运行中' }
      const task = await startJobByName('aidj.metadata-sync', {
        name: 'AIDJ 元数据同步',
        description: '扫描曲库并更新缺失歌曲元数据'
      })
      if (!task) return { ok: false, error: '元数据同步任务无法启动' }
      log.info('Metadata sync job started', { taskId: task.id })
      return { ok: true, task }
    }
  },
  {
    name: 'aidj.analyse',
    description: '元数据分布分析',
    usage: 'aidj.analyse --field <language|emotion|genre|loudness>',
    run: async (ctx) => {
      const field = (ctx.named.field as string) || 'language'
      await ensureLibraryLoaded()
      const metadata = _metadata
      if (!metadata) return { ok: false, error: '元数据未加载' }
      const counter = new Map<string, number>()
      for (const meta of metadata.values()) {
        const raw = (meta as Record<string, unknown>)[field]
        if (!raw) continue
        const values = Array.isArray(raw) ? raw : [String(raw)]
        for (const v of values) {
          counter.set(String(v), (counter.get(String(v)) ?? 0) + 1)
        }
      }
      const sorted = [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          label,
          count,
          pct: Math.round((count / metadata.size) * 1000) / 10
        }))
      return { ok: true, field, total: metadata.size, distribution: sorted }
    }
  },
  {
    name: 'aidj.chat',
    description: '发送消息到持续会话',
    usage: 'aidj.chat --task <id> --text <message>',
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const text = (ctx.named.text as string) || ctx.positional.join(' ')
      if (!taskId || !text) return { ok: false, error: '需要 --task 和 --text 参数' }
      const st = getChatTask(taskId)
      if (!st) return { ok: false, error: '持续会话未运行' }

      // `/discard_follows` may be sent alone OR appended to a real message
      // (e.g. "从C418开始，语种多样化吧 /discard_follows"). Strip it, apply
      // the discard, and still send the rest as the user message so the DJ
      // reacts to the new direction immediately.
      const raw = text.trim()
      let content = raw
      let discard = false
      const lead = raw.match(/^\/discard_follows\s*([\s\S]*)$/)
      const trail = raw.match(/^([\s\S]*?)\s+\/discard_follows\s*$/)
      if (lead) {
        discard = true
        content = lead[1].trim()
      } else if (trail) {
        discard = true
        content = trail[1].trim()
      }
      if (discard) {
        // Don't clear the continuous queue now — the old songs keep playing
        // while the AI works. The new batch replaces the queue once generated.
        st.session.discardFollows()
        st.forceFetch = true
        st.replaceQueueOnNext = true
      }
      if (content) {
        st.session.injectUserMessage(content)
        // A regular user message must wake the DJ up too — without this, the
        // next batch only generates once the continuous queue drains below the
        // refill threshold, so a message mid-queue appears "lost".
        st.forceFetch = true
        st.control.push({ data: { type: 'user', content } })
      }
      return {
        ok: true,
        effect: discard ? (content ? 'discard_follows+injected' : 'discard_follows') : 'injected'
      }
    }
  },
  {
    name: 'aidj.chat-player',
    description: '切换持续会话的发送目标播放器',
    usage: 'aidj.chat-player --task <id> --player <name>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const player = ctx.named.player as string
      if (!taskId || !player) return { ok: false, error: '需要 --task 和 --player 参数' }
      const r = await setChatPlayer(taskId, player)
      if (!r.ok) return { ok: false, error: r.error }
      const st = getChatTask(taskId)
      if (st) {
        st.control.pushLine(`发送目标已切换 → ${st.player}`)
      }
      return { ok: true, player: st?.player ?? player }
    }
  },
  {
    name: 'aidj.chat-resend',
    description: '将歌单重新发送到持续会话的连续播放器',
    usage: 'aidj.chat-resend --task <id> --songs <json>',
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const songsJson = ctx.named.songs as string
      if (!taskId || !songsJson) return { ok: false, error: '需要 --task 和 --songs 参数' }
      let songs: unknown
      try {
        songs = JSON.parse(songsJson)
      } catch {
        return { ok: false, error: '--songs 不是合法 JSON' }
      }
      return await chatResendPlaylist(taskId, songs as { name: string; path: string }[])
    }
  },
  {
    name: 'aidj.chat-clear-memory',
    description: '清空持续会话的已播记忆',
    usage: 'aidj.chat-clear-memory --task <id>',
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      const st = getChatTask(taskId)
      if (!st) return { ok: false, error: '持续会话未运行' }
      st.session.clearMemory()
      st.control.push({
        data: {
          type: 'chat_status',
          promptTokens: st.session.promptTokens,
          completionTokens: st.session.completionTokens,
          tokens: st.session.promptTokens + st.session.completionTokens,
          context: st.session.lastPromptTokens,
          contextCompletion: st.session.lastCompletionTokens,
          memory: 0
        }
      })
      st.control.pushLine('已播记忆已清空')
      return { ok: true }
    }
  },
  {
    name: 'aidj.chat-revert',
    description: '回退持续会话到指定消息（删除该消息及之后所有，重建上下文和记忆）',
    usage: 'aidj.chat-revert --task <id> --keep <count>',
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const keep = Number(ctx.named.keep) || 0
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      const st = getChatTask(taskId)
      if (!st) return { ok: false, error: '持续会话未运行' }
      const sid = st.session.sessionId
      if (!sid) return { ok: false, error: '持续会话没有 session 记录' }

      const raw = await SessionManager.readRawHistory(sid)
      const keepLines = computeRawKeep(raw, keep)
      await SessionManager.truncateTail(sid, raw.length - keepLines)
      const kept = raw.slice(0, keepLines)
      log.info('Chat revert', { sessionId: sid, keep, removedLines: raw.length - keepLines })

      st.abortFetch?.()
      clearContinuousPending(st.player)

      const sysPrompt =
        st.session.chatHistory[0]?.role === 'system' ? st.session.chatHistory[0] : null
      const rebuilt = rawToChatHistory(kept)
      const bothCount = kept.filter((m) => m.type === 'both').length
      st.session.chatHistory = sysPrompt ? [sysPrompt, ...rebuilt] : rebuilt
      st.session.rollingHistory = rawToRollingHistory(kept)
      st.session.fetchCount = sysPrompt ? Math.max(1, bothCount) : 0
      st.session.promptTokens = 0
      st.session.completionTokens = 0
      st.session.pendingUserPrompt = null
      st.session.buffer = []
      st.session.currentQueue = []
      st.session.lastIntro = ''

      st.control.push({ data: { type: 'clear_history' } })
      for (const m of st.session.chatHistory) {
        // The library/system prompt (chatHistory[0]) and compact markers must stay
        // in the AI context but must NOT be rendered as chat messages.
        if (m.role === 'system') continue
        const t = m.role === 'user' ? 'user' : 'assistant'
        st.control.push({ data: { type: t, content: m.content, history: true } })
        if (m.playlist && m.playlist.length > 0) {
          st.control.push({ data: { type: 'playlist', songs: m.playlist, history: true } })
        }
      }
      st.control.push({
        data: {
          type: 'chat_status',
          promptTokens: st.session.promptTokens,
          completionTokens: st.session.completionTokens,
          tokens: st.session.promptTokens + st.session.completionTokens,
          context: st.session.lastPromptTokens,
          contextCompletion: st.session.lastCompletionTokens,
          memory: st.session.rollingHistory.length
        }
      })
      return { ok: true, kept }
    }
  },
  {
    name: 'aidj.revert',
    description: '回退主界面会话到指定消息（删除该消息及之后所有）',
    usage: 'aidj.revert --keep <count>',
    run: async (ctx) => {
      const keep = Number(ctx.named.keep) || 0
      if (!_session) return { ok: false, error: '没有活跃会话' }
      if (!_sessionId) return { ok: false, error: '没有会话记录' }

      const raw = await SessionManager.readRawHistory(_sessionId)
      const keepLines = computeRawKeep(raw, keep)
      await SessionManager.truncateTail(_sessionId, raw.length - keepLines)
      const kept = raw.slice(0, keepLines)
      log.info('Main revert', { sessionId: _sessionId, keep, removedLines: raw.length - keepLines })

      const sysPrompt = _session.chatHistory[0]?.role === 'system' ? _session.chatHistory[0] : null
      const rebuilt = rawToChatHistory(kept)
      const bothCount = kept.filter((m) => m.type === 'both').length
      _session.chatHistory = sysPrompt ? [sysPrompt, ...rebuilt] : rebuilt
      _session.playedSongs = new Set(rawToRollingHistory(kept))
      _session.turnCount = sysPrompt ? Math.max(1, bothCount) : 0
      _session.promptTokens = 0
      _session.completionTokens = 0
      return { ok: true, kept }
    }
  },
  {
    name: 'aidj.sessions.list',
    description: '列出所有已保存的 AI DJ 会话',
    usage: 'aidj.sessions.list',
    run: async () => {
      const meta = await SessionManager.listSessions()
      const sessions = await Promise.all(
        meta.map(async (s) => {
          const raw = await SessionManager.readRawHistory(s.id)
          const messages = rawToChatHistory(raw)
          const last = messages[messages.length - 1]
          const preview = last ? (last.content || '').split(SEPARATOR)[0].trim().slice(0, 80) : ''
          return {
            ...s,
            messageCount: messages.length,
            preview
          }
        })
      )
      sessions.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
        return b.updated_at - a.updated_at
      })
      return { ok: true, sessions }
    }
  },
  {
    name: 'aidj.sessions.open',
    description: '载入一个已保存的会话为当前活跃会话',
    usage: 'aidj.sessions.open --id <sessionId>',
    run: async (ctx) => {
      const id = (ctx.named.id as string) || ''
      if (!id) return { ok: false, error: '需要 --id 参数' }
      const { session } = await ensureInit()
      const raw = await SessionManager.readRawHistory(id)
      if (!raw.length) return { ok: false, error: '会话为空或不存在' }

      const sysPrompt = session.buildSystemPrompt()
      const uiMessages = rawToChatHistory(
        raw,
        (rawText) => session.parseRawPlaylist(rawText, 'AI'),
        (done, total) => {
          // Parsing every assistant playlist is the slow part of a session
          // load — stream progress to the renderer so it can animate instead
          // of appearing frozen.
          getBroadcast()('cockpit:aidj-session-progress', { id, done, total })
        }
      )
      // AI context keeps EVERY persisted line: raw assistant text (separator
      // included), user requests, and `updated` system markers (compact/drop
      // hints) — exactly what a live session would carry, so manageContext and
      // nextStep see identical history. `model` audit lines are already
      // excluded by rawToChatHistory.
      const rebuilt = rawToChatHistory(raw)
      const bothCount = raw.filter((m) => m.type === 'both').length

      session.chatHistory = [
        { role: 'system', content: sysPrompt, timestamp: Date.now() },
        ...rebuilt
      ]
      session.playedSongs = new Set(rawToRollingHistory(raw))
      session.turnCount = Math.max(1, bothCount)
      session.promptTokens = 0
      session.completionTokens = 0
      session.lastPromptTokens = 0
      session.lastCompletionTokens = 0
      _session = session
      _sessionId = id
      abortCurrentRequest()
      log.info('Session loaded', { id, messages: uiMessages.length, bothCount })
      return { ok: true, messages: uiMessages, sessionId: id }
    }
  },
  {
    name: 'aidj.session-fork',
    description: '将当前会话分支为新会话 (--keep <n> 截断；--become true 载入为新会话)',
    usage: 'aidj.session-fork [--keep <n>] [--become true]',
    run: async (ctx) => {
      if (!_sessionId) return { ok: false, error: '当前没有会话可分支' }
      const keep = Number(ctx.named.keep)
      let keepN: number | undefined
      if (Number.isFinite(keep) && keep >= 0) {
        const raw = await SessionManager.readRawHistory(_sessionId)
        keepN = computeRawKeep(raw, Math.floor(keep))
      }
      const newId = await SessionManager.forkSession(_sessionId, { keep: keepN })
      if (!newId) return { ok: false, error: '源会话不存在' }
      const meta = await SessionManager.getSession(newId)
      const base = { ok: true, sessionId: newId, title: meta?.title ?? '' }
      if (ctx.named.become !== true) return base

      // Become the current session (mirror sessions.open) so the branch is live.
      const raw = await SessionManager.readRawHistory(newId)
      const { session } = await ensureInit()
      const sysPrompt = session.buildSystemPrompt()
      const uiMessages = rawToChatHistory(raw, (rawText) => session.parseRawPlaylist(rawText, 'AI'))
      const rebuilt = rawToChatHistory(raw)
      session.chatHistory = [
        { role: 'system', content: sysPrompt, timestamp: Date.now() },
        ...rebuilt
      ]
      session.playedSongs = new Set(rawToRollingHistory(raw))
      session.turnCount = Math.max(1, raw.filter((m) => m.type === 'both').length)
      session.promptTokens = 0
      session.completionTokens = 0
      _session = session
      _sessionId = newId
      abortCurrentRequest()
      return { ...base, messages: uiMessages }
    }
  },
  {
    name: 'aidj.sessions.delete',
    description: '删除一个已保存的会话及其历史',
    usage: 'aidj.sessions.delete --id <sessionId>',
    run: async (ctx) => {
      const id = (ctx.named.id as string) || ''
      if (!id) return { ok: false, error: '需要 --id 参数' }
      const ok = await SessionManager.deleteSession(id)
      if (ok && _sessionId === id) {
        _sessionId = ''
        _session?.refresh(true)
      }
      return ok ? { ok: true } : { ok: false, error: '会话不存在' }
    }
  },
  {
    name: 'aidj.sessions.pin',
    description: '置顶/取消置顶一个会话',
    usage: 'aidj.sessions.pin --id <sessionId>',
    run: async (ctx) => {
      const id = (ctx.named.id as string) || ''
      if (!id) return { ok: false, error: '需要 --id 参数' }
      const pinned = await SessionManager.togglePin(id)
      if (pinned === null) return { ok: false, error: '会话不存在' }
      return { ok: true, pinned }
    }
  },
  {
    name: 'aidj.sessions.rename',
    description: '设置会话标题（空或纯空格则保持不变）',
    usage: 'aidj.sessions.rename --id <sessionId> --title <title>',
    run: async (ctx) => {
      const id = (ctx.named.id as string) || ''
      const title = (ctx.named.title as string) || ''
      if (!id) return { ok: false, error: '需要 --id 参数' }
      const changed = await SessionManager.renameSession(id, title)
      if (changed === null) return { ok: false, error: '会话不存在' }
      return { ok: true, changed, title: title.trim() }
    }
  },
  {
    name: 'aidj.sessions.gen-title',
    description: '用对话 AI 根据会话上下文异步生成标题',
    usage: 'aidj.sessions.gen-title --id <sessionId>',
    run: async (ctx) => {
      const id = (ctx.named.id as string) || ''
      if (!id) return { ok: false, error: '需要 --id 参数' }
      const already = listTasks().some(
        (tk) =>
          tk.status === 'running' &&
          tk.name === 'AIDJ 标题生成' &&
          (tk.description ?? '').includes(id)
      )
      if (already)
        return { ok: false, alreadyRunning: true, error: '该会话的标题生成任务正在运行中' }
      const task = await startJobByName('aidj.title', {
        sessionId: id,
        name: 'AIDJ 标题生成',
        description: `为会话 ${id} 自动生成标题`
      })
      if (!task) return { ok: false, error: '标题生成任务无法启动' }
      log.info('Session title job started', { id, taskId: task.id })
      return { ok: true, taskId: task.id }
    }
  },
  {
    name: 'aidj.start-persistent',
    description: '启动持久模式',
    usage: 'aidj.start-persistent --prompt <text> [--anchor <value>]',
    enabled: dbusMode,
    run: async (ctx) => {
      const prompt = (ctx.named.prompt as string) || ctx.positional.join(' ')
      if (!prompt) return { ok: false, error: '需要初始提示词' }
      const anchor = ctx.named.anchor !== undefined ? Number(ctx.named.anchor) : null
      const { client, config, dbus } = await ensureInit()
      const lib = await loadLibrary()
      _metadata = lib.metadata
      _musicPaths = lib.musicPaths
      const ps = new PersistentSession(
        client,
        lib.metadata,
        lib.musicPaths,
        config,
        dbus,
        prompt,
        anchor
      )
      setPersistentSession(ps)
      return { ok: true, message: '持久模式已启动' }
    }
  },
  {
    name: 'aidj.stop-persistent',
    description: '停止持久模式',
    enabled: dbusMode,
    run: async () => {
      const ps = getPersistentSession()
      if (!ps) return { ok: false, error: '持久模式未运行' }
      ps.stop()
      setPersistentSession(null)
      return { ok: true, message: '持久模式已停止' }
    }
  },
  {
    name: 'aidj.abort',
    description: '中止当前 AI 请求',
    run: async () => {
      abortCurrentRequest()
      return { ok: true }
    }
  },
  {
    name: 'aidj.session-new',
    description: '新建会话：中止当前请求并清空会话上下文，下次生成从全新会话开始',
    run: async () => {
      abortCurrentRequest()
      _sessionId = ''
      return { ok: true }
    }
  },
  {
    name: 'aidj.network-test',
    description: '测试 AI API 连通性',
    run: async () => {
      if (!_config) {
        _config = await loadAidjConfig()
      }
      if (!_config) return { ok: false, error: '配置未加载' }
      try {
        const url = _config.ai_settings.base_url.replace(/\/+$/, '') + '/models'
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${_config.secrets.api_key}` },
          signal: controller.signal
        })
        clearTimeout(t)
        // Any HTTP response (2xx/3xx/4xx/5xx) proves the endpoint is reachable.
        // Some providers don't expose /models and return 404, but chat works fine.
        return { ok: true, latency: `HTTP ${res.status}` }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    }
  },
  {
    name: 'aidj.stream-status',
    description: '获取当前流式生成的字符数',
    run: async () => {
      return {
        ok: true,
        chars: _streamingChars,
        retrying: _retrying,
        retryAttempt: _retryAttempt,
        retryWaitMs: _retryWaitMs,
        retryElapsed: _retryStart ? Date.now() - _retryStart : 0,
        retryLastError: _retryLastError
      }
    }
  },
  {
    name: 'aidj.get-config',
    description: '获取当前 AIDJ 配置',
    run: async () => {
      if (!_config) {
        _config = await loadAidjConfig()
      }
      return { ok: true, config: _config }
    }
  },
  {
    name: 'aidj.save-config',
    description: '将当前 AIDJ 配置持久化到 aidj/config.json',
    run: async () => {
      if (!_config) {
        _config = await loadAidjConfig()
      }
      if (!_config) return { ok: false, error: '配置未加载' }
      return saveAidjConfig(_config)
    }
  },
  {
    name: 'aidj.get-models',
    description: '从 API /v1/models 获取可用模型列表',
    run: async () => {
      if (!_config) {
        _config = await loadAidjConfig()
      }
      if (!_config) return { ok: false, error: '配置未加载', models: [] }
      try {
        const url = _config.ai_settings.base_url.replace(/\/+$/, '') + '/models'
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${_config.secrets.api_key}` }
        })
        if (!res.ok) return { ok: false, error: `API 返回 ${res.status}`, models: [] }
        const data = (await res.json()) as { data?: { id: string }[] }
        const models = (data.data ?? []).map((m: { id: string }) => m.id).sort()
        return { ok: true, models }
      } catch (e) {
        return { ok: false, error: String(e), models: [] }
      }
    }
  },
  {
    name: 'aidj.update-config',
    description: '更新 AIDJ 配置（运行时，不持久化到 yaml）',
    usage: 'aidj.update-config --path <key> --value <json>',
    run: async (ctx) => {
      if (!_config) {
        // loadAidjConfig materializes a default file when missing; the inline
        // fallback covers any edge where it still couldn't be built — one
        // update-config is then enough to bootstrap the config deep-created.
        _config = (await loadAidjConfig()) ?? { ...DEFAULT_AIDJ_CONFIG }
      }
      const path = ctx.named.path as string
      const value = ctx.named.value
      if (!path || value === undefined) return { ok: false, error: '需要 --path 和 --value 参数' }
      if (!_config) return { ok: false, error: '配置未加载' }

      // Support dot-notation paths like "preferences.model" or "secrets.api_key"
      const keys = path.split('.')
      let target: Record<string, unknown> = _config as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (!(k in target) || typeof target[k] !== 'object') {
          target[k] = {}
        }
        target = target[k] as Record<string, unknown>
      }
      target[keys[keys.length - 1]] = value

      return { ok: true, config: _config }
    }
  },
  {
    name: 'aidj.reload',
    description: '重新加载曲库元数据',
    run: async () => {
      _config = null
      _client = null
      _session = null
      _metadata = null
      _musicPaths = null
      _sessionId = ''
      invalidateLibrary()
      // Re-read the persisted backend mode + drop the stale wrapper.
      resetPlayerMode()
      const oldDbus = getDbusManager()
      if (oldDbus) oldDbus.disconnect()
      setDbusManager(null as unknown as DBusManager)
      const { session } = await ensureInit()
      reconcilePlayerAbilityVisibility()
      return {
        ok: true,
        librarySize: session.metadata.size,
        pathsSize: session.musicPaths.size
      }
    }
  },
  {
    name: 'aidj.invalidate-library',
    description: '使曲库缓存失效（下次加载重新扫描目录）',
    run: async () => {
      invalidateLibrary()
      _metadata = null
      _musicPaths = null
      return { ok: true }
    }
  },
  {
    name: 'aidj.list-players',
    description: '列出所有可用的 MPRIS 播放器',
    usage: 'aidj.list-players [--force true]',
    // dbus-exclusive: not exposed in web-player mode (no session bus on non-Linux)
    enabled: dbusMode,
    run: async (ctx) => {
      const force = String(ctx.named.force ?? '') === 'true'
      const players = await listAvailablePlayers(force)
      const dbus = getDbusManager()
      const current = dbus?.getPlayerName() || ''
      const auto = dbus ? dbus.autoMode : true
      return { ok: true, players, current, auto }
    }
  },
  {
    name: 'aidj.select-player',
    description: '切换到指定播放器',
    usage: 'aidj.select-player --name <player>',
    enabled: dbusMode,
    run: async (ctx) => {
      const name = ctx.named.name as string
      if (!name) return { ok: false, error: '需要 --name 参数指定播放器名称' }
      const ok = await switchPlayer(name)
      return ok ? { ok: true, player: name } : { ok: false, error: `切换到 ${name} 失败` }
    }
  },
  {
    name: 'aidj.player-mode',
    description: '查询或切换播放后端模式（dbus=外部 MPRIS 播放器，web=内置播放器）',
    usage: 'aidj.player-mode [--set <dbus|web>]',
    run: async (ctx) => {
      const set = ctx.named.set as string | undefined
      if (set !== undefined) {
        if (set !== 'dbus' && set !== 'web') {
          return { ok: false, error: 'mode 必须是 dbus 或 web' }
        }
        return setPlayerMode(set)
      }
      const mode = await getPlayerMode()
      const backend = await getActiveBackend()
      return {
        ok: true,
        mode,
        backend: backend?.mode ?? null,
        supported: backend?.supported ?? true,
        displayName: backend?.displayName ?? ''
      }
    }
  },
  {
    name: 'aidj.web-player-report',
    description: '渲染端内置播放器状态上报（内部）',
    usage: 'aidj.web-player-report --state <json>',
    // web-exclusive: no renderer engine exists in dbus mode
    enabled: webMode,
    run: async (ctx) => {
      // The renderer engine passes the report directly as named args; the CLI
      // form is `--state <json>`.
      let state = (ctx.named.state as string | WebPlayerReport | undefined) ?? ctx.named
      if (typeof state === 'string') {
        try {
          state = JSON.parse(state) as WebPlayerReport
        } catch {
          return { ok: false, error: '--state 不是合法 JSON' }
        }
      }
      if (!state || typeof state !== 'object') {
        return { ok: false, error: '需要 --state 状态对象' }
      }
      getWebPlayerBackend().report(state as WebPlayerReport)
      return { ok: true }
    }
  },
  {
    name: 'aidj.player-state',
    description: '获取统一播放状态（播放器页轮询；dbus=MPRIS 快照，web=内置播放器上报）',
    usage: 'aidj.player-state',
    run: async () => {
      const mode = await getPlayerMode()
      const backend = await getActiveBackend()
      if (!backend) return { ok: true, mode, state: null }
      const state = await backend.getPlaybackDetail()
      return { ok: true, mode, state }
    }
  },
  {
    name: 'aidj.player-volbal',
    description: '查询或设置内置播放器的响度平衡（--enabled <bool> --method <lufs|linear>）',
    usage: 'aidj.player-volbal [--enabled <true|false>] [--method <lufs|linear>]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      if (ctx.named.enabled === undefined && ctx.named.method === undefined) {
        return { ok: true, ...backend.getVolbalState() }
      }
      const enabled = String(ctx.named.enabled ?? '') !== 'false'
      const method = ctx.named.method as 'lufs' | 'linear' | undefined
      if (method && method !== 'lufs' && method !== 'linear') {
        return { ok: false, error: 'method 必须是 lufs 或 linear' }
      }
      await backend.setVolbal(enabled, method)
      // Persist the shared preference (same fields the continuous task uses).
      try {
        const config = await loadAidjConfig()
        if (config) {
          config.preferences.dynamic_balance_volume = enabled
          if (method) config.preferences.sound_adjust_method = method
          await saveAidjConfig(config)
        }
      } catch (e) {
        log.warn('persist player volbal failed', { error: String(e) })
      }
      return { ok: true, ...backend.getVolbalState() }
    }
  },
  {
    name: 'aidj.player-rebase',
    description: '将当前音量设为内置播放器响度平衡的新基准',
    usage: 'aidj.player-rebase --base <0-1>',
    enabled: webMode,
    run: async (ctx) => {
      const base = Number(ctx.named.base)
      if (isNaN(base) || base < 0 || base > 1) return { ok: false, error: '需要 --base (0-1)' }
      const ok = await getWebPlayerBackend().rebase(base)
      return ok ? { ok: true, base } : { ok: false, error: 'rebase 失败' }
    }
  },
  {
    name: 'aidj.seek',
    description: '跳转到指定位置（毫秒）',
    usage: 'aidj.seek --position <ms>',
    run: async (ctx) => {
      const position = Number(ctx.named.position)
      if (!Number.isFinite(position) || position < 0) {
        return { ok: false, error: '需要 --position 非负毫秒数' }
      }
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: '播放后端未连接' }
      const ok = await backend.seek(position)
      return ok ? { ok: true, position } : { ok: false, error: 'seek 失败' }
    }
  },
  {
    name: 'aidj.get-cover',
    description: '获取歌曲封面（base64 data URL）',
    usage: 'aidj.get-cover --path <filepath>',
    run: async (ctx) => {
      const path = ctx.named.path as string
      if (!path) return { ok: false, error: '需要 --path 参数' }
      const url = await getCoverArt(path)
      return { ok: true, url }
    }
  },
  {
    name: 'aidj.freq',
    description: '歌曲播放频率列表（含曲库路径，按次数降序）',
    usage: 'aidj.freq',
    run: async () => {
      const [freq, lib] = await Promise.all([loadFrequency(), loadLibrary()])
      const rows = [...freq.entries()]
        .map(([name, times]) => ({ name, times, path: lib.musicPaths.get(name) ?? '' }))
        .sort((a, b) => b.times - a.times)
      return { ok: true, rows }
    }
  },
  {
    name: 'aidj.continuous-list',
    description: '列出所有运行中的连续播放任务',
    enabled: dbusMode,
    run: async () => {
      const tasks = getContinuousTasks().map((t) => ({
        taskId: t.control.id,
        player: t.playerKey,
        current: t.current?.name ?? null,
        currentPath: t.current?.path ?? null,
        next: t.queue[t.index]?.name ?? null,
        played: t.index,
        total: t.total,
        queue: t.queue.slice(t.index).map((s) => ({ name: s.name, path: s.path })),
        volbal: t.volbal,
        recordFreq: t.recordFreq
      }))
      const boundPlayers = tasks.map((t) => t.player).filter(Boolean)
      return { ok: true, tasks, boundPlayers }
    }
  },
  {
    name: 'aidj.continuous-switch',
    description: '切换连续播放任务的 MPRIS 播放器',
    usage: 'aidj.continuous-switch --task <id> --player <name>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const player = ctx.named.player as string
      if (!taskId || !player) return { ok: false, error: '需要 --task 和 --player 参数' }
      const st = getContinuousTask(taskId)
      if (!st) return { ok: false, error: '任务不存在或已结束' }
      const taken = getContinuousTasks().some(
        (t) => t.playerKey === player && t.control.id !== taskId
      )
      if (taken) return { ok: false, error: `播放器 ${player} 已被其他连续播放任务绑定` }
      if (!st.dbus) return { ok: false, error: '连续播放任务尚未连接播放器' }
      const ok = await st.dbus.switchToPlayer(player)
      if (!ok) return { ok: false, error: `切换到 ${player} 失败` }
      const r = switchContinuousPlayer(taskId, player)
      if (!r.ok) return r
      return {
        ok: true,
        taskId,
        player,
        current: st.current?.name ?? null,
        next: st.queue[st.index]?.name ?? null
      }
    }
  },
  {
    name: 'aidj.continuous-reorder',
    description: '调整连续播放队列顺序',
    usage: 'aidj.continuous-reorder --task <id> --songs <json>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const songsJson = ctx.named.songs as string
      if (!taskId || !songsJson) return { ok: false, error: '需要 --task 和 --songs 参数' }
      let songs: unknown
      try {
        songs = JSON.parse(songsJson)
      } catch {
        return { ok: false, error: '--songs 不是合法 JSON' }
      }
      const r = reorderContinuousQueue(taskId, songs as { name: string; path: string }[])
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  },
  {
    name: 'aidj.continuous-enqueue',
    description: '向运行中的连续播放任务添加歌曲',
    usage: 'aidj.continuous-enqueue --task <id> --songs <json>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const songsJson = ctx.named.songs as string
      if (!taskId || !songsJson) return { ok: false, error: '需要 --task 和 --songs 参数' }
      let songs: unknown
      try {
        songs = JSON.parse(songsJson)
      } catch {
        return { ok: false, error: '--songs 不是合法 JSON' }
      }
      const r = enqueueContinuousSongs(taskId, songs as { name: string; path: string }[])
      return r.ok
        ? { ok: true, total: r.total, queueLen: r.queueLen }
        : { ok: false, error: r.error }
    }
  },
  {
    name: 'aidj.continuous-volbal',
    description: '切换连续播放任务的响度平衡开关/方法',
    usage: 'aidj.continuous-volbal --task <id> --enabled <true|false> [--method <lufs|linear>]',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      const enabled = String(ctx.named.enabled ?? '') !== 'false'
      const method = ctx.named.method as string | undefined
      const r = setContinuousVolbal(taskId, enabled, method)
      // persist to the global config so a restart keeps the choice
      if (r.ok && _config) {
        _config.preferences.dynamic_balance_volume = enabled
        if (method) _config.preferences.sound_adjust_method = method as 'lufs' | 'linear'
      }
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  },
  {
    name: 'aidj.continuous-recordfreq',
    description: '切换连续播放任务的播放频率记录',
    usage: 'aidj.continuous-recordfreq --task <id> --enabled <true|false>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      const enabled = String(ctx.named.enabled ?? '') !== 'false'
      const r = setContinuousRecordFreq(taskId, enabled)
      if (r.ok && _config) _config.preferences.record_freq = enabled
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  },
  {
    name: 'aidj.continuous-clear-memory',
    description: '重置连续播放队列的已播记忆（从头重播）',
    usage: 'aidj.continuous-clear-memory --task <id>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      const r = clearContinuousMemory(taskId)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
  },
  {
    name: 'aidj.continuous-volume',
    description: '获取或设置连续播放任务的音量',
    usage: 'aidj.continuous-volume --task <id> [--set <0-1>]',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      if (!taskId) return { ok: false, error: '需要 --task 参数' }
      if (ctx.named.set !== undefined) {
        const vol = Number(ctx.named.set)
        if (isNaN(vol) || vol < 0 || vol > 1) return { ok: false, error: '音量需在 0-1 之间' }
        const r = await setContinuousVolume(taskId, vol)
        return r.ok ? { ok: true, volume: vol } : { ok: false, error: r.error }
      }
      const volume = await getContinuousVolume(taskId)
      return { ok: true, volume }
    }
  },
  {
    name: 'aidj.continuous-rebase',
    description: '将当前音量设为响度平衡的新基准（自定义 anchor）',
    usage: 'aidj.continuous-rebase --task <id> --base <0-1>',
    enabled: dbusMode,
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const base = Number(ctx.named.base)
      if (!taskId || isNaN(base) || base < 0 || base > 1) {
        return { ok: false, error: '需要 --task 和 --base (0-1) 参数' }
      }
      return setContinuousBaseVol(taskId, base)
    }
  },
  {
    name: 'aidj.lyrics',
    description: '当前播放状态 + 对应歌词（桌面歌词窗口 1Hz 轮询；dbus/web 通用）',
    usage: 'aidj.lyrics',
    run: async () => {
      if ((await getPlayerMode()) === 'web') return getWebLyricPlayback()
      return getLyricPlayback()
    }
  },
  {
    name: 'aidj.lyrics-state',
    description: '当前播放器对应的歌词窗口是否已打开（菜单开关状态）',
    usage: 'aidj.lyrics-state',
    run: async () => {
      const key = await currentLyricsKey()
      const windowId = lyricWindowId(key)
      const open = listChildWindows().some((w) => w.id === windowId)
      return { ok: true, open, windowId, player: key }
    }
  },
  {
    name: 'aidj.lyrics-open',
    description: '打开当前播放器的桌面歌词浮窗（透明 · 无边框 · 圆角）',
    usage: 'aidj.lyrics-open',
    run: async () => {
      const { id, key, spec } = await lyricWindowSpec()
      const res = createChildWindow(spec)
      return { ...res, windowId: id, player: key }
    }
  },
  {
    name: 'aidj.lyrics-close',
    description: '关闭当前播放器的桌面歌词浮窗',
    usage: 'aidj.lyrics-close',
    run: async () => {
      const { id, key } = await lyricWindowSpec()
      const closed = destroyChildWindow(id)
      return { ok: true, closed, windowId: id, player: key }
    }
  },
  {
    name: 'aidj.lyrics-toggle',
    description: '切换当前播放器的桌面歌词浮窗开关',
    usage: 'aidj.lyrics-toggle',
    run: async () => {
      const { id, key, spec } = await lyricWindowSpec()
      const res = createChildWindow(spec)
      if (res.created) return { ok: true, open: true, windowId: id, player: key }
      destroyChildWindow(id)
      return { ok: true, open: false, windowId: id, player: key }
    }
  },
  {
    name: 'aidj.activate',
    description: '激活 AIDJ 的共享 DBus 播放器绑定（无需启动 AI 会话）',
    usage: 'aidj.activate',
    run: async () => {
      // Mode-aware rather than gated: the lyrics page calls this in both modes.
      if ((await getPlayerMode()) === 'web') {
        return { ok: false, error: '内置播放器模式无需 DBus 绑定' }
      }
      return activateAidjDbus()
    }
  },
  {
    name: 'aidj.lyrics-player',
    description: '获取歌词页当前绑定的播放器与可用列表（web 模式返回空列表）',
    usage: 'aidj.lyrics-player',
    run: async () => {
      // Shared command: in web mode there is no player selection — report the
      // mode so the in-app page can hide the selector.
      if ((await getPlayerMode()) === 'web') {
        return { ok: true, players: [], current: '', auto: true, mode: 'web' }
      }
      const players = await listAvailablePlayers()
      const binding = await getLyricPlayerBinding()
      return { ok: true, players, current: binding.current, auto: binding.auto, mode: 'dbus' }
    }
  },
  {
    name: 'aidj.lyrics-select-player',
    description: '绑定歌词页到指定 MPRIS 播放器（或 __auto__ 自动跟随）',
    usage: 'aidj.lyrics-select-player --name <player>',
    enabled: dbusMode,
    run: async (ctx) => {
      const name = ctx.named.name as string
      if (!name) return { ok: false, error: '需要 --name 参数指定播放器' }
      const ok = await switchLyricsPlayer(name)
      return ok ? { ok: true, player: name } : { ok: false, error: `切换到 ${name} 失败` }
    }
  },
  {
    name: 'aidj.lyrics-page-config',
    description: '获取歌词页（AIDJ Lyrics）显示配置',
    usage: 'aidj.lyrics-page-config',
    run: async () => {
      const config = await loadLyricsPageConfig()
      return { ok: true, config }
    }
  },
  {
    name: 'aidj.lyrics-page-save',
    description: '保存歌词页（AIDJ Lyrics）显示配置',
    usage: 'aidj.lyrics-page-save --config <json>',
    run: async (ctx) => {
      let config = ctx.named.config as AidjLyricsPageConfig | undefined
      if (typeof config === 'string') {
        try {
          config = JSON.parse(config)
        } catch {
          return { ok: false, error: '--config 不是合法 JSON' }
        }
      }
      if (!config || typeof config !== 'object') {
        return { ok: false, error: '需要 --config <json>' }
      }
      return saveLyricsPageConfig(config)
    }
  }
]
export default commands
