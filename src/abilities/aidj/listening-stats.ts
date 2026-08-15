import { appendFile, mkdir, open, readFile, writeFile } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { registerStartupHook } from '../../main/process/startup'
import { DBusBackend, getPlayerMode, getWebPlayerBackend } from './player-backend'
import { getDbusManager, initDbusManager, loadAidjConfig } from './service'

const log = makeLogger('aidj-time-stats')

/**
 * 听歌时长统计 —— 每小时一行的 CSV 时间账本。
 *
 * 语义（与产品讨论一致）：
 *  - "在听" = 当前播放后端报告 Playing：dbus 模式 = MPRIS 检测到播放，
 *    web 模式 = aidj-player 内置播放器在播（两种模式互斥，天然去重）。
 *  - 每 30s 采样一次，播放中 +0.5 分钟；"半分钟以上算一分钟"由落盘时
 *    四舍五入保证（一小时最多 120 次采样 → [0,60]）。
 *  - 一小时写一次盘（小时翻转时落盘上一小时桶），程序退出时再写一次。
 *  - 文件 `~/.config/LinuxCockpit/aidj/time.csv`，格式 `timestamp,duration`，
 *    timestamp = 该小时起点（epoch ms，线性递增 → 直接 append）。
 *
 * 回拨保险：写盘时若 `now + 10min < 最后一条 timestamp`，说明系统时钟
 * 被大幅往回拨（手动改时间/跨时区），该小时桶丢弃（不写行），时钟追上来
 * 后自动恢复——文件始终保持单调，解析端零修复。
 *
 * 崩溃窗口：最多丢当前未满一小时的部分（进程被杀不触发 exit 钩子）。
 */

export interface TimeStatRow {
  /** 小时起点 (epoch ms) */
  timestamp: number
  /** 该小时听歌分钟数 [0,60] */
  duration: number
}

const TIME_CSV = join(USER_CONFIG_DIR, 'aidj', 'time.csv')

/** 采样间隔：30s → 一小时 120 次 × 0.5 = 60 分钟满桶 */
const TICK_MS = 30_000
const HOUR_MS = 3_600_000
/** 回拨保险：当前时间落后最后一条记录超过该值 → 时钟不可信，丢弃桶 */
const ROLLBACK_SAFETY_MS = 10 * 60_000

/** 当前小时桶（内存累计，落盘后清零） */
let bucketStart = 0 // 小时起点 (epoch ms)
let bucketMinutes = 0 // 累计收听分钟（浮点，落盘时四舍五入）
/** 当前小时已有一行（上次退出时落盘的部分小时）→ 落盘时替换最后一行而非追加 */
let replaceLast = false
/** 磁盘最后一条 timestamp（写时回拨判定的基线） */
let lastTs = 0
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

function hourStartOf(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS
}

function clampMinutes(m: number): number {
  return Math.max(0, Math.min(60, Math.round(m)))
}

/** 读取 CSV 最后一行（容忍残行/空文件）。 */
async function readLastRow(): Promise<{ ts: number; dur: number } | null> {
  try {
    const raw = await readFile(TIME_CSV, 'utf-8')
    for (const line of raw.split('\n').reverse()) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [tsRaw, durRaw] = trimmed.split(',')
      const ts = Number(tsRaw)
      const dur = Number(durRaw)
      if (Number.isFinite(ts) && Number.isFinite(dur)) return { ts, dur }
    }
  } catch {
    /* 文件不存在 */
  }
  return null
}

/** 回拨判定：当前时间（含安全余量）仍早于最后一条记录 → 时钟不可信。 */
function clockRolledBack(now: number): boolean {
  return lastTs > 0 && now + ROLLBACK_SAFETY_MS < lastTs
}

/** 把当前小时桶写进 CSV。`replaceLast` 时改写最后一行（重启续写同一小时）。 */
async function flushBucket(): Promise<void> {
  if (bucketMinutes <= 0 && !replaceLast) return
  if (clockRolledBack(Date.now())) {
    log.warn('clock rollback: dropping listening bucket', {
      lastTs,
      bucketStart,
      minutes: bucketMinutes
    })
    bucketMinutes = 0
    return
  }
  const dur = clampMinutes(bucketMinutes)
  const line = `${bucketStart},${dur}\n`
  await mkdir(dirname(TIME_CSV), { recursive: true })
  if (replaceLast && lastTs === bucketStart) {
    try {
      const raw = await readFile(TIME_CSV, 'utf-8')
      const lines = raw.replace(/\n+$/, '').split('\n')
      const idx = lines.length - 1
      if (Number(lines[idx]?.split(',')[0]) === bucketStart) {
        lines[idx] = `${bucketStart},${dur}`
        await writeFile(TIME_CSV, lines.join('\n') + '\n', 'utf-8')
      } else {
        await appendFile(TIME_CSV, line, 'utf-8')
      }
    } catch {
      await appendFile(TIME_CSV, line, 'utf-8')
    }
  } else {
    await appendFile(TIME_CSV, line, 'utf-8')
  }
  lastTs = bucketStart
  replaceLast = false
  bucketMinutes = 0
  log.info('time.csv flushed', { ts: bucketStart, dur })
}

/** 同步版落盘（process.on('exit') 只能跑同步代码）。 */
function flushBucketSync(): void {
  if (bucketMinutes <= 0 && !replaceLast) return
  if (clockRolledBack(Date.now())) return
  const dur = clampMinutes(bucketMinutes)
  try {
    mkdirSync(dirname(TIME_CSV), { recursive: true })
    if (replaceLast && lastTs === bucketStart) {
      let raw = ''
      try {
        raw = readFileSync(TIME_CSV, 'utf-8')
      } catch {
        /* 文件不存在 → 直接写 */
      }
      const lines = raw.replace(/\n+$/, '').split('\n')
      const idx = lines.length - 1
      if (Number(lines[idx]?.split(',')[0]) === bucketStart) {
        lines[idx] = `${bucketStart},${dur}`
        writeFileSync(TIME_CSV, lines.join('\n') + '\n', 'utf-8')
      } else {
        appendFileSync(TIME_CSV, `${bucketStart},${dur}\n`, 'utf-8')
      }
    } else {
      appendFileSync(TIME_CSV, `${bucketStart},${dur}\n`, 'utf-8')
    }
    lastTs = bucketStart
    replaceLast = false
    bucketMinutes = 0
  } catch (e) {
    log.warn('exit flush failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** "在听"判定：当前模式的活动后端报告 Playing。无副作用（不触发懒连接）。
 *  dbus 模式（仅 Linux）下若共享 DBusManager 尚未初始化（用户从未打开
 *  AIDJ 页面），在此懒初始化一次——保证"外部 MPRIS 播放器在播"在
 *  不进入 AIDJ 界面时也能被后台计时；只在从未绑定过时创建，不干扰
 *  正在使用中的连接。 */
async function isPlaying(): Promise<boolean> {
  try {
    const mode = await getPlayerMode()
    if (mode === 'web') {
      const st = await getWebPlayerBackend().getStatus()
      return st.status === 'Playing'
    }
    let mgr = getDbusManager()
    if (!mgr) {
      const cfg = await loadAidjConfig()
      if (!cfg) return false
      try {
        mgr = await initDbusManager(cfg)
        log.info('listening stats: lazy-initialized shared DBus manager')
      } catch {
        return false
      }
    }
    const st = await new DBusBackend(mgr).getStatus()
    return st.status === 'Playing'
  } catch {
    return false
  }
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    const hourStart = hourStartOf(now)
    // 小时翻转：先落盘上一小时桶，再开新桶
    if (hourStart !== bucketStart) {
      await flushBucket()
      bucketStart = hourStart
      bucketMinutes = 0
      replaceLast = false
    }
    // 总开关（设置/状态栏可关）：关闭时只维持小时翻转，不累计
    const cfg = await loadAidjConfig()
    if (cfg?.preferences.listening_stats === false) return
    if (await isPlaying()) bucketMinutes += 0.5
  } catch (e) {
    log.warn('listening tick failed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    ticking = false
  }
}

registerStartupHook(async () => {
  const last = await readLastRow()
  lastTs = last?.ts ?? 0
  const now = Date.now()
  bucketStart = hourStartOf(now)
  // 同一小时已有一行（上次退出时落盘的部分小时）→ 续写累计，落盘时替换
  if (last && last.ts === bucketStart) {
    bucketMinutes = clampMinutes(last.dur)
    replaceLast = true
  }
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  log.info('listening stats started', {
    lastTs,
    bucketStart,
    replaceLast,
    seededMinutes: bucketMinutes
  })
})

// 程序结束时把当前小时桶落盘（同步写，退出路径唯一可靠钩子）。
process.on('exit', () => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  flushBucketSync()
})

// ---------------------------------------------------------------------------
// 读取端 —— range(t0, t1) API，非全量提取：
//   - 内部固定容量 LRU 区间缓存（重复查询零 IO）；
//   - 未命中 → 字节级二分定位 t0/t1 所在行（timestamp 单调递增），
//     只读目标区间那一小段字节，复杂度 O(log n) 次 4KB 探测 + O(区间)。
// ---------------------------------------------------------------------------

const BLOCK_BYTES = 4096
/** 区间缓存上限（LRU）。 */
const RANGE_CACHE_MAX = 24
/** 超过该行数的查询结果不入缓存（避免全量查询污染缓存）。 */
const CACHE_MAX_ROWS = 512

interface CachedRange {
  start: number
  end: number
  rows: TimeStatRow[]
}

/** LRU，最近使用在前。 */
const rangeCache: CachedRange[] = []

function touchCache(entry: CachedRange): void {
  const i = rangeCache.indexOf(entry)
  if (i > 0) {
    rangeCache.splice(i, 1)
    rangeCache.unshift(entry)
  }
}

function pushCache(entry: CachedRange): void {
  rangeCache.unshift(entry)
  while (rangeCache.length > RANGE_CACHE_MAX) rangeCache.pop()
}

/** 从句柄指定偏移读一行（防御：行跨块尾时用），解析出 timestamp。 */
async function readTsAt(handle: FileHandle, offset: number): Promise<number> {
  const buf = Buffer.alloc(128)
  const { bytesRead } = await handle.read(buf, 0, 128, offset)
  if (!bytesRead) return NaN
  const s = buf.subarray(0, bytesRead).toString('utf-8')
  const nl = s.indexOf('\n')
  const ts = Number((nl >= 0 ? s.slice(0, nl) : s).split(',')[0])
  return Number.isFinite(ts) ? ts : NaN
}

/**
 * 二分：找到文件中第一个 `timestamp >= target` 的行。
 * 返回 `{ offset, ts }`（行首偏移 + 该行 timestamp），不存在则 null。
 * 行很短（< 64B）远小于 4KB 块，块内必有完整行，二分按行首偏移收敛。
 */
async function findFirstGe(
  handle: FileHandle,
  size: number,
  target: number
): Promise<{ offset: number; ts: number } | null> {
  let lo = 0
  let hi = size
  const buf = Buffer.alloc(BLOCK_BYTES)
  while (hi - lo > BLOCK_BYTES) {
    const mid = (lo + hi) >> 1
    const { bytesRead } = await handle.read(buf, 0, BLOCK_BYTES, mid)
    if (!bytesRead) break
    const chunk = buf.subarray(0, bytesRead).toString('utf-8')
    const nl = chunk.indexOf('\n')
    if (nl < 0) {
      // 块内无换行（异常/尾部残行）——跳过该块继续向右
      lo = mid + bytesRead
      continue
    }
    const lineStart = mid + nl + 1
    const lineEnd = chunk.indexOf('\n', nl + 1)
    let ts: number
    if (lineEnd >= 0) {
      ts = Number(chunk.slice(nl + 1, lineEnd).split(',')[0])
    } else {
      ts = await readTsAt(handle, lineStart)
    }
    if (!Number.isFinite(ts) || ts < target) lo = lineStart
    else hi = lineStart
  }
  // 顺序扫描 [lo, hi)（≤ 一块）：逐行找第一个 ts >= target
  const scanLen = Math.min(BLOCK_BYTES, size - lo)
  if (scanLen <= 0) return null
  const { bytesRead } = await handle.read(buf, 0, scanLen, lo)
  const chunk = buf.subarray(0, bytesRead).toString('utf-8')
  let scanPos = 0
  let lineStart = lo // 当前行在文件中的绝对偏移，逐行推进
  while (scanPos < chunk.length) {
    const nl = chunk.indexOf('\n', scanPos)
    let line: string
    if (nl < 0) {
      line = chunk.slice(scanPos)
      scanPos = chunk.length
    } else {
      line = chunk.slice(scanPos, nl)
      scanPos = nl + 1
    }
    const trimmed = line.trim()
    if (trimmed) {
      const ts = Number(trimmed.split(',')[0])
      if (Number.isFinite(ts) && ts >= target) {
        return { offset: lineStart, ts }
      }
    }
    lineStart += line.length + 1
  }
  return null
}

/** 读取 [startOffset, endOffset) 字节并解析为行（容忍残行）。
 *  循环读到满——单次 fs.read 可能短读（POSIX 不保证一次读满），
 *  大区间（全量查询）必须循环补齐，否则会静默丢数据。 */
async function loadRange(
  handle: FileHandle,
  startOffset: number,
  endOffset: number
): Promise<TimeStatRow[]> {
  const len = endOffset - startOffset
  if (len <= 0) return []
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(Math.min(len, BLOCK_BYTES * 16))
  let pos = startOffset
  let remaining = len
  while (remaining > 0) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, remaining), pos)
    if (bytesRead <= 0) break // EOF/IO 异常——以实际读到的为准
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)))
    pos += bytesRead
    remaining -= bytesRead
  }
  const rows: TimeStatRow[] = []
  for (const line of Buffer.concat(chunks).toString('utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [tsRaw, durRaw] = trimmed.split(',')
    const ts = Number(tsRaw)
    const dur = Number(durRaw)
    if (Number.isFinite(ts) && Number.isFinite(dur)) {
      rows.push({ timestamp: ts, duration: clampMinutes(dur) })
    }
  }
  return rows
}

/** 把内存实时桶合并进查询结果（替换同小时旧行 / 补插新行）。 */
function mergeLiveBucket(rows: TimeStatRow[], startMs: number, endMs: number): TimeStatRow[] {
  if (bucketMinutes <= 0 || bucketStart < startMs || bucketStart > endMs) return rows
  const live: TimeStatRow = { timestamp: bucketStart, duration: clampMinutes(bucketMinutes) }
  const out = rows.slice()
  const idx = out.findIndex((r) => r.timestamp === bucketStart)
  if (idx >= 0) out[idx] = live
  else {
    out.push(live)
    out.sort((a, b) => a.timestamp - b.timestamp)
  }
  return out
}

/**
 * 区间查询：返回 timestamp ∈ [startMs, endMs] 的行。
 * 缓存完全覆盖 → 直接返回；否则二分定位 + 只读目标区间。
 */
export async function queryTimeRange(startMs: number, endMs: number): Promise<TimeStatRow[]> {
  if (startMs > endMs) return []
  const hit = rangeCache.find((c) => c.start <= startMs && c.end >= endMs)
  if (hit) {
    touchCache(hit)
    return mergeLiveBucket(
      hit.rows.filter((r) => r.timestamp >= startMs && r.timestamp <= endMs),
      startMs,
      endMs
    )
  }
  let rows: TimeStatRow[] = []
  try {
    const handle = await open(TIME_CSV, 'r')
    try {
      const { size } = await handle.stat()
      if (size > 0) {
        const s = await findFirstGe(handle, size, startMs)
        if (s) {
          // 上界用 endMs+1：第一个 ts > endMs 的行（ts 是整数毫秒）
          const e = await findFirstGe(handle, size, endMs + 1)
          rows = await loadRange(handle, s.offset, e ? e.offset : size)
        }
      }
    } finally {
      await handle.close()
    }
  } catch {
    /* 文件不存在 → 空 */
  }
  rows = mergeLiveBucket(rows, startMs, endMs)
  if (rows.length <= CACHE_MAX_ROWS) {
    pushCache({ start: startMs, end: endMs, rows })
  }
  return rows
}

/** 全量统计（range API 的薄包装，保持原有返回形状）。 */
export async function loadTimeStats(): Promise<{ rows: TimeStatRow[]; totalMinutes: number }> {
  const rows = await queryTimeRange(0, Number.MAX_SAFE_INTEGER)
  const totalMinutes = rows.reduce((sum, r) => sum + r.duration, 0)
  return { rows, totalMinutes }
}
