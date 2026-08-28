/**
 * Google 官方 Map Tiles API (2D) 会话管理与切片获取器。
 * 遵循官方 Map Tiles API 规范：先通过 createSession 获取 sessionToken（2周有效期），再拉取 2dtiles 切片。
 */
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('yarj-google-tiles')

const sessionCache = new Map<string, Promise<string | null>>()

export async function getGoogleTileSession(
  apiKey: string,
  mapType: string = 'satellite',
  layerTypes?: string[],
  lang: string = 'zh-CN',
  forceRefresh = false
): Promise<string | null> {
  const cacheKey = `${apiKey}:${mapType}:${layerTypes?.join(',') || ''}:${lang}`
  if (!forceRefresh && sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey)!
  }

  const promise = (async () => {
    try {
      const url = `https://tile.googleapis.com/v1/createSession?key=${apiKey}`
      const body: Record<string, unknown> = {
        mapType,
        language: lang,
        region: 'CN',
        scale: 'scaleFactor2x',
        overlay: false
      }
      if (layerTypes && layerTypes.length) {
        body.layerTypes = layerTypes
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        log.warn('Google createSession failed', { status: res.status, error: errText })
        return null
      }

      const data = (await res.json()) as { session?: string }
      if (data?.session) {
        log.info('Google Map Tiles session created successfully', { mapType, lang })
        return data.session
      }
      return null
    } catch (err) {
      log.error('Google createSession error', { error: String(err) })
      return null
    }
  })()

  sessionCache.set(cacheKey, promise)
  return promise
}

export function invalidateGoogleTileSession(
  apiKey: string,
  mapType: string = 'satellite',
  layerTypes?: string[],
  lang: string = 'zh-CN'
): void {
  const cacheKey = `${apiKey}:${mapType}:${layerTypes?.join(',') || ''}:${lang}`
  sessionCache.delete(cacheKey)
}
