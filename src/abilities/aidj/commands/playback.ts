import type { CommandSpec } from '../../../main/process/commands/types'
import {
  loadAidjConfig,
  loadLibrary,
  isLibraryLoading,
  initDbusManager,
  getDbusManager,
  bumpFrequency,
  getCurrentDbusTrackInfo,
  getCoverArt
} from '../service'
import { getActiveBackend, getPlayerMode, setPlayerMode } from '../player-backend'
import { state, dbusMode } from './shared'

export const playbackCommands: CommandSpec[] = [
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
      if (!state.config) state.config = await loadAidjConfig()
      // Warm the library cache in the BACKGROUND — the first status poll (the
      // player page polls immediately on mount) must NOT block on a full music
      // folder scan + metadata read, which freezes the UI for seconds with a
      // large library. librarySize reflects whatever is already loaded (0 until
      // the warm finishes / a session loads); the next poll picks it up.
      void loadLibrary()
        .then((lib) => {
          if (!state.metadata) state.metadata = lib.metadata
          if (!state.musicPaths) state.musicPaths = lib.musicPaths
        })
        .catch(() => {})
      const session = state.session
      let librarySize: number | null = null
      if (session) {
        librarySize =
          session.musicPaths && session.musicPaths.size > 0
            ? [...session.metadata.keys()].filter((k) => session.musicPaths.has(k)).length
            : session.metadata.size
      } else if (state.metadata && state.musicPaths && state.musicPaths.size > 0) {
        librarySize = [...state.metadata.keys()].filter((k) => state.musicPaths!.has(k)).length
      } else if (state.metadata) {
        librarySize = state.metadata.size
      } else if (isLibraryLoading()) {
        librarySize = null
      } else {
        librarySize = 0
      }
      const base = {
        ok: true,
        // null = library still loading (first background scan/read in flight) —
        // the UI shows "…" instead of a misleading 0.
        tracks: librarySize as number | null,
        memory: state.session?.playedSongs.size ?? 0,
        volbal: {
          enabled: state.config?.preferences.dynamic_balance_volume ?? false,
          method: state.config?.preferences.sound_adjust_method ?? 'lufs'
        },
        recordFreq: state.config?.preferences.record_freq ?? false,
        listeningStats: state.config?.preferences.listening_stats ?? true,
        statusBar: state.config?.preferences.status_bar,
        mode: await getPlayerMode()
      }
      // Web backend: bypass the DBus path entirely — the built-in player fills
      // its own status model.
      const backend = await getActiveBackend()
      if (backend?.mode === 'web') {
        return { ...base, status: await backend.getStatus() }
      }
      let dbus = getDbusManager()
      if (!dbus && state.config) dbus = await initDbusManager(state.config)
      if (!dbus) {
        return {
          ...base,
          status: { status: 'Unknown', track: '', volume: null, player: '' }
        }
      }
      const status = await dbus.getStatus()
      if (status.status === 'Unknown' && !status.player) {
        dbus.disconnect()
        if (state.config) dbus = await initDbusManager(state.config)
        return { ...base, status: await dbus.getStatus() }
      }
      return { ...base, status }
    }
  },
  {
    name: 'aidj.send',
    description: '发送歌单到播放器',
    usage: 'aidj.send [--path <filepath>]... [--append <true|false>]',
    run: async (ctx) => {
      const backend = await getActiveBackend()
      if (!backend) return { ok: false, error: 'DBus 未连接' }
      const paths = ctx.named.path as string[] | string | undefined
      const pathArray = Array.isArray(paths) ? paths : paths ? [paths] : []
      if (pathArray.length === 0) return { ok: false, error: '未指定文件路径' }
      const append = String(ctx.named.append ?? '') === 'true'
      await backend.sendFiles(pathArray, { append })
      const lib = await loadLibrary()
      const pathToName = new Map<string, string>()
      for (const [name, p] of lib.musicPaths) pathToName.set(p, name)
      const names = pathArray.map((p) => pathToName.get(p) ?? '').filter(Boolean)
      if (!state.config) state.config = await loadAidjConfig()
      if (state.config?.preferences.record_freq) {
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
    name: 'aidj.current-dbus-track',
    description: '获取当前 DBus 播放器的歌曲信息（用于“从此刻开始”）',
    usage: 'aidj.current-dbus-track',
    enabled: dbusMode,
    run: async () => {
      return await getCurrentDbusTrackInfo()
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
        const r = await setPlayerMode(set)
        if (r.ok) state.config = await loadAidjConfig()
        return r
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
    name: 'aidj.player-state',
    description: '获取统一播放状态（播放器页轮询；dbus=MPRIS 快照，web=内置播放器上报）',
    usage: 'aidj.player-state',
    run: async () => {
      const mode = await getPlayerMode()
      const backend = await getActiveBackend()
      if (!backend) return { ok: true, mode, state: null }
      const s = await backend.getPlaybackDetail()
      return { ok: true, mode, state: s }
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
  }
]
