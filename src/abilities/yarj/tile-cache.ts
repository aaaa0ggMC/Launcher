/**
 * 瓦片本地磁盘缓存管理器 — 缓存已加载的地图切片，避免重复网络请求与 API 扣费。
 * 存储路径：~/.config/LinuxCockpit/yarj/tile_cache/<providerId>/<lang>/<z>/<x>/<y>.<ext>
 * 支持用户自定义配额上限（默认 1024MB = 1GB）与后台 LRU 自动淘汰机制。
 */
import { mkdir, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import type { TileCacheStats } from './types'

const log = makeLogger('yarj-cache')

const memCache = new Map<string, Buffer>()
const MAX_MEM_TILES = 1200

let lastPruneTime = 0
let pruneInProgress = false

export function tileCacheBaseDir(): string {
  return join(USER_CONFIG_DIR, 'yarj', 'tile_cache')
}

export function tilePath(
  providerId: string,
  z: number,
  x: number,
  y: number,
  ext: string = 'png',
  lang?: string
): string {
  const langSub = lang ? lang : 'default'
  return join(tileCacheBaseDir(), providerId, langSub, String(z), String(x), `${y}.${ext}`)
}

/** 读取本地缓存瓦片（优先从内存 LRU 读，未命中读磁盘，命中返回 Buffer）。 */
export async function readCachedTile(
  providerId: string,
  z: number,
  x: number,
  y: number,
  ext: string = 'png',
  lang?: string
): Promise<Buffer | null> {
  const key = `${providerId}:${lang || 'default'}:${z}:${x}:${y}:${ext}`
  const mem = memCache.get(key)
  if (mem) {
    // 刷新 LRU 热度
    memCache.delete(key)
    memCache.set(key, mem)
    return mem
  }

  const p = tilePath(providerId, z, x, y, ext, lang)
  try {
    const buf = await readFile(p)
    if (memCache.size >= MAX_MEM_TILES) {
      const firstKey = memCache.keys().next().value
      if (firstKey) memCache.delete(firstKey)
    }
    memCache.set(key, buf)

    // 异步更新访问时间以供 LRU 淘汰参考
    const now = new Date()
    utimes(p, now, now).catch(() => undefined)
    return buf
  } catch {
    return null
  }
}

/** 写入本地缓存瓦片（同步存入内存 LRU，异步写入磁盘）。 */
export async function writeCachedTile(
  providerId: string,
  z: number,
  x: number,
  y: number,
  ext: string = 'png',
  data: Buffer | Uint8Array,
  lang?: string,
  maxCacheMb?: number
): Promise<void> {
  const key = `${providerId}:${lang || 'default'}:${z}:${x}:${y}:${ext}`
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)

  if (memCache.size >= MAX_MEM_TILES) {
    const firstKey = memCache.keys().next().value
    if (firstKey) memCache.delete(firstKey)
  }
  memCache.set(key, buf)

  const p = tilePath(providerId, z, x, y, ext, lang)
  try {
    const langSub = lang ? lang : 'default'
    const dir = join(tileCacheBaseDir(), providerId, langSub, String(z), String(x))
    await mkdir(dir, { recursive: true })
    await writeFile(p, buf)

    // 定期（每 60 秒或写入积累时）异步检查并执行 LRU 淘汰
    const now = Date.now()
    if (maxCacheMb && maxCacheMb > 0 && now - lastPruneTime > 60_000) {
      lastPruneTime = now
      void pruneTileCacheLRU(maxCacheMb * 1024 * 1024)
    }
  } catch (err) {
    log.warn('writeCachedTile failed', { path: p, error: String(err) })
  }
}

interface FileEntry {
  path: string
  size: number
  mtime: number
}

async function collectFiles(dir: string, list: FileEntry[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        await collectFiles(full, list)
      } else if (ent.isFile()) {
        try {
          const st = await stat(full)
          list.push({ path: full, size: st.size, mtime: st.mtimeMs })
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir not exist */
  }
}

async function cleanEmptyDirs(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const full = join(dir, ent.name)
        await cleanEmptyDirs(full)
        try {
          await rmdir(full)
        } catch {
          /* not empty */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/** 执行磁盘 LRU 淘汰，裁剪到不超过 maxBytes 的 85% */
export async function pruneTileCacheLRU(
  maxBytes: number
): Promise<{ prunedBytes: number; prunedCount: number }> {
  if (maxBytes <= 0 || pruneInProgress) return { prunedBytes: 0, prunedCount: 0 }
  pruneInProgress = true

  try {
    const base = tileCacheBaseDir()
    const files: FileEntry[] = []
    await collectFiles(base, files)

    let totalBytes = files.reduce((s, f) => s + f.size, 0)
    if (totalBytes <= maxBytes) {
      return { prunedBytes: 0, prunedCount: 0 }
    }

    const targetBytes = Math.floor(maxBytes * 0.85)
    // 按修改/访问时间升序排列（最旧的在前面）
    files.sort((a, b) => a.mtime - b.mtime)

    let prunedBytes = 0
    let prunedCount = 0

    for (const f of files) {
      if (totalBytes <= targetBytes) break
      try {
        await rm(f.path, { force: true })
        totalBytes -= f.size
        prunedBytes += f.size
        prunedCount++
      } catch {
        /* ignore */
      }
    }

    // 清理空目录
    await cleanEmptyDirs(base)
    log.info('tile cache pruned via LRU', {
      prunedBytes,
      prunedCount,
      remainingBytes: totalBytes,
      quota: maxBytes
    })
    return { prunedBytes, prunedCount }
  } finally {
    pruneInProgress = false
  }
}

/** 递归统计目录大小与文件数。 */
async function walkDir(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        const sub = await walkDir(full)
        bytes += sub.bytes
        count += sub.count
      } else if (ent.isFile()) {
        try {
          const st = await stat(full)
          bytes += st.size
          count += 1
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir might not exist yet */
  }
  return { bytes, count }
}

/** 获取瓦片缓存统计。 */
export async function getTileCacheStats(maxMb?: number): Promise<TileCacheStats> {
  const base = tileCacheBaseDir()
  const result: TileCacheStats = {
    totalBytes: 0,
    tileCount: 0,
    maxMb: maxMb ?? 1024,
    maxBytes: (maxMb ?? 1024) > 0 ? (maxMb ?? 1024) * 1024 * 1024 : undefined,
    byProvider: {}
  }
  try {
    const entries = await readdir(base, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const pDir = join(base, ent.name)
        const sub = await walkDir(pDir)
        result.byProvider[ent.name] = sub
        result.totalBytes += sub.bytes
        result.tileCount += sub.count
      }
    }
  } catch {
    /* base not exist */
  }
  return result
}

/** 清空瓦片缓存（可选仅清空指定 provider）。 */
export async function clearTileCache(providerId?: string): Promise<void> {
  if (providerId) {
    for (const k of memCache.keys()) {
      if (k.startsWith(`${providerId}:`)) memCache.delete(k)
    }
  } else {
    memCache.clear()
  }
  const target = providerId ? join(tileCacheBaseDir(), providerId) : tileCacheBaseDir()
  try {
    await rm(target, { recursive: true, force: true })
    log.info('cleared tile cache', { target })
  } catch (err) {
    log.warn('clearTileCache failed', { target, error: String(err) })
  }
}
