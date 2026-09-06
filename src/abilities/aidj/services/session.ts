import { readFile, mkdir, appendFile, writeFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import { makeLogger } from '../../../main/process/logger'
import { writeJsonAtomic } from '../../../main/process/util'
import type {
  AidjConfig,
  SongMeta,
  PlaylistEntry,
  ChatMessage,
  RawHistoryMessage,
  SessionMeta
} from '../types'
import { SEPARATOR, DEFAULT_PERSONA } from '../types'
import { SESSIONS_DIR, SESSIONS_INDEX, loadSessionsIndex } from './config'
import { LoudnessCache } from './loudness'
import type { DBusManager } from './dbus'

const log = makeLogger('aidj-session')

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

/** Tokenize a song name (punctuation → whitespace, then unique lowercase words). */
export function splitNameTokens(text: string): string[] {
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
  promptTokens: number
  completionTokens: number
  lastPromptTokens: number
  lastCompletionTokens: number
  private _validKeysCache: string[] | null = null
  private _validKeysSig = ''
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
    const sig = `${this.musicPaths.size}:${this.metadata.size}`
    if (this._validKeysCache && this._validKeysSig === sig) return this._validKeysCache
    this._validKeysCache = [...this.metadata.keys()].filter((k) => this.musicPaths.has(k))
    this._validKeysSig = sig
    return this._validKeysCache
  }

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
    const m = a.length
    const n = b.length
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

  bestMatch(query: string, candidates?: string[]): string | null {
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
    const scope = pool.size > 0 ? [...pool] : (candidates ?? this.validKeys())

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
    return { playlist, intro: introText }
  }

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
      const content = resp.choices[0]?.message?.content?.trim() ?? ''
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
    raw: string
    updated?: RawHistoryMessage | null
  }> {
    this.turnCount++
    const model = this.config.preferences.model

    log.debug(`Thinking with ${model}...`)

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
  dbus: DBusManager | null
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  chatHistory: ChatMessage[]
  rollingHistory: string[]
  currentQueue: PlaylistEntry[]
  buffer: PlaylistEntry[][]
  fetchCount: number
  working: boolean
  lastIntro = ''
  promptTokens = 0
  completionTokens = 0
  lastPromptTokens = 0
  lastCompletionTokens = 0
  pendingUserPrompt: string | null = null
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

let _persistentSession: PersistentSession | null = null

export function getPersistentSession(): PersistentSession | null {
  return _persistentSession
}

export function setPersistentSession(s: PersistentSession | null): void {
  _persistentSession = s
}

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
      const idx = await loadSessionsIndex()
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
    const idx = await loadSessionsIndex()
    return idx.sessions
  }

  static async getSession(sessionId: string): Promise<SessionMeta | null> {
    const all = await this.listSessions()
    return all.find((s) => s.id === sessionId) ?? null
  }

  static async touchSession(sessionId: string): Promise<void> {
    await withHistoryLock('__index__', async () => {
      const idx = await loadSessionsIndex()
      const s = idx.sessions.find((x) => x.id === sessionId)
      if (s) {
        s.updated_at = Date.now()
        await writeJsonAtomic(SESSIONS_INDEX, idx)
      }
    })
  }

  static async forkSession(
    sessionId: string,
    opts?: { keep?: number; title?: string }
  ): Promise<string | null> {
    const src = await this.getSession(sessionId)
    if (!src) return null
    const raw = await this.readRawHistory(sessionId)
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

  static async deleteSession(sessionId: string): Promise<boolean> {
    return withHistoryLock('__index__', async () => {
      const idx = await loadSessionsIndex()
      const before = idx.sessions.length
      idx.sessions = idx.sessions.filter((s) => s.id !== sessionId)
      if (idx.sessions.length === before) return false
      await writeJsonAtomic(SESSIONS_INDEX, idx)
      await rm(join(SESSIONS_DIR, sessionId), { recursive: true, force: true }).catch(() => {})
      log.info('Session deleted', { sessionId })
      return true
    })
  }

  static async renameSession(sessionId: string, title: string): Promise<boolean | null> {
    const clean = title.trim()
    let result: boolean | null = null
    await withHistoryLock('__index__', async () => {
      const idx = await loadSessionsIndex()
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

  static async togglePin(sessionId: string): Promise<boolean | null> {
    let result: boolean | null = null
    await withHistoryLock('__index__', async () => {
      const idx = await loadSessionsIndex()
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
