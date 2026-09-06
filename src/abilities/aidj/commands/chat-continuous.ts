import type { CommandSpec } from '../../../main/process/commands/types'
import { saveAidjConfig } from '../service'
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
  chatResendPlaylist
} from '../jobs'
import { dbusMode, state } from './shared'

export const chatContinuousCommands: CommandSpec[] = [
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
      const short = (n: string): string => n.replace(/^org\.mpris\.MediaPlayer2\./, '')
      const same = (a: string, b: string): boolean => short(a) === short(b)
      const taken = getContinuousTasks().some(
        (t) => same(t.playerKey, player) && t.control.id !== taskId
      )
      if (taken) return { ok: false, error: `播放器 ${player} 已被其他连续播放任务绑定` }
      const r = await switchContinuousPlayer(taskId, player)
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
      if (r.ok && state.config) {
        state.config.preferences.dynamic_balance_volume = enabled
        if (method) state.config.preferences.sound_adjust_method = method as 'lufs' | 'linear'
        await saveAidjConfig(state.config)
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
      if (r.ok && state.config) {
        state.config.preferences.record_freq = enabled
        await saveAidjConfig(state.config)
      }
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
  }
]
