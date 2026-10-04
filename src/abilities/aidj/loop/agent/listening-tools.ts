/**
 * 「用户情境」类工具：当前时间、用户真实听过什么、听歌节律、每首歌的播放频次。
 *
 * 与 `session_memory`（本 DJ 会话已播 / 已入队的歌，用来避免重复）不同，这里的 recent_listens /
 * listening_habits / play_frequency 读的是**跨会话、跨天的真实记录**（songs_timeline.csv、frequency.csv）。
 *
 * 隐私：这些数据会发给用户配置的 LLM 服务商。数据本来就是用户自己的，且只在记录开关打开时才提供
 * （`preferences.song_timeline` / `record_freq` 关了，对应工具就不出现）；`preferences.loop.disabled_tools`
 * 可以逐个关闭。提示词要求模型只用来调整选歌，不要向用户复述。
 */
import type { AidjConfig } from '../../types'
import { loadFrequency } from '../../services/config'
import {
  collapseRepeats,
  describeAgo,
  eventsAroundHour,
  formatLocal,
  habitsFromEvents,
  loadRecentListens,
  timeInfo,
  type ListenEvent
} from '../../services/listening-history'
import { brief, clampInt } from './builtin-tools'
import { isIdRef } from './ids'
import { registerDjTool, type DjToolContext } from './tools'

/** 数据来源与时钟集中在这里，测试里整体替换（不碰真实用户目录，也不依赖当前时间）。 */
export const listeningSources = {
  freq: (): Promise<Map<string, number>> => loadFrequency(),
  events: (): Promise<ListenEvent[]> => loadRecentListens(),
  nowMs: (): number => Date.now(),
  random: (): number => Math.random()
}

/** 记录开关：用户没开记录，对应工具就不出现（没有数据可用，也不该去用） */
const timelineOn = (_p: unknown, c?: AidjConfig): boolean => c?.preferences?.song_timeline !== false
const freqOn = (_p: unknown, c?: AidjConfig): boolean => c?.preferences?.record_freq !== false

/** 库里有对应文件的曲目才有 ID / 标签。 */
function inLibrary(ctx: DjToolContext, name: string): boolean {
  return ctx.musicPaths.has(name) && ctx.metadata.has(name)
}

function resolveRef(ctx: DjToolContext, ref: string): string | null {
  return isIdRef(ref) ? ctx.ids.keyOf(ref) : ctx.resolveKey(ref)
}

function topTags(
  ctx: DjToolContext,
  events: ListenEvent[],
  field: 'emotion' | 'genre',
  top: number
): string[] {
  const counts = new Map<string, number>()
  for (const e of events) {
    const m = ctx.metadata.get(e.name)
    const raw = m?.[field]
    for (const tag of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const t = String(tag)
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([t, n]) => `${t}(${n})`)
}

registerDjTool({
  name: 'current_time',
  description:
    "The user's current local date / time, weekday and part of day (e.g. late night, early morning, " +
    'evening). Use it when the mood of the moment matters ("适合现在的", "深夜", "上班路上") or the user ' +
    'hints at a time, instead of guessing.',
  parameters: { type: 'object', properties: {} },
  run: () => timeInfo(new Date(listeningSources.nowMs()))
})

registerDjTool({
  name: 'recent_listens',
  description:
    'What the user REALLY listened to lately, newest first, with how long ago — across sessions and days ' +
    "(NOT this session's no-repeat memory: that is session_memory). Use it to continue a taste they " +
    'showed today, avoid what they just heard, or notice a change of mood. Tracks outside the library ' +
    "have no id. Use it silently to shape the picks; don't recite their history back unless asked.",
  parameters: {
    type: 'object',
    properties: {
      n: { type: 'integer', description: 'How many (default 20, max 100)' },
      since_hours: {
        type: 'number',
        description: 'Only plays within the last N hours (default: no limit; max 8760)'
      }
    }
  },
  enabled: timelineOn,
  run: async (args, ctx) => {
    const nowSec = Math.floor(listeningSources.nowMs() / 1000)
    const n = clampInt(args.n, 20, 1, 100)
    const hours = Number(args.since_hours)
    const since = Number.isFinite(hours) && hours > 0 ? nowSec - Math.min(hours, 8760) * 3600 : 0
    const all = collapseRepeats(await listeningSources.events())
    const picked = all
      .filter((e) => e.ts >= since)
      .slice(-n)
      .reverse()
    return {
      now: formatLocal(new Date(nowSec * 1000)),
      count: picked.length,
      tracks: picked.map((e) => {
        const when = {
          ago: describeAgo(e.ts, nowSec),
          at: formatLocal(new Date(e.ts * 1000))
        }
        return inLibrary(ctx, e.name)
          ? { ...brief(ctx, e.name), ...when }
          : { key: e.name, in_library: false, ...when }
      })
    }
  }
})

registerDjTool({
  name: 'listening_habits',
  description:
    "The user's listening rhythm over the last N days: plays per hour of day and weekday, peak hours, " +
    'and what they usually play around THIS hour of the day (top emotion / genre tags). Use it to fit ' +
    'the pick to the moment ("they usually want calm music at this hour"). Optional — skip when the ' +
    'request is already specific.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Look-back window in days (default 30, max 365)' }
    }
  },
  enabled: timelineOn,
  run: async (args, ctx) => {
    const nowMs = listeningSources.nowMs()
    const nowSec = Math.floor(nowMs / 1000)
    const days = clampInt(args.days, 30, 1, 365)
    const events = collapseRepeats(await listeningSources.events())
    const h = habitsFromEvents(events, nowSec, days)
    const hour = new Date(nowMs).getHours()
    const around = eventsAroundHour(events, nowSec, days, hour, 1)
    return {
      ...h,
      now: { hour, weekday: new Date(nowMs).getDay() },
      usually_around_now: {
        window: `${(hour + 23) % 24}:00–${(hour + 2) % 24}:00`,
        plays: around.length,
        emotion: topTags(ctx, around, 'emotion', 5),
        genre: topTags(ctx, around, 'genre', 5)
      },
      note: "by_hour is 0–23; by_weekday is Sunday..Saturday; all in the user's local time."
    }
  }
})

registerDjTool({
  name: 'play_frequency',
  description:
    'How often the user plays each library track (play counts). order=most: their all-time favourites; ' +
    'least: played but rarely; unplayed: tracks they have NEVER played (a random sample — for discovery). ' +
    'Or pass ids to look up the counts of specific tracks. Use favourites as seeds for dream_from_seeds, ' +
    'and unplayed ones to bring something new — but a direct request always comes first.',
  parameters: {
    type: 'object',
    properties: {
      order: { type: 'string', enum: ['most', 'least', 'unplayed'], description: 'Default most' },
      n: { type: 'integer', description: 'How many (default 15, max 100)' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Look up the play counts of these tracks (#ids from earlier results) instead'
      }
    }
  },
  enabled: freqOn,
  run: async (args, ctx) => {
    const freq = await listeningSources.freq()
    const n = clampInt(args.n, 15, 1, 100)
    const withPlays = [...freq.entries()].filter(([k, v]) => v > 0 && inLibrary(ctx, k))
    const totals = {
      tracks_with_plays: withPlays.length,
      total_plays: withPlays.reduce((s, [, v]) => s + v, 0)
    }

    const refs = Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : []
    if (refs.length) {
      const unresolved: string[] = []
      const tracks: Record<string, unknown>[] = []
      for (const ref of refs.slice(0, 100)) {
        const key = resolveRef(ctx, ref)
        if (!key) unresolved.push(ref)
        else tracks.push({ ...brief(ctx, key), plays: freq.get(key) ?? 0 })
      }
      return {
        count: tracks.length,
        ...totals,
        tracks,
        ...(unresolved.length ? { unresolved } : {})
      }
    }

    const order = args.order === 'least' || args.order === 'unplayed' ? args.order : 'most'
    if (order === 'unplayed') {
      const never = [...ctx.musicPaths.keys()].filter(
        (k) => ctx.metadata.has(k) && !(freq.get(k) ?? 0) && !ctx.played.has(k)
      )
      // 洗牌取样（Fisher–Yates）：每次给出不同的「没听过」，而不是永远同一批
      const pool = [...never]
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(listeningSources.random() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
      }
      return {
        order,
        count: Math.min(n, pool.length),
        total_unplayed: never.length,
        ...totals,
        tracks: pool.slice(0, n).map((k) => ({ ...brief(ctx, k), plays: 0 }))
      }
    }
    const sorted = [...withPlays].sort(
      (a, b) => (order === 'most' ? b[1] - a[1] : a[1] - b[1]) || a[0].localeCompare(b[0])
    )
    return {
      order,
      count: Math.min(n, sorted.length),
      ...totals,
      tracks: sorted.slice(0, n).map(([k, v]) => ({ ...brief(ctx, k), plays: v }))
    }
  }
})
