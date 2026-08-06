import type { CommandSpec } from '../../main/process/commands/types'
import { makeLogger } from '../../main/process/logger'
import {
  loadAidjConfig,
  saveAidjConfig,
  ensureAidjDir,
  loadLibrary,
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
  listAvailablePlayers,
  switchPlayer,
  getCoverArt,
  bumpFrequency
} from './service'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import type { AidjConfig, SongMeta } from './types'
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
  getChatTask,
  setChatPlayer,
  clearContinuousPending
} from './jobs'

const log = makeLogger('aidj')

let _client: OpenAI | null = null
let _session: DJSession | null = null
let _metadata: Map<string, SongMeta> | null = null
let _musicPaths: Map<string, string> | null = null
let _config: AidjConfig | null = null
let _currentAbort: AbortController | null = null
let _streamingChars = 0
let _retrying = false
let _retryAttempt = 0

export function getCurrentAbortSignal(): AbortSignal | null {
  return _currentAbort?.signal ?? null
}

export function abortCurrentRequest(): void {
  _currentAbort?.abort()
  _currentAbort = null
  _streamingChars = 0
  _retrying = false
  _retryAttempt = 0
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
  dbus: DBusManager
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

  let dbus = getDbusManager()
  if (!dbus) {
    dbus = await initDbusManager(config)
  }

  let session = _session
  if (!session) {
    await ensureAidjDir()
    const lib = await loadLibrary()
    const paths = lib.musicPaths
    const metadata = lib.metadata
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
      _metadata = synced
    }
    session = new DJSession(client, _metadata, paths, config)
    _session = session
  }

  return { client, config, session, dbus }
}

const commands: CommandSpec[] = [
  {
    name: 'aidj.generate',
    description: 'AI 生成歌单',
    usage: 'aidj.generate --prompt <text>',
    run: async (ctx) => {
      const prompt = (ctx.named.prompt as string) || ctx.positional.join(' ')
      const { session } = await ensureInit()
      _currentAbort = new AbortController()
      _streamingChars = 0
      _retrying = false
      _retryAttempt = 0
      try {
        const { playlist, intro } = await session.nextStep(
          prompt,
          (full: string) => {
            _streamingChars = full.length
          },
          _currentAbort.signal,
          (attempt) => {
            _retrying = true
            _retryAttempt = attempt
            _streamingChars = 0
          }
        )
        const enriched = playlist.map((s) => ({
          ...s,
          meta: session.metadata.get(s.name) || null
        }))
        return {
          ok: true,
          intro,
          playlist: enriched,
          tokens: { prompt: session.promptTokens, completion: session.completionTokens }
        }
      } finally {
        _currentAbort = null
        _streamingChars = 0
        _retrying = false
        _retryAttempt = 0
      }
    }
  },
  {
    name: 'aidj.next',
    description: '下一首',
    run: async () => {
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      await dbus.control('next')
      return { ok: true }
    }
  },
  {
    name: 'aidj.prev',
    description: '上一首',
    run: async () => {
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      await dbus.control('prev')
      return { ok: true }
    }
  },
  {
    name: 'aidj.toggle',
    description: '播放/暂停',
    run: async () => {
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      await dbus.control('toggle')
      return { ok: true }
    }
  },
  {
    name: 'aidj.stop',
    description: '停止播放',
    run: async () => {
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      await dbus.control('stop')
      return { ok: true }
    }
  },
  {
    name: 'aidj.status',
    description: '获取播放器状态',
    run: async () => {
      if (!_config) _config = await loadAidjConfig()
      await ensureLibraryLoaded()
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
        statusBar: _config?.preferences.status_bar
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
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      const paths = ctx.named.path as string[] | string | undefined
      const pathArray = Array.isArray(paths) ? paths : paths ? [paths] : []
      if (pathArray.length === 0) return { ok: false, error: '未指定文件路径' }
      await dbus.sendFiles(pathArray)
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
      const dbus = getDbusManager()
      if (!dbus) return { ok: false, error: 'DBus 未连接' }
      if (ctx.named.set !== undefined) {
        const vol = Number(ctx.named.set)
        if (isNaN(vol) || vol < 0 || vol > 1) return { ok: false, error: '音量需在 0-1 之间' }
        await dbus.setVolume(vol)
        return { ok: true, volume: vol }
      }
      const vol = await dbus.getVolume()
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
      const missing = await findMissingSongs(musicPaths, metadata)
      if (missing.size === 0) return { ok: true, synced: 0, message: '无新歌曲需要同步' }
      const synced = await syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      )
      _metadata = synced
      return { ok: true, synced: missing.size }
    }
  },
  {
    name: 'aidj.analyse',
    description: '元数据分布分析',
    usage: 'aidj.analyse --field <language|emotion|genre>',
    run: async (ctx) => {
      const field = (ctx.named.field as string) || 'language'
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
      if (text.startsWith('/discard_follows')) {
        st.session.discardFollows()
        clearContinuousPending(st.player)
        return { ok: true, effect: 'discard_follows' }
      }
      st.session.injectUserMessage(text)
      st.control.push({ data: { type: 'user', content: text } })
      return { ok: true, effect: 'injected' }
    }
  },
  {
    name: 'aidj.chat-player',
    description: '切换持续会话的发送目标播放器',
    usage: 'aidj.chat-player --task <id> --player <name>',
    run: async (ctx) => {
      const taskId = ctx.named.task as string
      const player = ctx.named.player as string
      if (!taskId || !player) return { ok: false, error: '需要 --task 和 --player 参数' }
      const r = setChatPlayer(taskId, player)
      if (!r.ok) return { ok: false, error: r.error }
      const st = getChatTask(taskId)
      if (st) {
        st.control.pushLine(`发送目标已切换 → ${player}`)
      }
      return { ok: true, player }
    }
  },
  {
    name: 'aidj.start-persistent',
    description: '启动持久模式',
    usage: 'aidj.start-persistent --prompt <text> [--anchor <value>]',
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
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        return { ok: true, latency: 'ok' }
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
        retryAttempt: _retryAttempt
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
        _config = await loadAidjConfig()
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
      invalidateLibrary()
      const oldDbus = getDbusManager()
      if (oldDbus) oldDbus.disconnect()
      setDbusManager(null as unknown as DBusManager)
      const { session } = await ensureInit()
      return {
        ok: true,
        librarySize: session.metadata.size,
        pathsSize: session.musicPaths.size
      }
    }
  },
  {
    name: 'aidj.list-players',
    description: '列出所有可用的 MPRIS 播放器',
    run: async () => {
      const players = await listAvailablePlayers()
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
    run: async (ctx) => {
      const name = ctx.named.name as string
      if (!name) return { ok: false, error: '需要 --name 参数指定播放器名称' }
      const ok = await switchPlayer(name)
      return ok ? { ok: true, player: name } : { ok: false, error: `切换到 ${name} 失败` }
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
    name: 'aidj.continuous-list',
    description: '列出所有运行中的连续播放任务',
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
  }
]
export default commands
