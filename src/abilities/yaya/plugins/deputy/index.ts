/**
 * 内置 deputy 插件：副代理（子 Agent）。
 *
 * - 工具 `deputy_dispatch`：主 Agent 把一个或几个**独立、自带完整背景**的子任务交给副代理并行去做。
 *   每个副代理有自己的对话与工具循环（`ctx.workflow.runAgent`），只把最终报告交回主 Agent，
 *   中间的工具输出不进主对话（主上下文保持干净）。副代理的工具调用照常审批，过程卡片里可展开查看。
 * - 工作流 `deputy.dispatch`「分派模式」：先由分派子 Agent 把用户的请求拆成可并行的子任务，
 *   副代理并行执行，主 Agent 拿着各份报告（可再用工具核实）写出回答。请求简单时不拆，直接回答。
 *
 * 副代理不能再派副代理（本插件的工具不交给副代理），避免递归。
 * 提示词固定英文（稳定，提示词缓存友好），报告语言跟随任务。
 */
import { t, te } from '../../../../main/process/i18n'
import type {
  PluginConfigField,
  ToolWorkflowHandle,
  YayaPlugin
} from '../../services/plugins/types'
import type {
  AgentRunResult,
  AvailableTool,
  WorkflowContext,
  WorkflowDefinition
} from '../../services/workflow/types'
import { MaxStepsError } from '../../services/workflow/types'

export const PLUGIN_ID = 'deputy'
export const DISPATCH_WORKFLOW_ID = 'deputy.dispatch'
/** 一次最多派几个副代理 */
export const MAX_TASKS = 6

const CONFIG: PluginConfigField[] = [
  {
    key: 'maxParallel',
    type: 'number',
    label: '同时运行的副代理数',
    labelKey: 'yaya.deputy.cfg.parallel',
    description: '超出的排队等前面的做完',
    descriptionKey: 'yaya.deputy.cfg.parallel_desc',
    default: 3,
    min: 1,
    max: MAX_TASKS,
    step: 1
  },
  {
    key: 'maxRounds',
    type: 'number',
    label: '每个副代理最多几轮',
    labelKey: 'yaya.deputy.cfg.rounds',
    description: '一轮 = 一次模型调用（可带多个工具调用）；用完后收掉工具让它写报告',
    descriptionKey: 'yaya.deputy.cfg.rounds_desc',
    default: 8,
    min: 2,
    max: 30,
    step: 1
  },
  {
    key: 'toolScope',
    type: 'select',
    label: '副代理可用的工具',
    labelKey: 'yaya.deputy.cfg.scope',
    default: 'all',
    options: [
      { value: 'all', label: '与主 Agent 相同', labelKey: 'yaya.deputy.scope.all' },
      { value: 'readonly', label: '只给免确认的工具', labelKey: 'yaya.deputy.scope.readonly' },
      { value: 'none', label: '不给工具（只动脑）', labelKey: 'yaya.deputy.scope.none' }
    ]
  }
]

export interface DeputyTask {
  name: string
  task: string
  tools?: string[]
}

export interface DeputyOutcome {
  name: string
  task: string
  status: 'ok' | 'error' | 'stopped'
  report: string
  error?: string
  calls: number
  failedCalls: number
  rounds: number
  tokens: number
  exhausted: boolean
}

/** 工具结果的 display（界面 DeputyResultView 用） */
export interface DeputyDisplay {
  deputies: DeputyOutcome[]
}

export const DEPUTY_SYSTEM = `You are a deputy agent: a sub-agent that a main assistant sent to do ONE task.
You only see the task below, not the user's conversation; the brief is all the context you get.
Rules:
- Work autonomously with the tools you have. Nobody will answer questions, so make reasonable assumptions and state them.
- Be efficient: do not repeat a tool call that already answered the question; stop as soon as the task is done.
- Do not do more than the task asks, and never take destructive actions the task did not explicitly ask for.
- Finish with a report for the main assistant, in the task's language: the result first, then the evidence it rests on \
(file paths, command output, URLs, numbers), then anything you could not verify. Keep it under about 400 words unless the task asks for full content.`

const TOOL_DESCRIPTION = `Send one or more deputy agents (sub-agents with their own tool loop) to do independent tasks in parallel. \
Each deputy sees ONLY its brief (not this conversation) and returns a written report; its intermediate tool output stays out of your context.
Use it for: independent pieces of a larger job (research several things, inspect several files/hosts, compare options), \
long tool-heavy digging whose details you do not need, or a second opinion. Do not use it for a single quick tool call you can make yourself.
Write each brief so a capable stranger could do it: goal, all relevant facts from the conversation (paths, names, constraints), \
what to return. Deputies cannot send deputies, and tools that need approval still ask the user.`

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def
}

/** 工具参数 → 任务列表（容忍模型把单个任务直接写在顶层） */
export function parseTasks(args: Record<string, unknown>): DeputyTask[] {
  const raw = Array.isArray(args.tasks) ? args.tasks : args.task ? [args] : []
  const out: DeputyTask[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const task = str(o.task) || str(o.brief) || str(o.prompt)
    if (!task) continue
    const tools = Array.isArray(o.tools) ? o.tools.map(str).filter(Boolean) : undefined
    out.push({
      name: (str(o.name) || `#${out.length + 1}`).slice(0, 40),
      task,
      ...(tools?.length ? { tools } : {})
    })
  }
  return out.slice(0, MAX_TASKS)
}

/** 交给副代理的工具：去掉本插件自己的（不递归）→ 按范围 → 按任务白名单 */
export function deputyTools(
  available: AvailableTool[],
  scope: string,
  whitelist?: string[]
): string[] {
  if (scope === 'none') return []
  let list = available.filter((x) => x.pluginId !== PLUGIN_ID)
  if (scope === 'readonly') list = list.filter((x) => x.approval === 'auto')
  if (whitelist?.length) list = list.filter((x) => whitelist.includes(x.name))
  return list.map((x) => x.name)
}

/** 简单的并发上限 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

function outcome(task: DeputyTask, res: AgentRunResult): DeputyOutcome {
  return {
    name: task.name,
    task: task.task,
    status: 'ok',
    report: res.content.trim(),
    calls: res.calls.length,
    failedCalls: res.calls.filter((c) => c.status === 'failed').length,
    rounds: res.rounds,
    tokens: res.tokens,
    exhausted: res.exhausted
  }
}

/** 并行跑一组副代理；单个失败不影响其他（被用户停止则整体抛出） */
export async function runDeputies(
  handle: Pick<ToolWorkflowHandle, 'runAgent' | 'availableTools'>,
  tasks: DeputyTask[],
  cfg: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {}
): Promise<DeputyOutcome[]> {
  const parallel = num(cfg.maxParallel, 3, 1, MAX_TASKS)
  const rounds = num(cfg.maxRounds, 8, 2, 30)
  const scope = str(cfg.toolScope) || 'all'
  const available = handle.availableTools()
  return mapLimit(tasks, parallel, async (task) => {
    if (opts.signal?.aborted)
      return { ...outcome(task, emptyRun()), status: 'stopped' as const, report: '' }
    try {
      const res = await handle.runAgent({
        agent: 'deputy',
        label: task.name,
        system: DEPUTY_SYSTEM,
        task: task.task,
        tools: deputyTools(available, scope, task.tools),
        maxRounds: rounds
      })
      return outcome(task, res)
    } catch (e) {
      if (opts.signal?.aborted) throw e
      return {
        ...outcome(task, emptyRun()),
        status: 'error' as const,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })
}

function emptyRun(): AgentRunResult {
  return { content: '', calls: [], rounds: 0, tokens: 0, exhausted: false }
}

/** 交给主 Agent 的文字：每个副代理一节 */
export function reportText(list: DeputyOutcome[]): string {
  return list
    .map((d) => {
      const head = `## Deputy "${d.name}" — ${d.status}${d.exhausted ? ' (ran out of rounds)' : ''}`
      const meta = `(${d.calls} tool calls${d.failedCalls ? `, ${d.failedCalls} failed` : ''})`
      const body =
        d.status === 'ok' ? d.report || '(empty report)' : `Error: ${d.error ?? d.status}`
      return `${head} ${meta}\n${body}`
    })
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// 分派模式工作流
// ---------------------------------------------------------------------------

export const DISPATCHER_SYSTEM = `You are the dispatcher of a desktop assistant that can send deputy agents (sub-agents with tools) to work in parallel.
Read the conversation and decide whether the user's LAST message has 2 or more independent parts worth doing in parallel \
(e.g. research several topics, inspect several files or services, compare several options).
Output ONLY a JSON object: {"tasks":[{"name":"<2-5 word label in the user's language>","task":"<self-contained brief>"}]}
- Each brief must contain everything a deputy needs (it will NOT see the conversation): goal, relevant facts, what to report back.
- At most ${MAX_TASKS} tasks. Tasks must not depend on each other.
- If the request is simple, conversational, or not parallelizable, output {"tasks":[]} and the main assistant will answer directly.`

/** 从分派子 Agent 的输出里取 JSON（容忍代码块包裹、前后多余文字） */
export function parseDispatch(text: string): DeputyTask[] | null {
  const s = text.replace(/```(?:json)?/gi, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
    return Array.isArray(obj.tasks) ? parseTasks(obj) : null
  } catch {
    return null
  }
}

async function toolLoop(ctx: WorkflowContext, extraSystem?: string): Promise<void> {
  for (let i = 0; i < ctx.maxSteps; i++) {
    const step = await ctx.assistantStep({ tools: 'enabled', extraSystem })
    if (ctx.aborted || step.toolCalls.length === 0) return
    await ctx.runTools(step)
    if (ctx.aborted) return
  }
  throw new MaxStepsError(ctx.maxSteps)
}

const dispatchWorkflow: WorkflowDefinition = {
  id: DISPATCH_WORKFLOW_ID,
  icon: 'mdi-account-multiple-outline',
  labelKey: 'yaya.deputy.wf',
  label: '分派模式',
  descriptionKey: 'yaya.deputy.wf_desc',
  description:
    '能并行的请求先拆成子任务，交给多个副代理同时去做，再由主 Agent 汇总；简单问题直接回答',
  usesTools: true,
  async run(ctx) {
    const plan = await ctx.subAgent({
      agent: 'dispatcher',
      label: t('yaya.deputy.step.dispatch', '拆分任务'),
      system: DISPATCHER_SYSTEM
    })
    if (ctx.aborted) return
    const tasks = parseDispatch(plan.content) ?? []
    if (!tasks.length) {
      ctx.note(t('yaya.deputy.step.direct', '无需拆分，直接回答'))
      await toolLoop(ctx)
      return
    }
    const results = await runDeputies(
      {
        availableTools: () => ctx.availableTools(),
        runAgent: (o) => ctx.runAgent(o)
      },
      tasks,
      ctx.pluginConfig,
      { signal: ctx.signal }
    )
    if (ctx.aborted) return
    ctx.note(
      te(
        'yaya.deputy.step.done',
        {
          n: String(results.filter((r) => r.status === 'ok').length),
          total: String(results.length)
        },
        '副代理完成 {n}/{total}'
      )
    )
    await toolLoop(
      ctx,
      `Deputy agents worked on parts of the user's last message in parallel. Their reports:\n\n${reportText(results)}\n\n` +
        'Write the answer to the user from these reports: combine them, resolve conflicts (use tools to verify when it matters), ' +
        'and say plainly what is still uncertain. Do not mention deputies unless it helps the user.'
    )
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

const plugin: YayaPlugin = {
  id: PLUGIN_ID,
  kind: 'builtin',
  label: 'Deputy 副代理',
  labelKey: 'yaya.deputy.label',
  description:
    '让 AI 把独立的子任务交给副代理（带工具的子 Agent）并行去做，只收回报告；另带「分派模式」工作流',
  descriptionKey: 'yaya.deputy.desc',
  icon: 'mdi-account-multiple-outline',
  defaultEnabled: true,
  docs: `**副代理**是带工具的子 Agent：主 Agent 用 \`deputy_dispatch\` 交给它一段自带完整背景的任务，它自己调用工具做完，
只把报告交回来。中间的工具输出不进主对话，主上下文更干净；多个副代理可以并行。

- 副代理的工具调用照常审批；过程卡片里每个副代理是一步，展开可看它调了哪些工具。
- 副代理看不到对话，也不能再派副代理。
- 工作流「分派模式」：先拆任务、并行派副代理、最后主 Agent 汇总（可在输入框的工作流菜单里选）。`,
  configSchema: CONFIG,
  tools: () => [
    {
      name: 'dispatch',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_TASKS,
            description: 'Independent tasks; each runs in its own deputy, in parallel.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Short label shown to the user (2-5 words, user language)'
                },
                task: {
                  type: 'string',
                  description: 'Self-contained brief: goal, all needed context, what to report back'
                },
                tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional: restrict this deputy to these tool names'
                }
              },
              required: ['name', 'task']
            }
          }
        },
        required: ['tasks']
      },
      approval: 'auto',
      // 副代理可能跑很久（还要等审批）；停止由用户控制
      timeoutMs: 2 * 60 * 60 * 1000,
      async run(args, ctx) {
        if (!ctx.workflow)
          throw new Error(t('yaya.deputy.err.no_workflow', '副代理只能在对话的工作流里使用'))
        const tasks = parseTasks(args)
        if (!tasks.length)
          throw new Error(
            t('yaya.deputy.err.no_tasks', '没有可执行的任务：tasks 里每项都需要 task')
          )
        const deputies = await runDeputies(ctx.workflow, tasks, ctx.config ?? {}, {
          signal: ctx.signal
        })
        const display: DeputyDisplay = { deputies }
        return {
          content: [{ type: 'text', text: reportText(deputies) }],
          display,
          isError: deputies.every((d) => d.status !== 'ok')
        }
      }
    }
  ],
  workflows: () => [dispatchWorkflow]
}

export default plugin
