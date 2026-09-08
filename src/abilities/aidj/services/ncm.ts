import OpenAI from 'openai'
import { makeLogger } from '../../../main/process/logger'
import { ncmSearch, ncmLyric, ncmComments } from '../ncm_api'
import type { SongMeta, MetadataSyncCounts, MetadataSyncProgress } from '../types'
import { appendMetadata } from './library'
import { appendLyric, yrcToInlineLrc } from './lyrics'

const log = makeLogger('aidj-ncm')

let ncmBaseUrl = 'http://localhost:3000'

export function setNcmBaseUrl(url: string): void {
  ncmBaseUrl = url
}

let ncmMode: 'auto' | 'external' | 'builtin' = 'auto'
let ncmApproved = false

export function setNcmMode(mode: 'auto' | 'external' | 'builtin' | undefined): void {
  ncmMode = mode ?? 'auto'
}

export function setNcmApproved(approved: boolean | undefined): void {
  ncmApproved = Boolean(approved)
}

let ncmCommentCount = 10

export function setNcmCommentCount(count: number | undefined): void {
  ncmCommentCount = Math.max(0, Math.min(50, Math.round(count ?? 10)))
}

function formatComments(cs: { nickname: string; content: string; likes: number }[]): string[] {
  return cs.slice(0, ncmCommentCount).map((c) => `${c.nickname}: ${c.content} (👍 ${c.likes})`)
}

export type NcmSearchResultT = {
  sid: number | null
  lyric: string
  karaoke: string
  networkError: boolean
  comments: string[]
}

export async function searchNcmApi(keywords: string): Promise<NcmSearchResultT> {
  // If user hasn't approved NCM built-in scraping, strictly disallow builtin requests
  if (!ncmApproved) {
    if (ncmMode === 'builtin') {
      log.warn(
        'NCM built-in API blocked: not approved by user. Please run aidj.approve-ncm or enable in settings.',
        { keywords }
      )
      return { sid: null, lyric: '', karaoke: '', networkError: true, comments: [] }
    }
    return searchNcmApiExternal(keywords)
  }

  if (ncmMode === 'builtin') return searchNcmApiBuiltin(keywords)
  const external = await searchNcmApiExternal(keywords)
  if (ncmMode === 'external' || !external.networkError) return external
  log.info('NCM external service unreachable — falling back to built-in', { keywords })
  return searchNcmApiBuiltin(keywords)
}

async function searchNcmApiExternal(keywords: string): Promise<NcmSearchResultT> {
  const started = Date.now()
  try {
    const sRes = await fetch(
      `${ncmBaseUrl}/search?keywords=${encodeURIComponent(keywords)}&limit=1`
    )
    const sData = (await sRes.json()) as {
      code: number
      result: { songCount: number; songs: { id: number }[] }
    }
    if (sData.code !== 200 || !sData.result?.songCount) {
      log.debug('NCM search: no result', {
        keywords,
        code: sData.code,
        latencyMs: Date.now() - started
      })
      return { sid: null, lyric: '', karaoke: '', networkError: false, comments: [] }
    }
    const sid = sData.result.songs[0].id
    const lRes = await fetch(`${ncmBaseUrl}/lyric?id=${sid}`)
    const lData = (await lRes.json()) as {
      code: number
      lrc: { lyric: string }
      yrc?: { lyric: string }
    }
    const lyric = lData.code === 200 ? (lData.lrc?.lyric ?? '') : ''
    const yrc = lData.code === 200 && lData.yrc?.lyric ? lData.yrc.lyric : ''
    const karaoke = yrc ? yrcToInlineLrc(yrc) : ''
    const comments = await fetchExternalComments(sid)
    log.debug('NCM search ok', {
      keywords,
      sid,
      songCount: sData.result.songCount,
      lyricLen: lyric.length,
      karaokeLen: karaoke.length,
      commentCount: comments.length,
      latencyMs: Date.now() - started
    })
    return { sid, lyric, karaoke, networkError: false, comments }
  } catch (e) {
    log.warn('NCM search failed', { keywords, error: String(e) })
    return { sid: null, lyric: '', karaoke: '', networkError: true, comments: [] }
  }
}

async function fetchExternalComments(sid: number): Promise<string[]> {
  if (ncmCommentCount <= 0) return []
  try {
    const res = await fetch(`${ncmBaseUrl}/comment/music?id=${sid}&limit=${ncmCommentCount}`)
    const data = (await res.json()) as {
      code: number
      hotComments?: { user?: { nickname?: string }; content?: string; likedCount?: number }[]
    }
    if (data.code !== 200 || !data.hotComments?.length) return []
    return formatComments(
      data.hotComments.slice(0, ncmCommentCount).map((c) => ({
        nickname: c.user?.nickname ?? '',
        content: c.content ?? '',
        likes: c.likedCount ?? 0
      }))
    )
  } catch {
    return []
  }
}

async function searchNcmApiBuiltin(keywords: string): Promise<NcmSearchResultT> {
  if (!ncmApproved) {
    log.warn('NCM built-in API blocked: not approved by user', { keywords })
    return { sid: null, lyric: '', karaoke: '', networkError: true, comments: [] }
  }
  const started = Date.now()
  try {
    const sData = await ncmSearch(keywords, 1)
    if (sData.code !== 200 || !sData.result?.songCount || !sData.result.songs.length) {
      log.debug('NCM builtin search: no result', { keywords, code: sData.code })
      return { sid: null, lyric: '', karaoke: '', networkError: false, comments: [] }
    }
    const sid = sData.result.songs[0].id
    const lData = await ncmLyric(sid)
    const lyric = lData.code === 200 ? (lData.lrc?.lyric ?? '') : ''
    const yrc = lData.code === 200 && lData.yrc?.lyric ? lData.yrc.lyric : ''
    const karaoke = yrc ? yrcToInlineLrc(yrc) : ''
    const comments =
      ncmCommentCount > 0
        ? formatComments(await ncmComments(sid, ncmCommentCount).catch(() => []))
        : []
    log.debug('NCM builtin search ok', {
      keywords,
      sid,
      songCount: sData.result.songCount,
      lyricLen: lyric.length,
      karaokeLen: karaoke.length,
      commentCount: comments.length,
      latencyMs: Date.now() - started
    })
    return { sid, lyric, karaoke, networkError: false, comments }
  } catch (e) {
    log.warn('NCM builtin search failed', { keywords, error: String(e) })
    return { sid: null, lyric: '', karaoke: '', networkError: true, comments: [] }
  }
}

export async function extractMetadataAi(
  client: OpenAI,
  name: string,
  lyric: string,
  model: string,
  comments?: string[]
): Promise<{ meta: SongMeta | null; error?: string }> {
  const started = Date.now()
  try {
    const info = {
      title: name,
      lyrics: lyric.slice(0, 500),
      ...(comments?.length ? { hot_comments: comments } : {})
    }
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content: `You are a music metadata annotator. Given a song title, its lyrics (which may be partial or missing) and listener comments (may be absent), return a JSON object with EXACTLY these fields:
- "language": string — the dominant language of the song, e.g. "Chinese", "English", "Japanese", "Cantonese". Use "Unknown" when the lyrics are empty.
- "emotion": string or string[] — one to three concise mood keywords, e.g. "nostalgic", "upbeat", "melancholic".
- "genre": string or string[] — one to three genre tags, e.g. "indie rock", "city pop", "folk".
- "loudness": string — a coarse intensity descriptor: "soft", "medium", or "loud". Infer it from the song style implied by the title and lyrics, never from the lyrics text itself.
- "review": string — a vivid 1-2 sentence review of the song. GROUND IT in the hot_comments when present (synthesize their sentiment/observations); never invent facts about the artist, release year, or awards.

RULES:
- Use a string[] for "emotion" and "genre" when there are multiple values; otherwise use a plain string.
- Only infer from the information provided.
- When the lyrics are empty, rely on the title (and comments) alone and set "language" to "Unknown".`
          },
          { role: 'user', content: JSON.stringify(info) }
        ],
        response_format: { type: 'json_object' }
      },
      { timeout: 30_000 }
    )
    const content = resp.choices[0]?.message?.content
    if (!content) {
      log.debug('Metadata extraction: empty', { name, latencyMs: Date.now() - started })
      return { meta: null, error: 'AI 返回空内容' }
    }
    const parsed = JSON.parse(content) as SongMeta
    log.debug('Metadata extracted', {
      name,
      model,
      lyricLen: lyric.length,
      commentCount: comments?.length ?? 0,
      parsed,
      latencyMs: Date.now() - started
    })
    return { meta: parsed }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.warn('extractMetadataAi failed', { name, error })
    return { meta: null, error }
  }
}

const _syncing = new Set<string>()

export async function syncMetadata(
  client: OpenAI,
  missing: Map<string, string>,
  metadata: Map<string, SongMeta>,
  model: string,
  concurrency: number,
  onProgress?: (p: MetadataSyncProgress) => void,
  lyrics?: Map<string, string>,
  isCancelled?: () => boolean
): Promise<{ metadata: Map<string, SongMeta>; counts: MetadataSyncCounts }> {
  const counts: MetadataSyncCounts = { ok: 0, noLyric: 0, failed: 0, networkError: 0 }
  if (!missing.size) return { metadata, counts }
  const entries = [...missing.entries()].filter(([name]) => {
    if (_syncing.has(name)) return false
    _syncing.add(name)
    return true
  })
  if (!entries.length) return { metadata, counts }
  log.info(`Syncing ${entries.length} songs... concurrency=${concurrency}`)
  const workers = Math.min(concurrency, entries.length)
  let done = 0
  try {
    await Promise.allSettled(
      Array.from({ length: workers }, async (_, i) => {
        for (let j = i; j < entries.length; j += workers) {
          if (isCancelled?.()) return
          const [name] = entries[j]
          const { sid, lyric, karaoke, networkError, comments } = await searchNcmApi(name)
          if (sid === null) {
            if (networkError) {
              counts.networkError++
              log.warn('Metadata sync: NCM unreachable', { name })
              onProgress?.({
                done: ++done,
                total: entries.length,
                name,
                status: 'networkError',
                error: 'NCM API 连接失败'
              })
            } else {
              counts.noLyric++
              log.debug('Metadata sync: no result', { name })
              onProgress?.({
                done: ++done,
                total: entries.length,
                name,
                status: 'noLyric'
              })
            }
            continue
          }
          const { meta, error } = await extractMetadataAi(client, name, lyric, model, comments)
          if (meta) {
            metadata.set(name, meta)
            await appendMetadata(name, meta)
            counts.ok++
            onProgress?.({
              done: ++done,
              total: entries.length,
              name,
              status: 'ok',
              sid,
              lyricLen: lyric.length,
              meta
            })
          } else {
            counts.failed++
            log.warn('Metadata sync: extraction failed', { name, sid, error })
            onProgress?.({
              done: ++done,
              total: entries.length,
              name,
              status: 'failed',
              sid,
              lyricLen: lyric.length,
              error
            })
          }
          if (lyric && (!lyrics || !lyrics.has(name))) {
            await appendLyric(name, lyric, karaoke)
            if (lyrics) lyrics.set(name, lyric)
          }
        }
      })
    )
  } finally {
    for (const [name] of entries) _syncing.delete(name)
  }
  log.info('Metadata sync done', {
    total: entries.length,
    ...counts
  })
  return { metadata, counts }
}
