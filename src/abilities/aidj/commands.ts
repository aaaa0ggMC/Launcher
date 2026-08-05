import type { CommandSpec } from '../../main/process/commands/types'
import { makeLogger } from '../../main/process/logger'
import {
  loadAidjConfig,
  saveAidjConfig,
  ensureAidjDir,
  scanMusicFiles,
  loadMetadata,
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
  PersistentSession
} from './service'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import type { AidjConfig, SongMeta } from './types'
import './jobs'

const log = makeLogger('aidj')

let _client: OpenAI | null = null
let _session: DJSession | null = null
let _metadata: Map<string, SongMeta> | null = null
let _musicPaths: Map<string, string> | null = null
let _config: AidjConfig | null = null

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
    const musicPaths = await scanMusicFiles(config.music_folders)
    _musicPaths = musicPaths
    const metadata = (await loadMetadata()) as Map<string, SongMeta>
    _metadata = metadata
    log.info(`metadata loaded: ${metadata.size} songs`)
    const missing = await findMissingSongs(musicPaths, metadata)
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
    session = new DJSession(client, _metadata, musicPaths, config)
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
      const { playlist, intro } = await session.nextStep(prompt)
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
      let dbus = getDbusManager()
      if (!dbus && _config) dbus = await initDbusManager(_config)
      if (!dbus) {
        return { ok: true, status: { status: 'Unknown', track: '', volume: null, player: '' } }
      }
      const status = await dbus.getStatus()
      if (status.status === 'Unknown' && !status.player) {
        dbus.disconnect()
        if (_config) dbus = await initDbusManager(_config)
        return { ok: true, status: await dbus.getStatus() }
      }
      return {
        ok: true,
        status,
        tracks: _session?.playedSongs.size ?? 0,
        volbal: {
          enabled: _config?.preferences.dynamic_balance_volume ?? false,
          method: _config?.preferences.sound_adjust_method ?? 'lufs'
        },
        recordFreq: _config?.preferences.record_freq ?? false,
        statusBar: _config?.preferences.status_bar
      }
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
      let metadata = _metadata
      let musicPaths = _musicPaths
      if (!metadata) {
        musicPaths = await scanMusicFiles(config.music_folders)
        _musicPaths = musicPaths
        metadata = (await loadMetadata()) as Map<string, SongMeta>
        _metadata = metadata
      }
      if (!musicPaths) {
        musicPaths = await scanMusicFiles(config.music_folders)
        _musicPaths = musicPaths
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
    description: '发送消息到持久模式会话',
    usage: 'aidj.chat --text <message>',
    run: async (ctx) => {
      const text = (ctx.named.text as string) || ctx.positional.join(' ')
      if (!text) return { ok: false, error: '需要消息内容' }
      const ps = getPersistentSession()
      if (!ps) return { ok: false, error: '持久模式未运行' }
      ps.injectUserMessage(text)
      if (text.startsWith('/discard_follows')) {
        ps.discardFollows()
        return { ok: true, effect: 'discard_follows' }
      }
      return { ok: true, effect: 'injected' }
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
      let metadata = _metadata
      let musicPaths = _musicPaths
      if (!metadata) {
        musicPaths = await scanMusicFiles(config.music_folders)
        _musicPaths = musicPaths
        metadata = (await loadMetadata()) as Map<string, SongMeta>
        _metadata = metadata
      }
      if (!musicPaths) {
        musicPaths = await scanMusicFiles(config.music_folders)
        _musicPaths = musicPaths
      }
      const ps = new PersistentSession(client, metadata, musicPaths, config, dbus, prompt, anchor)
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
  }
]
export default commands
