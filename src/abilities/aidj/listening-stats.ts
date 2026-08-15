import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { registerStartupHook } from '../../main/process/startup'
import { DBusBackend, getPlayerMode, getWebPlayerBackend } from './player-backend'
import { getDbusManager } from './service'

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

/** "在听"判定：当前模式的活动后端报告 Playing。无副作用（不触发懒连接）。 */
async function isPlaying(): Promise<boolean> {
  try {
    const mode = await getPlayerMode()
    if (mode === 'web') {
      const st = await getWebPlayerBackend().getStatus()
      return st.status === 'Playing'
    }
    const mgr = getDbusManager()
    if (!mgr) return false
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
// 读取端 —— 顺序聚合即可（写入侧已保证单调），容忍残行 / 最后一行不完整。
// ---------------------------------------------------------------------------

/** 解析 time.csv 全部行（含当前未落盘的实时桶，用于"今天听了多久"）。 */
export async function loadTimeStats(): Promise<{ rows: TimeStatRow[]; totalMinutes: number }> {
  const rows: TimeStatRow[] = []
  try {
    const raw = await readFile(TIME_CSV, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [tsRaw, durRaw] = trimmed.split(',')
      const ts = Number(tsRaw)
      const dur = Number(durRaw)
      if (!Number.isFinite(ts) || !Number.isFinite(dur)) continue // 残行/损坏行跳过
      rows.push({ timestamp: ts, duration: clampMinutes(dur) })
    }
  } catch {
    /* 文件不存在 → 空 */
  }
  // 合并内存中的实时桶。当前小时尚未落盘 → 补一行；尾行恰好是当前小时
  // （重启续写场景，磁盘上是旧的部分值）→ 用实时值替换。
  if (bucketMinutes > 0) {
    const last = rows[rows.length - 1]
    if (last && last.timestamp === bucketStart) {
      last.duration = clampMinutes(bucketMinutes)
    } else {
      rows.push({ timestamp: bucketStart, duration: clampMinutes(bucketMinutes) })
    }
  }
  const totalMinutes = rows.reduce((sum, r) => sum + r.duration, 0)
  return { rows, totalMinutes }
}
