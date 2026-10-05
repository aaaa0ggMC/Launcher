/**
 * 内置工作流：
 * - agent    —— 标准工具循环：思考 → 调工具 → 观察 → … → 回答（默认）
 * - chat     —— 纯对话：一次生成，不提供任何工具
 * - plan-act —— 先由规划子 Agent 把任务拆成步骤（不进对话，过程卡片可看），
 *               再由主 Agent 带着计划跑工具循环
 * - review   —— 正常回答后由审阅子 Agent 挑错，有实质问题时不带工具重写一版
 * - perspectives —— 专家 / 质疑 / 实用三个子 Agent 并行作答，主 Agent 综合（可用工具核实）
 */
import { t } from '../../../../main/process/i18n'
import { registerWorkflow } from './registry'
import { MaxStepsError, type WorkflowContext } from './types'

async function toolLoop(ctx: WorkflowContext, extraSystem?: string): Promise<void> {
  for (let i = 0; i < ctx.maxSteps; i++) {
    const step = await ctx.assistantStep({ tools: 'enabled', extraSystem })
    if (ctx.aborted || step.toolCalls.length === 0) return
    await ctx.runTools(step)
    if (ctx.aborted) return
  }
  throw new MaxStepsError(ctx.maxSteps)
}

registerWorkflow({
  id: 'agent',
  labelKey: 'yaya.wf.agent',
  label: '智能体',
  descriptionKey: 'yaya.wf.agent_desc',
  description: '按需调用工具（查系统、读写文件、执行命令），直到给出回答',
  usesTools: true,
  run: (ctx) => toolLoop(ctx)
})

registerWorkflow({
  id: 'chat',
  labelKey: 'yaya.wf.chat',
  label: '纯对话',
  descriptionKey: 'yaya.wf.chat_desc',
  description: '只聊天，不调用任何工具；更快、更省 tokens',
  usesTools: false,
  run: async (ctx) => {
    await ctx.assistantStep({ tools: 'none' })
  }
})

const PLANNER_SYSTEM = `You are the planning sub-agent of a desktop assistant that can use local tools \
(read/write files, run shell commands, call system commands, fetch URLs).
Read the conversation and write a short, concrete plan for answering the user's LAST message.
Rules:
- Output only a numbered list (at most 6 steps), each step one line, in the user's language.
- Name the kind of tool a step needs when one is needed; mark steps that change the system with "(needs approval)".
- If the request is simple enough to answer directly, output a single step saying so.
- Do not answer the request yourself.`

registerWorkflow({
  id: 'plan-act',
  labelKey: 'yaya.wf.plan_act',
  label: '先规划再执行',
  descriptionKey: 'yaya.wf.plan_act_desc',
  description: '规划 Agent 先拆出步骤，再按计划调用工具执行；适合多步骤任务',
  usesTools: true,
  run: async (ctx) => {
    const plan = await ctx.subAgent({
      agent: 'planner',
      label: t('yaya.wf.step.plan', '制定计划'),
      system: PLANNER_SYSTEM
    })
    if (ctx.aborted) return
    const extra = plan.content.trim()
      ? `A planning sub-agent proposed this plan. Follow it, adapt when tool results say otherwise, and keep the user informed:\n${plan.content.trim()}`
      : undefined
    await toolLoop(ctx, extra)
  }
})

// ---------------------------------------------------------------------------
// review —— 先回答，再由审阅子 Agent 挑错；有实质问题时按意见重写一版
// ---------------------------------------------------------------------------

/** 审阅子 Agent 认为不需要修改时只输出这个词 */
export const REVIEW_PASS = 'LGTM'

const REVIEWER_SYSTEM = `You are the reviewing sub-agent of a desktop assistant.
The conversation ends with the assistant's draft answer (and any tool results it used) to the user's last request.
Check the draft for: factual or logical errors, claims not supported by the tool results, missed parts of the request, \
unsafe or destructive suggestions, and code that would not work.
Rules:
- If there is nothing substantive to fix, output exactly ${REVIEW_PASS} and nothing else.
- Otherwise output a short bullet list of concrete problems and how to fix each, in the user's language.
- Do not rewrite the answer yourself; ignore style nitpicks.`

/** 审阅意见是否等于「通过」（容忍标点、大小写、代码块包裹） */
export function reviewPassed(text: string): boolean {
  const s = text
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/[.。!！\s]+$/g, '')
    .trim()
  return s.toUpperCase() === REVIEW_PASS || !s
}

registerWorkflow({
  id: 'review',
  labelKey: 'yaya.wf.review',
  label: '回答后自我审阅',
  descriptionKey: 'yaya.wf.review_desc',
  description:
    '先正常回答（可用工具），再由审阅 Agent 检查错误与遗漏；有问题时重写一版。更慢，更稳',
  usesTools: true,
  run: async (ctx) => {
    await toolLoop(ctx)
    if (ctx.aborted) return
    const review = await ctx.subAgent({
      agent: 'reviewer',
      label: t('yaya.wf.step.review', '审阅回答'),
      system: REVIEWER_SYSTEM
    })
    if (ctx.aborted) return
    if (reviewPassed(review.content)) {
      ctx.note(t('yaya.wf.step.review_pass', '审阅通过，无需修改'))
      return
    }
    await ctx.assistantStep({
      tools: 'none',
      label: t('yaya.wf.step.revise', '按审阅意见修订'),
      extraSystem: `A reviewing sub-agent found problems in your previous answer:\n${review.content.trim()}\n\nWrite the complete corrected answer to the user's last request now (not a diff, no mention of the review unless a correction matters to the user).`
    })
  }
})

// ---------------------------------------------------------------------------
// perspectives —— 多个子 Agent 并行从不同角度作答，主 Agent 综合（可再用工具核实）
// ---------------------------------------------------------------------------

export const PERSPECTIVES: Array<{
  agent: string
  labelKey: string
  label: string
  system: string
}> = [
  {
    agent: 'expert',
    labelKey: 'yaya.wf.persp.expert',
    label: '专家视角',
    system:
      "You are a domain expert. Answer the user's last message as thoroughly and accurately as you can, noting assumptions. You cannot use tools; say what would need checking."
  },
  {
    agent: 'skeptic',
    labelKey: 'yaya.wf.persp.skeptic',
    label: '质疑视角',
    system:
      "You are a careful skeptic. For the user's last message, list the pitfalls, edge cases, risks and common wrong answers, and what evidence would settle them. Be concise."
  },
  {
    agent: 'pragmatist',
    labelKey: 'yaya.wf.persp.pragmatist',
    label: '实用视角',
    system:
      "You are a pragmatic engineer. Give the simplest approach that actually works for the user's last message, with concrete steps or commands. Be brief."
  }
]

registerWorkflow({
  id: 'perspectives',
  labelKey: 'yaya.wf.perspectives',
  label: '多视角并行',
  descriptionKey: 'yaya.wf.perspectives_desc',
  description:
    '专家 / 质疑 / 实用三个子 Agent 并行作答，主 Agent 综合并按需用工具核实；适合方案选择与难题',
  usesTools: true,
  run: async (ctx) => {
    const results = await Promise.allSettled(
      PERSPECTIVES.map((p) =>
        ctx.subAgent({ agent: p.agent, label: t(p.labelKey, p.label), system: p.system })
      )
    )
    if (ctx.aborted) return
    const views = results
      .map((r, i) =>
        r.status === 'fulfilled' && r.value.content.trim()
          ? `## ${PERSPECTIVES[i].agent}\n${r.value.content.trim()}`
          : ''
      )
      .filter(Boolean)
    const extra = views.length
      ? `Sub-agents answered the user's last message independently from different angles:\n\n${views.join('\n\n')}\n\nSynthesize one answer: keep what is correct, resolve disagreements (use tools to verify when it matters), and do not mention the sub-agents unless useful.`
      : undefined
    await toolLoop(ctx, extra)
  }
})
