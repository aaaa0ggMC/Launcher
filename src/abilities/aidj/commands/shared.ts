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
  setNcmApproved,
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
import type { AgentEvent } from '../loop/agent/runner'
import { runAgentWorkflow } from '../loop/agent/workflow'
import { mergeUsage, usageFromHistory, type TurnContext, type UsageBreakdown } from '../loop/usage'
import { resolveLoopPolicy } from '../loop/policy'
import { resolveLoopPrompts } from '../loop/prompts'
import { planBatch } from '../loop/planner'
import { agentHistory, rememberAgentTurn, withNetworkRetry } from '../services/session'

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
  /** Agent workflow events of the running / last instant request (`aidj.stream-status --since`). */
  workflow: AgentEvent[]
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
  sessionId: '',
  workflow: []
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
  setNcmApproved(config.preferences?.ncm_approved)
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
      // In the background: opening a session / the first request must not wait
      // for NCM + AI extraction (seconds per song). syncMetadata fills this same
      // map, so the session sees new tags as soon as they land.
      log.info(`Found ${missing.size} new songs, syncing metadata in the background...`)
      void syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      ).catch((e) => log.warn('background metadata sync failed', { error: String(e) }))
    }
    session = new DJSession(client, state.metadata, paths, config)
    state.session = session
  }

  return { client, config, session, dbus }
}

/**
 * history.jsonl → chat messages. `withWorkflow` (UI replay only) attaches each
 * `workflow` line to the next assistant message; without it — e.g. when building
 * the AI context — workflow lines are dropped like every non-chat line.
 */
export function rawToChatHistory(
  raw: RawHistoryMessage[],
  parse?: (rawText: string) => { intro: string; playlist: PlaylistEntry[] },
  onProgress?: (done: number, total: number) => void,
  opts: { withWorkflow?: boolean } = {}
): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingWorkflow: Record<string, unknown>[] | undefined
  const take = (): { workflow?: Record<string, unknown>[] } => {
    const w = pendingWorkflow
    pendingWorkflow = undefined
    return w?.length ? { workflow: w } : {}
  }
  for (let i = 0; i < raw.length; i++) {
    if (onProgress) onProgress(i + 1, raw.length)
    const m = raw[i]
    if (m.type === 'workflow') {
      if (opts.withWorkflow && Array.isArray(m.workflow)) {
        pendingWorkflow = [...(pendingWorkflow ?? []), ...m.workflow]
      }
      continue
    }
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
        timestamp: m.ts,
        ...take()
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
      timestamp: m.ts,
      ...(role === 'assistant' ? take() : {})
    })
  }
  return out
}

/**
 * Rebuild a session's token counters from its history (open / revert / fork).
 * Returns what the chat view shows: totals (+ per agent, cached) and the last
 * turn's Context / Completion.
 */
export function restoreUsage(
  s: {
    usage: UsageBreakdown
    promptTokens: number
    completionTokens: number
    lastPromptTokens: number
    lastCompletionTokens: number
  },
  raw: RawHistoryMessage[]
): { tokens: UsageBreakdown; context: TurnContext } {
  const { usage, context } = usageFromHistory(raw)
  s.usage = usage
  s.promptTokens = usage.prompt
  s.completionTokens = usage.completion
  s.lastPromptTokens = context.prompt
  s.lastCompletionTokens = context.completion
  return { tokens: usage, context }
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

/**
 * Gate capsules for CommandSpec.enabled — spreading one of these applies both
 * the mode check AND the reason string, so an agent that trips the gate in the
 * other mode gets "command X 当前不可用: <reason>" instead of a bare
 * "unknown command" (see `unavailableReason` in commands/types.ts).
 *
 * Switching the backend for real: AIDJ 设置 → 「播放后端」select
 * (`preferences.player_mode`, components/AidjSettingsSection.vue), which calls
 * `aidj.player-mode --set dbus|web` (player-backend.ts `setPlayerMode`).
 */
export const DBUS_ONLY = {
  enabled: dbusMode,
  unavailableReason:
    '当前为内置播放器 (web) 模式，此命令仅在外部播放器 (MPRIS / DBus) 模式下可用。' +
    '切换方式：AIDJ 设置 → 「播放后端」选「外部播放器 (MPRIS / DBus)」，或执行 aidj.player-mode --set dbus' +
    '（切换会停止运行中的连续播放 / 持久会话）'
} as const

export const WEB_ONLY = {
  enabled: webMode,
  unavailableReason:
    '当前为外部播放器 (MPRIS / DBus) 模式，此命令仅在内置播放器 (web) 模式下可用。' +
    '切换方式：AIDJ 设置 → 「播放后端」选「内置播放器」，或执行 aidj.player-mode --set web' +
    '（切换会停止运行中的连续播放 / 持久会话；内置播放器为实验性后端）'
} as const

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

/** Workflow events kept for one instant request (the view polls them incrementally). */
const MAX_WORKFLOW_EVENTS = 400

/**
 * Instant chat (`aidj.generate`) in agent mode: the same LoopAgent → RankAgent
 * workflow as the persistent chat, on the instant DJSession's history. Events
 * go to `state.workflow` for the chat view (polled via `aidj.stream-status`).
 */
export async function runInstantAgent(
  session: DJSession,
  config: AidjConfig,
  prompt: string,
  signal: AbortSignal,
  onRetry: (attempt: number, waitMs: number, error?: unknown) => void
): Promise<{
  playlist: PlaylistEntry[]
  intro: string
  raw: string
  updated?: RawHistoryMessage | null
}> {
  const policy = resolveLoopPolicy(config)
  const lib = await loadLibrary()
  const played = [...session.playedSongs]
  const plan = planBatch({
    policy,
    prompts: resolveLoopPrompts(config),
    mode: 'agent',
    metadata: session.metadata,
    initialPrompt: prompt,
    // First message = initial request; later ones = a new user direction.
    userDirection: session.turnCount > 0 ? prompt : null,
    fetchCount: 0,
    rollingHistory: played
  })
  const max = Math.max(2, config.preferences.max_history_length || 10)
  state.workflow = []
  const r = await runAgentWorkflow({
    client: session.client,
    config,
    policy,
    plan,
    helper: session,
    metadata: session.metadata,
    musicPaths: session.musicPaths,
    lyrics: lib.lyrics,
    played,
    history: agentHistory(session.chatHistory, max),
    goal: prompt,
    retry: (fn) =>
      withNetworkRetry(fn, {
        retryMinutes: config.preferences.network_retry_minutes ?? 0,
        signal,
        onRetry
      }),
    signal,
    emit: (e) => {
      if (state.workflow.length < MAX_WORKFLOW_EVENTS) state.workflow.push(e)
    },
    log
  })
  session.turnCount++
  session.lastPromptTokens = r.lastPromptTokens
  session.lastCompletionTokens = r.lastCompletionTokens
  session.promptTokens += r.promptTokens
  session.completionTokens += r.completionTokens
  session.usage = mergeUsage(session.usage, r.usage)
  if (signal.aborted) return { playlist: [], intro: '', raw: '' }
  if (!r.failed) {
    rememberAgentTurn(session.chatHistory, plan.prompt, r.intro, r.playlist, max)
    for (const s of r.playlist) session.playedSongs.add(s.name)
  }
  return { playlist: r.playlist, intro: r.intro, raw: r.failed ? '' : r.intro, updated: null }
}
