/**
 * Minimal request layer for the built-in Netease search/lyric access — adapted
 * from NeteaseCloudMusicApi's util/request.js (MIT, Binaryify), trimmed to the
 * three crypto modes we use (`weapi` search, `eapi` word-level lyric, plain
 * form POST for the classic lyric endpoint) and using fetch instead of axios.
 * See ./LICENSE.
 */
import { weapi, eapi, eapiDecrypt, randomNmtId } from './crypto'

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'

export interface NcmRequestOptions {
  /** 'weapi'/'eapi' encrypt the payload; 'api' is a plain form POST (lyric). */
  crypto?: 'weapi' | 'eapi' | 'api'
  /** API route path used by eapi encryption (e.g. '/api/song/lyric/v1'). */
  route?: string
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
  if (options.crypto === 'weapi') {
    const enc = weapi({ csrf_token: '', ...data })
    body = new URLSearchParams({ params: enc.params, encSecKey: enc.encSecKey }).toString()
    url = url.replace(/\w*api/, 'weapi')
  } else if (options.crypto === 'eapi') {
    const header: Record<string, string> = {
      osver: '17,1,2',
      deviceId: '',
      appver: '8.9.70',
      versioncode: '140',
      mobilename: '',
      buildver: Date.now().toString().slice(0, 10),
      resolution: '1920x1080',
      __csrf: '',
      os: 'ios',
      channel: '',
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(4, '0')}`
    }
    const enc = eapi(options.route ?? '', { ...data, header })
    body = new URLSearchParams({ params: enc.params }).toString()
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeout ?? 15_000)
    })
    const buf = Buffer.from(await res.arrayBuffer())
    // eapi responses come back hex-encrypted OR plaintext JSON depending on
    // request identity — try JSON first, decrypt as hex when it isn't.
    const asText = buf.toString('utf8')
    try {
      return JSON.parse(asText) as Record<string, unknown>
    } catch {
      return JSON.parse(eapiDecrypt(buf)) as Record<string, unknown>
    }
  } else {
    body = new URLSearchParams(data as Record<string, string>).toString()
  }
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeout ?? 15_000)
  })
  return (await res.json()) as Record<string, unknown>
}
