import type { CommandSpec } from '../../../main/process/commands/types'
import {
  createChildWindow,
  destroyChildWindow,
  listChildWindows
} from '../../../main/process/windows'
import {
  loadAidjConfig,
  saveAidjConfig,
  listAvailablePlayers,
  switchPlayer,
  getLyricPlayback,
  activateAidjDbus,
  getLyricPlayerBinding,
  switchLyricsPlayer,
  loadLyricsPageConfig,
  saveLyricsPageConfig,
  getDbusManager
} from '../service'
import { getActiveBackend, getPlayerMode, WebPlayerBackend } from '../player-backend'
import { DEFAULT_AIDJ_CONFIG } from '../types'
import type { AidjLyricsPageConfig } from '../types'
import { loadTimeStats, queryTimeRange } from '../listening-stats'
import {
  state,
  dbusMode,
  lyricWindowId,
  currentLyricsKey,
  getWebLyricPlayback,
  lyricWindowSpec
} from './shared'

export const configLyricsCommands: CommandSpec[] = [
  {
    name: 'aidj.get-config',
    description: '获取当前 AIDJ 配置',
    run: async () => {
      if (!state.config) {
        state.config = await loadAidjConfig()
      }
      return { ok: true, config: state.config }
    }
  },
  {
    name: 'aidj.save-config',
    description: '将当前 AIDJ 配置持久化到 aidj/config.json',
    run: async () => {
      if (!state.config) {
        state.config = await loadAidjConfig()
      }
      if (!state.config) return { ok: false, error: '配置未加载' }
      const res = await saveAidjConfig(state.config)
      const backend = await getActiveBackend()
      if (backend instanceof WebPlayerBackend) {
        await backend.syncPrefs()
      }
      return res
    }
  },
  {
    name: 'aidj.get-models',
    description: '从 API /v1/models 获取可用模型列表',
    run: async () => {
      if (!state.config) {
        state.config = await loadAidjConfig()
      }
      if (!state.config) return { ok: false, error: '配置未加载', models: [] }
      try {
        const url = state.config.ai_settings.base_url.replace(/\/+$/, '') + '/models'
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${state.config.secrets.api_key}` }
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
      if (!state.config) {
        // loadAidjConfig materializes a default file when missing; the inline
        // fallback covers any edge where it still couldn't be built — one
        // update-config is then enough to bootstrap the config deep-created.
        state.config = (await loadAidjConfig()) ?? { ...DEFAULT_AIDJ_CONFIG }
      }
      const path = ctx.named.path as string
      const value = ctx.named.value
      if (!path || value === undefined) return { ok: false, error: '需要 --path 和 --value 参数' }
      if (!state.config) return { ok: false, error: '配置未加载' }

      // Support dot-notation paths like "preferences.model" or "secrets.api_key"
      const keys = path.split('.')
      let target: Record<string, unknown> = state.config as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (!(k in target) || typeof target[k] !== 'object') {
          target[k] = {}
        }
        target = target[k] as Record<string, unknown>
      }
      target[keys[keys.length - 1]] = value

      return { ok: true, config: state.config }
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
  },
  {
    name: 'aidj.time-stats',
    description: '听歌时长统计（time.csv，每小时一行，含当前未落盘的实时小时）',
    usage: 'aidj.time-stats',
    run: async () => {
      const { rows, totalMinutes } = await loadTimeStats()
      return { ok: true, totalMinutes, rows }
    }
  },
  {
    name: 'aidj.time-range',
    description: '听歌时长区间查询（二分定位 + 缓存，只读目标区间）',
    usage: 'aidj.time-range --start <ms> --end <ms>',
    run: async (ctx) => {
      const start = Number(ctx.named.start ?? 0)
      const end = Number(ctx.named.end ?? Number.MAX_SAFE_INTEGER)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { ok: false, error: '--start/--end 需要毫秒时间戳' }
      }
      const rows = await queryTimeRange(start, end)
      const totalMinutes = rows.reduce((s, r) => s + r.duration, 0)
      return { ok: true, totalMinutes, rows }
    }
  }
]
