/**
 * Roleplay（GameMaster）插件的纯逻辑：命令解析、档案（设定 / 世界观 / 人物 / 剧情摘要）的归一化与合并、
 * 提示词拼装、`prompt` 命令的导出文本。不依赖 Electron / 数据库，单测直接跑。
 *
 * 分工：凡是能确定的事都由代码做——命令、阶段、设定取值、导出；模型只负责「讲故事」与「从文字里抽设定」。
 */

// ---------------------------------------------------------------------------
// 设定
// ---------------------------------------------------------------------------

export type Pov = 'third' | 'second' | 'first'
export type Pace = 'slow' | 'medium' | 'fast'
export type PlayMode = 'free' | 'interactive'

/** 生效的故事设定（插件配置给默认值，开场时用户在 intro 里明说的覆盖它） */
export interface RpSetup {
  protagonist: string
  genre: string
  style: string
  pov: Pov
  /** 精细程度 1–16，1 = 流水账 */
  detail: number
  pace: Pace
  mode: PlayMode
}

/** 开场时从用户的话里抽出来的覆盖项（只记用户明说的） */
export type RpOverrides = Partial<Pick<RpSetup, 'style' | 'pov' | 'detail' | 'pace' | 'mode'>>

export interface RpCharacter {
  name: string
  note: string
}

export interface RpState {
  v: 1
  /** opening = 开场已写、等用户确认；playing = 故事进行中 */
  phase: 'opening' | 'playing'
  /** 已推进的轮数（c 一次 +1；开场 / 扩写 / 导出不算） */
  turn: number
  title: string
  /** 设定阶段确定下来的主角 / 题材（随机或按 intro 总结） */
  protagonist: string
  genre: string
  overrides: RpOverrides
  world: string[]
  characters: RpCharacter[]
  /** 每轮一句话的剧情摘要 */
  summary: string[]
}

export const LIMITS = { world: 40, characters: 24, summary: 80, text: 600 }

function str(v: unknown, max = LIMITS.text): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function strList(v: unknown, max: number): string[] {
  return Array.isArray(v)
    ? v
        .map((x) => str(x))
        .filter(Boolean)
        .slice(0, max)
    : []
}

export function clampDetail(v: unknown, dflt = 8): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(16, Math.max(1, Math.round(n))) : dflt
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined
}

const POVS = ['third', 'second', 'first'] as const
const PACES = ['slow', 'medium', 'fast'] as const

function modeOf(v: unknown): PlayMode | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (s === 'i' || s === 'interactive') return 'interactive'
  if (s === 'f' || s === 'free') return 'free'
  return undefined
}

/** 插件配置 → 默认设定 */
export function setupFromConfig(cfg: Record<string, unknown>): RpSetup {
  return {
    protagonist: str(cfg.protagonist),
    genre: str(cfg.genre),
    style: str(cfg.style) || '大众化的网文风',
    pov: oneOf(cfg.pov, POVS) ?? 'third',
    detail: clampDetail(cfg.detail),
    pace: oneOf(cfg.pace, PACES) ?? 'slow',
    mode: modeOf(cfg.mode) ?? 'free'
  }
}

/** 生效设定 = 配置默认值 ← 档案里定下的主角 / 题材 ← 用户明说的覆盖项 */
export function effectiveSetup(cfg: Record<string, unknown>, state: RpState | null): RpSetup {
  const base = setupFromConfig(cfg)
  if (!state) return base
  return {
    ...base,
    protagonist: state.protagonist || base.protagonist,
    genre: state.genre || base.genre,
    ...state.overrides
  }
}

export function emptyState(): RpState {
  return {
    v: 1,
    phase: 'opening',
    turn: 0,
    title: '',
    protagonist: '',
    genre: '',
    overrides: {},
    world: [],
    characters: [],
    summary: []
  }
}

/** 读回来的档案做一次归一化（旧版本 / 手改坏了都不要崩） */
export function normalizeState(raw: unknown): RpState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const s = emptyState()
  s.phase = r.phase === 'playing' ? 'playing' : 'opening'
  s.turn = Math.max(0, Math.round(Number(r.turn) || 0))
  s.title = str(r.title, 80)
  s.protagonist = str(r.protagonist)
  s.genre = str(r.genre, 200)
  s.overrides = normalizeOverrides(r.overrides)
  s.world = strList(r.world, LIMITS.world)
  s.characters = normalizeCharacters(r.characters)
  s.summary = strList(r.summary, LIMITS.summary)
  return s
}

export function normalizeOverrides(raw: unknown): RpOverrides {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: RpOverrides = {}
  const pov = oneOf(r.pov, POVS)
  if (pov) out.pov = pov
  const pace = oneOf(r.pace, PACES)
  if (pace) out.pace = pace
  const mode = modeOf(r.mode)
  if (mode) out.mode = mode
  if (
    r.detail !== null &&
    r.detail !== undefined &&
    r.detail !== '' &&
    Number.isFinite(Number(r.detail))
  )
    out.detail = clampDetail(r.detail)
  const style = str(r.style, 200)
  if (style) out.style = style
  return out
}

function normalizeCharacters(raw: unknown): RpCharacter[] {
  if (!Array.isArray(raw)) return []
  const out: RpCharacter[] = []
  for (const x of raw) {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const name = str(r.name, 60)
    // 主角不进人物表（主角的设定在 protagonist）
    if (!name || /\[\[main\]\]/i.test(name)) continue
    if (out.some((c) => c.name === name)) continue
    out.push({ name, note: str(r.note, 300) })
    if (out.length >= LIMITS.characters) break
  }
  return out
}

/** 从模型输出里取 JSON 对象（允许 ``` 包裹、尾逗号） */
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

/**
 * 设定 Agent 的输出 → 新档案（开场 / 开场返工时）。之前的档案（返工）里有的、这次没给的保留；
 * 配置里写死的主角 / 题材优先于模型。
 */
export function stateFromSetup(
  json: Record<string, unknown> | null,
  prev: RpState | null,
  cfg: Record<string, unknown>
): RpState {
  const s = emptyState()
  const j = json ?? {}
  const base = setupFromConfig(cfg)
  s.title = str(j.title, 80) || prev?.title || ''
  s.protagonist = base.protagonist || str(j.protagonist) || prev?.protagonist || ''
  s.genre = base.genre || str(j.genre, 200) || prev?.genre || ''
  s.overrides = { ...prev?.overrides, ...normalizeOverrides(j.overrides) }
  const world = strList(j.world, LIMITS.world)
  s.world = world.length ? world : (prev?.world ?? [])
  const chars = normalizeCharacters(j.characters)
  s.characters = chars.length ? chars : (prev?.characters ?? [])
  return s
}

/** 记录员的输出（这一段新增 / 变化的内容）并进档案 */
export function mergeChronicle(state: RpState, json: Record<string, unknown> | null): RpState {
  const next: RpState = JSON.parse(JSON.stringify(state))
  if (!json) return next
  const summary = str(json.summary, 300)
  if (summary) next.summary = [...next.summary, summary].slice(-LIMITS.summary)
  for (const fact of strList(json.world_add, 12)) {
    if (!next.world.includes(fact)) next.world.push(fact)
  }
  next.world = next.world.slice(-LIMITS.world)
  for (const c of normalizeCharacters(json.characters)) {
    const hit = next.characters.find((x) => x.name === c.name)
    if (hit) {
      if (c.note) hit.note = c.note
    } else next.characters.push(c)
  }
  next.characters = next.characters.slice(-LIMITS.characters)
  return next
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export type RpCommand =
  | { kind: 'continue'; text: string }
  | { kind: 'expand'; text: string }
  | { kind: 'export' }
  | { kind: 'help' }
  /** 没有命令头的普通文字：开场前 = intro，开场后 = 对开场的意见，游玩中 = 继续 */
  | { kind: 'text'; text: string }

const COMMAND_RE = /^\s*[/／]?(c|continue|r|prompt|help|\?|？)(?=\s|$)\s*([\s\S]*)$/i

/** 解析用户这一条消息的命令头（不区分大小写；`c` 后面必须是空白或结尾，`cat …` 不算） */
export function parseCommand(text: string): RpCommand {
  const m = COMMAND_RE.exec(text ?? '')
  if (!m) return { kind: 'text', text: (text ?? '').trim() }
  const head = m[1].toLowerCase()
  const rest = m[2].trim()
  if (head === 'c' || head === 'continue') return { kind: 'continue', text: rest }
  if (head === 'r') return { kind: 'expand', text: rest }
  if (head === 'prompt') return { kind: 'export' }
  return { kind: 'help' }
}

export type RpAction =
  | { kind: 'opening'; intro: string }
  | { kind: 'revise'; feedback: string }
  | { kind: 'continue'; guidance: string }
  | { kind: 'expand'; aspect: string }
  | { kind: 'export' }
  | { kind: 'help' }

/** 命令 + 当前阶段 → 这一轮做什么 */
export function decide(cmd: RpCommand, state: RpState | null): RpAction {
  if (cmd.kind === 'export') return { kind: 'export' }
  if (cmd.kind === 'help') return { kind: 'help' }
  if (!state) {
    // 还没开场：无论 c / r / 普通文字，都把文字当作 intro
    return { kind: 'opening', intro: cmd.text }
  }
  if (cmd.kind === 'expand') return { kind: 'expand', aspect: cmd.text }
  if (cmd.kind === 'continue') return { kind: 'continue', guidance: cmd.text }
  if (state.phase === 'opening') return { kind: 'revise', feedback: cmd.text }
  return { kind: 'continue', guidance: cmd.text }
}

// ---------------------------------------------------------------------------
// 提示词（固定英文：稳定、利于缓存；正文语言跟随用户）
// ---------------------------------------------------------------------------

export function lengthHint(detail: number): string {
  const zh = 80 + detail * 60
  const en = Math.round(zh * 0.6)
  return `about ${zh} Chinese characters / ${en} English words`
}

const POV_TEXT: Record<Pov, string> = {
  third:
    'third person, centered on [[main]] (write "[[main]]" wherever the protagonist\'s name would appear)',
  second: 'second person ("you" = [[main]], the user)',
  first: 'first person ("I" = [[main]])'
}

const PACE_TEXT: Record<Pace, string> = {
  slow: 'slow-burn: give room to atmosphere, daily life and relationships; at most one small conflict at a time, no big confrontation in a short span',
  medium: 'moderate: steady progress, conflicts arise naturally and get room to breathe',
  fast: 'fast: keep things moving, frequent events and turning points'
}

/**
 * GM 的系统提示词（替换助手的系统提示词）：只依赖生效设定、additions 与有没有工具，同一个故事里稳定。
 * 不写任何内容尺度 / 安全规则：那由模型自己判断。
 */
export function gmSystem(
  setup: RpSetup,
  additions: string,
  opts: { tools?: boolean } = {}
): string {
  return [
    'You are the GameMaster (GM) of a text roleplay. Using prose, you lead the user through the world they imagine.',
    "The user plays the protagonist. Refer to the protagonist ONLY with the literal token [[main]] (the app shows it as the protagonist's name). Never give [[main]] a name or call them anything else.",
    'Write in the same language the user writes in. Write story prose, not assistant talk: no headings, no meta commentary unless you are asking the user something at the end.',
    '',
    '## Story settings',
    `- Protagonist: ${setup.protagonist || 'not specified: create one fitting the story'}`,
    `- Point of view: ${POV_TEXT[setup.pov]}`,
    `- Genre: ${setup.genre || "derive it from the user's intro"}`,
    `- Style: ${setup.style}`,
    `- Detail level: ${setup.detail}/16 (1 = brisk chronicle of events, 16 = every moment rendered richly). Length per passage: ${lengthHint(setup.detail)}.`,
    `- Pacing: ${PACE_TEXT[setup.pace]}.`,
    setup.mode === 'interactive'
      ? '- Play mode: Interactive. After the passage, add a blank line and offer 2-4 short numbered options for what [[main]] could do next (the user may also do anything else).'
      : "- Play mode: Free. Do not offer options. End with one short line asking whether to continue, then wait for the user's command.",
    '',
    '## How the user talks to you',
    "Messages may start with a command (case-insensitive); the app has already interpreted it and tells you this turn's task below:",
    '- "c [message]": continue the story; the optional message steers what happens next or what [[main]] does.',
    '- "r <aspect>": expand on an aspect of the current moment without advancing the plot.',
    '- "prompt" / "help": handled by the app (you may see their short notes in the history).',
    '',
    opts.tools
      ? [
          '## Working on a turn',
          'Organize each turn yourself. You have tools (such as web search): when the story touches real places, history, culture, works or facts you are unsure about, look them up first, then write.',
          'Your final message (the one without tool calls) is the passage shown to the user. While you are still calling tools, write nothing else.',
          ''
        ].join('\n')
      : '',
    '## Rules',
    '- Stay consistent with established facts (see the story memory). Show, do not tell.',
    '- Never spoil future developments.',
    additions.trim()
      ? `\n## Additional instructions from the user\nFollow these unless they conflict with the rules above.\n${additions.trim()}`
      : ''
  ]
    .filter((x) => x !== '')
    .join('\n')
}

/** 本轮任务 + 故事记忆（每轮变化，放在系统提示词末尾） */
export function turnInstructions(action: RpAction, state: RpState): string {
  const task = (() => {
    switch (action.kind) {
      case 'opening':
        return [
          "## This turn: the OPENING (the user's last message is their intro)",
          "If the intro is an exported save of a previous session (settings, world, story so far), restore it: keep everything, briefly recap where the story stands, and wait for the user's command instead of starting over.",
          'If the intro explicitly asks for different settings (point of view, detail level, pace, play mode, style), follow the intro over the settings above.',
          'Otherwise:',
          "1. Flesh out [[main]]'s origin and background (consistent with the protagonist setting).",
          "2. Depict the scene of the user's intro: set the stage. Do NOT push the plot forward yet.",
          '3. End by asking whether the user is satisfied with this opening; tell them they can reply with changes, or "c" to begin.'
        ].join('\n')
      case 'revise':
        return [
          '## This turn: REVISE the opening',
          `The user is not fully satisfied with the opening. Their feedback: ${action.feedback || '(see their last message)'}`,
          'Rewrite the complete opening applying the feedback, then ask again whether they are satisfied (reply with changes, or "c" to begin).'
        ].join('\n')
      case 'continue':
        return [
          '## This turn: CONTINUE the story',
          action.guidance
            ? `The user's guidance for what comes next: ${action.guidance}`
            : 'No guidance: you decide how the story continues, including what [[main]] does, true to their character.',
          'Show the consequences of what happened before; end at a natural pause.'
        ].join('\n')
      case 'expand':
        return [
          '## This turn: EXPAND (do not advance the plot)',
          `Aspect to expand: ${action.aspect || 'the current scene'}`,
          'Describe it in depth within the current moment: senses, details, inner state, backstory already established. Do not move time forward, do not reveal or hint at what will happen next.',
          'Afterwards just wait for the next command (no options needed).'
        ].join('\n')
      default:
        return ''
    }
  })()
  return [task, memoryBrief(state)].filter(Boolean).join('\n\n')
}

export function memoryBrief(state: RpState): string {
  const parts: string[] = []
  if (state.title) parts.push(`Title: ${state.title}`)
  if (state.world.length) parts.push('World:\n' + state.world.map((x) => `- ${x}`).join('\n'))
  if (state.characters.length)
    parts.push('Characters:\n' + state.characters.map((c) => `- ${c.name}: ${c.note}`).join('\n'))
  if (state.summary.length)
    parts.push('Story so far:\n' + state.summary.map((x, i) => `${i + 1}. ${x}`).join('\n'))
  return parts.length ? `## Story memory\n${parts.join('\n\n')}` : ''
}

export function setupAgentSystem(setup: RpSetup, prev: RpState | null): string {
  return `You record the setup of a text roleplay. You do not write story text. Read the record: the user's messages are their intro for the story${prev ? ' and their feedback on the opening' : ''}; it ends with the GM's opening passage. Record what the intro and the opening established (the opening is canon: follow it).
Output ONLY a JSON object:
{
  "title": "short story title",
  "protagonist": "1-3 sentences: background, personality, look. Refer to the protagonist as [[main]]; never name them",
  "genre": "genre and tone",
  "world": ["3-8 concrete facts about the world / setting"],
  "characters": [{"name": "", "note": "who they are, relation to [[main]]"}],
  "overrides": {"pov": null, "style": null, "detail": null, "pace": null, "mode": null}
}
Rules:
- Protagonist: ${setup.protagonist ? `fixed by the user's settings: "${setup.protagonist}" (copy it, you may add details the intro gives)` : 'from the intro if described, otherwise invent one'}.
- Genre: ${setup.genre ? `fixed: "${setup.genre}"` : 'summarize it from the intro, or pick one if the intro gives none'}.
- overrides: ONLY settings the user explicitly asked for in their messages, else null. pov: third|second|first; pace: slow|medium|fast; mode: I|F; detail: 1-16; style: text.
- If the intro is an exported save of an earlier session, take everything from it.
- Values in the language the user writes in; JSON keys in English.${prev ? `\n- Current setup (keep what the feedback does not change):\n${JSON.stringify({ title: prev.title, protagonist: prev.protagonist, genre: prev.genre, world: prev.world, characters: prev.characters, overrides: prev.overrides })}` : ''}`
}

export function chroniclerSystem(state: RpState): string {
  return `You keep the memory of a text roleplay. You do not write story text. The record you are given ends with the newest story passage.
Compare it with the memory below and output ONLY a JSON object with what this passage added:
{
  "summary": "one sentence: what happened in this passage (use [[main]] for the protagonist)",
  "world_add": ["newly established facts about the world, if any"],
  "characters": [{"name": "", "note": "who they are now, relation to [[main]]"}]
}
Only include characters that are new or changed. Never list [[main]] as a character. Values in the story's language. Keep it short.

${memoryBrief(state) || '## Story memory\n(empty)'}`
}

// ---------------------------------------------------------------------------
// 导出（prompt 命令）：完全由档案生成，不调模型
// ---------------------------------------------------------------------------

export interface ExportLabels {
  heading: string
  settings: string
  protagonist: string
  pov: string
  genre: string
  style: string
  detail: string
  pace: string
  mode: string
  world: string
  characters: string
  story: string
  povText: Record<Pov, string>
  paceText: Record<Pace, string>
  modeText: Record<PlayMode, string>
  hint: string
  /** 「键：值」的分隔符（中文全角冒号 / 英文 ': '） */
  colon: string
}

export function exportText(state: RpState, setup: RpSetup, L: ExportLabels): string {
  const c = L.colon
  const lines: string[] = [
    `# ${L.heading}${state.title ? `${c}${state.title}` : ''}`,
    '',
    `> ${L.hint}`,
    ''
  ]
  lines.push(`## ${L.settings}`)
  lines.push(`- ${L.protagonist}${c}${setup.protagonist || '—'}（[[main]]）`)
  lines.push(`- ${L.pov}${c}${L.povText[setup.pov]}`)
  lines.push(`- ${L.genre}${c}${setup.genre || '—'}`)
  lines.push(`- ${L.style}${c}${setup.style}`)
  lines.push(`- ${L.detail}${c}${setup.detail}/16`)
  lines.push(`- ${L.pace}${c}${L.paceText[setup.pace]}`)
  lines.push(`- ${L.mode}${c}${L.modeText[setup.mode]}`)
  if (state.world.length) {
    lines.push('', `## ${L.world}`)
    for (const w of state.world) lines.push(`- ${w}`)
  }
  if (state.characters.length) {
    lines.push('', `## ${L.characters}`)
    for (const ch of state.characters) lines.push(`- ${ch.name}${c}${ch.note}`)
  }
  if (state.summary.length) {
    lines.push('', `## ${L.story}`)
    state.summary.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }
  return lines.join('\n')
}
