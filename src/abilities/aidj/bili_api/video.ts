import { BiliClient } from './client'
import { bvid2aid } from './aidBvid'
import { makeLogger } from '../../../main/process/logger'

const log = makeLogger('bili-video')

export interface BiliVideoPage {
  cid: number
  page: number
  part: string
  duration: number
}

export interface BiliVideoInfo {
  aid: number
  bvid: string
  cid: number
  title: string
  desc: string
  author: string
  duration: number
  pic: string
  tags: string[]
  pages?: BiliVideoPage[]
}

export interface BiliSubtitleItem {
  from: number
  to: number
  content: string
}

export interface BiliCommentItem {
  user: string
  message: string
  likes: number
}

export interface BiliPlayUrlResult {
  format?: string
  quality?: number
  url?: string
  videoUrl?: string
  audioUrl?: string
  isDash: boolean
}

/**
 * Format timestamp in seconds to LRC time tag: [mm:ss.xx]
 */
export function formatLrcTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}]`
}

/**
 * Convert Bili subtitle items to standard LRC format.
 */
export function subtitlesToLrc(items: BiliSubtitleItem[]): string {
  return items
    .filter((it) => it.content && it.content.trim())
    .map((it) => `${formatLrcTime(it.from)}${it.content.trim()}`)
    .join('\n')
}

/**
 * Get video basic metadata and tags.
 */
export async function getVideoDetail(client: BiliClient, bvid: string): Promise<BiliVideoInfo> {
  const aid = bvid2aid(bvid)
  const res = await client.executeGet<{
    cid?: number
    pages?: Array<{ cid?: number; page?: number; part?: string; duration?: number }>
    title?: string
    desc?: string
    owner?: { name?: string }
    duration?: number
    pic?: string
  }>('https://api.bilibili.com/x/web-interface/view', {
    bvid,
    aid
  })

  const rawPages = Array.isArray(res?.pages) ? res.pages : []
  const pages: BiliVideoPage[] = rawPages.map((p, idx) => ({
    cid: p.cid ?? 0,
    page: p.page ?? idx + 1,
    part: (p.part || '').trim(),
    duration: Number(p.duration || 0)
  }))

  const cid = res?.cid || pages[0]?.cid || 0
  const title = (res?.title || '').trim()
  const desc = (res?.desc || '').trim()
  const author = (res?.owner?.name || '').trim()
  const duration = Number(res?.duration || 0)
  const pic = (res?.pic || '').trim()

  // Try to fetch tags
  let tags: string[] = []
  try {
    const tagRes = await client.executeGet<Array<{ tag_name?: string; name?: string }>>(
      'https://api.bilibili.com/x/tag/archive/tags',
      { aid, bvid }
    )
    if (Array.isArray(tagRes)) {
      tags = tagRes
        .map((t) => (t.tag_name || t.name || '').trim())
        .filter((s): s is string => Boolean(s))
    }
  } catch {
    /* tags optional */
  }

  return {
    aid,
    bvid,
    cid,
    title,
    desc,
    author,
    duration,
    pic,
    tags,
    pages
  }
}

/**
 * Fetch subtitle tracks (CC or AI subtitles) and format as LRC.
 */
export async function getVideoSubtitles(
  client: BiliClient,
  aid: number,
  bvid: string,
  cid: number
): Promise<{ lrc: string; trackName?: string }> {
  try {
    const playerInfo = await client.executeGet<{
      subtitle?: {
        subtitles?: Array<{ lan: string; lan_doc: string; subtitle_url: string; ai_type?: number }>
      }
    }>('https://api.bilibili.com/x/player/wbi/v2', { aid, bvid, cid }, { wbi: true, dm: true })

    const tracks: Array<{ lan: string; lan_doc: string; subtitle_url: string; ai_type?: number }> =
      playerInfo?.subtitle?.subtitles || []

    if (!tracks.length) return { lrc: '' }

    // Pick best track: Chinese preferred, otherwise first track
    const selected =
      tracks.find((t) => t.lan === 'zh-CN' || t.lan.includes('zh') || t.lan_doc.includes('中')) ||
      tracks[0]

    let url = selected.subtitle_url
    if (url.startsWith('//')) url = 'https:' + url

    const res = (await client.rawRequest(url, { method: 'GET' })) as {
      body?: Array<{ from: number; to: number; content: string }>
    }
    const body: Array<{ from: number; to: number; content: string }> = Array.isArray(res?.body)
      ? res.body
      : []

    const lrc = subtitlesToLrc(body)
    return { lrc, trackName: selected.lan_doc }
  } catch (e) {
    log.warn('Failed to fetch video subtitles', { bvid, cid, error: String(e) })
    return { lrc: '' }
  }
}

/**
 * Fetch top comments for the video to ground AI reviews.
 */
export async function getVideoComments(
  client: BiliClient,
  aid: number,
  limit = 15
): Promise<BiliCommentItem[]> {
  try {
    const res = await client.executeGet<{
      replies?: Array<{
        member?: { uname?: string }
        content?: { message?: string }
        like?: number
      }>
    }>(
      'https://api.bilibili.com/x/v2/reply/wbi/main',
      {
        oid: aid,
        type: 1,
        mode: 3, // hot/like order
        ps: limit
      },
      { wbi: true }
    )

    const replies = res?.replies || []
    return replies.slice(0, limit).map((r) => ({
      user: r.member?.uname || 'BiliUser',
      message: (r.content?.message || '').trim(),
      likes: Number(r.like || 0)
    }))
  } catch (e) {
    log.warn('Failed to fetch video comments', { aid, error: String(e) })
    return []
  }
}

/**
 * Fetch raw XML danmaku content for a CID.
 */
export async function getVideoDanmakuXml(client: BiliClient, cid: number): Promise<string | null> {
  try {
    const url = `https://comment.bilibili.com/${cid}.xml`
    const xml = (await client.rawRequest(url, { method: 'GET' })) as string
    return typeof xml === 'string' && xml.includes('<d p=') ? xml : null
  } catch (e) {
    log.warn('Failed to fetch video danmaku xml', { cid, error: String(e) })
    return null
  }
}

/**
 * Parse sampled danmakus from raw XML string.
 */
export function parseDanmakuSamples(xml: string | null | undefined, limit = 40): string[] {
  if (!xml || typeof xml !== 'string') return []
  const regex = /<d p="([^"]+)">([^<]+)<\/d>/g
  const items: Array<{ time: number; text: string }> = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(xml)) !== null) {
    const p = match[1].split(',')
    const timeSec = parseFloat(p[0] || '0')
    const text = match[2].trim()
    if (text && text.length >= 2 && !text.startsWith('http')) {
      items.push({ time: timeSec, text })
    }
  }

  items.sort((a, b) => a.time - b.time)
  if (items.length <= limit) {
    return items.map((it) => `[${formatLrcTime(it.time).slice(1, 6)}] ${it.text}`)
  }

  const step = Math.floor(items.length / limit)
  const sampled: string[] = []
  for (let i = 0; i < items.length && sampled.length < limit; i += step) {
    const it = items[i]
    sampled.push(`[${formatLrcTime(it.time).slice(1, 6)}] ${it.text}`)
  }
  return sampled
}

/**
 * Fetch XML danmaku and extract representative danmakus.
 */
export async function getVideoDanmakus(
  client: BiliClient,
  cid: number,
  limit = 40
): Promise<string[]> {
  const xml = await getVideoDanmakuXml(client, cid)
  return parseDanmakuSamples(xml, limit)
}

/**
 * Fetch play and download URL for video stream.
 */
export async function getVideoPlayUrl(
  client: BiliClient,
  bvid: string,
  cid: number,
  qn = 80
): Promise<BiliPlayUrlResult> {
  const res = await client.executeGet<{
    format?: string
    quality?: number
    durl?: Array<{ url: string }>
    dash?: {
      video?: Array<{ baseUrl?: string; base_url?: string }>
      audio?: Array<{ baseUrl?: string; base_url?: string }>
    }
  }>(
    'https://api.bilibili.com/x/player/wbi/playurl',
    {
      bvid,
      cid,
      qn,
      fnval: 0, // Request direct single stream (MP4/FLV) first
      fnver: 0,
      fourk: 1
    },
    { wbi: true }
  )

  if (Array.isArray(res?.durl) && res.durl.length > 0) {
    return {
      format: res.format,
      quality: res.quality,
      url: res.durl[0].url,
      isDash: false
    }
  }

  // Fallback to DASH
  if (res?.dash) {
    const videoStream = res.dash.video?.[0]
    const audioStream = res.dash.audio?.[0]
    return {
      format: res.format,
      quality: res.quality,
      videoUrl: videoStream?.baseUrl || videoStream?.base_url,
      audioUrl: audioStream?.baseUrl || audioStream?.base_url,
      isDash: true
    }
  }

  throw new Error('未获取到视频播放流地址')
}
