import { BiliCredential } from './credential'
import { calculateMixinKey, encodeDm, signWbi } from './wbi'
import { makeLogger } from '../../../main/process/logger'

const log = makeLogger('bili-client')

export interface BiliClientOptions {
  credential?: BiliCredential
  userAgent?: string
  timeoutMs?: number
}

export interface RawFetchResponse<T = unknown> {
  data: T
  status: number
  headers: Headers
  setCookies: string[]
}

export class BiliClient {
  public credential: BiliCredential
  public userAgent: string
  public timeoutMs: number

  private mixinKeyCache?: { key: string; expiresAt: number }

  constructor(options: BiliClientOptions = {}) {
    this.credential = options.credential ?? BiliCredential.loadDefault()
    this.userAgent =
      options.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    this.timeoutMs = options.timeoutMs ?? 15000
  }

  /**
   * Fetch WBI mixin key with 10-minute cache.
   */
  public async getMixinKey(): Promise<string> {
    const now = Date.now()
    if (this.mixinKeyCache && this.mixinKeyCache.expiresAt > now) {
      return this.mixinKeyCache.key
    }

    try {
      const resp = (await this.rawRequest('https://api.bilibili.com/x/web-interface/nav', {
        method: 'GET'
      })) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
      const data = resp?.data
      if (data?.wbi_img?.img_url && data?.wbi_img?.sub_url) {
        const imgKey = data.wbi_img.img_url.split('/').pop()?.split('.')[0] || ''
        const subKey = data.wbi_img.sub_url.split('/').pop()?.split('.')[0] || ''
        const mixinKey = calculateMixinKey(imgKey, subKey)
        this.mixinKeyCache = {
          key: mixinKey,
          expiresAt: now + 10 * 60 * 1000
        }
        return mixinKey
      }
    } catch (e) {
      log.warn('Failed to fetch nav WBI key, using fallback key', { error: String(e) })
    }

    return 'ea1ae52dc71990eb7e79402145610a1f'
  }

  public async rawRequestWithHeaders<T = unknown>(
    url: string,
    options: {
      method?: string
      params?: Record<string, unknown>
      headers?: Record<string, string>
    } = {}
  ): Promise<RawFetchResponse<T>> {
    const method = (options.method || 'GET').toUpperCase()
    const finalUrl = new URL(url)

    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          finalUrl.searchParams.set(k, String(v))
        }
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Referer: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      ...options.headers
    }

    const cookieStr = this.credential.toCookieString()
    if (cookieStr) {
      headers['Cookie'] = cookieStr
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resp = await fetch(finalUrl.toString(), {
        method,
        headers,
        signal: controller.signal
      })

      const setCookies =
        typeof resp.headers.getSetCookie === 'function'
          ? resp.headers.getSetCookie()
          : resp.headers.get('set-cookie')
            ? [resp.headers.get('set-cookie')!]
            : []

      let data: unknown
      const contentType = resp.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        data = await resp.json()
      } else {
        data = await resp.text()
      }

      return {
        data: data as T,
        status: resp.status,
        headers: resp.headers,
        setCookies
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn('BiliClient rawRequest failed', { url: finalUrl.toString(), error })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  public async rawRequest(
    url: string,
    options: {
      method?: string
      params?: Record<string, unknown>
      headers?: Record<string, string>
    } = {}
  ): Promise<unknown> {
    const res = await this.rawRequestWithHeaders(url, options)
    return res.data
  }

  /**
   * Execute API endpoint with optional WBI signing and error checking.
   */
  public async executeGet<T = unknown>(
    url: string,
    params: Record<string, unknown> = {},
    options: { wbi?: boolean; dm?: boolean } = {}
  ): Promise<T> {
    let finalParams = { ...params }
    if (options.dm) {
      finalParams = encodeDm(finalParams)
    }
    if (options.wbi) {
      const mixinKey = await this.getMixinKey()
      finalParams = signWbi(finalParams, mixinKey)
    }

    const res = await this.rawRequest(url, { method: 'GET', params: finalParams })
    if (res && typeof res === 'object' && 'code' in res) {
      const r = res as {
        code?: number | string
        message?: string
        msg?: string
        data?: unknown
        result?: unknown
      }
      const code = Number(r.code)
      if (code === 0) {
        return (r.data !== undefined ? r.data : r.result) as T
      }
      throw new Error(
        `Bilibili API Error [${code}]: ${String(r.message || r.msg || 'Request failed')}`
      )
    }
    return res as unknown as T
  }
}
