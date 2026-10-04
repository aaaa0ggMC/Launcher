import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import type { SongMeta } from '../types'
import { DEFAULT_AIDJ_CONFIG } from '../types'
import { DEFAULT_LOOP_POLICY } from './policy'
import { DEFAULT_LOOP_PROMPTS } from './prompts'
import { activeDjTools, type DjToolContext } from './agent/tools'
import { buildIdIndex } from './agent/ids'
import { buildLyricsIndex } from './agent/lyrics-index'
import { resolvePlaybooks } from './agent/playbooks'
import './agent/builtin-tools'
import { listeningSources } from './agent/listening-tools'
import {
  collapseRepeats,
  describeAgo,
  eventsAroundHour,
  habitsFromEvents,
  parseTimelineCsv,
  partOfDay,
  timeInfo,
  type ListenEvent
} from '../services/listening-history'

const meta = new Map<string, SongMeta>([
  [
    'C418 - Sweden',
    { emotion: ['peaceful', 'nostalgic'], genre: 'ambient', language: 'Instrumental' }
  ],
  ['C418 - Wet Hands', { emotion: ['peaceful'], genre: 'ambient', language: 'Instrumental' }],
  ['陈粒 - 小半', { emotion: ['melancholic'], genre: 'folk', language: 'Chinese' }],
  [
    'toe - Goodbye',
    { emotion: ['melancholic', 'nostalgic'], genre: 'post-rock', language: 'Japanese' }
  ],
  ['新歌 - 没听过', { emotion: ['dreamy'], genre: 'pop', language: 'Chinese' }]
])
const paths = new Map([...meta.keys()].map((k) => [k, `/m/${k}.flac`]))
const ids = buildIdIndex(meta.keys())

function ctx(over: Partial<DjToolContext> = {}): DjToolContext {
  return {
    config: DEFAULT_AIDJ_CONFIG,
    client: {} as OpenAI,
    policy: { ...DEFAULT_LOOP_POLICY, library_agent: false },
    prompts: DEFAULT_LOOP_PROMPTS,
    metadata: meta,
    musicPaths: paths,
    played: new Set(),
    staged: [],
    recent: [],
    capArtists: true,
    resolveKey: (q) => (meta.has(q) ? q : null),
    ids,
    pool: null,
    pinned: [],
    playbooks: resolvePlaybooks(DEFAULT_AIDJ_CONFIG, DEFAULT_LOOP_POLICY),
    lyrics: () => buildLyricsIndex(meta.keys(), paths, new Map()),
    formatLibrary: () => '',
    addUsage: () => {},
    ...over
  }
}

function tool(name: string): NonNullable<ReturnType<typeof activeDjTools>[number]> {
  const t = activeDjTools(DEFAULT_LOOP_POLICY, DEFAULT_AIDJ_CONFIG).find((x) => x.name === name)
  assert.ok(t, `tool ${name} should be active`)
  return t
}

// 本地时间 2026-10-04 01:30（周日、深夜）——用本地时间构造，断言不依赖运行机器的时区
const NOW = new Date(2026, 9, 4, 1, 30, 0)
const at = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000)

const real = { ...listeningSources }
afterEach(() => Object.assign(listeningSources, real))

describe('AIDJ listening history — 纯函数', () => {
  it('parseTimelineCsv：当前写法（带引号 + 空格）、旧写法、含逗号 / 引号的歌名、表头 / BOM / 坏行', () => {
    const text =
      '﻿Song Name, TimeStamp , LocalTime\n' +
      '"张玮玮 ／ 郭龙 - 米店", 1788346371 , 20260902185251\n' +
      '万晓利 - 陀螺,1788346708,20260902185828\n' +
      '"A, B - C ""live""", 1788346800 , 20260902190000\n' +
      'garbage line\n' +
      '"没有时间戳"\n'
    assert.deepEqual(parseTimelineCsv(text), [
      { name: '张玮玮 ／ 郭龙 - 米店', ts: 1788346371 },
      { name: '万晓利 - 陀螺', ts: 1788346708 },
      { name: 'A, B - C "live"', ts: 1788346800 }
    ])
    assert.deepEqual(parseTimelineCsv(''), [])
  })

  it('collapseRepeats：5 分钟内同一首只算一次，隔得久或换歌不合并', () => {
    const ev: ListenEvent[] = [
      { name: 'a', ts: 1000 },
      { name: 'a', ts: 1100 }, // 100s 内重复 → 合并
      { name: 'b', ts: 1150 },
      { name: 'a', ts: 1200 }, // 不是紧邻重复（中间有 b）
      { name: 'a', ts: 1700 } // 距上一个 500s → 保留
    ]
    assert.deepEqual(
      collapseRepeats(ev).map((e) => e.ts),
      [1000, 1150, 1200, 1700]
    )
  })

  it('describeAgo / partOfDay', () => {
    const now = 100000
    assert.equal(describeAgo(now - 30, now), 'just now')
    assert.equal(describeAgo(now - 5 * 60, now), '5m ago')
    assert.equal(describeAgo(now - 3 * 3600 - 12 * 60, now), '3h 12m ago')
    assert.equal(describeAgo(now - 2 * 3600, now), '2h ago')
    assert.equal(describeAgo(now - 86400, now), '1 day ago')
    assert.equal(describeAgo(now - 3 * 86400, now), '3 days ago')
    assert.deepEqual([0, 4, 5, 9, 12, 14, 18, 22, 23].map(partOfDay), [
      'late night',
      'late night',
      'early morning',
      'morning',
      'noon',
      'afternoon',
      'evening',
      'night',
      'night'
    ])
  })

  it('timeInfo：本地时间 / 星期 / 时段', () => {
    const t = timeInfo(NOW)
    assert.equal(t.local, '2026-10-04 01:30')
    assert.equal(t.hour, 1)
    assert.equal(t.part_of_day, 'late night')
    assert.equal(
      t.weekday,
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][NOW.getDay()]
    )
    assert.equal(t.is_weekend, NOW.getDay() === 0 || NOW.getDay() === 6)
    assert.equal(t.month, 10)
  })

  it('habitsFromEvents / eventsAroundHour：钟点分布、峰值、±1 小时环形窗口', () => {
    const nowSec = Math.floor(NOW.getTime() / 1000)
    const ev: ListenEvent[] = [
      { name: 'a', ts: at(2026, 10, 3, 23, 10) }, // 23 点
      { name: 'b', ts: at(2026, 10, 3, 23, 40) }, // 23 点
      { name: 'c', ts: at(2026, 10, 3, 1, 5) }, // 1 点
      { name: 'd', ts: at(2026, 10, 2, 14, 0) }, // 14 点
      { name: 'old', ts: at(2026, 8, 1, 23, 0) } // 超出 30 天
    ]
    const h = habitsFromEvents(ev, nowSec, 30)
    assert.equal(h.plays, 4)
    assert.equal(h.by_hour[23], 2)
    assert.equal(h.by_hour[1], 1)
    assert.equal(h.by_hour[14], 1)
    assert.equal(h.peak_hours[0], 23)
    // a、b、c 都在 10 月 3 日，d 在 10 月 2 日 → 2 个活跃日，平均每个活跃日 2 次
    assert.equal(h.active_days, 2)
    assert.equal(h.avg_plays_per_active_day, 2)
    // 现在是 1 点：±1 小时 = 0、1、2 点 + 环形的 23 点？不——±1 只覆盖 0..2；23 点与 1 点相差 2
    const around1 = eventsAroundHour(ev, nowSec, 30, 1, 1)
    assert.deepEqual(
      around1.map((e) => e.name),
      ['c']
    )
    // 现在是 0 点时，23 点和 1 点都在窗口内（0 与 23 环形相邻）
    const around0 = eventsAroundHour(ev, nowSec, 30, 0, 1)
    assert.deepEqual(around0.map((e) => e.name).sort(), ['a', 'b', 'c'])
  })
})

describe('AIDJ loop — 用户情境工具', () => {
  it('current_time：用注入的时钟', async () => {
    listeningSources.nowMs = () => NOW.getTime()
    const r = (await tool('current_time').run({}, ctx())) as Record<string, unknown>
    assert.equal(r.part_of_day, 'late night')
    assert.equal(r.local, '2026-10-04 01:30')
  })

  it('recent_listens：最新在前、带 ago、库外歌无 id、since_hours / n 生效、连续重复折叠', async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000)
    listeningSources.nowMs = () => NOW.getTime()
    listeningSources.events = async () => [
      { name: 'toe - Goodbye', ts: nowSec - 5 * 3600 },
      { name: 'C418 - Sweden', ts: nowSec - 40 * 60 },
      { name: 'C418 - Sweden', ts: nowSec - 38 * 60 }, // 重复，折叠
      { name: '某首库外的歌', ts: nowSec - 10 * 60 }
    ]
    const t = tool('recent_listens')
    const all = (await t.run({}, ctx())) as { count: number; tracks: Record<string, unknown>[] }
    assert.equal(all.count, 3)
    assert.equal(all.tracks[0].key, '某首库外的歌')
    assert.equal(all.tracks[0].in_library, false)
    assert.equal(all.tracks[0].id, undefined)
    assert.equal(all.tracks[0].ago, '10m ago')
    assert.equal(all.tracks[1].key, 'C418 - Sweden')
    assert.equal(all.tracks[1].id, ids.idOf('C418 - Sweden'))
    assert.deepEqual(all.tracks[1].emotion, ['peaceful', 'nostalgic'])
    assert.equal(all.tracks[2].ago, '5h ago')

    const recent = (await t.run({ since_hours: 1 }, ctx())) as { count: number }
    assert.equal(recent.count, 2)
    const one = (await t.run({ n: 1 }, ctx())) as { tracks: Record<string, unknown>[] }
    assert.equal(one.tracks.length, 1)
  })

  it('listening_habits：节律 + 此刻前后常听的标签', async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000)
    listeningSources.nowMs = () => NOW.getTime()
    listeningSources.events = async () => [
      { name: 'toe - Goodbye', ts: at(2026, 10, 3, 1, 10) },
      { name: 'C418 - Sweden', ts: at(2026, 10, 2, 0, 50) },
      { name: 'C418 - Wet Hands', ts: at(2026, 10, 2, 15, 0) } // 下午，不在此刻窗口内
    ]
    void nowSec
    const r = (await tool('listening_habits').run({ days: 30 }, ctx())) as {
      plays: number
      by_hour: number[]
      usually_around_now: { plays: number; emotion: string[]; genre: string[] }
    }
    assert.equal(r.plays, 3)
    assert.equal(r.by_hour[1], 1)
    assert.equal(r.usually_around_now.plays, 2)
    // toe(melancholic, nostalgic) + Sweden(peaceful, nostalgic) → nostalgic 2
    assert.equal(r.usually_around_now.emotion[0], 'nostalgic(2)')
    assert.ok(r.usually_around_now.genre.includes('post-rock(1)'))
  })

  it('play_frequency：most / least / unplayed / ids 查询', async () => {
    listeningSources.freq = async () =>
      new Map([
        ['C418 - Sweden', 12],
        ['toe - Goodbye', 5],
        ['陈粒 - 小半', 1],
        ['库外的歌', 99] // 不在库里：不算
      ])
    listeningSources.random = () => 0 // 洗牌结果确定
    const t = tool('play_frequency')
    const most = (await t.run({ order: 'most', n: 2 }, ctx())) as {
      tracks: { key: string; plays: number }[]
      total_plays: number
      tracks_with_plays: number
    }
    assert.deepEqual(
      most.tracks.map((x) => [x.key, x.plays]),
      [
        ['C418 - Sweden', 12],
        ['toe - Goodbye', 5]
      ]
    )
    assert.equal(most.tracks_with_plays, 3)
    assert.equal(most.total_plays, 18)

    const least = (await t.run({ order: 'least', n: 1 }, ctx())) as { tracks: { key: string }[] }
    assert.equal(least.tracks[0].key, '陈粒 - 小半')

    // 没听过：库里 5 首，3 首有播放 → 剩 2 首；本会话已播的不再算
    const un = (await t.run(
      { order: 'unplayed', n: 10 },
      ctx({ played: new Set(['C418 - Wet Hands']) })
    )) as {
      total_unplayed: number
      tracks: { key: string; plays: number }[]
    }
    assert.equal(un.total_unplayed, 1)
    assert.deepEqual(
      un.tracks.map((x) => x.key),
      ['新歌 - 没听过']
    )
    assert.equal(un.tracks[0].plays, 0)

    const look = (await t.run(
      { ids: [ids.idOf('C418 - Sweden'), 'C418 - Wet Hands', '#zzzz'] },
      ctx()
    )) as {
      tracks: { key: string; plays: number }[]
      unresolved?: string[]
    }
    assert.deepEqual(
      look.tracks.map((x) => [x.key, x.plays]),
      [
        ['C418 - Sweden', 12],
        ['C418 - Wet Hands', 0]
      ]
    )
    assert.deepEqual(look.unresolved, ['#zzzz'])
  })

  it('记录开关关了，对应工具就不出现；session_memory 在、recent_history 已改名', () => {
    const names = (cfg: typeof DEFAULT_AIDJ_CONFIG): string[] =>
      activeDjTools(DEFAULT_LOOP_POLICY, cfg).map((t) => t.name)
    const on = names(DEFAULT_AIDJ_CONFIG)
    for (const n of [
      'current_time',
      'recent_listens',
      'listening_habits',
      'play_frequency',
      'session_memory'
    ])
      assert.ok(on.includes(n), n)
    assert.ok(!on.includes('recent_history'))

    const noTimeline = names({
      ...DEFAULT_AIDJ_CONFIG,
      preferences: { ...DEFAULT_AIDJ_CONFIG.preferences, song_timeline: false }
    })
    assert.ok(!noTimeline.includes('recent_listens') && !noTimeline.includes('listening_habits'))
    assert.ok(noTimeline.includes('play_frequency') && noTimeline.includes('current_time'))

    const noFreq = names({
      ...DEFAULT_AIDJ_CONFIG,
      preferences: { ...DEFAULT_AIDJ_CONFIG.preferences, record_freq: false }
    })
    assert.ok(!noFreq.includes('play_frequency'))
    assert.ok(noFreq.includes('recent_listens'))

    // 也能被 loop.disabled_tools 逐个关闭
    const off = activeDjTools(
      { ...DEFAULT_LOOP_POLICY, disabled_tools: ['recent_listens'] },
      DEFAULT_AIDJ_CONFIG
    ).map((t) => t.name)
    assert.ok(!off.includes('recent_listens') && off.includes('listening_habits'))
  })
})
