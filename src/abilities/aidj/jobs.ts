import { registerJobHandler } from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'
import {
  loadAidjConfig,
  ensureAidjDir,
  scanMusicFiles,
  loadMetadata,
  findMissingSongs,
  syncMetadata,
  setNcmBaseUrl,
  initDbusManager,
  setPersistentSession,
  PersistentSession
} from './service'
import OpenAI from 'openai'
import type { SongMeta } from './types'

const log = makeLogger('aidj-persistent')

registerJobHandler('aidj.persistent', async (control, args) => {
  const initialPrompt = (args.prompt as string) || ''
  const anchorValue = args.anchor !== undefined ? Number(args.anchor) : null
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
  await ensureAidjDir()

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  const musicPaths = await scanMusicFiles(config.music_folders)
  let metadata: Map<string, SongMeta> = await loadMetadata()
  const missing = await findMissingSongs(musicPaths, metadata)
  if (missing.size > 0) {
    control.pushLine(`发现 ${missing.size} 首新歌曲，同步元数据中...`)
    metadata = await syncMetadata(
      client,
      missing,
      metadata,
      config.ai_settings.metadata_model,
      config.preferences.metadata_concurrency
    )
  }

  control.pushLine(`曲库已加载: ${metadata.size} 首歌曲`)
  control.pushLine(`初始提示: "${initialPrompt}"`)

  const dbus = await initDbusManager(config)
  if (!dbus) {
    control.pushLine('错误: DBus 连接失败', 'stderr')
    control.finish('error')
    return
  }
  control.pushLine('DBus 已连接')

  const session = new PersistentSession(
    client,
    metadata,
    musicPaths,
    config,
    dbus,
    initialPrompt,
    anchorValue
  )
  setPersistentSession(session)

  const ac = new AbortController()
  control.setCancel(() => {
    ac.abort()
    session.stop()
    setPersistentSession(null)
  })

  control.pushLine('持久模式 AI DJ 已启动')
  control.push({ data: { type: 'status', message: 'started', prompt: initialPrompt } })

  let lastStatusUpdate = 0
  let lastStatus: string | null = null

  while (!ac.signal.aborted) {
    try {
      if (await session.needsNextBatch()) {
        control.pushLine('AI 思考中...', 'stderr')
        control.push({ data: { type: 'status', message: 'thinking' } })
        await session.fetchBatch()
        control.push({ data: { type: 'status', message: 'idle' } })
      }

      await session.ensureNextBatchInQueue()

      if (session.hasReadyTrack()) {
        const status = await dbus.getStatus()
        if (status.status === 'Stopped' || status.status === 'Unknown') {
          const track = session.dequeue()
          if (track) {
            await session.adjustVolume(track)
            await dbus.sendFiles([track.path])
            control.push({ data: { type: 'now_playing', track: track.name, path: track.path } })
            control.pushLine(`▶ 播放: ${track.name}`)
          }
        }
      }

      const status = await dbus.getStatus()
      const statusKey = `${status.status}|${status.track}`
      if (statusKey !== lastStatus || Date.now() - lastStatusUpdate > 5000) {
        lastStatus = statusKey
        lastStatusUpdate = Date.now()
        control.push({ data: { type: 'status', message: 'running', playerStatus: status } })
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    } catch (e) {
      if (ac.signal.aborted) break
      log.error('persistent loop error', { error: String(e) })
      control.pushLine(`错误: ${String(e)}`, 'stderr')
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }

  control.pushLine('持久模式已停止')
  control.finish('exited')
})
