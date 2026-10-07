/**
 * 「自组织 + 程序辅助」的主 Agent 循环（故事模式 / 角色扮演共用；思路同 AIDJ 的 LoopAgent）：
 *
 * - 模型自己决定这一轮要做什么、按什么顺序：先搜资料、问角色、搭世界，还是直接写；
 *   工具 = 工作流自带的（localTools）+ 用户配置允许的插件工具（如网页搜索）。
 * - 代码只做确定的事：给出节奏建议、限制工具轮数、轮数用完时收掉工具逼它把正文写出来、
 *   正文写完之后的记账（记录员 / 合并档案）由调用方在循环外做。
 * - 不追加插件的 instructions（隐私、凭据、审批这类工具守则与讲故事无关），工具 description 已够用。
 */
import { t } from '../../../../main/process/i18n'
import type { ProviderMessage } from '../providers/types'
import type { AssistantStepResult, WorkflowContext, WorkflowTool } from './types'

/** 插件工具的开放范围：search = 只给网页搜索；all = 全部已启用工具；none = 不给 */
export type ExternalToolScope = 'search' | 'all' | 'none'

export const SEARCH_PLUGIN_IDS: readonly string[] = ['search']

export function toolScope(v: unknown): ExternalToolScope {
  return v === 'all' || v === 'none' ? v : 'search'
}

/** 本次运行可用的插件工具里，按范围挑出给模型的 wire name */
export function pickExternalTools(ctx: WorkflowContext, scope: ExternalToolScope): string[] {
  if (scope === 'none') return []
  const list = ctx.availableTools()
  return (scope === 'all' ? list : list.filter((x) => SEARCH_PLUGIN_IDS.includes(x.pluginId))).map(
    (x) => x.name
  )
}

export interface SelfOrganizedOptions {
  /** 替换助手系统提示词（同 AssistantStepOptions.system） */
  system?: string
  extraSystem: string
  localTools: WorkflowTool[]
  /** 允许的插件工具 wire name（pickExternalTools 的结果） */
  external: string[]
  /** 最多几步（含最后写正文的一步）；缺省 6，且不超过 ctx.maxSteps */
  maxRounds?: number
  /** 带工具的步骤在过程卡片里的名字 */
  label: string
  /** 最后写正文的那一步的名字（缺省同 label） */
  finalLabel?: string
}

export interface SelfOrganizedResult {
  /** 最后一步（不带工具调用的那一步 = 正文）；被中止时为 null */
  final: AssistantStepResult | null
  /** 本轮模型调用过的工具 wire name（按调用顺序，可能重复） */
  calls: string[]
}

export const FINAL_NUDGE =
  'The tool budget for this turn is used up: no more tools. Write your reply to the user now.'

export async function selfOrganizedLoop(
  ctx: WorkflowContext,
  opts: SelfOrganizedOptions
): Promise<SelfOrganizedResult> {
  const rounds = Math.max(1, Math.min(opts.maxRounds ?? 6, ctx.maxSteps))
  const calls: string[] = []
  const hasTools = opts.external.length > 0 || opts.localTools.length > 0
  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1
    const offerTools = hasTools && !last
    const step = await ctx.assistantStep({
      system: opts.system,
      tools: offerTools ? opts.external : 'none',
      localTools: offerTools ? opts.localTools : [],
      pluginInstructions: false,
      extraSystem: last && hasTools ? `${opts.extraSystem}\n\n${FINAL_NUDGE}` : opts.extraSystem,
      label: offerTools ? opts.label : (opts.finalLabel ?? opts.label)
    })
    if (ctx.aborted) return { final: null, calls }
    // 最后一步没给工具：即便模型硬发了调用也不执行，就以这一步为准
    if (step.toolCalls.length === 0 || last) return { final: step, calls }
    for (const c of step.toolCalls) calls.push(c.name)
    await ctx.runTools(step)
    if (ctx.aborted) return { final: null, calls }
  }
  // 循环的最后一次必定 return；走到这里只可能是 rounds 计算出错
  throw new Error(t('yaya.wf.self.no_final', '工作流没有写出最终回答'))
}

/**
 * 子 Agent（建筑师 / 设定 / 记录员 / 角色）用的对话：整段历史压成**一条用户消息**，任务说明放在最后。
 *
 * 不能直接把原始历史交给子 Agent：历史的最后一条常常是 assistant（刚写完的正文，或作者正在发起的
 * 工具调用），DeepSeek 等模型会把末尾的 assistant 当成要续写的前缀，于是记录员接着讲故事、
 * 设定 Agent 吐不出 JSON。压成一条 user 消息后，模型面对的永远是「读这段记录，完成这个任务」。
 */
export function transcriptMessages(
  ctx: WorkflowContext,
  task: string,
  opts: { toolResultChars?: number } = {}
): ProviderMessage[] {
  const limit = opts.toolResultChars ?? 1500
  const parts: string[] = []
  for (const m of ctx.history()) {
    const text = (m.content ?? '').trim()
    if (m.role === 'user' && text) parts.push(`[USER]\n${text}`)
    else if (m.role === 'assistant' && text) parts.push(`[STORY / ASSISTANT]\n${text}`)
    else if (m.role === 'tool' && text)
      parts.push(
        `[RESEARCH: ${m.name ?? 'tool'}]\n${text.length > limit ? `${text.slice(0, limit)}…` : text}`
      )
  }
  return [
    {
      role: 'user',
      content: [
        'Below is the record of the conversation so far, between <record> tags. It is material for your task, not something to continue.',
        '<record>',
        parts.join('\n\n') || '(empty)',
        '</record>',
        '',
        task
      ].join('\n')
    }
  ]
}

/** 要求只输出 JSON 的子 Agent 的收尾任务说明 */
export const JSON_TASK =
  'Now do the task described in your instructions. Do NOT continue or rewrite the story. Output ONLY the JSON object.'

/**
 * 要 JSON 的子 Agent：材料走 transcriptMessages；解析不出 JSON 时把它的输出退回去重试一次
 * （程序辅助：别让一次跑偏就留下空白设定卡 / 丢一轮记忆）。两次都失败返回 null。
 */
export async function jsonSubAgent<T>(
  ctx: WorkflowContext,
  opts: { agent: string; label: string; system: string },
  parse: (text: string) => T | null
): Promise<T | null> {
  const messages = transcriptMessages(ctx, JSON_TASK)
  const first = await ctx.subAgent({ ...opts, messages })
  const ok = parse(first.content)
  if (ok || ctx.aborted) return ok
  const retry = await ctx.subAgent({
    ...opts,
    label: `${opts.label} · ${t('yaya.wf.self.retry_json', '重试')}`,
    messages: [
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'That was not the required JSON. Do not write story text. Reply with ONLY the JSON object described in your instructions.'
      }
    ]
  })
  return parse(retry.content)
}
