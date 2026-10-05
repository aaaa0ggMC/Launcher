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
    const prevSize = usage
      ? await stat(p).then(
          (st) => st.size,
          () => -1
        )
      : -1
    await writeFile(p, buf)
    if (usage) {
      const u = providerUsage(providerId)
      u.bytes += buf.length - Math.max(0, prevSize)
      if (prevSize < 0) u.count += 1
    }

    // 定期（每 60 秒）检查配额；用量已在内存里记账，只有真超额才去遍历目录做 LRU 淘汰
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
  provider: string
}

type Usage = Map<string, { bytes: number; count: number }>

/**
 * 各图源的缓存用量（字节 / 文件数）。第一次需要时遍历一遍目录，之后随写入 / 淘汰 / 清空在内存里记账，
 * 统计和配额检查都不用再扫盘——缓存动辄几十万个小文件，逐个 stat 一遍要好几秒。
 */
let usage: Usage | null = null
let usageLoading: Promise<Usage> | null = null
/** 清空缓存时 +1，让清空前就开始的那次遍历结果作废。 */
let usageGen = 0

function providerUsage(providerId: string): { bytes: number; count: number } {
  let u = usage!.get(providerId)
  if (!u) {
    u = { bytes: 0, count: 0 }
    usage!.set(providerId, u)
  }
  return u
}

function usageFromFiles(files: FileEntry[]): Usage {
  const u: Usage = new Map()
  for (const f of files) {
    const e = u.get(f.provider) ?? { bytes: 0, count: 0 }
    e.bytes += f.size
    e.count += 1
    u.set(f.provider, e)
  }
  return u
}

function totalBytes(u: Usage): number {
  let n = 0
  for (const e of u.values()) n += e.bytes
  return n
}

/** 递归收集文件；同一目录内的条目并发 stat（顺序 await 时几十万个文件要好几秒）。 */
async function collectFiles(dir: string, provider: string, list: FileEntry[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return /* dir not exist */
  }
  await Promise.all(
    entries.map(async (ent) => {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        await collectFiles(full, provider, list)
      } else if (ent.isFile()) {
        try {
          const st = await stat(full)
          list.push({ path: full, size: st.size, mtime: st.mtimeMs, provider })
        } catch {
          /* ignore */
        }
      }
    })
  )
}

async function collectAllFiles(): Promise<FileEntry[]> {
  const base = tileCacheBaseDir()
  const files: FileEntry[] = []
  let providers: string[] = []
  try {
    providers = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    /* base not exist */
  }
  for (const p of providers) await collectFiles(join(base, p), p, files)
  return files
}

function ensureUsage(): Promise<Usage> {
  if (usage) return Promise.resolve(usage)
  if (!usageLoading) {
    const gen = usageGen
    usageLoading = collectAllFiles()
      .then((files) => {
        const u = usageFromFiles(files)
        if (gen === usageGen) usage = u
        return u
      })
      .finally(() => (usageLoading = null))
  }
  return usageLoading
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
    if (totalBytes(await ensureUsage()) <= maxBytes) {
      return { prunedBytes: 0, prunedCount: 0 }
    }

    const base = tileCacheBaseDir()
    const files = await collectAllFiles()
    let total = files.reduce((s, f) => s + f.size, 0)
    if (total <= maxBytes) {
      usage = usageFromFiles(files)
      return { prunedBytes: 0, prunedCount: 0 }
    }

    const targetBytes = Math.floor(maxBytes * 0.85)
    // 按修改/访问时间升序排列（最旧的在前面）
    files.sort((a, b) => a.mtime - b.mtime)

    let prunedBytes = 0
    let prunedCount = 0
    let scanned = 0

    for (const f of files) {
      if (total <= targetBytes) break
      try {
        await rm(f.path, { force: true })
        total -= f.size
        prunedBytes += f.size
        prunedCount++
      } catch {
        /* ignore */
      }
      scanned++
    }
    usage = usageFromFiles(files.slice(scanned))

    // 清理空目录
    await cleanEmptyDirs(base)
    log.info('tile cache pruned via LRU', {
      prunedBytes,
      prunedCount,
      remainingBytes: total,
      quota: maxBytes
    })
    return { prunedBytes, prunedCount }
  } finally {
    pruneInProgress = false
  }
}

/** 获取瓦片缓存统计（首次遍历目录，之后读内存记账）。 */
export async function getTileCacheStats(maxMb?: number): Promise<TileCacheStats> {
  const u = await ensureUsage()
  const result: TileCacheStats = {
    totalBytes: 0,
    tileCount: 0,
    maxMb: maxMb ?? 1024,
    maxBytes: (maxMb ?? 1024) > 0 ? (maxMb ?? 1024) * 1024 * 1024 : undefined,
    byProvider: {}
  }
  for (const [p, e] of u) {
    if (!e.count) continue
    result.byProvider[p] = { bytes: e.bytes, count: e.count }
    result.totalBytes += e.bytes
    result.tileCount += e.count
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
    if (usage) {
      if (providerId) usage.delete(providerId)
      else usage.clear()
    } else {
      usageGen++
    }
    log.info('cleared tile cache', { target })
  } catch (err) {
    log.warn('clearTileCache failed', { target, error: String(err) })
  }
}
