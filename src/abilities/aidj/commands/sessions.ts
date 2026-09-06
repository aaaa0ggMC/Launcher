import type { CommandSpec } from '../../../main/process/commands/types'
import { getBroadcast } from '../../../main/process/broadcast'
import { listTasks, startJobByName } from '../../../main/process/background-tasks'
import {
  loadLibrary,
  loadAidjConfig,
  SessionManager,
  getPersistentSession,
  setPersistentSession,
  PersistentSession
} from '../service'
import { SEPARATOR } from '../types'
import { getChatTask, clearContinuousPending } from '../jobs'
import {
  state,
  ensureInit,
  log,
  dbusMode,
  computeRawKeep,
  rawToChatHistory,
  rawToRollingHistory,
  abortCurrentRequest
} from './shared'

export const sessionsCommands: CommandSpec[] = [
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
      if (!state.session) return { ok: false, error: '没有活跃会话' }
      if (!state.sessionId) return { ok: false, error: '没有会话记录' }

      const raw = await SessionManager.readRawHistory(state.sessionId)
      const keepLines = computeRawKeep(raw, keep)
      await SessionManager.truncateTail(state.sessionId, raw.length - keepLines)
      const kept = raw.slice(0, keepLines)
      log.info('Main revert', {
        sessionId: state.sessionId,
        keep,
        removedLines: raw.length - keepLines
      })

      const sysPrompt =
        state.session.chatHistory[0]?.role === 'system' ? state.session.chatHistory[0] : null
      const rebuilt = rawToChatHistory(kept)
      const bothCount = kept.filter((m) => m.type === 'both').length
      state.session.chatHistory = sysPrompt ? [sysPrompt, ...rebuilt] : rebuilt
      state.session.playedSongs = new Set(rawToRollingHistory(kept))
      state.session.turnCount = sysPrompt ? Math.max(1, bothCount) : 0
      state.session.promptTokens = 0
      state.session.completionTokens = 0
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
      state.session = session
      state.sessionId = id
      abortCurrentRequest()
      log.info('Session loaded', { id, messages: uiMessages.length, bothCount })
      return { ok: true, messages: uiMessages, sessionId: id, memory: session.playedSongs.size }
    }
  },
  {
    name: 'aidj.session-fork',
    description: '将当前会话分支为新会话 (--keep <n> 截断；--become true 载入为新会话)',
    usage: 'aidj.session-fork [--keep <n>] [--become true]',
    run: async (ctx) => {
      if (!state.sessionId) return { ok: false, error: '当前没有会话可分支' }
      const keep = Number(ctx.named.keep)
      let keepN: number | undefined
      if (Number.isFinite(keep) && keep >= 0) {
        const raw = await SessionManager.readRawHistory(state.sessionId)
        keepN = computeRawKeep(raw, Math.floor(keep))
      }
      const newId = await SessionManager.forkSession(state.sessionId, { keep: keepN })
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
      state.session = session
      state.sessionId = newId
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
      if (ok && state.sessionId === id) {
        state.sessionId = ''
        const s = state.session
        if (s) {
          s.refresh(true)
          s.promptTokens = 0
          s.completionTokens = 0
          s.lastPromptTokens = 0
          s.lastCompletionTokens = 0
        }
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
      state.metadata = lib.metadata
      state.musicPaths = lib.musicPaths
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
    description:
      '新建会话：中止当前请求并重置会话状态（清空上下文、已播记忆与计费），下次生成从全新会话开始',
    run: async () => {
      abortCurrentRequest()
      state.sessionId = ''
      const session = state.session
      if (session) {
        // 换 session 必须重置必要的 status：已播记忆（memory）、上下文与计费，
        // 否则新会话会继承上一个会话的已播曲目、历史与 token 计数。
        session.refresh(true)
        session.promptTokens = 0
        session.completionTokens = 0
        session.lastPromptTokens = 0
        session.lastCompletionTokens = 0
      }
      return { ok: true }
    }
  },
  {
    name: 'aidj.network-test',
    description: '测试 AI API 连通性',
    run: async () => {
      if (!state.config) {
        state.config = await loadAidjConfig()
      }
      if (!state.config) return { ok: false, error: '配置未加载' }
      try {
        const url = state.config.ai_settings.base_url.replace(/\/+$/, '') + '/models'
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${state.config.secrets.api_key}` },
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
        chars: state.streamingChars,
        retrying: state.retrying,
        retryAttempt: state.retryAttempt,
        retryWaitMs: state.retryWaitMs,
        retryElapsed: state.retryStart ? Date.now() - state.retryStart : 0,
        retryLastError: state.retryLastError
      }
    }
  }
]
