/**
 * YAYA 工作流（Workflow）契约。
 *
 * 一次「用户发消息 → 得到回答」= 一次工作流运行。宿主（`loop/runner.ts`）负责
 * 对话树落盘、流式广播、工具审批与执行、中止、过程记录；工作流只描述「怎么走」：
 *
 *   registerWorkflow({
 *     id: 'my-flow', label: '…', description: '…', usesTools: true,
 *     async run(ctx) {
 *       const plan = await ctx.subAgent({ agent: 'planner', label: '…', system: '…' })
 *       const step = await ctx.assistantStep({ tools: 'enabled', extraSystem: plan.content })
 *       if (step.toolCalls.length) await ctx.runTools(step)
 *     }
 *   })
 *
 * 写进对话的只有 `assistantStep`（每次一个 assistant 节点）与工具结果节点；
 * `subAgent` / `note` 只进过程记录（界面的过程卡片里可展开查看）。
 */
import type { MessageNode, Session, ToolCallItem, ToolDefinition, YayaConfig } from '../../types'
import type { ProviderMessage } from '../providers/types'

export interface AssistantStepOptions {
  /** 'enabled' = 配置里启用的全部工具；'none' = 不给工具；或显式列表 */
  tools?: 'enabled' | 'none' | ToolDefinition[]
  /** 追加到系统提示词后面的说明（如规划结果） */
  extraSystem?: string
  /** 过程记录里这一步的显示名（缺省「生成回答」/「思考与调用工具」） */
  label?: string
}

export interface AssistantStepResult {
  messageId: string
  content: string
  toolCalls: ToolCallItem[]
}

export interface SubAgentOptions {
  /** 子 Agent 名（过程卡片里的徽标），如 'planner' */
  agent: string
  /** 已翻译的步骤显示名 */
  label: string
  /** 子 Agent 的系统提示词 */
  system: string
  /** 缺省 = 当前分支的对话历史（不含主系统提示词） */
  messages?: ProviderMessage[]
  /** 子 Agent 输出是否作为 detail 记进过程（缺省 true） */
  recordOutput?: boolean
}

export interface WorkflowContext {
  readonly session: Session
  readonly config: YayaConfig
  readonly signal: AbortSignal
  /** 单次运行允许的 assistantStep 上限 */
  readonly maxSteps: number
  readonly aborted: boolean
  /** 当前分支的对话历史（已过滤空节点，不含系统提示词） */
  history(): ProviderMessage[]
  /** 走一步主 Agent：流式写入一个 assistant 节点 */
  assistantStep(opts?: AssistantStepOptions): Promise<AssistantStepResult>
  /** 执行上一步产生的工具调用（含审批），结果节点接到对话树上 */
  runTools(step: AssistantStepResult): Promise<void>
  /** 不写进对话的子 Agent 调用（非流式），记进过程 */
  subAgent(opts: SubAgentOptions): Promise<{ content: string }>
  /** 往过程记录里加一条说明 */
  note(label: string, detail?: string): void
}

export interface WorkflowDefinition {
  id: string
  /** 翻译键与中文兜底（主进程 `t()` 翻译） */
  labelKey: string
  label: string
  descriptionKey: string
  description: string
  usesTools: boolean
  run(ctx: WorkflowContext): Promise<void>
}

/** 工作流跑满步数仍未结束 */
export class MaxStepsError extends Error {
  constructor(public readonly steps: number) {
    super(`max steps ${steps} reached`)
  }
}

export type { MessageNode }
