/**
 * 内置 storyteller 插件：互动故事工作流「故事模式」（`storyteller.story`）。
 *
 * 启用插件后，助手的默认工作流 / 输入框的工作流菜单里多出「故事模式」。一轮 = 用户给出主角的行动或方向。
 * 和 AIDJ 的 LoopAgent 一样是「自组织 + 程序辅助」：
 *
 *   ① 读取故事档案（计算）——档案存在每轮回答上，重新生成 / 编辑重发自动回到对应分支
 *   ② 导演（计算，非 AI）——戏剧弧线的张力目标、命运骰（d20）、可推进的线索、分章；只是建议
 *   ③ 故事状态卡（数据卡片）——章节、地点、张力、命运骰
 *   ④ 作者（主 Agent，工具循环）——自己决定这一轮怎么做：查资料（网页搜索等插件工具，按配置开放）、
 *      搭世界（story_build_world → 建筑师子 Agent）、问角色（story_ask_character → 角色子 Agent），
 *      最后写出正文；工具轮数用完时代码收掉工具，逼它把正文写出来
 *   ⑤ 程序辅助的收尾：第一轮模型没搭世界 → 建筑师按对话（含刚写的正文）补建；
 *      记录员（子 Agent）+ 合并（计算）——更新档案：角色状态、新事实、线索开合、本轮摘要
 *
 * 不往提示词里追加插件的工具守则；提示词固定英文（稳定），正文语言跟随用户。
 */
import { t, te } from '../../../../main/process/i18n'
import type { PluginConfigField, YayaPlugin } from '../../services/plugins/types'
import {
  pickExternalTools,
  selfOrganizedLoop,
  toolScope
} from '../../services/workflow/self-organized'
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowTool
} from '../../services/workflow/types'
import {
  bibleBrief,
  bibleFromArchitect,
  direct,
  emptyBible,
  extractJson,
  hashSeed,
  mergeChronicle,
  type DirectorNote,
  type StoryBible
} from './bible'

export const STORY_WORKFLOW_ID = 'storyteller.story'

const CONFIG: PluginConfigField[] = [
  {
    key: 'style',
    type: 'text',
    label: '文风',
    labelKey: 'yaya.story.cfg.style',
    description: '如「冷峻克制的黑色电影」「轻快幽默的童话」；留空 = 按故事题材自己定',
    descriptionKey: 'yaya.story.cfg.style_desc',
    default: ''
  },
  {
    key: 'pov',
    type: 'select',
    label: '叙事视角',
    labelKey: 'yaya.story.cfg.pov',
    default: 'second',
    options: [
      { value: 'second', label: '第二人称（你）', labelKey: 'yaya.story.pov.second' },
      { value: 'first', label: '第一人称（我）', labelKey: 'yaya.story.pov.first' },
      { value: 'third', label: '第三人称', labelKey: 'yaya.story.pov.third' }
    ]
  },
  {
    key: 'length',
    type: 'select',
    label: '每段篇幅',
    labelKey: 'yaya.story.cfg.length',
    default: 'medium',
    options: [
      { value: 'short', label: '短（约 200 字）', labelKey: 'yaya.story.len.short' },
      { value: 'medium', label: '中（约 450 字）', labelKey: 'yaya.story.len.medium' },
      { value: 'long', label: '长（约 900 字）', labelKey: 'yaya.story.len.long' }
    ]
  },
  {
    key: 'choices',
    type: 'boolean',
    label: '结尾给出行动选项',
    labelKey: 'yaya.story.cfg.choices',
    default: true
  },
  {
    key: 'character_agents',
    type: 'boolean',
    label: '角色 Agent',
    labelKey: 'yaya.story.cfg.character_agents',
    description: '作者可以让角色子 Agent 按人设给出意图与台词；关掉更快更省，但角色声音更像旁白',
    descriptionKey: 'yaya.story.cfg.character_agents_desc',
    default: true
  },
  {
    key: 'max_cast',
    type: 'number',
    label: '每轮最多问几个角色',
    labelKey: 'yaya.story.cfg.max_cast',
    default: 3,
    min: 1,
    max: 6,
    step: 1
  },
  {
    key: 'tools',
    type: 'select',
    label: '可用的插件工具',
    labelKey: 'yaya.story.cfg.tools',
    description: '作者可以先查资料再写；工具本身在插件页启用（如网页搜索）',
    descriptionKey: 'yaya.story.cfg.tools_desc',
    default: 'search',
    options: [
      { value: 'search', label: '只用网页搜索', labelKey: 'yaya.story.tools.search' },
      { value: 'all', label: '全部已启用的工具', labelKey: 'yaya.story.tools.all' },
      { value: 'none', label: '不用插件工具', labelKey: 'yaya.story.tools.none' }
    ]
  },
  {
    key: 'tool_rounds',
    type: 'number',
    label: '每轮最多工具步数',
    labelKey: 'yaya.story.cfg.tool_rounds',
    description: '作者查资料、问角色的轮数上限；用完后直接写正文',
    descriptionKey: 'yaya.story.cfg.tool_rounds_desc',
    default: 6,
    min: 1,
    max: 20,
    step: 1
  },
  {
    key: 'chapter_beats',
    type: 'number',
    label: '每章轮数',
    labelKey: 'yaya.story.cfg.chapter_beats',
    description: '导演按这个长度安排起承转合：张力在章末前达到高潮，然后收束开新章',
    descriptionKey: 'yaya.story.cfg.chapter_beats_desc',
    default: 8,
    min: 3,
    max: 30,
    step: 1
  },
  {
    key: 'fate',
    type: 'boolean',
    label: '命运骰',
    labelKey: 'yaya.story.cfg.fate',
    description: '每轮掷一次 d20，作为给作者的建议：小概率出意外 / 好运 / 转折，让故事不按套路走',
    descriptionKey: 'yaya.story.cfg.fate_desc',
    default: true
  }
]

// ---------------------------------------------------------------------------
// 提示词（固定英文；正文语言跟随用户）
// ---------------------------------------------------------------------------

const LANG_RULE =
  "Write all story text in the same language the user writes in (look at the user's messages)."

const ARCHITECT_SYSTEM = `You are the world architect of an interactive story engine.
From the conversation (the user's request is the seed of the story), design the story's foundation.
${LANG_RULE} JSON keys stay in English.
Output ONLY a JSON object:
{
  "title": "short title",
  "genre": "genre and tone",
  "premise": "2-3 sentences: the setup and the central dramatic question",
  "location": "where the story opens",
  "world": ["4-8 concrete facts about the world, rules, places, factions"],
  "characters": [
    {"name": "", "role": "protagonist|ally|antagonist|...", "traits": "", "goal": "", "status": "",
     "voice": "how they talk", "relations": "", "secret": "something only they know"}
  ],
  "threads": ["3-5 open plot threads / mysteries / goals to pursue"]
}
Rules:
- 3-6 characters. The protagonist is the user's character: if the user described them, follow it; otherwise create one and keep their personality light so the user can shape it.
- Every non-protagonist character gets a goal and a secret that can create conflict later.
- Be specific and original; avoid generic names and cliches unless the user asked for them.`

function characterSystem(name: string, bible: StoryBible, situation: string): string {
  const c = bible.characters.find((x) => x.name === name)
  const sheet = c
    ? `Name: ${c.name}\nRole: ${c.role}\nTraits: ${c.traits}\nGoal: ${c.goal}\nStatus: ${c.status}\nVoice: ${c.voice}\nRelations: ${c.relations}\nSecret (only you know): ${c.secret}`
    : `Name: ${name}\n(A new character: invent a consistent personality that fits the story.)`
  return `You are ${name}, a character in an interactive story. Stay fully in character.
Your sheet:
${sheet}

What the author says is happening now:
${situation || '(continue from the story so far)'}

The conversation so far is the story. Say what you WANT and DO right now, from your own point of view and interests (you may lie or hide things to protect your secret).
${LANG_RULE}
Output, briefly:
INTENT: one sentence
ACTIONS: 1-2 short lines
LINES: 1-3 lines of dialogue in your voice`
}

export const TOOL_BUILD_WORLD = 'story_build_world'
export const TOOL_ASK_CHARACTER = 'story_ask_character'

function fateLine(note: DirectorNote): string {
  switch (note.event) {
    case 'complication':
      return `Fate die: ${note.roll}/20, a complication (an obstacle, a setback, an enemy move).`
    case 'twist':
      return `Fate die: ${note.roll}/20, a twist (a revelation that recontextualizes something, ideally tied to a character secret).`
    case 'boon':
      return `Fate die: ${note.roll}/20, a stroke of luck or an unexpected ally.`
    default:
      return `Fate die: ${note.roll}/20, no forced event; follow the natural consequences.`
  }
}

/** 作者（主 Agent）的说明：设定、导演建议、工具、档案。只描述目标与可用手段，怎么做由模型自己定 */
export function authorExtra(
  bible: StoryBible,
  note: DirectorNote,
  cfg: Record<string, unknown>,
  tools: { buildWorld: boolean; askCharacter: boolean; external: boolean }
): string {
  const pov =
    cfg.pov === 'first'
      ? 'first person ("I"), the protagonist narrating'
      : cfg.pov === 'third'
        ? 'third person, close on the protagonist'
        : 'second person ("you" = the protagonist, i.e. the user)'
  const length =
    cfg.length === 'short'
      ? 'about 200 Chinese characters / 120 English words'
      : cfg.length === 'long'
        ? 'about 900 Chinese characters / 600 English words'
        : 'about 450 Chinese characters / 300 English words'
  const style = String(cfg.style ?? '').trim()
  const toolLines = [
    tools.external
      ? '- Plugin tools such as web search: look things up whenever the story touches real places, history, science, works or anything you are not sure about. Do it before writing, not after.'
      : '',
    tools.buildWorld
      ? `- ${TOOL_BUILD_WORLD}: a world-architect sub-agent designs the title, premise, world, characters (with goals and secrets) and plot threads, and saves them to the story bible. Use it in this first turn once you know what the user wants (after any research), and pass what you learned in "brief".`
      : '',
    tools.askCharacter
      ? `- ${TOOL_ASK_CHARACTER}: a sub-agent plays one character from their own sheet and secret and tells you their intent, actions and lines. Use it for characters whose choices matter in this beat; skip it when nobody important acts.`
      : ''
  ].filter(Boolean)
  return [
    '## STORY MODE',
    "You are the author of an interactive story. The user plays the protagonist; their last message is the protagonist's action or their direction for the story.",
    "Organize this turn yourself: decide what you need (research, world building, characters' reactions), use the tools for it, then write the next passage.",
    toolLines.length ? '\n### Tools\n' + toolLines.join('\n') : null,
    '',
    '### The passage',
    'Your final message (the one without tool calls) is the passage itself, shown to the user as the story. While you are still calling tools, write nothing else.',
    `- Point of view: ${pov}. Length: ${length}.`,
    style ? `- Style: ${style}.` : '- Style: fit the genre and tone of the story.',
    `- ${LANG_RULE}`,
    '- Story prose, not assistant talk: no meta commentary, no headings like "Scene".',
    "- Show what the user's message makes happen and its consequences. Do not decide the protagonist's next choice for them.",
    '- Stay consistent with the story bible; reveal character secrets only when the story earns it. Concrete sensory detail; end on a hook.',
    cfg.choices !== false
      ? '- After the prose, add a blank line and offer 2-3 short possible actions as a numbered list (the user may also do anything else).'
      : '- End with the hook; do not list options.',
    '',
    `### Director's suggestions (chapter ${note.chapter}, beat ${note.turn})`,
    "Pacing hints computed by the app. Follow them when they fit the story; the user's wishes come first.",
    note.newChapter
      ? '- A new chapter begins: a change of time or place, or a fresh situation.'
      : null,
    `- Target tension: ${note.tension}/100 (arc position ${note.arc}; 0 = calm setup, 100 = climax).`,
    cfg.fate !== false ? `- ${fateLine(note)}` : null,
    note.focusThread
      ? `- Thread worth advancing: [${note.focusThread.id}] ${note.focusThread.text}`
      : '- No open thread yet: plant a hook.',
    '',
    '### Story bible',
    bible.characters.length || bible.title
      ? bibleBrief(bible, { secrets: true })
      : '(empty: a new story)'
  ]
    .filter((x): x is string => x !== null)
    .join('\n')
}

const CHRONICLER_SYSTEM = `You are the chronicler of an interactive story engine. The conversation ends with the newest story passage.
Compare it with the story bible below and output ONLY a JSON object with what CHANGED in this passage:
{
  "summary": "one sentence: what happened in this passage",
  "location": "current location if it changed, else empty",
  "world_add": ["new established facts, if any"],
  "characters": [{"name": "", "status": "", "goal": "", "relations": "", "traits": "", "role": "", "voice": "", "secret": ""}],
  "threads_add": ["new open questions / goals raised"],
  "threads_resolved": ["ids like t1 of threads that were resolved"]
}
Rules: only include characters that changed or newly appeared (only the changed fields; new characters get all fields). Use the language of the story for values. Keep it short.`

// ---------------------------------------------------------------------------
// 工作流
// ---------------------------------------------------------------------------

function num(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt
}

/** 故事状态卡的数据（界面 StoryStateCard.vue 渲染） */
export interface StoryCardData {
  title: string
  chapter: number
  turn: number
  newChapter: boolean
  location: string
  tension: number
  roll: number | null
  event: DirectorNote['event'] | null
  cast: { name: string; role: string; status: string }[]
  focus: string
  openThreads: number
}

async function runStory(ctx: WorkflowContext): Promise<void> {
  const cfg = ctx.pluginConfig
  const maxCast = num(cfg.max_cast, 3, 1, 6)
  const fate = cfg.fate !== false

  // ① 档案
  let bible = await ctx.compute(
    t('yaya.story.step.load', '读取故事档案'),
    () => ctx.loadState<StoryBible>() ?? emptyBible(),
    {
      detail: (b) =>
        b.turn
          ? te(
              'yaya.story.step.load_detail',
              { title: b.title || '—', turn: String(b.turn), n: String(b.characters.length) },
              '《{title}》已进行 {turn} 轮，{n} 个角色'
            )
          : t('yaya.story.step.load_new', '新故事')
    }
  )
  if (ctx.aborted) return
  const fresh = bible.turn === 0 && !bible.characters.length

  // ② 导演：纯计算，给作者的建议
  const seed = hashSeed(`${ctx.session.id}:${bible.turn}:${Date.now()}`)
  const note = await ctx.compute(
    t('yaya.story.step.director', '导演：节奏与命运骰'),
    () => direct(bible, num(cfg.chapter_beats, 8, 3, 30), seed),
    {
      detail: (n) =>
        [
          `- ${t('yaya.story.card.chapter', '章节')}: ${n.chapter}${n.newChapter ? ' ★' : ''}`,
          `- ${t('yaya.story.card.tension', '张力')}: ${n.tension}/100`,
          fate ? `- d20: ${n.roll} → ${t(`yaya.story.event.${n.event}`, n.event)}` : '',
          n.focusThread ? `- ${t('yaya.story.card.focus', '推进线索')}: ${n.focusThread.text}` : ''
        ]
          .filter(Boolean)
          .join('\n')
    }
  )
  if (ctx.aborted) return

  // ③ 故事状态卡（写进对话；模型看不到——它要的信息已经在作者的说明里）
  const data: StoryCardData = {
    title: bible.title,
    chapter: note.chapter,
    turn: note.turn,
    newChapter: note.newChapter,
    location: bible.location || '',
    tension: note.tension,
    roll: fate ? note.roll : null,
    event: fate ? note.event : null,
    cast: [],
    focus: note.focusThread?.text ?? '',
    openThreads: bible.threads.filter((x) => x.status === 'open').length
  }
  ctx.addCard({
    type: 'story-state',
    title: bible.title || t('yaya.story.card.title', '故事状态'),
    data,
    markdown: [
      `**${t('yaya.story.card.chapter', '章节')} ${note.chapter} · ${t('yaya.story.card.turn', '第')} ${note.turn}**`,
      data.location ? `📍 ${data.location}` : '',
      `${t('yaya.story.card.tension', '张力')} ${note.tension}/100`
    ]
      .filter(Boolean)
      .join('  \n')
  })

  // ④ 作者：自组织的工具循环
  let built = false
  const asked: string[] = []
  const local: WorkflowTool[] = []
  if (fresh) {
    local.push({
      name: TOOL_BUILD_WORLD,
      description:
        "Design the story's foundation (title, premise, world, characters with goals and secrets, plot threads) with a world-architect sub-agent and save it to the story bible. Call once, in the first turn, after any research.",
      parameters: {
        type: 'object',
        properties: {
          brief: {
            type: 'string',
            description:
              "What the world must include: the user's wishes plus facts you researched (places, era, real details)."
          }
        }
      },
      run: async (args) => {
        if (built) return 'The story bible is already built; continue with it.'
        const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
        const out = await ctx.subAgent({
          agent: 'architect',
          label: t('yaya.story.step.architect', '构建世界与角色'),
          system: brief ? `${ARCHITECT_SYSTEM}\n\nThe author's brief:\n${brief}` : ARCHITECT_SYSTEM
        })
        const next = bibleFromArchitect(extractJson(out.content))
        if (!next.characters.length && !next.title)
          throw new Error('the architect returned no usable bible, try again with a clearer brief')
        bible = next
        built = true
        return `Story bible saved:\n\n${bibleBrief(bible, { secrets: true })}`
      }
    })
  }
  if (cfg.character_agents !== false) {
    local.push({
      name: TOOL_ASK_CHARACTER,
      description: `Ask one character (played by a sub-agent that knows their sheet and secret) what they want, do and say right now. At most ${maxCast} different characters per turn.`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Character name (from the bible, or a new one)' },
          situation: {
            type: 'string',
            description: 'What is happening to them in this beat, as they would perceive it'
          }
        },
        required: ['name']
      },
      run: async (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (!name) throw new Error('name is required')
        if (!asked.includes(name)) {
          if (asked.length >= maxCast)
            return `Character limit for this turn reached (${maxCast}); write the others yourself.`
          asked.push(name)
        }
        const situation = typeof args.situation === 'string' ? args.situation.trim() : ''
        const out = await ctx.subAgent({
          agent: 'character',
          label: te('yaya.story.step.character', { name }, '角色：{name}'),
          system: characterSystem(name, bible, situation)
        })
        return out.content.trim() || '(no answer)'
      }
    })
  }
  const external = pickExternalTools(ctx, toolScope(cfg.tools))
  const { final } = await selfOrganizedLoop(ctx, {
    extraSystem: authorExtra(bible, note, cfg, {
      buildWorld: fresh,
      askCharacter: cfg.character_agents !== false,
      external: external.length > 0
    }),
    localTools: local,
    external,
    maxRounds: num(cfg.tool_rounds, 6, 1, 20) + 1,
    label: t('yaya.story.step.author', '作者：构思与查资料'),
    finalLabel: t('yaya.story.step.narrate', '旁白：写下这一段')
  })
  if (ctx.aborted || !final) return

  // ⑤ 程序辅助：第一轮没搭世界 → 按对话（含刚写的正文）补建
  if (fresh && !built) {
    const out = await ctx.subAgent({
      agent: 'architect',
      label: t('yaya.story.step.architect', '构建世界与角色'),
      system: `${ARCHITECT_SYSTEM}\nThe conversation already contains the opening passage: stay consistent with it.`
    })
    if (ctx.aborted) return
    bible = bibleFromArchitect(extractJson(out.content))
  }

  // 记录员 + 合并
  const chronicle = await ctx.subAgent({
    agent: 'chronicler',
    label: t('yaya.story.step.chronicle', '记录员：更新档案'),
    system: `${CHRONICLER_SYSTEM}\n\n### Story bible\n${bibleBrief(bible, { secrets: true })}`
  })
  const next = await ctx.compute(
    t('yaya.story.step.merge', '合并档案'),
    () => {
      const merged = mergeChronicle(bible, extractJson(chronicle.content))
      merged.turn = note.turn
      merged.chapter = note.chapter
      merged.tension = note.tension
      return merged
    },
    {
      detail: (b) =>
        te(
          'yaya.story.step.merge_detail',
          {
            n: String(b.characters.length),
            open: String(b.threads.filter((x) => x.status === 'open').length)
          },
          '{n} 个角色，{open} 条未解决线索'
        )
    }
  )
  ctx.saveState(next)
}

export const storyWorkflow: WorkflowDefinition = {
  id: STORY_WORKFLOW_ID,
  labelKey: 'yaya.story.wf',
  label: '故事模式',
  descriptionKey: 'yaya.story.wf_desc',
  description:
    '互动故事：作者自己决定先查资料、搭世界、问角色还是直接写，导演给节奏建议，记录员维护设定；你决定主角做什么',
  icon: 'mdi-book-open-page-variant-outline',
  usesTools: true,
  run: runStory
}

const plugin: YayaPlugin = {
  id: 'storyteller',
  kind: 'builtin',
  label: 'StoryTeller 故事模式',
  labelKey: 'yaya.story.label',
  description:
    '给助手加一个「故事模式」工作流：作者 Agent 自己查资料、搭世界、问角色，讲互动故事（插件启用后在工作流菜单里选）',
  descriptionKey: 'yaya.story.desc',
  icon: 'mdi-book-open-page-variant-outline',
  defaultEnabled: false,
  mentionable: false,
  docs: [
    '启用后，在输入框的工作流菜单（或助手的默认工作流）里选「故事模式」，然后告诉它你想要的故事。',
    '之后每条消息就是你（主角）的行动或对剧情的要求。',
    '',
    '每一轮由「作者」（主 Agent）自己组织：要不要先查资料、要不要搭世界、要问哪些角色，都由它决定，',
    '代码只给节奏建议、限制工具步数、在正文写完后记账。',
    '',
    '| 谁 | 做什么 |',
    '|---|---|',
    '| 导演（计算，非 AI） | 按每章轮数给出张力目标，掷命运骰（意外 / 转折 / 好运），建议推进哪条线索；只是建议 |',
    '| 作者（主 Agent） | 查资料（网页搜索等，按配置开放）、调下面两个工具，最后写出正文，可在结尾给出行动选项 |',
    '| 建筑师（作者在第一轮调用） | 造世界、角色（每人有目标和秘密）、初始线索；作者没调用时，正文写完后由程序补建 |',
    '| 角色（作者按需调用） | 按自己的人设和秘密给出意图与台词 |',
    '| 记录员（正文写完后） | 更新故事档案：角色状态、新事实、线索开合、剧情摘要 |',
    '',
    '每轮开头会有一张「故事状态」卡片（章节、地点、张力、命运骰）。',
    '提示词里不追加插件的工具守则（隐私、凭据、审批说明），内容尺度交给模型自己判断。',
    '故事档案跟着对话分支走：重新生成或编辑之前的消息，档案自动回到那个分支的样子。',
    '输入框「+」→「故事档案」可以随时查看完整设定。'
  ].join('\n'),
  tools: () => [],
  configSchema: CONFIG,
  workflows: () => [storyWorkflow]
}

export default plugin
