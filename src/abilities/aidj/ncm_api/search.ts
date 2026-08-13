/**
 * Netease song search — adapted from NeteaseCloudMusicApi module/search.js
 * (MIT, Binaryify), trimmed to type 1 (single tracks). See ./LICENSE.
 */
import { ncmRequest } from './request'

export interface NcmSongHit {
  id: number
  name: string
  artists?: { id: number; name: string }[]
  album?: { id: number; name: string }
  duration?: number
}

export interface NcmSearchResult {
  code: number
  result?: {
    songCount: number
    songs: NcmSongHit[]
  }
}

export async function ncmSearch(keywords: string, limit = 1): Promise<NcmSearchResult> {
  const body = await ncmRequest(
    'POST',
    'https://music.163.com/weapi/search/get',
    { s: keywords, type: 1, limit, offset: 0 },
    { crypto: 'weapi' }
  )
  return body as unknown as NcmSearchResult
}
