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
import type { MessageNode, Session, ToolCallItem, YayaConfig } from '../../types'
import type { ProviderMessage } from '../providers/types'

export interface AssistantStepOptions {
  /** 'enabled' = 本次运行可用的全部工具；'none' = 不给工具；或 wire name 白名单 */
  tools?: 'enabled' | 'none' | string[]
  /**
   * 替换助手的系统提示词（角色扮演这类自带人设的工作流用）；插件 instructions 与 extraSystem 照常追加。
   * 助手原来的系统提示词可经 `ctx.assistantPrompt()` 取到，自己决定要不要作为补充说明放进去。
   */
  system?: string
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

/** `ctx.addCard` 的参数，见 `WorkflowCardMeta` */
export interface WorkflowCardInput {
  type: string
  title?: string
  data?: unknown
  /** 没有自定义卡片视图时显示的 Markdown */
  markdown?: string
  /** 写进对话历史、之后的模型调用能看到的文字；不给 = 模型看不到这张卡 */
  modelText?: string
}

export interface ComputeOptions<T> {
  /** 结果在过程卡片里的展示（缺省：字符串原样，其余 JSON） */
  detail?: (result: T) => string
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
  /** 助手 / 会话的系统提示词（变量已替换）；还是出厂默认提示词时为空串 */
  assistantPrompt(): string
  /** 走一步主 Agent：流式写入一个 assistant 节点 */
  assistantStep(opts?: AssistantStepOptions): Promise<AssistantStepResult>
  /** 执行上一步产生的工具调用（含审批），结果节点接到对话树上 */
  runTools(step: AssistantStepResult): Promise<void>
  /** 不写进对话的子 Agent 调用（非流式），记进过程 */
  subAgent(opts: SubAgentOptions): Promise<{ content: string }>
  /** 往过程记录里加一条说明 */
  note(label: string, detail?: string): void
  /**
   * 非 AI 节点：纯计算 / 规则 / 随机数等，在过程卡片里显示为一步（耗时、结果）。
   * fn 抛错 = 这一步失败并把错误抛给工作流。
   */
  compute<T>(label: string, fn: () => T | Promise<T>, opts?: ComputeOptions<T>): Promise<T>
  /** 往对话里写一张数据卡片（不是 AI 的话），返回节点 id */
  addCard(card: WorkflowCardInput): string
  /** 本工作流在当前分支上最近一次保存的状态（重新生成 / 编辑重发时自动回到对应分支的状态） */
  loadState<T = unknown>(): T | undefined
  /** 把状态存到本次运行的回答节点上（每次运行最后一次保存为准） */
  saveState(state: unknown): void
  /** 插件工作流：所属插件的配置（默认值已填、secret 已解密）；内置工作流为 {} */
  readonly pluginConfig: Record<string, unknown>
}

export interface WorkflowDefinition {
  /** 全局唯一；插件工作流建议用 `<插件 id>.<名字>` */
  id: string
  /** 插件注入的工作流由注册表填上（插件不用自己写） */
  pluginId?: string
  /** mdi 图标 */
  icon?: string
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
