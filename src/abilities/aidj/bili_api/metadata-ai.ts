import type OpenAI from 'openai'
import type { SongMeta } from '../types'
import { makeLogger } from '../../../main/process/logger'
import { loadActiveVocab } from '../sanitize/store'
import { vocabPromptHint } from '../sanitize/vocab'

const log = makeLogger('bili-metadata-ai')

export interface BiliAiMetadataResult {
  song_title: string
  artist: string
  meta: SongMeta
}

/**
 * Prompt OpenAI model to synthesize metadata from Bilibili video info,
 * subtitles, comments, and danmakus.
 */
export async function extractBiliMetadataAi(
  client: OpenAI,
  model: string,
  data: {
    title: string
    desc: string
    author: string
    tags: string[]
    subtitlesSnippet?: string
    comments?: string[]
    danmakus?: string[]
  }
): Promise<BiliAiMetadataResult> {
  const started = Date.now()
  const payload = {
    video_title: data.title,
    uploader: data.author,
    tags: data.tags.slice(0, 8),
    description: data.desc.slice(0, 300),
    lyrics_snippet: (data.subtitlesSnippet || '').slice(0, 400),
    hot_comments: (data.comments || []).slice(0, 10),
    bullet_danmakus: (data.danmakus || []).slice(0, 15)
  }

  const systemPrompt = `You are an expert music metadata curator. Given information from a Bilibili music video (title, uploader, description, tags, lyrics/subtitles, listener comments, and bullet screen danmaku), return a JSON object with EXACTLY these fields:
- "song_title": string — the clean, canonical song title (strip clutter like "【MV】", "【4K60帧】", "【高音质】", episode tags, etc.).
- "artist": string — the primary music artist, band, composer, or singer. If it's an original song by the uploader, use the uploader or singer name; if it's a cover, credit the actual singer/producer. Crucially: if the specific artist/singer cannot be determined (such as for anime soundtracks, OST collections, BGMs, or videos uploaded by reposter/aggregator channels like "天使动漫", "搬运工", etc.), extract and use franchise or work clues from the video title or description—such as the anime title, animation name, or game title (e.g., "Sonny Boy", "漂流少年", "葬送的芙莉莲", "原神")—as the artist. If no artist, singer, anime, or franchise name can be determined, fallback to "Unknown". Never use generic reposter/aggregator uploader names as the artist.
- "language": string — dominant language ("Chinese", "Japanese", "English", "Instrumental", etc.).
- "emotion": string or string[] — 1 to 3 concise mood keywords (e.g. "energetic", "melancholic", "dreamy").
- "genre": string or string[] — 1 to 3 musical genres (e.g. "J-Pop", "Rock", "ACG", "Electronic", "Ballad").
- "loudness": string — "soft", "medium", or "loud".
- "review": string — a vivid 1-2 sentence review or atmospheric description of the track. GROUND IT in the listener comments and bullet danmaku impressions; capture what listeners felt or cheered for. Never invent non-existent history.

RULES:
- Always respond in valid JSON format.
- "song_title" must never be empty (fallback to a cleaned video title).
- "artist" must never be empty. If the exact singer/artist is not identified, replace it with clues from the title/description such as anime/animation/franchise name; if completely unknown, fallback to "Unknown". Do NOT fallback to reposter/curator uploaders.${vocabPromptHint(await loadActiveVocab())}`

  const resp = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      response_format: { type: 'json_object' }
    },
    { timeout: 35000 }
  )

  const content = resp.choices[0]?.message?.content
  if (!content) {
    throw new Error('AI 返回空内容')
  }

  const parsed = JSON.parse(content) as {
    song_title?: string
    artist?: string
    language?: string
    emotion?: string | string[]
    genre?: string | string[]
    loudness?: string
    review?: string
  }

  const song_title = (parsed.song_title || data.title).trim()
  const rawArtist = (parsed.artist || '').trim()
  const artist =
    rawArtist && rawArtist.toLowerCase() !== 'null' && rawArtist.toLowerCase() !== 'undefined'
      ? rawArtist
      : 'Unknown'

  const meta: SongMeta = {
    language: parsed.language || 'Chinese',
    emotion: parsed.emotion || 'pop',
    genre: parsed.genre || 'pop',
    loudness: parsed.loudness || 'medium',
    review: parsed.review || '充满活力的音乐作品。'
  }

  log.info('Bilibili metadata extracted via AI', {
    song_title,
    artist,
    latencyMs: Date.now() - started
  })

  return {
    song_title,
    artist,
    meta
  }
}
