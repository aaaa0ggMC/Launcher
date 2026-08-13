/**
 * Netease lyric fetch — adapted from NeteaseCloudMusicApi module/lyric.js
 * (MIT, Binaryify). Returns lrc (and yrc karaoke when present). See ./LICENSE.
 */
import { ncmRequest } from './request'

export interface NcmLyricResult {
  code: number
  lrc?: { lyric?: string }
  yrc?: { lyric?: string }
  nolyric?: boolean
}

export async function ncmLyric(id: number): Promise<NcmLyricResult> {
  const body = await ncmRequest(
    'POST',
    'https://music.163.com/api/song/lyric?_nmclfl=1',
    { id, tv: -1, lv: -1, rv: -1, kv: -1 },
    { crypto: 'api' }
  )
  return body as unknown as NcmLyricResult
}
