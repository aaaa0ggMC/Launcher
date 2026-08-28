/**
 * MBTiles 读取器 — node:sqlite（readOnly）直读，支持两种布局：
 *  1. `tiles` 表（标准布局）
 *  2. `map` + `images` 表（去重布局，join）
 * 坐标 TMS（tile_row 自南向北）→ 对外统一 XYZ，内部翻转 row = 2^z - 1 - y。
 * 瓦片数据可能 gzip 压缩（头 1f 8b）→ 异步解压后返回。
 * 连接按路径缓存（单例），瓦片 LRU 缓存防重复请求。
 */
import { DatabaseSync } from 'node:sqlite'
import { gunzip } from 'zlib'
import { promisify } from 'util'
import { makeLogger } from '../../main/process/logger'

// 注意：本环境（系统 Node 26.5 与 Electron 内嵌 Node 22.22）均无 `zlib/promises`
// 子路径，统一用 util.promisify 包装回调版 gunzip。
const gunzipAsync = promisify(gunzip)

const log = makeLogger('yarj-mbtiles')

export interface MbtilesMeta {
  minzoom: number
  maxzoom: number
  format: string
  bounds: [number, number, number, number]
  center: [number, number]
  tileCount: number
  /** 矢量瓦片的 source-layer id 列表。 */
  vectorLayers: string[]
  compression: string | null
}

const MIME_BY_FORMAT: Record<string, string> = {
  pbf: 'application/x-protobuf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

const LRU_MAX_TILES = 256
const LRU_MAX_BYTES = 64 * 1024 * 1024

interface TileEntry {
  data: Buffer
  size: number
}

class MbtilesSource {
  readonly path: string
  private db: DatabaseSync
  private hasTiles = false
  private hasMapImages = false
  private meta: MbtilesMeta | null = null
  private tileStmt: ReturnType<DatabaseSync['prepare']> | null = null
  private joinStmt: ReturnType<DatabaseSync['prepare']> | null = null
  private lru = new Map<string, TileEntry>()
  private lruBytes = 0

  constructor(path: string) {
    this.path = path
    this.db = new DatabaseSync(path, { readOnly: true })
  }

  /** 探测表结构 + 读取元数据（无效文件返回 null）。 */
  metaInfo(): MbtilesMeta | null {
    if (this.meta) return this.meta
    try {
      const tables = (
        this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
          name: string
        }[]
      ).map((t) => t.name)
      this.hasTiles = tables.includes('tiles')
      this.hasMapImages = tables.includes('map') && tables.includes('images')
      if (!this.hasTiles && !this.hasMapImages) return null

      this.tileStmt = this.hasTiles
        ? this.db.prepare(
            'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
          )
        : null
      this.joinStmt = this.hasMapImages
        ? this.db.prepare(
            'SELECT i.tile_data FROM map m JOIN images i ON m.tile_id = i.tile_id WHERE m.zoom_level = ? AND m.tile_column = ? AND m.tile_row = ?'
          )
        : null

      const metaRows = this.db.prepare('SELECT name, value FROM metadata').all() as unknown as {
        name: string
        value: string
      }[]
      const kv = new Map(metaRows.map((r) => [r.name, r.value]))

      const parseNum = (v: string | undefined, dflt: number): number => {
        const n = Number(v)
        return Number.isFinite(n) ? n : dflt
      }
      const parseBounds = (): [number, number, number, number] => {
        const parts = (kv.get('bounds') ?? '').split(',').map(Number)
        if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
          return [parts[0], parts[1], parts[2], parts[3]]
        }
        return [-180, -85.05, 180, 85.05]
      }
      const parseCenter = (): [number, number] => {
        const parts = (kv.get('center') ?? '').split(',').map(Number)
        if (parts.length >= 2 && parts.every((p) => Number.isFinite(p))) {
          return [parts[0], parts[1]]
        }
        return [0, 0]
      }
      const parseVectorLayers = (): string[] => {
        try {
          const json = kv.get('json')
          if (!json) return []
          const parsed = JSON.parse(json) as { vector_layers?: { id?: string }[] }
          return (parsed.vector_layers ?? []).map((l) => l.id ?? '').filter(Boolean)
        } catch {
          return []
        }
      }

      const countSql = this.hasTiles ? 'SELECT COUNT(*) c FROM tiles' : 'SELECT COUNT(*) c FROM map'
      const tileCount = Number(this.db.prepare(countSql).get()?.c ?? 0)

      this.meta = {
        minzoom: parseNum(kv.get('minzoom'), 0),
        maxzoom: parseNum(kv.get('maxzoom'), 14),
        format: kv.get('format') ?? 'pbf',
        bounds: parseBounds(),
        center: parseCenter(),
        tileCount,
        vectorLayers: parseVectorLayers(),
        compression: kv.get('compression') ?? null
      }
      return this.meta
    } catch (err) {
      log.warn('mbtiles meta read failed', { path: this.path, error: String(err) })
      return null
    }
  }

  /** 取一张瓦片（XYZ 坐标），未命中返回 null。已处理 TMS flip 与 gzip。 */
  async getTile(z: number, x: number, y: number): Promise<Buffer | null> {
    if (!this.metaInfo()) return null
    const row = 2 ** z - 1 - y
    const key = `${z}/${x}/${y}`
    const hit = this.lru.get(key)
    if (hit) {
      // 刷新 LRU 顺序
      this.lru.delete(key)
      this.lru.set(key, hit)
      return hit.data
    }
    const stmt = this.tileStmt ?? this.joinStmt
    if (!stmt) return null
    const found = stmt.get(z, x, row) as { tile_data: Uint8Array } | undefined
    if (!found) return null
    let data = Buffer.from(found.tile_data)
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      try {
        data = await gunzipAsync(data)
      } catch (err) {
        log.warn('tile gunzip failed', { path: this.path, z, x, y, error: String(err) })
        return null
      }
    }
    this.lruSet(key, data)
    return data
  }

  mime(): string {
    const f = this.metaInfo()?.format.toLowerCase() ?? 'pbf'
    return MIME_BY_FORMAT[f] ?? 'application/octet-stream'
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* noop */
    }
    this.lru.clear()
    this.lruBytes = 0
  }

  private lruSet(key: string, data: Buffer): void {
    this.lru.delete(key)
    this.lru.set(key, { data, size: data.length })
    this.lruBytes += data.length
    while (this.lru.size > LRU_MAX_TILES || this.lruBytes > LRU_MAX_BYTES) {
      const oldest = this.lru.keys().next().value as string | undefined
      if (!oldest) break
      const entry = this.lru.get(oldest)
      this.lruBytes -= entry?.size ?? 0
      this.lru.delete(oldest)
    }
  }
}

const sources = new Map<string, MbtilesSource>()

/** 取（或惰性打开）一个路径的 MBTiles 源。 */
export function getMbtilesSource(path: string): MbtilesSource {
  let src = sources.get(path)
  if (!src) {
    src = new MbtilesSource(path)
    sources.set(path, src)
  }
  return src
}

/** 读取 MBTiles 元数据（无效文件返回 null，打开失败抛错由调用方 catch）。 */
export function readMbtilesMeta(path: string): MbtilesMeta | null {
  return getMbtilesSource(path).metaInfo()
}

/** 取瓦片（XYZ），未命中返回 null。 */
export async function fetchTile(
  path: string,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  return getMbtilesSource(path).getTile(z, x, y)
}

/** 瓦片响应 Content-Type。 */
export function tileMime(path: string): string {
  return getMbtilesSource(path).mime()
}

/** 关闭并移除一个路径的缓存（配置变更时调用）。 */
export function closeMbtiles(path: string): void {
  const src = sources.get(path)
  if (src) {
    src.close()
    sources.delete(path)
  }
  log.debug('mbtiles source closed', { path })
}
