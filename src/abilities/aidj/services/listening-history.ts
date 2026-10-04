/**
 * 用户真实的听歌记录（`songs_timeline.csv`）的读取与统计——给 AI 循环的 recent_listens /
 * listening_habits 工具用。写入在 `song-timeline.ts`，这里只读。
 *
 * 与「会话记忆」（DJSession.playedSongs，状态栏的 Memory，用来避免重复）不是一回事：
 * 那个只覆盖当前 DJ 会话，这个是跨会话、跨天的真实播放记录。
 *
 * 纯函数（parse / 统计 / 文案）不碰文件系统，便于测试；`loadRecentListens` 只读文件尾部。
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { USER_CONFIG_DIR } from '../../../main/process/paths'

/**
 * 与 `song-timeline.ts` 的 SONG_TIMELINE_CSV 是同一个文件。故意不从那里 import：它会引入 service.ts，
 * 而 service 链路可能反向引到 loop 代码（循环依赖）；这里只是个路径常量。
 */
export const SONG_TIMELINE_FILE = join(USER_CONFIG_DIR, 'aidj', 'songs_timeline.csv')

export interface ListenEvent {
  name: string
  /** Unix 秒 */
  ts: number
}

/**
 * 解析 songs_timeline.csv 的内容（按时间升序保留原顺序）。
 * 兼容两种写法：`"歌名", 1788346371 , 20260902185251`（当前，带引号 + 空格）和
 * `歌名,1788346371,20260902185251`（旧）。歌名可能含逗号 / 引号，所以从右往左切最后两个逗号。
 */
export function parseTimelineCsv(text: string): ListenEvent[] {
  const out: ListenEvent[] = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const c2 = line.lastIndexOf(',')
    if (c2 <= 0) continue
    const c1 = line.lastIndexOf(',', c2 - 1)
    if (c1 <= 0) continue
    const ts = Number(line.slice(c1 + 1, c2).trim())
    if (!Number.isFinite(ts) || ts <= 0) continue // 表头 / 坏行
    let name = line.slice(0, c1).trim()
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/""/g, '"')
    }
    if (name) out.push({ name, ts })
  }
  return out
}

/** 只读文件尾部（默认 512KB ≈ 上万次播放），返回按时间升序的事件；文件不存在 = 空。 */
export async function loadRecentListens(
  file: string = SONG_TIMELINE_FILE,
  tailBytes = 512 * 1024
): Promise<ListenEvent[]> {
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return []
  }
  if (size === 0) return []
  const start = Math.max(0, size - tailBytes)
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    // 从中间读起时第一行可能是半截，丢掉
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return parseTimelineCsv(text)
  } finally {
    await fh.close()
  }
}

/** 连续重复（同一首歌 5 分钟内再次出现，如播放器反复上报 / 单曲循环）只算一次。 */
export function collapseRepeats(events: ListenEvent[], windowSec = 300): ListenEvent[] {
  const out: ListenEvent[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.name === e.name && e.ts - last.ts < windowSec) continue
    out.push(e)
  }
  return out
}

/** `3h 12m ago` / `2 days ago` / `just now` —— 给 LLM 看，英文即可。 */
export function describeAgo(ts: number, nowSec: number): string {
  const d = Math.max(0, nowSec - ts)
  if (d < 90) return 'just now'
  const m = Math.floor(d / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m ago` : `${h}h ago`
  const days = Math.floor(h / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 `YYYY-MM-DD HH:mm` */
export function formatLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 一天里的时段（本地时间），给 LLM 一个比钟点更好用的语义标签。 */
export function partOfDay(hour: number): string {
  if (hour < 5) return 'late night'
  if (hour < 9) return 'early morning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

export function timeInfo(d: Date): Record<string, unknown> {
  const day = d.getDay()
  return {
    local: formatLocal(d),
    weekday: WEEKDAYS[day],
    is_weekend: day === 0 || day === 6,
    hour: d.getHours(),
    part_of_day: partOfDay(d.getHours()),
    month: d.getMonth() + 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    // 本地相对 UTC 的偏移（分钟，东区为正）
    utc_offset_minutes: -d.getTimezoneOffset()
  }
}

export interface Habits {
  days: number
  plays: number
  active_days: number
  avg_plays_per_active_day: number
  /** 0–23 点各自的播放次数 */
  by_hour: number[]
  /** 播放最多的 3 个钟点 */
  peak_hours: number[]
  /** 周日到周六 */
  by_weekday: number[]
}

/** 最近 `days` 天的听歌节律（按本地时间的钟点 / 星期分布）。 */
export function habitsFromEvents(events: ListenEvent[], nowSec: number, days: number): Habits {
  const since = nowSec - days * 86400
  const byHour = new Array<number>(24).fill(0)
  const byWeekday = new Array<number>(7).fill(0)
  const dayKeys = new Set<string>()
  let plays = 0
  for (const e of events) {
    if (e.ts < since || e.ts > nowSec) continue
    const d = new Date(e.ts * 1000)
    byHour[d.getHours()]++
    byWeekday[d.getDay()]++
    dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
    plays++
  }
  const peak = byHour
    .map((n, h) => ({ n, h }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.h - b.h)
    .slice(0, 3)
    .map((x) => x.h)
  return {
    days,
    plays,
    active_days: dayKeys.size,
    avg_plays_per_active_day: dayKeys.size ? Math.round((plays / dayKeys.size) * 10) / 10 : 0,
    by_hour: byHour,
    peak_hours: peak,
    by_weekday: byWeekday
  }
}

/** 取出「当前钟点 ±radius 小时」（环形，0 点和 23 点相邻）内的事件，供统计这个时段常听什么。 */
export function eventsAroundHour(
  events: ListenEvent[],
  nowSec: number,
  days: number,
  hour: number,
  radius = 1
): ListenEvent[] {
  const since = nowSec - days * 86400
  return events.filter((e) => {
    if (e.ts < since || e.ts > nowSec) return false
    const h = new Date(e.ts * 1000).getHours()
    const diff = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour))
    return diff <= radius
  })
}
