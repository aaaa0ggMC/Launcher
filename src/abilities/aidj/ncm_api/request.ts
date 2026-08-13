/**
 * Minimal request layer for the built-in Netease search/lyric access — adapted
 * from NeteaseCloudMusicApi's util/request.js (MIT, Binaryify), trimmed to the
 * two crypto modes we use (`weapi` for search, plain form POST for lyric) and
 * using fetch instead of axios. See ./LICENSE.
 */
import { weapi, randomNmtId } from './crypto'

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'

export interface NcmRequestOptions {
  /** 'weapi' encrypts the payload; 'api' is a plain form POST (lyric). */
  crypto?: 'weapi' | 'api'
  timeout?: number
}

/** Guest identity cookie — enough for search + lyric without login. */
function guestCookie(): string {
  return `__remember_me=true; NMTID=${randomNmtId()}; os=ios`
}

export async function ncmRequest(
  method: 'POST',
  url: string,
  data: Record<string, unknown>,
  options: NcmRequestOptions = {}
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'User-Agent': PC_UA,
    Referer: 'https://music.163.com',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: guestCookie()
  }
  let body: string
  let finalUrl = url
  if (options.crypto === 'weapi') {
    const enc = weapi({ csrf_token: '', ...data })
    body = new URLSearchParams({ params: enc.params, encSecKey: enc.encSecKey }).toString()
    finalUrl = url.replace(/\w*api/, 'weapi')
  } else {
    body = new URLSearchParams(data as Record<string, string>).toString()
  }
  const res = await fetch(finalUrl, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeout ?? 15_000)
  })
  return (await res.json()) as Record<string, unknown>
}
