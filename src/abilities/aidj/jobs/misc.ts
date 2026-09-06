import { registerJobHandler } from '../../../main/process/background-tasks'
import { makeLogger } from '../../../main/process/logger'
import {
  loadAidjConfig,
  SessionManager,
  loadLibrary,
  findMissingSongs,
  scanMusicFiles,
  syncMetadata
} from '../service'
import OpenAI from 'openai'
import { SEPARATOR } from '../types'
import {
  isWebRemoteRunning,
  getWebRemotePort,
  startWebRemoteServer,
  stopWebRemoteServer
} from '../web-remote'
import { getPlayerMode } from '../player-backend'

const log = makeLogger('aidj-jobs-misc')

// ---------------------------------------------------------------------------
// aidj.title — 异步自动生成会话标题（后台作业，不阻塞 IPC）。
// 前台经 background.job / btJob('aidj.title', { sessionId }) 触发。
// 完成时 push({ data: { type: 'title', sessionId, title } })，
// 渲染端监听 cockpit:bt 的 output 消息即可收到新标题。
// ---------------------------------------------------------------------------
registerJobHandler('aidj.title', async (control, args) => {
  const sessionId = (args.sessionId as string) || ''
  if (!sessionId) {
    control.pushLine('错误: 缺少 sessionId', 'stderr')
    control.finish('error')
    return
  }

  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  const raw = await SessionManager.readRawHistory(sessionId)
  if (!raw.length) {
    control.pushLine('会话为空或不存在', 'stderr')
    control.finish('error')
    return
  }

  control.pushLine(`正在为会话生成标题 (${raw.length} 条记录)...`)

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  // 只取“用户说了什么”作为命名依据，AI DJ 的推荐内容仅作背景。
  const transcript = raw
    .filter((m) => m.type === 'user' || m.type === 'both')
    .map((m) => {
      const content = m.content.split(SEPARATOR)[0].trim()
      return m.type === 'both' ? `AI DJ: ${content}` : `用户: ${content}`
    })
    .join('\n')
    .slice(0, 3000)

  let title = ''
  try {
    const resp = await client.chat.completions.create(
      {
        model: config.preferences.model,
        messages: [
          {
            role: 'system',
            content:
              '你是 AI 音乐电台 (AIDJ) 的会话标题命名助手。AI DJ 会接收用户的点歌/氛围需求，用一段引入语推荐一组歌曲歌单。\n' +
              '你的任务：只根据【用户】发送的内容理解其核心意图/话题来命名，不要用 AI DJ 推荐的歌单内容命名。\n' +
              '要求：长度不超过 20 字；不要引号、句号等标点；直接输出标题本身。'
          },
          {
            role: 'user',
            content:
              `以下是该 AIDJ 会话的对话记录（"用户"是点歌/氛围需求，"AI DJ"是歌单推荐与播音）：\n\n` +
              `${transcript || '(空)'}\n\n请输出标题：`
          }
        ],
        max_tokens: 60,
        temperature: 0.7
      },
      { timeout: 30_000 }
    )
    title = (resp.choices[0]?.message?.content ?? '')
      .replace(/^["'「『【《]+|["'」』】》\s]+$/g, '')
      .trim()
  } catch (e) {
    log.warn('Session title generation failed', { sessionId, error: String(e) })
    control.pushLine(`标题生成失败: ${e instanceof Error ? e.message : String(e)}`, 'stderr')
    control.finish('error')
    return
  }

  if (!title) {
    control.pushLine('AI 未能生成标题', 'stderr')
    control.finish('error')
    return
  }

  const changed = await SessionManager.renameSession(sessionId, title.slice(0, 40))
  if (changed === null) {
    control.pushLine('会话不存在', 'stderr')
    control.finish('error')
    return
  }
  log.info('Session title generated', { sessionId, title })
  control.pushLine(`标题已生成: ${title}`)
  control.push({ data: { type: 'title', sessionId, title } })
  control.finish('exited')
})

// ---------------------------------------------------------------------------
// aidj.metadata-sync — 后台扫描曲库，为缺失元数据的歌曲生成元数据并写入
// music_metadata.jsonl。与 AIDJ 参考实现的 sync_metadata 逻辑一致
// (NCM 搜索歌词 → AI 提取 language/emotion/genre/loudness/review → 追加 JSONL)。
// 任务 name 固定为 'AIDJ 元数据同步'，用于渲染端/命令的去重检测。
// ---------------------------------------------------------------------------
registerJobHandler('aidj.metadata-sync', async (control) => {
  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }

  const abort = new AbortController()
  control.setCancel(() => abort.abort())

  control.pushLine('正在扫描曲库...')
  const lib = await loadLibrary()
  const fresh = await scanMusicFiles(config.music_folders ?? [])
  for (const [name, path] of fresh) {
    if (!lib.musicPaths.has(name)) lib.musicPaths.set(name, path)
  }

  const missing = await findMissingSongs(lib.musicPaths, lib.metadata)
  if (missing.size === 0) {
    control.pushLine('所有歌曲元数据均已就绪，无需同步')
    control.push({ data: { type: 'metadata_sync_done', synced: 0 } })
    control.finish('exited')
    return
  }

  control.pushLine(
    `发现 ${missing.size} 首歌曲缺少元数据，并发: ${config.preferences.metadata_concurrency}，模型: ${config.ai_settings.metadata_model}`
  )
  control.push({ data: { type: 'metadata_sync_start', total: missing.size } })

  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  let lastReported = 0
  const total = missing.size

  const { counts } = await syncMetadata(
    client,
    missing,
    lib.metadata,
    config.ai_settings.metadata_model,
    config.preferences.metadata_concurrency,
    (p) => {
      const now = Date.now()
      if (p.done === total || now - lastReported > 800) {
        lastReported = now
        control.setProgress(Math.round((p.done / total) * 100))
        control.push({ data: { type: 'metadata_sync_progress', done: p.done, total } })
      }
    },
    lib.lyrics,
    () => abort.signal.aborted
  )

  if (abort.signal.aborted) {
    control.pushLine('已停止（已完成的部分歌曲已保存，其余保留待下次同步）')
    control.finish('cancelled')
    return
  }

  if (counts.networkError > 0) {
    control.pushLine(
      `⚠️ NCM API 不可用 (${counts.networkError} 首请求失败)，请检查 ncm_base_url 或启动 NeteaseCloudMusicApi 服务`,
      'stderr'
    )
  }
  control.pushLine(
    `元数据同步完成: 成功 ${counts.ok}，未找到歌词 ${counts.noLyric}，提取失败 ${counts.failed}` +
      (counts.networkError ? `，网络错误 ${counts.networkError}` : '')
  )
  control.push({ data: { type: 'metadata_sync_done', synced: counts.ok } })
  control.finish('exited')
})

// ---------------------------------------------------------------------------
// aidj.web-remote — 内置播放器的局域网 Web 遥控服务器（M4）。
// 以后台任务形式运行：启动服务器并常驻，直到用户停止/切换后端/退出。
// 端口来自 `preferences.web_remote_port`（设置页可配），page-menu 的开关就是
// 启停这个任务；后台面板同样可以直接停止。
// ---------------------------------------------------------------------------
registerJobHandler(
  'aidj.web-remote',
  async (control) => {
    if (isWebRemoteRunning()) {
      control.pushLine(`遥控服务已在运行（端口 ${getWebRemotePort()}）`)
      control.finish('exited')
      return
    }

    const config = await loadAidjConfig()
    const port = config?.preferences.web_remote_port ?? 17320

    let urls: string[] = []
    try {
      urls = (await startWebRemoteServer(port)).urls
    } catch (e) {
      control.pushLine(`启动失败: ${e instanceof Error ? e.message : String(e)}`, 'stderr')
      control.finish('error')
      return
    }

    control.push({ data: { type: 'state', running: true, port: getWebRemotePort() } })
    control.pushLine(`局域网遥控已启动，端口 ${getWebRemotePort()}`)
    control.pushLine(`本机访问: http://localhost:${getWebRemotePort()}`)
    for (const u of urls) control.pushLine(`局域网访问: ${u}`)
    control.pushLine('手机浏览器打开上面的地址即可查看歌曲/封面并控制播放。')

    const ac = new AbortController()
    control.setCancel(async () => {
      ac.abort()
      await stopWebRemoteServer()
    })

    // Keep the task alive until cancelled.
    while (!ac.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    control.push({ data: { type: 'state', running: false, port: getWebRemotePort() } })
    control.pushLine('局域网遥控已停止')
    control.finish('exited')
  },
  // web-exclusive: the built-in player is the control target
  () => getPlayerMode().then((m) => m === 'web')
)
