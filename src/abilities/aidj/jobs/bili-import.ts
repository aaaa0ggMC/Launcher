import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import { registerJobHandler, type JobControl } from '../../../main/process/background-tasks'
import { makeLogger } from '../../../main/process/logger'
import type { AidjConfig } from '../types'
import { loadAidjConfig, getAidjDir } from '../services/config'
import { appendMetadata, invalidateLibrary, scanMusicFiles } from '../services/library'
import { appendLyric } from '../services/lyrics'
import { invalidateCoverCache } from '../services/cover'
import { getBiliDefaultSlotName } from '../services/metadata-slots'
import { syncSlotsAndBroadcast } from '../commands/metadata-slots'
import { state } from '../commands/shared'
import {
  BiliClient,
  BiliCredential,
  parseBvid,
  getVideoDetail,
  getVideoSubtitles,
  getVideoComments,
  getVideoDanmakuXml,
  parseDanmakuSamples,
  getVideoPlayUrl,
  downloadBiliMedia,
  extractBiliMetadataAi
} from '../bili_api'

const log = makeLogger('aidj-bili-import')

export interface BiliImportItemSpec {
  bvid: string
  aid?: number
  cid?: number
  page?: number
  partTitle?: string
  title?: string
  author?: string
  duration?: number
  pic?: string
  folder?: string
  audioOnly?: boolean
  slotName?: string
}

export interface BiliImportArgs extends BiliImportItemSpec {}

/** Sanitize filename for Linux/Unix */
export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim()
}

/**
 * Common pipeline to download a single Bilibili item (full video or single part P),
 * generate AI metadata, extract lyrics, save files, and record metadata into specified slot.
 */
export async function processBiliItem(
  client: BiliClient,
  config: AidjConfig,
  item: BiliImportItemSpec,
  control: JobControl,
  abortSignal: AbortSignal,
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; title: string; cleanBase?: string; error?: string }> {
  if (abortSignal.aborted) {
    return { ok: false, title: item.title || item.bvid, error: 'Cancelled' }
  }

  const bvid = parseBvid(item.bvid)
  if (!bvid) {
    const err = `无法解析 BVID: "${item.bvid}"`
    control.pushLine(`错误: ${err}`, 'stderr')
    return { ok: false, title: item.title || item.bvid, error: err }
  }

  // 1. Fetch video metadata
  let videoDetail
  try {
    control.pushLine(`正在获取视频基本信息 (${bvid})...`)
    videoDetail = await getVideoDetail(client, bvid)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    control.pushLine(`获取视频详情失败: ${error}`, 'stderr')
    return { ok: false, title: item.title || bvid, error }
  }

  if (abortSignal.aborted) return { ok: false, title: videoDetail.title, error: 'Cancelled' }

  // Resolve target CID (for multi-P, use item.cid if specified, otherwise page matching or pages[0])
  let targetCid = item.cid || 0
  let partSuffix = ''
  if (!targetCid) {
    if (item.page && videoDetail.pages && videoDetail.pages.length > 0) {
      const matchedPage = videoDetail.pages.find((p) => p.page === item.page)
      if (matchedPage) {
        targetCid = matchedPage.cid
        partSuffix = matchedPage.part
          ? ` - P${matchedPage.page} ${matchedPage.part}`
          : ` - P${matchedPage.page}`
      }
    }
  } else if (item.partTitle) {
    partSuffix = item.page ? ` - P${item.page} ${item.partTitle}` : ` - ${item.partTitle}`
  }
  if (!targetCid) {
    targetCid = videoDetail.cid || videoDetail.pages?.[0]?.cid || 0
  }

  const displayTitle = `${videoDetail.title}${partSuffix}`
  control.pushLine(
    `目标: ${displayTitle} (UP主: ${videoDetail.author}, 时长: ${Math.floor(videoDetail.duration / 60)}分${videoDetail.duration % 60}秒)`
  )

  // 2. Fetch subtitles
  control.pushLine('正在拉取官方/AI 字幕轨道...')
  const { lrc, trackName } = await getVideoSubtitles(client, videoDetail.aid, bvid, targetCid)
  if (lrc) {
    control.pushLine(`✅ 已获取字幕 (${trackName || '默认字幕'}，共 ${lrc.split('\n').length} 行)`)
  } else {
    control.pushLine('⚠️ 未检测到有效字幕轨，将依赖视频信息与评论进行推断')
  }

  if (abortSignal.aborted) return { ok: false, title: displayTitle, error: 'Cancelled' }

  // 3. Fetch comments and danmakus
  control.pushLine('正在抓取热门评论与弹幕数据...')
  const [comments, danmakuXml] = await Promise.all([
    getVideoComments(client, videoDetail.aid, 15),
    getVideoDanmakuXml(client, targetCid)
  ])
  const danmakus = parseDanmakuSamples(danmakuXml, 30)
  control.pushLine(
    `已获取 ${comments.length} 条热门评论${danmakuXml ? '，已下载完整弹幕数据' : ''}`
  )

  if (abortSignal.aborted) return { ok: false, title: displayTitle, error: 'Cancelled' }

  // 4. Metadata AI extraction
  control.pushLine('正在调用 Metadata AI 分析提取歌曲元数据与深度乐评...')
  let aiResult
  try {
    const aiClient = new OpenAI({
      apiKey: config.secrets.api_key,
      baseURL: config.ai_settings.base_url
    })
    const model = config.ai_settings.metadata_model || config.preferences.model
    aiResult = await extractBiliMetadataAi(aiClient, model, {
      title: displayTitle,
      desc: videoDetail.desc,
      author: videoDetail.author,
      tags: videoDetail.tags,
      subtitlesSnippet: lrc,
      comments: comments.map((c) => `${c.user}: ${c.message}`),
      danmakus
    })

    control.pushLine(`AI 推断曲名: 《${aiResult.song_title}》 歌手: ${aiResult.artist}`)
    control.pushLine(
      `情感: ${JSON.stringify(aiResult.meta.emotion)} 流派: ${JSON.stringify(aiResult.meta.genre)} 响度: ${aiResult.meta.loudness}`
    )
    control.pushLine(`乐评: ${aiResult.meta.review}`)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    control.pushLine(`Metadata AI 分析失败: ${error}，将使用视频原标题`, 'stderr')
    aiResult = {
      song_title: displayTitle,
      artist: videoDetail.author,
      meta: {
        language: 'Chinese',
        emotion: 'pop',
        genre: 'pop',
        loudness: 'medium',
        review: videoDetail.desc || '来自 Bilibili 的视频音轨。'
      }
    }
  }

  if (abortSignal.aborted) return { ok: false, title: displayTitle, error: 'Cancelled' }

  // 5. Target directory determination (folders[0]/Bilibili/<bvid>/) & distinct filename
  const baseMusicFolder = item.folder || config.music_folders?.[0] || join(getAidjDir(), 'media')
  const targetFolder = join(baseMusicFolder, 'Bilibili', bvid)
  await mkdir(targetFolder, { recursive: true })

  let baseTitle = `${aiResult.artist} - ${aiResult.song_title}`
  // If multi-P, ensure the part number is in the base title to prevent collisions
  if (item.page && item.page > 1 && !baseTitle.includes(`P${item.page}`)) {
    const pLabel = item.partTitle ? `P${item.page} ${item.partTitle}` : `P${item.page}`
    baseTitle = `${baseTitle} [${pLabel.trim()}]`
  }
  let cleanBase = sanitizeFileName(baseTitle) || bvid
  const mediaExt = item.audioOnly ? '.m4a' : '.mp4'
  let targetMediaFile = join(targetFolder, `${cleanBase}${mediaExt}`)
  // If target file exists and does not already include bvid, avoid collision
  if (existsSync(targetMediaFile) && !cleanBase.includes(bvid)) {
    cleanBase = `${cleanBase} [${bvid}]`
    targetMediaFile = join(targetFolder, `${cleanBase}${mediaExt}`)
  }
  const targetLrcFile = join(targetFolder, `${cleanBase}.lrc`)
  const targetDanmakuFile = join(targetFolder, `${cleanBase}.danmaku.xml`)
  const targetXmlFile = join(targetFolder, `${cleanBase}.xml`)

  // 6. Fetch play url
  control.pushLine('正在获取音视频流下载地址...')
  let playUrl
  try {
    playUrl = await getVideoPlayUrl(client, bvid, targetCid)
    control.pushLine(
      `已获取播放流 (画质代码: ${playUrl.quality || '标准'}, 格式: ${playUrl.format || 'mp4'})`
    )
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    control.pushLine(`获取流地址失败: ${error}`, 'stderr')
    return { ok: false, title: displayTitle, error }
  }

  // 7. Download stream
  control.pushLine(`开始下载至: ${targetMediaFile}`)
  let lastPct = 0
  try {
    await downloadBiliMedia(client, playUrl, targetMediaFile, {
      audioOnly: item.audioOnly,
      abortSignal,
      onProgress: (p) => {
        if (p.percent - lastPct >= 5 || p.percent === 100) {
          lastPct = p.percent
          onProgress?.(p.percent)
          if (p.totalBytes > 0) {
            const mb = (p.downloadedBytes / (1024 * 1024)).toFixed(1)
            const totalMb = (p.totalBytes / (1024 * 1024)).toFixed(1)
            control.pushLine(`下载进度: ${p.percent}% (${mb}MB / ${totalMb}MB)`)
          }
        }
      }
    })
    control.pushLine('✅ 视频流下载完成')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    control.pushLine(`下载失败: ${error}`, 'stderr')
    return { ok: false, title: displayTitle, error }
  }

  // 8. Save LRC & Danmaku XML if available
  if (lrc) {
    try {
      await writeFile(targetLrcFile, lrc, 'utf-8')
      await appendLyric(cleanBase, lrc)
      control.pushLine(`✅ 歌词文件已保存: ${cleanBase}.lrc`)
    } catch (e) {
      log.warn('Failed to save LRC file', { error: String(e) })
    }
  }

  if (danmakuXml) {
    try {
      await writeFile(targetDanmakuFile, danmakuXml, 'utf-8')
      await writeFile(targetXmlFile, danmakuXml, 'utf-8')
      control.pushLine(`✅ 弹幕文件已保存: ${cleanBase}.danmaku.xml (及 .xml)`)
    } catch (e) {
      log.warn('Failed to save danmaku XML file', { error: String(e) })
    }
  }

  // 8.5 Save Cover Image
  if (videoDetail.pic) {
    try {
      const picUrl = videoDetail.pic.startsWith('//') ? `https:${videoDetail.pic}` : videoDetail.pic
      const picRes = await fetch(picUrl, {
        headers: {
          'User-Agent': client.userAgent,
          Referer: 'https://www.bilibili.com'
        },
        signal: abortSignal
      })
      if (picRes.ok) {
        const picBuf = Buffer.from(await picRes.arrayBuffer())
        const targetCoverFile = join(targetFolder, `${cleanBase}.jpg`)
        const targetDirCoverFile = join(targetFolder, 'cover.jpg')
        await writeFile(targetCoverFile, picBuf)
        await writeFile(targetDirCoverFile, picBuf)
        invalidateCoverCache(targetMediaFile)
        control.pushLine(`✅ 视频封面已保存: ${cleanBase}.jpg`)
      }
    } catch (e) {
      log.warn('Failed to download cover picture', { error: String(e) })
    }
  }

  // 9. Save Metadata to target slot (defaults to Bili default slot, e.g. Bilibili-Current.metadata)
  const targetSlot = item.slotName || (await getBiliDefaultSlotName())
  try {
    await appendMetadata(cleanBase, aiResult.meta, targetSlot)
    control.pushLine(`✅ 歌曲元数据已保存至槽位: ${targetSlot}`)
  } catch (e) {
    log.warn('Failed to append metadata', { error: String(e) })
  }

  return { ok: true, title: displayTitle, cleanBase }
}

registerJobHandler(
  'aidj.bili-import',
  async (control: JobControl, rawArgs: Record<string, unknown>) => {
    const effectiveArgs = (
      rawArgs.args && typeof rawArgs.args === 'object' && !Array.isArray(rawArgs.args)
        ? { ...rawArgs, ...(rawArgs.args as Record<string, unknown>) }
        : rawArgs
    ) as Record<string, unknown>
    const args = effectiveArgs as unknown as BiliImportArgs
    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    const config = await loadAidjConfig()
    if (!config) {
      control.pushLine('错误: AIDJ 配置未找到', 'stderr')
      control.finish('error')
      return
    }

    // Guard: User must have approved Bilibili disclaimer
    if (!config.preferences?.bilibili_approved) {
      control.pushLine(
        '错误: Bilibili API 未获授权批准。请先在设置中查看并同意免责声明，或运行 aidj.approve-bilibili',
        'stderr'
      )
      control.finish('error')
      return
    }

    const { credential, sourcePath } = BiliCredential.resolve(
      config.preferences?.bili_credential_path
    )
    if (credential.hasSessdata()) {
      control.pushLine(`已加载 Bilibili 凭据 (来源: ${sourcePath || '本地配置'})`)
    } else {
      control.pushLine('未检测到 Bilibili 登录凭据，以游客身份访问（音画质可能受限）')
    }
    const client = new BiliClient({ credential })

    const res = await processBiliItem(client, config, args, control, ac.signal, (pct) =>
      control.setProgress(pct)
    )

    if (ac.signal.aborted) {
      control.finish('cancelled')
      return
    }

    if (!res.ok) {
      control.finish('error')
      return
    }

    // Invalidate library cache and rescan so AIDJ sees the new song immediately
    invalidateLibrary()
    try {
      state.musicPaths = await scanMusicFiles(config.music_folders ?? [])
      await syncSlotsAndBroadcast()
    } catch {
      /* ignore */
    }
    control.pushLine(`🎉 导入成功！《${res.cleanBase || res.title}》现已加入曲库。`)
    control.setProgress(100)
    control.finish('exited')
  }
)
