/**
 * 内置工作流：
 * - agent    —— 标准工具循环：思考 → 调工具 → 观察 → … → 回答（默认）
 * - chat     —— 纯对话：一次生成，不提供任何工具
 * - plan-act —— 先由规划子 Agent 把任务拆成步骤（不进对话，过程卡片可看），
 *               再由主 Agent 带着计划跑工具循环
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
