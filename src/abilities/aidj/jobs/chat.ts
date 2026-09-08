import { registerJobHandler, type JobControl } from '../../../main/process/background-tasks'
import { makeLogger } from '../../../main/process/logger'
import { t, te } from '../../../main/process/i18n'
import {
  loadAidjConfig,
  ensureAidjDir,
  loadLibrary,
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  setNcmMode,
  setNcmApproved,
  setNcmCommentCount,
  PersistentSession,
  SessionManager,
  getCurrentPlayerKey
} from '../service'
import OpenAI from 'openai'
import type { PlaylistEntry, ChatMessage } from '../types'
import { getPlayerMode, getWebPlayerBackend } from '../player-backend'
import { sleep, cancellableWait, samePlayer } from './shared'
import {
  queueRemainingFor,
  ensureContinuousPlayer,
  replaceContinuousQueue,
  onContinuousPlayerSwitch
} from './continuous'

const log = makeLogger('aidj-chat')

export interface ChatTaskState {
  session: PersistentSession
  player: string
  control: JobControl
  abortFetch?: () => void
  forceFetch?: boolean
  replaceQueueOnNext?: boolean
}

const chatTasks = new Map<string, ChatTaskState>()

onContinuousPlayerSwitch((oldKey, newKey) => {
  for (const ct of chatTasks.values()) {
    if (samePlayer(ct.player, oldKey)) ct.player = newKey
  }
})

export function getChatTask(taskId: string): ChatTaskState | undefined {
  return chatTasks.get(taskId)
}

export function getChatTasks(): ChatTaskState[] {
  return [...chatTasks.values()]
}

export async function setChatPlayer(
  taskId: string,
  player: string
): Promise<{ ok: boolean; error?: string }> {
  const st = chatTasks.get(taskId)
  if (!st) return { ok: false, error: '持续会话未运行' }
  st.player = player
  return { ok: true }
}

/** Resend a playlist to the chat session's continuous player. */
export async function chatResendPlaylist(
  chatTaskId: string,
  songs: PlaylistEntry[]
): Promise<{ ok: boolean; error?: string; total?: number }> {
  const st = chatTasks.get(chatTaskId)
  if (!st) return { ok: false, error: '持续会话未运行' }
  return ensureContinuousPlayer(st.player, songs)
}

registerJobHandler('aidj.chat', async (control, args) => {
  const initialPrompt = (args.prompt as string) || ''
  const history = (args.history ?? []) as ChatMessage[]
  const rollingHistoryArg = (args.rollingHistory ?? []) as string[]
  const playerArg = (args.player as string) || ''
  if (!initialPrompt) {
    control.pushLine('错误: 需要初始提示词', 'stderr')
    control.finish('error')
    return
  }

  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  setNcmBaseUrl(config.ncm_base_url)
  setNcmApproved(config.preferences?.ncm_approved)
  setNcmMode(config.preferences?.ncm_mode)
  setNcmCommentCount(config.preferences?.metadata_comment_count)
  await ensureAidjDir()

  const lib = await loadLibrary()
  const missing = await findMissingSongs(lib.musicPaths, lib.metadata)
  if (missing.size > 0) {
    control.pushLine(`发现 ${missing.size} 首新歌曲，同步元数据中...`)
    const syncClient = new OpenAI({
      apiKey: config.secrets.api_key,
      baseURL: config.ai_settings.base_url
    })
    await syncMetadata(
      syncClient,
      missing,
      lib.metadata,
      config.ai_settings.metadata_model,
      config.preferences.metadata_concurrency
    )
  }

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })
  // Resolve the push target. Web mode → the built-in engine ('web'); dbus →
  // __auto__/empty resolve to the active MPRIS player so the push matches the
  // existing continuous task (keyed by the concrete name).
  const webMode = (await getPlayerMode()) === 'web'
  const player = webMode
    ? 'web'
    : playerArg && playerArg !== '__auto__'
      ? playerArg
      : await getCurrentPlayerKey().catch(() => config.preferences.dbus_target || 'vlc')

  const sessionArg = (args.sessionId as string) || ''
  // /persist forks a session up front and passes it in — reuse it so the
  // persistent conversation lives in the forked (Copy) session; otherwise
  // create a fresh chat session from the seeded history.
  const sessionId =
    sessionArg && (await SessionManager.getSession(sessionArg))
      ? sessionArg
      : await SessionManager.createSession({
          title: initialPrompt.slice(0, 40),
          type: 'chat'
        })
  const isForked = sessionId === sessionArg
  const session = new PersistentSession(
    client,
    lib.metadata,
    lib.musicPaths,
    config,
    null,
    initialPrompt
  )
  session.sessionId = sessionId
  if (Array.isArray(history) && history.length) {
    session.chatHistory = history.map((m) => ({ ...m }))
    // When the session was pre-forked (/persist), its history lines are ALREADY
    // persisted by the fork — only append the new user message (the /persist
    // prompt), otherwise every line would be duplicated in the session file.
    if (isForked) {
      const last = history[history.length - 1]
      if (last?.role === 'user') {
        await SessionManager.appendMessage(sessionId, {
          role: 'user',
          content: last.content,
          ts: last.timestamp,
          type: 'user'
        })
      }
    } else {
      await SessionManager.appendMessages(
        sessionId,
        history
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role,
            content: m.content,
            ts: m.timestamp,
            type: m.role === 'assistant' ? 'both' : 'user',
            playlist: m.playlist
          }))
      )
    }
  }
  if (Array.isArray(rollingHistoryArg) && rollingHistoryArg.length) {
    session.rollingHistory = rollingHistoryArg.slice(0, 100)
  }

  const ac = new AbortController()
  const st: ChatTaskState = { session, player, control }
  chatTasks.set(control.id, st)
  control.setCancel(() => {
    ac.abort()
    chatTasks.delete(control.id)
    session.stop()
  })

  // Replay seeded history into the view.
  for (const m of session.chatHistory) {
    const t = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'
    control.push({
      data: {
        type: t,
        content: m.content,
        history: true
      }
    })
    if (m.playlist && m.playlist.length > 0) {
      control.push({ data: { type: 'playlist', songs: m.playlist, history: true } })
    }
  }

  control.push({ data: { type: 'state', message: 'started', player, prompt: initialPrompt } })
  control.pushLine(`持续会话已启动 → ${player}`)
  control.push({
    data: {
      type: 'chat_status',
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      context: 0,
      contextCompletion: 0,
      memory: session.rollingHistory.length
    }
  })

  const REFILL = 8
  const FETCH_TIMEOUT = 180_000
  let fetchAc = new AbortController()
  st.abortFetch = () => fetchAc.abort()
  let lastErrorShown = ''
  let lastIntroShown = ''
  let lastWebTrack = ''

  const fetchWithTimeout = async (): Promise<void> => {
    fetchAc.abort()
    fetchAc = new AbortController()
    const t = setTimeout(() => fetchAc.abort(), FETCH_TIMEOUT)
    let retryStart = 0
    try {
      await session.fetchBatch(
        AbortSignal.any([ac.signal, fetchAc.signal]),
        (attempt, _waitMs, err) => {
          retryStart = retryStart || Date.now()
          const elapsed = Math.round((Date.now() - retryStart) / 1000)
          const errMsg = err ? String(err instanceof Error ? err.message : err) : ''
          control.push({
            data: {
              type: 'retry',
              attempt,
              elapsed,
              content: `重试中(${attempt}: 已经${elapsed}s)${errMsg ? `\n⚠️ ${errMsg}` : ''}`
            }
          })
        }
      )
    } finally {
      clearTimeout(t)
    }
  }

  try {
    while (!ac.signal.aborted) {
      try {
        const queueLen = queueRemainingFor(st.player)

        // Refill when the queue is low — or immediately when the user sent a
        // new message (/discard_follows), regardless of the batch threshold.
        if ((queueLen < REFILL || st.forceFetch) && !session.working) {
          st.forceFetch = false
          control.push({ data: { type: 'thinking' } })
          try {
            await fetchWithTimeout()
          } finally {
            control.push({ data: { type: 'idle' } })
            control.push({ data: { type: 'retry_clear' } })
            control.push({
              data: {
                type: 'chat_status',
                promptTokens: session.promptTokens,
                completionTokens: session.completionTokens,
                tokens: session.promptTokens + session.completionTokens,
                context: session.lastPromptTokens,
                contextCompletion: session.lastCompletionTokens,
                memory: session.rollingHistory.length
              }
            })
          }

          const batch = session.buffer.shift()
          if (batch && batch.length) {
            if (session.lastIntro) {
              if (session.lastIntro.startsWith('⚠️')) {
                if (session.lastIntro !== lastErrorShown) {
                  lastErrorShown = session.lastIntro
                  control.push({ data: { type: 'system', content: session.lastIntro } })
                }
              } else if (session.lastIntro !== lastIntroShown) {
                lastIntroShown = session.lastIntro
                control.push({ data: { type: 'assistant', content: session.lastIntro } })
              }
            }
            control.push({ data: { type: 'playlist', songs: batch } })
            // A user-directed /discard_follows generation REPLACES the pending
            // queue once the new songs are ready (never clears it beforehand).
            const mode = st.replaceQueueOnNext ? 'replace' : 'enqueue'
            st.replaceQueueOnNext = false
            const push = async (): Promise<{ ok: boolean; error?: string }> =>
              mode === 'replace'
                ? replaceContinuousQueue(st.player, batch)
                : ensureContinuousPlayer(st.player, batch)
            let r = await push()
            let attempts = 0
            // A failed push (e.g. the player isn't up yet) must NOT be dropped
            // for the next cycle — keep retrying every 10s until it lands or
            // the user cancels.
            while (!r.ok && !ac.signal.aborted) {
              attempts++
              if (attempts === 1) {
                control.push({
                  data: {
                    type: 'system',
                    content: te('aidj.push.retry', { error: r.error ?? '未知错误' })
                  }
                })
              }
              control.pushLine(
                te('aidj.push.attempt', {
                  n: String(attempts),
                  error: r.error ?? ''
                }),
                'stderr'
              )
              await cancellableWait(10_000, ac.signal)
              if (ac.signal.aborted) break
              r = await push()
            }
            if (ac.signal.aborted) {
              control.pushLine(t('aidj.push.cancelled'), 'stderr')
              break
            }
            if (r.ok) {
              if (attempts > 0) {
                control.push({
                  data: {
                    type: 'system',
                    content: te('aidj.push.retriedOk', { n: String(attempts) })
                  }
                })
              }
              control.pushLine(te('aidj.push.ok', { n: String(batch.length) }))
            }
          } else if (session.lastIntro) {
            if (session.lastIntro.startsWith('⚠️')) {
              if (session.lastIntro !== lastErrorShown) {
                lastErrorShown = session.lastIntro
                control.push({ data: { type: 'system', content: session.lastIntro } })
              }
            } else if (session.lastIntro !== lastIntroShown) {
              lastIntroShown = session.lastIntro
              control.push({ data: { type: 'assistant', content: session.lastIntro } })
            }
          }
        }

        // Web mode: the built-in engine auto-advances its queue, so the chat
        // job surfaces per-track "now playing" itself (dbus mode gets it from
        // the continuous task).
        if (webMode) {
          const detail = await getWebPlayerBackend().getPlaybackDetail()
          if (detail.ok && detail.track && detail.track !== lastWebTrack) {
            lastWebTrack = detail.track
            const path = detail.url.startsWith('file://')
              ? decodeURIComponent(detail.url.slice('file://'.length))
              : null
            control.push({ data: { type: 'now_playing', track: detail.track, path } })
          }
        }

        await sleep(1000)
      } catch (e) {
        if (ac.signal.aborted) break
        log.error('chat loop error', { error: String(e) })
        const errMsg = `⚠️ API 错误: ${String(e)}`
        if (errMsg !== lastErrorShown) {
          lastErrorShown = errMsg
          control.push({ data: { type: 'system', content: errMsg } })
        }
        control.pushLine(`错误: ${String(e)}`, 'stderr')
        await sleep(5000)
      }
    }
  } finally {
    chatTasks.delete(control.id)
  }

  control.pushLine('持续会话已结束')
  control.finish('exited')
})
