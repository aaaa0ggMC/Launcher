/**
 * `cockpit-tile://` 自定义协议处理器：
 * 1. 在线瓦片代理与磁盘缓存：`cockpit-tile://online/<providerId>/<z>/<x>/<y>`
 * 2. 本地 MBTiles 瓦片直读：`cockpit-tile://<mapId>/<z>/<x>/<y>`
 */
import { readFile } from 'fs/promises'
import { protocol } from 'electron'
import { makeLogger } from '../../main/process/logger'
import { CONFIG_JSON } from '../../main/process/paths'
import { loadYarjConfig } from './service'
import { closeMbtiles, fetchTile, tileMime } from './mbtiles'
import {
  BUILTIN_PROVIDERS,
  DEFAULT_GOOGLE_API_KEY,
  formatTileUrl,
  resolveMapLanguage
} from './providers'
import { readCachedTile, writeCachedTile } from './tile-cache'
import { getGoogleTileSession, invalidateGoogleTileSession } from './google-tiles'
import type { MapProviderConfig } from './types'

const log = makeLogger('yarj-tiles')

let registered = false
const inFlightTiles = new Map<
  string,
  Promise<{ arrayBuffer: ArrayBuffer; contentType: string } | null>
>()

async function getAppLanguage(): Promise<string> {
  try {
    const raw = await readFile(CONFIG_JSON, 'utf-8')
    const cfg = JSON.parse(raw) as { language?: string }
    return cfg.language ?? 'zh'
  } catch {
    return 'zh'
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pbf: 'application/x-protobuf'
}

function resolveProvider(
  cfg: {
    activeProviderId?: string
    customUrlTemplate?: string
    customSubdomains?: string[]
  },
  providerId: string
): MapProviderConfig | null {
  if (providerId === 'custom') {
    return {
      id: 'custom',
      name: '自定义在线瓦片',
      category: 'custom',
      type: 'raster',
      urlTemplate: cfg.customUrlTemplate ?? '',
      subdomains: cfg.customSubdomains?.length ? cfg.customSubdomains : ['0', '1', '2', '3'],
      minZoom: 0,
      maxZoom: 20,
      tileSize: 256,
      ext: 'png'
    }
  }
  return BUILTIN_PROVIDERS.find((p) => p.id === providerId) ?? null
}

export function registerYarjTileProtocol(): void {
  if (registered) return
  registered = true
  protocol.handle('cockpit-tile', async (request) => {
    try {
      const raw = request.url.slice('cockpit-tile://'.length)
      const parts = raw.split('/').filter(Boolean)

      // 分支 A: 在线瓦片（带本地磁盘缓存）: online/<providerId>/<z>/<x>/<y>
      if (parts[0] === 'online' && parts.length === 5) {
        const [, providerId, zs, xs, ys] = parts
        const z = Number(zs)
        const x = Number(xs)
        const y = Number(ys)
        if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0) {
          return new Response(null, { status: 400 })
        }

        const cfg = await loadYarjConfig()
        const provider = resolveProvider(cfg, providerId)
        if (!provider || !provider.urlTemplate) {
          return new Response(null, { status: 404 })
        }

        const ext = provider.ext ?? 'png'
        const enableCache = cfg.enableTileCache !== false

        const appLang = await getAppLanguage()
        const resolvedLang = resolveMapLanguage(cfg.mapLanguage, appLang)
        const langKey =
          provider.category === 'google' || provider.category === 'google-official'
            ? resolvedLang || 'local'
            : 'default'

        // 1. 尝试读磁盘缓存
        if (enableCache) {
          const cachedBuf = await readCachedTile(providerId, z, x, y, ext, langKey)
          if (cachedBuf) {
            const ab = cachedBuf.buffer.slice(
              cachedBuf.byteOffset,
              cachedBuf.byteOffset + cachedBuf.byteLength
            ) as ArrayBuffer
            return new Response(ab, {
              headers: {
                'Content-Type': MIME_BY_EXT[ext] || 'image/png',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=2592000'
              }
            })
          }
        }

        // 2. 从上游拉取（合并并发相同瓦片请求）
        const reqKey = `${providerId}:${langKey}:${z}:${x}:${y}`
        let fetchPromise = inFlightTiles.get(reqKey)

        if (!fetchPromise) {
          fetchPromise = (async () => {
            // Google 官方 Map Tiles API (2D 会话鉴权与切片)
            if (provider.category === 'google-official') {
              const apiKey = cfg.googleApiKey || DEFAULT_GOOGLE_API_KEY
              const mapType =
                provider.id.includes('satellite') || provider.id.includes('hybrid')
                  ? 'satellite'
                  : provider.id.includes('terrain')
                    ? 'terrain'
                    : 'roadmap'
              const layerTypes = provider.id.includes('hybrid') ? ['layerRoadmap'] : undefined
              const langParam = resolvedLang || 'zh-CN'

              for (let attempt = 0; attempt < 2; attempt++) {
                const sessionToken = await getGoogleTileSession(
                  apiKey,
                  mapType,
                  layerTypes,
                  langParam,
                  attempt > 0
                )
                if (!sessionToken) return null

                const targetUrl = `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(sessionToken)}&key=${encodeURIComponent(apiKey)}`

                try {
                  const controller = new AbortController()
                  const timeoutId = setTimeout(() => controller.abort(), 12000)
                  const upstream = await fetch(targetUrl, {
                    headers: {
                      'User-Agent':
                        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
                    },
                    signal: controller.signal
                  })
                  clearTimeout(timeoutId)

                  if (upstream.ok) {
                    const arrayBuffer = await upstream.arrayBuffer()
                    const contentType =
                      upstream.headers.get('Content-Type') || MIME_BY_EXT[ext] || 'image/jpeg'

                    if (enableCache && arrayBuffer.byteLength > 0) {
                      void writeCachedTile(
                        providerId,
                        z,
                        x,
                        y,
                        ext,
                        Buffer.from(arrayBuffer),
                        langKey,
                        cfg.maxTileCacheMb ?? 1024
                      )
                    }

                    return { arrayBuffer, contentType }
                  } else if (
                    upstream.status === 401 ||
                    upstream.status === 403 ||
                    upstream.status === 404
                  ) {
                    invalidateGoogleTileSession(apiKey, mapType, layerTypes, langParam)
                  }
                } catch (fetchErr) {
                  log.debug('Google official tile fetch failed', {
                    attempt,
                    error: String(fetchErr)
                  })
                }
              }
              return null
            }

            const apiKey =
              provider.category === 'google'
                ? cfg.googleApiKey || DEFAULT_GOOGLE_API_KEY
                : provider.category === 'tianditu'
                  ? cfg.tiandituApiKey || ''
                  : ''

            const subs = provider.subdomains?.length ? provider.subdomains : ['0', '1', '2', '3']
            const baseSubIdx = Math.abs(x + y) % subs.length

            for (let attempt = 0; attempt < 2; attempt++) {
              const currentSub = subs[(baseSubIdx + attempt) % subs.length]
              const targetUrl = formatTileUrl(provider.urlTemplate, z, x, y, {
                subdomains: [currentSub],
                apiKey,
                isRetina: true,
                lang: resolvedLang
              })

              if (!targetUrl) break

              try {
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), 12000)
                const upstream = await fetch(targetUrl, {
                  headers: {
                    'User-Agent':
                      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
                  },
                  signal: controller.signal
                })
                clearTimeout(timeoutId)

                if (upstream.ok) {
                  const arrayBuffer = await upstream.arrayBuffer()
                  const contentType =
                    upstream.headers.get('Content-Type') || MIME_BY_EXT[ext] || 'image/png'

                  // 异步写入本地磁盘与内存缓存
                  if (enableCache && arrayBuffer.byteLength > 0) {
                    void writeCachedTile(
                      providerId,
                      z,
                      x,
                      y,
                      ext,
                      Buffer.from(arrayBuffer),
                      langKey,
                      cfg.maxTileCacheMb ?? 1024
                    )
                  }

                  return { arrayBuffer, contentType }
                }
              } catch (fetchErr) {
                log.debug('tile fetch attempt failed, trying alternate subdomain', {
                  attempt,
                  subdomain: currentSub,
                  error: String(fetchErr)
                })
              }
            }
            return null
          })()

          inFlightTiles.set(reqKey, fetchPromise)
        }

        let fetchResult: { arrayBuffer: ArrayBuffer; contentType: string } | null = null
        try {
          fetchResult = await fetchPromise
        } finally {
          inFlightTiles.delete(reqKey)
        }

        if (!fetchResult) {
          return new Response(null, { status: 404 })
        }

        return new Response(fetchResult.arrayBuffer, {
          headers: {
            'Content-Type': fetchResult.contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=2592000'
          }
        })
      }

      // 分支 B: 本地 MBTiles: <mapId>/<z>/<x>/<y>
      if (parts.length === 4) {
        const [mapId, zs, xs, ys] = parts
        const z = Number(zs)
        const x = Number(xs)
        const y = Number(ys)
        if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0) {
          return new Response(null, { status: 400 })
        }
        const cfg = await loadYarjConfig()
        const map = cfg.maps.find((m) => m.id === mapId)
        if (!map || !map.enabled) return new Response(null, { status: 404 })
        const data = await fetchTile(map.path, z, x, y)
        if (!data) return new Response(null, { status: 404 })

        const ab = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ) as ArrayBuffer
        return new Response(ab, {
          headers: {
            'Content-Type': tileMime(map.path),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=86400'
          }
        })
      }

      return new Response(null, { status: 400 })
    } catch (err) {
      log.error('tile request failed', { url: request.url, error: String(err) })
      return new Response(null, { status: 500 })
    }
  })
  log.info('cockpit-tile protocol registered (online cache + mbtiles)')
}

/** 地图移除/配置变更时释放对应 mbtiles 连接缓存。 */
export function dropMbtilesCache(path: string): void {
  closeMbtiles(path)
}
