import OpenAI from 'openai'
import { screen } from 'electron'
import { makeLogger } from '../../../main/process/logger'
import { listTasks } from '../../../main/process/background-tasks'
import { t } from '../../../main/process/i18n'
import type { WindowSpec } from '../../../main/process/windows'
import type {
  AidjConfig,
  SongMeta,
  ChatMessage,
  RawHistoryMessage,
  PlaylistEntry,
  LyricsDisplayConfig,
  LyricPlaybackState
} from '../types'
import { SEPARATOR, LYRICS_WINDOW_ID, DEFAULT_LYRICS_CFG } from '../types'
import {
  loadAidjConfig,
  loadLibrary,
  scanMusicFiles,
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  setNcmMode,
  setNcmCommentCount,
  ensureAidjDir,
  DJSession,
  DBusManager,
  initDbusManager,
  getDbusManager,
  SessionManager,
  getCurrentPlayerKey,
  resolveLyricForTrackPath
} from '../service'
import { getPlayerMode, getWebPlayerBackend } from '../player-backend'

export const log = makeLogger('aidj')

export interface CommandRuntimeState {
  client: OpenAI | null
  session: DJSession | null
  metadata: Map<string, SongMeta> | null
  musicPaths: Map<string, string> | null
  config: AidjConfig | null
  currentAbort: AbortController | null
  streamingChars: number
  retrying: boolean
  retryAttempt: number
  retryWaitMs: number
  retryStart: number
  retryLastError: string
  sessionId: string
}

export const state: CommandRuntimeState = {
  client: null,
  session: null,
  metadata: null,
  musicPaths: null,
  config: null,
  currentAbort: null,
  streamingChars: 0,
  retrying: false,
  retryAttempt: 0,
  retryWaitMs: 0,
  retryStart: 0,
  retryLastError: '',
  sessionId: ''
}

export async function getCachedConfig(): Promise<AidjConfig | null> {
  if (!state.config) state.config = await loadAidjConfig()
  return state.config
}

export function setCachedConfig(cfg: AidjConfig | null): void {
  state.config = cfg
}

export function getCurrentAbortSignal(): AbortSignal | null {
  return state.currentAbort?.signal ?? null
}

export function abortCurrentRequest(): void {
  state.currentAbort?.abort()
  state.currentAbort = null
  state.streamingChars = 0
  state.retrying = false
  state.retryAttempt = 0
  state.retryWaitMs = 0
  state.retryStart = 0
  state.retryLastError = ''
}

export async function ensureLibraryLoaded(): Promise<AidjConfig | null> {
  let config = state.config
  if (!config) {
    config = await loadAidjConfig()
    if (!config) return null
    state.config = config
  }
  if (!state.musicPaths || !state.metadata) {
    const lib = await loadLibrary()
    state.metadata = lib.metadata
    state.musicPaths = lib.musicPaths
  }
  return config
}

export async function ensureInit(): Promise<{
  client: OpenAI
  config: AidjConfig
  session: DJSession
  dbus: DBusManager | null
}> {
  let config = state.config
  if (!config) {
    config = await loadAidjConfig()
    if (!config) throw new Error('AIDJ 配置未找到，请先在 aidj/config.json 中配置')
    state.config = config
  }

  setNcmBaseUrl(config.ncm_base_url)
  setNcmMode(config.preferences?.ncm_mode)
  setNcmCommentCount(config.preferences?.metadata_comment_count)

  let client = state.client
  if (!client) {
    client = new OpenAI({
      apiKey: config.secrets.api_key,
      baseURL: config.ai_settings.base_url
    })
    state.client = client
  }

  let dbus: DBusManager | null = getDbusManager()
  if (!dbus && (await getPlayerMode()) === 'dbus') {
    dbus = await initDbusManager(config)
  }

  let session = state.session
  if (!session) {
    await ensureAidjDir()
    const lib = await loadLibrary()
    const paths = lib.musicPaths
    const metadata = lib.metadata
    const fresh = await scanMusicFiles(config.music_folders ?? [])
    for (const [name, path] of fresh) {
      if (!paths.has(name)) paths.set(name, path)
    }
    state.musicPaths = paths
    state.metadata = metadata
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
      state.metadata = synced.metadata
    }
    session = new DJSession(client, state.metadata, paths, config)
    state.session = session
  }

  return { client, config, session, dbus }
}

export function rawToChatHistory(
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

export function rawToRollingHistory(raw: RawHistoryMessage[]): string[] {
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

export function computeRawKeep(raw: RawHistoryMessage[], keepUiMessages: number): number {
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

export async function pushPlaylistToSession(
  session: DJSession,
  userText: string,
  intro: string,
  playlist: PlaylistEntry[]
): Promise<string> {
  if (!state.sessionId) {
    state.sessionId = await SessionManager.createSession({
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
  await SessionManager.appendMessages(state.sessionId, rawMsgs)
  session.chatHistory.push(
    { role: 'user', content: userText, timestamp: Date.now() },
    { role: 'assistant', content: raw, timestamp: Date.now() }
  )
  for (const name of names) session.playedSongs.add(name)
  return raw
}

export function sampleNames(pool: string[], n: number): string[] {
  const copy = [...pool]
  const out: string[] = []
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
  }
  return out
}

/** Locate the running web-remote background task id (if any). */
export function findWebRemoteTaskId(): string {
  return listTasks().find((t) => t.name === 'AIDJ 局域网遥控' && t.status === 'running')?.id ?? ''
}

export const dbusMode = (): Promise<boolean> => getPlayerMode().then((m) => m === 'dbus')
export const webMode = (): Promise<boolean> => getPlayerMode().then((m) => m === 'web')

export const MAX_VARIANT_CACHE_BYTES = 80 * 1024 * 1024
export const AVG_VARIANT_ENTRY_BYTES = 4500

export function lyricWindowId(playerKey: string): string {
  return `${LYRICS_WINDOW_ID}-${playerKey.replace(/[^\w.-]/g, '_')}`
}

export const LYRICS_WINDOW_W = 560

export function lyricWindowHeight(cfg: LyricsDisplayConfig): number {
  const before = Math.max(0, cfg.lines_before ?? 0)
  const after = Math.max(0, cfg.lines_after ?? 0)
  const lines = before + 1 + after
  const unit =
    Math.max(cfg.font_size, cfg.candidate_size ?? 0) * (cfg.line_height ?? 1.3) +
    Math.max(2, cfg.line_gap ?? 6)
  const titleH = cfg.show_title !== false ? (cfg.header_size ?? 13) + 8 : 0
  return Math.max(140, Math.round(24 + titleH + lines * unit))
}

export function lyricWindowPosition(
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

export async function effectiveLyricsCfg(): Promise<LyricsDisplayConfig> {
  const config = await loadAidjConfig()
  return { ...DEFAULT_LYRICS_CFG, ...(config?.preferences?.lyrics ?? {}) }
}

export async function currentLyricsKey(): Promise<string> {
  return (await getPlayerMode()) === 'web' ? 'web' : getCurrentPlayerKey()
}

export async function getWebLyricPlayback(): Promise<LyricPlaybackState> {
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
    karaokeLyric:
      resolveLyricForTrackPath(path, detail.track, lib.karaoke, { fuzzy: false }) ?? null
  }
}

export async function lyricWindowSpec(): Promise<{ id: string; key: string; spec: WindowSpec }> {
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
