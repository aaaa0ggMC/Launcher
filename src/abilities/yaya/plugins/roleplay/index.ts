/**
 * 内置 roleplay 插件：GameMaster 角色扮演工作流（`roleplay.gm`）。
 *
 * 与 StoryTeller（作者 + 子 Agent 写故事）不同，这里是「一个 GM 带着用户玩」，同样是自组织 + 程序辅助：
 *
 *   ① 读档案 + 解析命令（计算）——`c [消息]` 继续 / `r <内容>` 扩写 / `prompt` 导出 / `help`，
 *      不区分大小写；没有命令头的文字按阶段解释（开场前 = intro，开场后 = 对开场的意见，之后 = 继续）
 *   ② GM（主 Agent，工具循环）——自己决定要不要先查资料（网页搜索等插件工具，按配置开放）再写；
 *      GM 提示词替换助手的系统提示词，助手原来的系统提示词作为「用户补充说明」注入；不追加插件的工具守则
 *   ③ 设定 Agent（子 Agent，只在开场 / 开场返工，GM 写完之后）——从 intro 与开场里记下主角、题材、
 *      世界、人物、用户明说的设定 → 开局设定卡（数据卡片）
 *   ④ 记录员（子 Agent，可关）+ 合并（计算）——剧情摘要、新的世界设定、人物
 *
 * `prompt` 与 `help` 完全由代码生成（卡片），不调模型。主角在正文里一律写成 `[[main]]`，
 * 界面按配置里的主角名显示（ui.ts 的 inlineTokens）。档案跟着对话分支走（ctx.saveState）。
 */
import { t, te } from '../../../../main/process/i18n'
import type { PluginConfigField, YayaPlugin } from '../../services/plugins/types'
import {
  pickExternalTools,
  selfOrganizedLoop,
  toolScope
} from '../../services/workflow/self-organized'
import type { WorkflowContext, WorkflowDefinition } from '../../services/workflow/types'
import {
  chroniclerSystem,
  decide,
  effectiveSetup,
  emptyState,
  exportText,
  extractJson,
  gmSystem,
  mergeChronicle,
  normalizeState,
  parseCommand,
  setupAgentSystem,
  stateFromSetup,
  turnInstructions,
  type ExportLabels,
  type RpAction,
  type RpSetup,
  type RpState
} from './game'

export const ROLEPLAY_WORKFLOW_ID = 'roleplay.gm'

const CONFIG: PluginConfigField[] = [
  {
    key: 'protagonist',
    type: 'text',
    label: '主角设定',
    labelKey: 'yaya.rp.cfg.protagonist',
    description:
      '身份、性格、外貌等；留空 = 按开场 intro 或随机生成。主角在正文里写作 [[main]]，不起名字',
    descriptionKey: 'yaya.rp.cfg.protagonist_desc',
    default: ''
  },
  {
    key: 'main_name',
    type: 'string',
    label: '主角显示名',
    labelKey: 'yaya.rp.cfg.main_name',
    description:
      '正文里的 [[main]] 在界面上显示成这个名字；留空显示为「主角」标签。只影响显示，模型看不到',
    descriptionKey: 'yaya.rp.cfg.main_name_desc',
    default: ''
  },
  {
    key: 'pov',
    type: 'select',
    label: '故事人称',
    labelKey: 'yaya.rp.cfg.pov',
    default: 'third',
    options: [
      { value: 'third', label: '第三人称（用主角名）', labelKey: 'yaya.rp.pov.third' },
      { value: 'second', label: '第二人称（你）', labelKey: 'yaya.rp.pov.second' },
      { value: 'first', label: '第一人称（我）', labelKey: 'yaya.rp.pov.first' }
    ]
  },
  {
    key: 'genre',
    type: 'string',
    label: '故事题材',
    labelKey: 'yaya.rp.cfg.genre',
    description: '留空 = 按开场 intro 总结，没有就随机',
    descriptionKey: 'yaya.rp.cfg.genre_desc',
    default: ''
  },
  {
    key: 'style',
    type: 'string',
    label: '文风',
    labelKey: 'yaya.rp.cfg.style',
    default: '大众化的网文风'
  },
  {
    key: 'detail',
    type: 'number',
    label: '精细程度',
    labelKey: 'yaya.rp.cfg.detail',
    description: '1 = 流水账式讲故事，16 = 每个瞬间都细细描写；也决定每段的篇幅',
    descriptionKey: 'yaya.rp.cfg.detail_desc',
    default: 8,
    min: 1,
    max: 16,
    step: 1
  },
  {
    key: 'pace',
    type: 'select',
    label: '故事进展速度',
    labelKey: 'yaya.rp.cfg.pace',
    default: 'slow',
    options: [
      { value: 'slow', label: '慢热（短期内不制造太多冲突）', labelKey: 'yaya.rp.pace.slow' },
      { value: 'medium', label: '适中', labelKey: 'yaya.rp.pace.medium' },
      { value: 'fast', label: '快节奏', labelKey: 'yaya.rp.pace.fast' }
    ]
  },
  {
    key: 'mode',
    type: 'select',
    label: '游玩模式',
    labelKey: 'yaya.rp.cfg.mode',
    default: 'free',
    options: [
      { value: 'free', label: 'F 自由：不给选项，问一句是否继续', labelKey: 'yaya.rp.mode.free' },
      {
        value: 'interactive',
        label: 'I 互动：每段结尾给几个行动选项',
        labelKey: 'yaya.rp.mode.interactive'
      }
    ]
  },
  {
    key: 'tools',
    type: 'select',
    label: '可用的插件工具',
    labelKey: 'yaya.rp.cfg.tools',
    description: 'GM 可以先查资料再写；工具本身在插件页启用（如网页搜索）',
    descriptionKey: 'yaya.rp.cfg.tools_desc',
    default: 'search',
    options: [
      { value: 'search', label: '只用网页搜索', labelKey: 'yaya.rp.tools.search' },
      { value: 'all', label: '全部已启用的工具', labelKey: 'yaya.rp.tools.all' },
      { value: 'none', label: '不用插件工具', labelKey: 'yaya.rp.tools.none' }
    ]
  },
  {
    key: 'tool_rounds',
    type: 'number',
    label: '每段最多工具步数',
    labelKey: 'yaya.rp.cfg.tool_rounds',
    description: 'GM 查资料的轮数上限；用完后直接写正文',
    descriptionKey: 'yaya.rp.cfg.tool_rounds_desc',
    default: 4,
    min: 1,
    max: 20,
    step: 1
  },
  {
    key: 'memory',
    type: 'boolean',
    label: '故事记忆',
    labelKey: 'yaya.rp.cfg.memory',
    description:
      '每段之后由记录员整理剧情摘要、世界观与人物（多一次模型调用）；prompt 导出与长故事的连贯性都靠它',
    descriptionKey: 'yaya.rp.cfg.memory_desc',
    default: true
  }
]

/** 开局设定卡 / 导出卡 / 帮助卡的数据（RoleplayCard.vue 渲染） */
export interface RpSetupCardData {
  title: string
  setup: RpSetup
  world: number
  characters: { name: string; note: string }[]
}
export interface RpExportCardData {
  text: string
}

function num(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt
}

function lastUserText(ctx: WorkflowContext): string {
  const h = ctx.history()
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'user') return h[i].content ?? ''
  return ''
}

function exportLabels(): ExportLabels {
  return {
    heading: t('yaya.rp.export.heading', '角色扮演存档'),
    hint: t(
      'yaya.rp.export.hint',
      '新开一个对话，选「角色扮演」工作流，把这段整个发过去即可接着玩。'
    ),
    settings: t('yaya.rp.export.settings', '基础设定'),
    protagonist: t('yaya.rp.cfg.protagonist', '主角设定'),
    pov: t('yaya.rp.cfg.pov', '故事人称'),
    genre: t('yaya.rp.cfg.genre', '故事题材'),
    style: t('yaya.rp.cfg.style', '文风'),
    detail: t('yaya.rp.cfg.detail', '精细程度'),
    pace: t('yaya.rp.cfg.pace', '故事进展速度'),
    mode: t('yaya.rp.cfg.mode', '游玩模式'),
    world: t('yaya.rp.export.world', '世界观'),
    characters: t('yaya.rp.export.characters', '人物'),
    story: t('yaya.rp.export.story', '故事至今'),
    povText: {
      third: t('yaya.rp.pov.third', '第三人称（用主角名）'),
      second: t('yaya.rp.pov.second', '第二人称（你）'),
      first: t('yaya.rp.pov.first', '第一人称（我）')
    },
    paceText: {
      slow: t('yaya.rp.pace.slow', '慢热（短期内不制造太多冲突）'),
      medium: t('yaya.rp.pace.medium', '适中'),
      fast: t('yaya.rp.pace.fast', '快节奏')
    },
    modeText: {
      free: t('yaya.rp.mode.free', 'F 自由：不给选项，问一句是否继续'),
      interactive: t('yaya.rp.mode.interactive', 'I 互动：每段结尾给几个行动选项')
    },
    colon: t('yaya.rp.export.colon', '：')
  }
}

function actionLabel(a: RpAction): string {
  switch (a.kind) {
    case 'opening':
      return t('yaya.rp.act.opening', '开场')
    case 'revise':
      return t('yaya.rp.act.revise', '按意见重写开场')
    case 'continue':
      return a.guidance
        ? te('yaya.rp.act.continue_with', { text: a.guidance.slice(0, 60) }, '继续：{text}')
        : t('yaya.rp.act.continue', '继续（由 GM 推进）')
    case 'expand':
      return te('yaya.rp.act.expand', { text: a.aspect.slice(0, 60) || '—' }, '扩写：{text}')
    case 'export':
      return t('yaya.rp.act.export', '导出存档')
    case 'help':
      return t('yaya.rp.act.help', '命令帮助')
  }
}

async function runRoleplay(ctx: WorkflowContext): Promise<void> {
  const cfg = ctx.pluginConfig

  // ① 档案 + 命令
  const prev = normalizeState(ctx.loadState<RpState>())
  const action = await ctx.compute(
    t('yaya.rp.step.parse', '解析命令'),
    () => decide(parseCommand(lastUserText(ctx)), prev),
    { detail: actionLabel }
  )
  if (ctx.aborted) return

  if (action.kind === 'help') {
    ctx.addCard({
      type: 'roleplay-help',
      title: t('yaya.rp.help.title', '角色扮演命令'),
      markdown: t(
        'yaya.rp.help.markdown',
        '- `c [消息]` 继续故事，消息可选\n- `r <内容>` 扩写某个方面，不推进剧情\n- `prompt` 导出设定与世界观，贴到新对话里接着玩\n- 其余文字：开场前是 intro，开场后是对开场的意见，故事开始后等同 `c`'
      ),
      modelText: '(The app showed the command help to the user.)'
    })
    if (prev) ctx.saveState(prev)
    return
  }

  if (action.kind === 'export') {
    const state = prev
    const text = state ? exportText(state, effectiveSetup(cfg, state), exportLabels()) : ''
    const data: RpExportCardData = { text }
    ctx.addCard({
      type: 'roleplay-export',
      title: t('yaya.rp.export.title', '故事存档'),
      data,
      markdown: text || t('yaya.rp.export.empty', '还没有开始故事，没有可导出的内容。'),
      modelText: '(The app exported the story settings and memory for the user.)'
    })
    if (state) ctx.saveState(state)
    return
  }

  const opening = action.kind === 'opening' || action.kind === 'revise'
  // 开场前没有档案：GM 只按配置的默认设定与 intro 写，设定 Agent 在它写完后再记录
  const state = prev ?? emptyState()

  // ② GM：自组织（要不要先查资料由它决定）
  const external = pickExternalTools(ctx, toolScope(cfg.tools))
  const setupNow = effectiveSetup(cfg, prev)
  const gmLabel =
    action.kind === 'expand'
      ? t('yaya.rp.step.expand', 'GM：扩写')
      : action.kind === 'continue'
        ? t('yaya.rp.step.continue', 'GM：推进故事')
        : t('yaya.rp.step.opening', 'GM：开场')
  const { final } = await selfOrganizedLoop(ctx, {
    system: gmSystem(setupNow, ctx.assistantPrompt(), { tools: external.length > 0 }),
    extraSystem: turnInstructions(action, state),
    localTools: [],
    external,
    maxRounds: num(cfg.tool_rounds, 4, 1, 20) + 1,
    label: t('yaya.rp.step.research', 'GM：查资料'),
    finalLabel: gmLabel
  })
  if (ctx.aborted || !final) return

  let next: RpState = JSON.parse(JSON.stringify(state))

  // ③ 设定 Agent：开场 / 开场返工，记下 intro 与开场定下来的东西
  if (opening) {
    const out = await ctx.subAgent({
      agent: 'setup',
      label: t('yaya.rp.step.setup', '设定：主角、题材与世界'),
      system: setupAgentSystem(setupNow, prev)
    })
    if (ctx.aborted) return
    next = stateFromSetup(extractJson(out.content), prev, cfg)
    const setup = effectiveSetup(cfg, next)
    // 开局设定卡（模型看不到：设定之后会在 GM 的系统提示词里）
    const data: RpSetupCardData = {
      title: next.title,
      setup,
      world: next.world.length,
      characters: next.characters
    }
    ctx.addCard({
      type: 'roleplay-setup',
      title: next.title || t('yaya.rp.card.setup', '开局设定'),
      data,
      markdown: [
        `**${t('yaya.rp.cfg.protagonist', '主角设定')}**: ${setup.protagonist || '—'}`,
        `**${t('yaya.rp.cfg.genre', '故事题材')}**: ${setup.genre || '—'}`
      ].join('  \n')
    })
  }

  if (action.kind === 'continue') {
    next.phase = 'playing'
    next.turn += 1
  }

  // ④ 记录员：扩写不改变剧情，不记
  if (cfg.memory !== false && action.kind !== 'expand') {
    const chronicle = await ctx.subAgent({
      agent: 'chronicler',
      label: t('yaya.rp.step.chronicle', '记录员：更新故事记忆'),
      system: chroniclerSystem(next)
    })
    const merged = await ctx.compute(
      t('yaya.rp.step.merge', '合并故事记忆'),
      () => mergeChronicle(next, extractJson(chronicle.content)),
      {
        detail: (s) =>
          te(
            'yaya.rp.step.merge_detail',
            {
              world: String(s.world.length),
              characters: String(s.characters.length),
              summary: String(s.summary.length)
            },
            '世界观 {world} 条 · 人物 {characters} 个 · 剧情 {summary} 段'
          )
      }
    )
    next = merged
  }
  ctx.saveState(next)
}

export const roleplayWorkflow: WorkflowDefinition = {
  id: ROLEPLAY_WORKFLOW_ID,
  labelKey: 'yaya.rp.wf',
  label: '角色扮演',
  descriptionKey: 'yaya.rp.wf_desc',
  description:
    'GameMaster 带你玩文字角色扮演：先发 intro 开场，之后 c 继续 / r 扩写 / prompt 导出存档',
  icon: 'mdi-drama-masks',
  usesTools: true,
  run: runRoleplay
}

const plugin: YayaPlugin = {
  id: 'roleplay',
  kind: 'builtin',
  label: 'Roleplay 角色扮演',
  labelKey: 'yaya.rp.label',
  description:
    '给助手加一个「角色扮演」工作流：GameMaster 用文字带你体验你想象的世界（插件启用后在工作流菜单里选）',
  descriptionKey: 'yaya.rp.desc',
  icon: 'mdi-drama-masks',
  defaultEnabled: false,
  mentionable: false,
  docs: [
    '启用后，在输入框的工作流菜单（或助手的默认工作流）里选「角色扮演」，然后发出你的故事 intro。',
    'GM 先完善主角的出身、描绘 intro 的场景，问你是否满意：直接回复意见会重写开场，回复 `c` 开始。',
    'GM 每一段都自己决定要不要先查资料（网页搜索等，见配置「可用的插件工具」）再写。',
    '提示词里不追加插件的工具守则（隐私、凭据、审批说明），内容尺度交给模型自己判断。',
    '',
    '| 命令（不区分大小写） | 作用 |',
    '|---|---|',
    '| `c [消息]` | 继续故事；消息可选，是你对下一步的引导 |',
    '| `r <内容>` | 扩写某个方面，不推进剧情、不剧透 |',
    '| `prompt` | 导出设定、世界观与剧情摘要（由档案直接生成，不调模型），贴进新对话即可续玩 |',
    '| `help` | 显示命令 |',
    '',
    '故事开始后，不带命令头的文字等同于 `c 文字`。',
    '主角在正文里写作 `[[main]]`，界面上显示成配置里的「主角显示名」。',
    '',
    '下面的配置是默认设定；开场时你在 intro 里明确说了的（如「第一人称」「精细程度 12」「I 模式」）优先。',
    '助手自己的系统提示词不会被当作系统提示词，而是作为「用户补充说明」交给 GM。'
  ].join('\n'),
  tools: () => [],
  configSchema: CONFIG,
  workflows: () => [roleplayWorkflow]
}

export default plugin
