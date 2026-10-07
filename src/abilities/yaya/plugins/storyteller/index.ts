/**
 * 内置 storyteller 插件：分层的互动故事工作流「故事模式」（`storyteller.story`）。
 *
 * 启用插件后，助手的默认工作流 / 输入框的工作流菜单里多出「故事模式」。一轮 = 用户给出主角的行动或方向，
 * 系统分层推进故事：
 *
 *   ① 读取故事档案（计算）——档案存在每轮回答上，重新生成 / 编辑重发自动回到对应分支
 *   ② 建筑师（子 Agent，只在第一轮）——按用户的设定造世界、角色、线索
 *   ③ 导演（计算，非 AI）——戏剧弧线的张力目标、命运骰（d20）、该推进的线索、分章
 *   ④ 编剧（子 Agent）——本轮的节拍：场景目标、出场角色、冲突、结尾钩子
 *   ⑤ 角色（子 Agent × 出场人数，并行）——各自按人设给出意图与台词（知道自己的秘密）
 *   ⑥ 故事状态卡（数据卡片）——章节、地点、张力、命运骰、出场角色、线索，写进对话
 *   ⑦ 旁白（主 Agent）——把以上写成正文，可选在结尾给出行动选项
 *   ⑧ 记录员（子 Agent）+ 合并（计算）——更新档案：角色状态、新事实、线索开合、本轮摘要
 *
 * 不给模型加工具；提示词固定英文（稳定），正文语言跟随用户。
 */
import { t, te } from '../../../../main/process/i18n'
import type { PluginConfigField, YayaPlugin } from '../../services/plugins/types'
import type { WorkflowContext, WorkflowDefinition } from '../../services/workflow/types'
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
    description: '出场角色各由一个子 Agent 按人设给出意图与台词；关掉更快更省，但角色声音更像旁白',
    descriptionKey: 'yaya.story.cfg.character_agents_desc',
    default: true
  },
  {
    key: 'max_cast',
    type: 'number',
    label: '每轮最多出场角色',
    labelKey: 'yaya.story.cfg.max_cast',
    default: 3,
    min: 1,
    max: 6,
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
    description: '每轮掷一次 d20：小概率出意外 / 好运 / 转折，让故事不按套路走',
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

function plotterSystem(note: DirectorNote, maxCast: number, fate: boolean): string {
  const event = !fate
    ? ''
    : note.event === 'complication'
      ? '- FATE: a complication strikes this beat (an obstacle, a setback, an enemy move).'
      : note.event === 'twist'
        ? '- FATE: a twist this beat (a revelation that recontextualizes something, ideally tied to a character secret).'
        : note.event === 'boon'
          ? '- FATE: a stroke of luck or an unexpected ally this beat.'
          : '- FATE: no forced event; follow the natural consequences.'
  return `You are the plot writer of an interactive story engine. You plan the NEXT beat; you do not write prose.
The story bible is below the conversation instructions. The user's last message is the protagonist's action or the user's direction for the story: honor it, its consequences must be visible.
Director's constraints for this beat:
- Chapter ${note.chapter}, beat ${note.turn}${note.newChapter ? ' (a NEW chapter begins: change of time/place or a fresh situation)' : ''}.
- Target tension: ${note.tension}/100 (arc position ${note.arc}; 0 = calm setup, 100 = climax).
${event}
- Advance this plot thread if it fits: ${note.focusThread ? `[${note.focusThread.id}] ${note.focusThread.text}` : '(none open: introduce a new hook)'}.
Output ONLY a JSON object:
{
  "scene": "where and when, one line",
  "goal": "what this beat must accomplish for the story",
  "cast": ["names of up to ${maxCast} characters who act in this beat (existing names, or new ones)"],
  "beats": ["3-5 short bullet points of what happens, in order"],
  "hook": "how the beat ends: a question, threat or opportunity that invites the user's next move"
}
Keep characters consistent with the bible; never take control of the protagonist's decisions beyond what the user stated.`
}

function characterSystem(name: string, bible: StoryBible, plan: string): string {
  const c = bible.characters.find((x) => x.name === name)
  const sheet = c
    ? `Name: ${c.name}\nRole: ${c.role}\nTraits: ${c.traits}\nGoal: ${c.goal}\nStatus: ${c.status}\nVoice: ${c.voice}\nRelations: ${c.relations}\nSecret (only you know): ${c.secret}`
    : `Name: ${name}\n(A new character: invent a consistent personality that fits the story.)`
  return `You are ${name}, a character in an interactive story. Stay fully in character.
Your sheet:
${sheet}

The current scene plan:
${plan}

The conversation so far is the story. In this beat, say what you WANT and DO, from your own point of view and interests (you may lie or hide things to protect your secret).
${LANG_RULE}
Output, briefly:
INTENT: one sentence
ACTIONS: 1-2 short lines
LINES: 1-3 lines of dialogue in your voice`
}

function narratorExtra(
  bible: StoryBible,
  note: DirectorNote,
  plan: string,
  voices: string[],
  cfg: Record<string, unknown>
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
  return [
    '## STORY MODE',
    'You are the narrator of an interactive story. Write the next part of the story as prose — not as an assistant, no meta talk, no headings like "Scene".',
    `- Point of view: ${pov}. Length: ${length}.`,
    style ? `- Style: ${style}.` : '- Style: fit the genre and tone of the story.',
    `- ${LANG_RULE}`,
    "- The user's last message is the protagonist's action / the user's direction: show it happening and its consequences. Do not decide the protagonist's next choice for them.",
    "- Follow the beat plan and use the characters' intents and lines (adapt wording, keep their voices). Never reveal a character's secret directly unless the plan says it is revealed.",
    '- Stay consistent with the story bible. Show, do not tell; concrete sensory detail; end on the hook.',
    cfg.choices !== false
      ? '- After the prose, add a blank line and offer 2-3 short possible actions as a numbered list (the user may also do anything else).'
      : '- End with the hook; do not list options.',
    '',
    `### Director: chapter ${note.chapter}, beat ${note.turn}, target tension ${note.tension}/100`,
    '',
    '### Story bible',
    bibleBrief(bible),
    '',
    '### Beat plan',
    plan,
    voices.length ? '\n### Characters (their own intents and lines)\n' + voices.join('\n\n') : ''
  ].join('\n')
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

  // ② 建筑师：第一轮造世界
  if (bible.turn === 0 && !bible.characters.length) {
    const out = await ctx.subAgent({
      agent: 'architect',
      label: t('yaya.story.step.architect', '构建世界与角色'),
      system: ARCHITECT_SYSTEM
    })
    if (ctx.aborted) return
    bible = bibleFromArchitect(extractJson(out.content))
  }

  // ③ 导演：纯计算
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

  // ④ 编剧
  const planOut = await ctx.subAgent({
    agent: 'plotter',
    label: t('yaya.story.step.plot', '编排本轮剧情'),
    system: `${plotterSystem(note, maxCast, fate)}\n\n### Story bible\n${bibleBrief(bible, { secrets: true })}`
  })
  if (ctx.aborted) return
  const planJson = extractJson(planOut.content)
  const plan = planJson ? JSON.stringify(planJson, null, 2) : planOut.content.trim()
  const cast = (Array.isArray(planJson?.cast) ? planJson!.cast : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, maxCast)

  // ⑤ 角色：并行，各自只知道自己的秘密
  let voices: string[] = []
  if (cfg.character_agents !== false && cast.length) {
    const results = await Promise.allSettled(
      cast.map((name) =>
        ctx.subAgent({
          agent: 'character',
          label: te('yaya.story.step.character', { name }, '角色：{name}'),
          system: characterSystem(name, bible, plan)
        })
      )
    )
    if (ctx.aborted) return
    voices = results.flatMap((r, i) =>
      r.status === 'fulfilled' && r.value.content.trim()
        ? [`#### ${cast[i]}\n${r.value.content.trim()}`]
        : []
    )
  }

  // ⑥ 故事状态卡（写进对话；模型看不到——它要的信息已经在旁白的说明里）
  const data: StoryCardData = {
    title: bible.title,
    chapter: note.chapter,
    turn: note.turn,
    newChapter: note.newChapter,
    location:
      (typeof planJson?.scene === 'string' && planJson.scene.trim()) || bible.location || '',
    tension: note.tension,
    roll: fate ? note.roll : null,
    event: fate ? note.event : null,
    cast: cast.map((name) => {
      const c = bible.characters.find((x) => x.name === name)
      return { name, role: c?.role ?? '', status: c?.status ?? '' }
    }),
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

  // ⑦ 旁白：主 Agent 写正文
  await ctx.assistantStep({
    tools: 'none',
    label: t('yaya.story.step.narrate', '旁白：写下这一段'),
    extraSystem: narratorExtra(bible, note, plan, voices, cfg)
  })
  if (ctx.aborted) return

  // ⑧ 记录员 + 合并
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
    '分层的互动故事：导演控节奏、编剧排剧情、角色各说各话、旁白写正文、记录员维护设定；你决定主角做什么',
  icon: 'mdi-book-open-page-variant-outline',
  usesTools: false,
  run: runStory
}

const plugin: YayaPlugin = {
  id: 'storyteller',
  kind: 'builtin',
  label: 'StoryTeller 故事模式',
  labelKey: 'yaya.story.label',
  description:
    '给助手加一个「故事模式」工作流：分层 Agent 一起讲互动故事（插件启用后在工作流菜单里选）',
  descriptionKey: 'yaya.story.desc',
  icon: 'mdi-book-open-page-variant-outline',
  defaultEnabled: false,
  mentionable: false,
  docs: [
    '启用后，在输入框的工作流菜单（或助手的默认工作流）里选「故事模式」，然后告诉它你想要的故事。',
    '之后每条消息就是你（主角）的行动或对剧情的要求。',
    '',
    '| 层 | 做什么 |',
    '|---|---|',
    '| 导演（计算，非 AI） | 按每章轮数安排起承转合的张力，掷命运骰（意外 / 转折 / 好运），轮流推进线索 |',
    '| 建筑师（第一轮） | 造世界、角色（每人有目标和秘密）、初始线索 |',
    '| 编剧 | 排本轮节拍：场景、出场角色、发生什么、结尾钩子 |',
    '| 角色 × N（并行） | 每个出场角色按自己的人设和秘密给出意图与台词 |',
    '| 旁白（主 Agent） | 写进对话的正文，可在结尾给出行动选项 |',
    '| 记录员 | 更新故事档案：角色状态、新事实、线索开合、剧情摘要 |',
    '',
    '每轮开头会有一张「故事状态」卡片（章节、地点、张力、命运骰、出场角色）。',
    '故事档案跟着对话分支走：重新生成或编辑之前的消息，档案自动回到那个分支的样子。',
    '输入框「+」→「故事档案」可以随时查看完整设定。'
  ].join('\n'),
  tools: () => [],
  configSchema: CONFIG,
  workflows: () => [storyWorkflow]
}

export default plugin
