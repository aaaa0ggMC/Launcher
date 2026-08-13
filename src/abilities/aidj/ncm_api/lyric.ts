/**
 * Netease lyric fetch — adapted from NeteaseCloudMusicApi module/lyric.js and
 * module/lyric_new.js (MIT, Binaryify). Prefers the word-level `/lyric/v1`
 * endpoint (returns yrc karaoke), falls back to the classic `/api/song/lyric`.
 * See ./LICENSE.
 */
import { ncmRequest } from './request'

export interface NcmLyricResult {
  code: number
  lrc?: { lyric?: string }
  yrc?: { lyric?: string }
  nolyric?: boolean
}

/** New endpoint — word-level lyrics, carries `yrc` karaoke when available. */
async function lyricV1(id: number): Promise<NcmLyricResult> {
  const body = await ncmRequest(
    'POST',
    'https://interface3.music.163.com/eapi/song/lyric/v1',
    { id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
    { crypto: 'eapi', route: '/api/song/lyric/v1' }
  )
  return body as unknown as NcmLyricResult
}

/** Classic endpoint — plain lrc; may lack yrc for some songs. */
async function lyricClassic(id: number): Promise<NcmLyricResult> {
  const body = await ncmRequest(
    'POST',
    'https://music.163.com/api/song/lyric?_nmclfl=1',
    { id, tv: -1, lv: -1, rv: -1, kv: -1 },
    { crypto: 'api' }
  )
  return body as unknown as NcmLyricResult
}

export async function ncmLyric(id: number): Promise<NcmLyricResult> {
  try {
    const v1 = await lyricV1(id)
    if (v1.code === 200 && (v1.lrc?.lyric || v1.yrc?.lyric)) return v1
    // fall through to the classic endpoint on failure / empty
  } catch {
    /* network hiccup → try classic */
  }
  return lyricClassic(id)
}
