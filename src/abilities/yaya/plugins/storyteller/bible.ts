/**
 * StoryTeller 的纯逻辑（不调模型、不碰磁盘，主进程 / 渲染端 / 单测共用）：
 * - 故事档案（StoryBible）的结构、初始化、合并记录员的补丁；
 * - 导演（Director）：纯计算的节奏控制——戏剧弧线的张力目标、命运骰、推进哪条线索、分章；
 * - 从模型输出里稳妥地抠出 JSON。
 */

export interface StoryCharacter {
  name: string
  /** 主角 / 配角 / 反派… */
  role: string
  /** 性格、外貌等，一句话 */
  traits: string
  /** 当前想要什么 */
  goal: string
  /** 当前状态（受伤、在哪、心情…） */
  status: string
  /** 说话方式 */
  voice: string
  /** 和别人的关系，一句话 */
  relations: string
  /** 只有角色自己知道的事（旁白不直接揭露） */
  secret: string
}

export interface StoryThread {
  id: string
  text: string
  status: 'open' | 'resolved'
}

export interface StoryBible {
  version: 1
  /** 已经讲了几轮 */
  turn: number
  chapter: number
  title: string
  premise: string
  genre: string
  location: string
  world: string[]
  characters: StoryCharacter[]
  threads: StoryThread[]
  /** 每轮一句的剧情摘要（最近的在后面） */
  timeline: string[]
  /** 上一轮的张力（导演给的目标），0–100 */
  tension: number
}

export const LIMITS = { world: 40, characters: 20, threads: 24, timeline: 40 }

export function emptyBible(): StoryBible {
  return {
    version: 1,
    turn: 0,
    chapter: 1,
    title: '',
    premise: '',
    genre: '',
    location: '',
    world: [],
    characters: [],
    threads: [],
    timeline: [],
    tension: 20
  }
}

function str(v: unknown, max = 400): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function strList(v: unknown, max = 300): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean) : []
}

/** 模型输出 → JSON 对象：认 ```json 代码块、前后有废话、尾逗号 */
export function extractJson(text: string): Record<string, unknown> | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fence ? fence[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const raw = body.slice(start, end + 1)
  for (const candidate of [raw, raw.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const v = JSON.parse(candidate) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

export function normalizeCharacter(raw: unknown): StoryCharacter | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = str(r.name, 60)
  if (!name) return null
  return {
    name,
    role: str(r.role, 60),
    traits: str(r.traits),
    goal: str(r.goal),
    status: str(r.status),
    voice: str(r.voice),
    relations: str(r.relations),
    secret: str(r.secret)
  }
}

let threadSeq = 0
function threadId(existing: StoryThread[]): string {
  const used = new Set(existing.map((t) => t.id))
  let id: string
  do id = `t${existing.length + ++threadSeq}`
  while (used.has(id))
  return id
}

/** 建筑师（第一轮）的输出 → 档案 */
export function bibleFromArchitect(raw: Record<string, unknown> | null): StoryBible {
  const b = emptyBible()
  if (!raw) return b
  b.title = str(raw.title, 80)
  b.premise = str(raw.premise, 600)
  b.genre = str(raw.genre, 60)
  b.location = str(raw.location, 120)
  b.world = strList(raw.world).slice(0, LIMITS.world)
  b.characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .map(normalizeCharacter)
    .filter((c): c is StoryCharacter => !!c)
    .slice(0, LIMITS.characters)
  for (const text of strList(raw.threads).slice(0, LIMITS.threads))
    b.threads.push({ id: threadId(b.threads), text, status: 'open' })
  return b
}

export interface ChroniclePatch {
  summary?: string
  location?: string
  world_add?: string[]
  /** 新角色或已有角色的变化（按名字合并，只覆盖给了的字段） */
  characters?: Partial<StoryCharacter>[]
  threads_add?: string[]
  /** 已解决的线索：id 或原文 */
  threads_resolved?: string[]
}

/** 记录员的补丁并进档案（返回新对象；turn 由调用方推进） */
export function mergeChronicle(bible: StoryBible, raw: Record<string, unknown> | null): StoryBible {
  const b: StoryBible = JSON.parse(JSON.stringify(bible))
  if (!raw) return b
  const summary = str(raw.summary, 300)
  if (summary) b.timeline = [...b.timeline, summary].slice(-LIMITS.timeline)
  const location = str(raw.location, 120)
  if (location) b.location = location
  for (const fact of strList(raw.world_add)) if (!b.world.includes(fact)) b.world.push(fact)
  b.world = b.world.slice(-LIMITS.world)
  for (const c of Array.isArray(raw.characters) ? raw.characters : []) {
    const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const name = str(r.name, 60)
    if (!name) continue
    const cur = b.characters.find((x) => x.name === name)
    if (cur) {
      for (const k of [
        'role',
        'traits',
        'goal',
        'status',
        'voice',
        'relations',
        'secret'
      ] as const) {
        const v = str(r[k])
        if (v) cur[k] = v
      }
    } else if (b.characters.length < LIMITS.characters) {
      const fresh = normalizeCharacter(r)
      if (fresh) b.characters.push(fresh)
    }
  }
  for (const key of strList(raw.threads_resolved)) {
    const th = b.threads.find((t) => t.id === key || t.text === key)
    if (th) th.status = 'resolved'
  }
  for (const text of strList(raw.threads_add)) {
    if (b.threads.some((t) => t.text === text)) continue
    b.threads.push({ id: threadId(b.threads), text, status: 'open' })
  }
  // 线索太多时先丢最早解决的
  while (b.threads.length > LIMITS.threads) {
    const i = b.threads.findIndex((t) => t.status === 'resolved')
    b.threads.splice(i >= 0 ? i : 0, 1)
  }
  return b
}

// ---------------------------------------------------------------------------
// 导演：纯计算的节奏控制
// ---------------------------------------------------------------------------

export type FateEvent = 'complication' | 'twist' | 'steady' | 'boon'

export interface DirectorNote {
  /** 本轮是第几轮（从 1 开始） */
  turn: number
  chapter: number
  /** 本轮开了新的一章 */
  newChapter: boolean
  /** 章内位置 0–1 */
  arc: number
  /** 张力目标 0–100 */
  tension: number
  /** 命运骰（d20） */
  roll: number
  event: FateEvent
  /** 这一轮该推进的线索 */
  focusThread: StoryThread | null
}

/** 小而确定的 PRNG（mulberry32）：同一个种子同一个结果，方便测试与复现 */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * 一章 `chapterBeats` 轮：张力沿弧线上升到 ~85%（高潮）再回落收尾；
 * 命运骰在弧线后段更容易出「转折」；推进最久没动的那条未解决线索。
 */
export function direct(bible: StoryBible, chapterBeats: number, seed: number): DirectorNote {
  const beats = Math.max(3, Math.min(30, Math.round(chapterBeats) || 8))
  const turn = bible.turn + 1
  const index = (turn - 1) % beats
  const chapter = Math.floor((turn - 1) / beats) + 1
  const arc = beats > 1 ? index / (beats - 1) : 0
  // 0.85 处到顶：起 → 承 → 高潮 → 收
  const peak = 0.85
  const shape = arc <= peak ? arc / peak : 1 - ((arc - peak) / (1 - peak)) * 0.6
  const tension = Math.round(15 + 75 * shape)
  const roll = Math.floor(rng(seed)() * 20) + 1
  const event: FateEvent =
    roll >= 19
      ? 'boon'
      : roll <= 3
        ? 'complication'
        : arc > 0.5 && roll <= 7
          ? 'twist'
          : roll <= 5
            ? 'complication'
            : 'steady'
  const open = bible.threads.filter((t) => t.status === 'open')
  return {
    turn,
    chapter,
    newChapter: turn > 1 && index === 0,
    arc: Math.round(arc * 100) / 100,
    tension,
    roll,
    event,
    // 轮流推进：按轮次在未解决的线索里转
    focusThread: open.length ? open[(turn - 1) % open.length] : null
  }
}

/** 档案压成给模型看的紧凑文本（不放秘密时给旁白用） */
export function bibleBrief(b: StoryBible, opts: { secrets?: boolean } = {}): string {
  const lines: string[] = []
  if (b.title) lines.push(`Title: ${b.title}`)
  if (b.genre) lines.push(`Genre: ${b.genre}`)
  if (b.premise) lines.push(`Premise: ${b.premise}`)
  lines.push(`Chapter ${b.chapter}, turn ${b.turn}. Location: ${b.location || 'unknown'}`)
  if (b.world.length) lines.push('World facts:\n' + b.world.map((w) => `- ${w}`).join('\n'))
  if (b.characters.length)
    lines.push(
      'Characters:\n' +
        b.characters
          .map((c) => {
            const parts = [
              c.role && `role: ${c.role}`,
              c.traits && `traits: ${c.traits}`,
              c.goal && `goal: ${c.goal}`,
              c.status && `status: ${c.status}`,
              c.voice && `voice: ${c.voice}`,
              c.relations && `relations: ${c.relations}`,
              opts.secrets && c.secret && `secret: ${c.secret}`
            ].filter(Boolean)
            return `- ${c.name} (${parts.join('; ')})`
          })
          .join('\n')
    )
  const open = b.threads.filter((t) => t.status === 'open')
  if (open.length)
    lines.push('Open plot threads:\n' + open.map((t) => `- [${t.id}] ${t.text}`).join('\n'))
  if (b.timeline.length)
    lines.push(
      'Story so far:\n' +
        b.timeline
          .slice(-12)
          .map((s) => `- ${s}`)
          .join('\n')
    )
  return lines.join('\n\n')
}
