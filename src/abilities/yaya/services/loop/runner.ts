/**
 * YAYA 工作流宿主 (Workflow Host)
 *
 * 为一次运行实现 `WorkflowContext`（见 `../workflow/types.ts`），再把控制权交给选中的工作流。
 * 宿主保证：
 * - 每个 assistant 节点结束时一定落到终态（completed / interrupted / error），不留悬空的 streaming；
 * - 流式内容先进内存缓冲（`buffered*`），`yaya.messages-branch` 读取时叠加到 DB 内容上，
 *   渲染端任何时候重拉都拿到完整的进行中文本；
 * - 过程记录（WorkflowRecord）挂在本次运行的第一个 assistant 节点的 `meta.workflow` 上，
 *   每次变化落盘并广播快照；
 * - 工具来自插件注册表，执行时打 `local-agent` 来源（隐私 SDK 的脱敏 / 授权 / deny 照常生效）；
 * - 运行期间登记为 agent 会话（AgentBar 出现头像），用户可暂停 / 继续 / 停止：
 *   每步开始、每次工具调用前过暂停闸门；
 * - 组装历史时修复悬空的 tool_calls（打断后缺结果的调用补一条「已中断」），打断不需要回滚。
 */
import { randomUUID } from 'node:crypto'
import { normalizeEffort } from '../providers/reasoning'
import { getBroadcast } from '../../../../main/process/broadcast'
import { makeLogger } from '../../../../main/process/logger'
import { t, te } from '../../../../main/process/i18n'
import type {
  ApprovalScope,
  MessageAttachment,
  ReasoningEffort,
  Session,
  ToolCallItem,
  TokenUsage,
  WorkflowRecord,
  WorkflowStepRecord
} from '../../types'
import {
  insertMessage,
  updateMessage,
  getMessage,
  getMessageBranch,
  getSession,
  updateSession
} from '../db'
import { normalizeAssistantName, resolveSystemPrompt } from '../config'
import {
  buildPluginInstructions,
  normalizeToolResult,
  resolveTools,
  runPluginTool,
  toolNeedsApproval,
  type ResolvedTool
} from '../plugins/registry'
import type { ProviderMessage, ProviderTool } from '../providers/types'
import type { ToolSessionContext } from '../plugins/types'
import { withOrigin, type CallOrigin } from '../../../../main/process/privacy'
import { currentBrowserClient, withBrowserClient } from '../../../../main/process/browser-ui'
import {
  endSession,
  setSessionAttention,
  setSessionControl,
  setSessionPaused,
  touchSession
} from '../../../../main/process/agent/sessions'
import { resolveWorkflow, workflowLabel } from '../workflow/registry'
import {
  MaxStepsError,
  type AssistantStepOptions,
  type AssistantStepResult,
  type SubAgentOptions,
  type WorkflowContext,
  type WorkflowDefinition
} from '../workflow/types'
import type { LoopContext, WorkflowSnapshot, WorkflowStatus } from './types'

const log = makeLogger('yaya-loop')

interface ApprovalDecision {
  approved: boolean
  reason?: string
  scope?: ApprovalScope
}

/** 用户主动停止时写进 message.error 的标记，界面据此显示「已停止」而不是错误横幅 */
export const ABORTED_MARK = 'aborted'

export class WorkflowRunner {
  private ctx: LoopContext
  private approvalResolver: ((decision: ApprovalDecision) => void) | null = null
  private abortController = new AbortController()
  private readonly startedAt = Date.now()
  private bufferedContent = ''
  private bufferedReasoning = ''
  /** 本次运行第一个 assistant 节点（过程记录挂在它上面），首个 assistantStep 复用它 */
  private readonly anchorId: string
  private anchorUsed = false
  /** 对话树上的当前末端（下一个节点的 parent） */
  private parentId: string
  private stepCount = 0
  private record: WorkflowRecord | null = null
  private session: Session | null = null
  /** 本次运行可用的工具（运行开始时解析一次，保证整轮工具表稳定 → 提示词缓存友好） */
  private tools: ResolvedTool[] = []
  private paused = false
  private resumeWaiters: (() => void)[] = []
  /**
   * 发起本次运行的浏览器标签页（无头 B5）：在构造函数（还在启动命令的调用链里）时捕获，
   * 工具调用时恢复——`ui.*` 因此只操作这个页面，隐私来源仍是 local-agent。
   * Electron 下为 null（界面操作走 CDP inspector）。
   */
  private readonly browserClient: string | null = null
  /** 最近一次主循环模型调用的 usage（给插件 SDK 的 ctx.context） */
  private lastUsage: TokenUsage | null = null

  constructor(ctx: LoopContext) {
    this.ctx = ctx
    this.anchorId = ctx.assistantMessageId
    this.parentId = ctx.userMessageId
    this.browserClient = currentBrowserClient()
  }

  get sessionId(): string {
    return this.ctx.sessionId
  }

  get status(): WorkflowStatus {
    return this.ctx.status
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted
  }

  /** 当前进行中节点的内存缓冲（给 messages-branch 叠加） */
  liveBuffer(): { messageId: string; content: string; reasoning: string } {
    return {
      messageId: this.ctx.assistantMessageId,
      content: this.bufferedContent,
      reasoning: this.bufferedReasoning
    }
  }

  /** agent 会话 id（AgentBar / 隐私授权按它记） */
  get agentSessionId(): string {
    return `yaya:${this.ctx.sessionId}:${this.anchorId}`
  }

  private get origin(): CallOrigin {
    return {
      kind: 'local-agent',
      session: this.agentSessionId,
      client: normalizeAssistantName(this.ctx.config.assistantName)
    }
  }

  pause(): void {
    if (this.paused || this.aborted) return
    this.paused = true
    setSessionPaused(this.agentSessionId, true)
    this.emitSnapshot()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    setSessionPaused(this.agentSessionId, false)
    for (const w of this.resumeWaiters.splice(0)) w()
    this.emitSnapshot()
  }

  /** 暂停闸门：每步开始、每次工具调用前调用；暂停中就等继续或停止 */
  private async gate(): Promise<void> {
    if (!this.paused || this.aborted) return
    const before = this.ctx.status
    this.setStatus('paused')
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    if (!this.aborted) this.setStatus(before)
  }

  abort(): void {
    if (this.aborted) return
    this.abortController.abort()
    // 暂停中的闸门放行，让流程走到终止分支
    for (const w of this.resumeWaiters.splice(0)) w()
    this.paused = false
    // 挂起中的审批视为拒绝，让流程自然收尾
    this.resolveApproval(false)
    this.ctx.status = 'interrupted'
    updateMessage(this.ctx.assistantMessageId, {
      content: this.bufferedContent,
      reasoningContent: this.bufferedReasoning || undefined,
      status: 'interrupted',
      error: ABORTED_MARK
    })
    this.finishRecord('stopped')
    this.emitSnapshot()
  }

  /**
   * 用户对挂起工具调用的决定；拒绝时可附理由（会作为工具结果回传给模型）。
   * 批准可带范围：run = 本次执行里同一工具不再询问；session = 记进会话，本对话都不再询问。
   * 只跳过 YAYA 的工具审批——工具内部的隐私授权（guard）照样会弹。
   */
  resolveApproval(approved: boolean, reason?: string, scope: ApprovalScope = 'once'): void {
    if (this.approvalResolver) {
      this.approvalResolver({
        approved,
        reason: reason?.trim().slice(0, 2000) || undefined,
        scope
      })
      this.approvalResolver = null
    }
  }

  /** 本次执行里已「都允许」的工具（wire name） */
  private runApproved = new Set<string>()

  /** 本次执行或本对话已免确认 */
  private preApproved(name: string): boolean {
    if (this.runApproved.has(name)) return true
    const list = this.session?.meta?.approvedTools
    return Array.isArray(list) && list.includes(name)
  }

  private rememberApproval(name: string, scope: ApprovalScope | undefined): void {
    if (scope === 'run') this.runApproved.add(name)
    if (scope !== 'session') return
    // 以数据库里的最新会话为准（运行期间用户可能在别处改过 meta）
    const fresh = getSession(this.ctx.sessionId) ?? this.session
    if (!fresh) return
    const list = Array.isArray(fresh.meta?.approvedTools)
      ? (fresh.meta.approvedTools as string[])
      : []
    if (list.includes(name)) return
    const meta = { ...(fresh.meta ?? {}), approvedTools: [...list, name] }
    updateSession(this.ctx.sessionId, { meta })
    this.session = { ...fresh, meta }
    getBroadcast()('cockpit:yaya-sessions-changed', {})
  }

  getSnapshot(): WorkflowSnapshot {
    return {
      sessionId: this.ctx.sessionId,
      messageId: this.ctx.assistantMessageId,
      status: this.ctx.status,
      currentStep: this.stepCount,
      maxSteps: this.ctx.maxSteps,
      pendingApprovalTool: this.ctx.pendingApprovalTool,
      bufferedTokens: this.bufferedContent,
      bufferedReasoning: this.bufferedReasoning,
      startedAt: this.startedAt
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot()
    this.ctx.onUpdate?.(snap)
    getBroadcast()('cockpit:yaya-loop', snap)
  }

  private setStatus(status: WorkflowStatus): void {
    this.ctx.status = status
    this.emitSnapshot()
  }

  // ---------------------------------------------------------------------------
  // 运行
  // ---------------------------------------------------------------------------

  async run(): Promise<void> {
    const session = getSession(this.ctx.sessionId)
    if (!session) throw new Error(`Session ${this.ctx.sessionId} not found`)
    this.session = session
    const workflow = resolveWorkflow(
      (session.meta?.workflow as string | undefined) ?? this.ctx.config.defaultWorkflow
    )
    this.record = {
      runId: randomUUID(),
      workflowId: workflow.id,
      label: workflowLabel(workflow),
      status: 'running',
      startedAt: this.startedAt,
      steps: [],
      tokens: 0
    }
    this.persistRecord()
    log.info('workflow start', { session: session.id, workflow: workflow.id })

    // 登记为 agent 会话：标题栏出现头像，用户可以在那里暂停 / 停止
    touchSession(this.agentSessionId, 'local', this.origin.client ?? 'YAYA', () => this.abort())
    setSessionControl(
      this.agentSessionId,
      {
        pause: () => this.pause(),
        resume: () => this.resume(),
        stop: () => this.abort(),
        approve: (ok, scope) => this.resolveApproval(ok, undefined, scope)
      },
      'yaya',
      { session: this.ctx.sessionId }
    )

    try {
      this.tools = workflow.usesTools ? await resolveTools(this.ctx.config) : []
      await workflow.run(this.buildContext(workflow))
      if (this.aborted) return
      this.closeOpenNode()
      this.finishRecord('ok')
      this.setStatus('completed')
    } catch (err: unknown) {
      if (this.aborted) return // abort() 已落盘
      const errMsg =
        err instanceof MaxStepsError
          ? te(
              'yaya.err.max_steps',
              { n: String(err.steps) },
              '已达到最大循环步数（{n}），工作流停止'
            )
          : err instanceof Error
            ? err.message
            : String(err)
      log.error('workflow failed', { error: errMsg })
      this.failCurrentNode(errMsg)
      this.finishRecord('error')
      this.setStatus('error')
    } finally {
      endSession(this.agentSessionId)
    }
  }

  private buildContext(workflow: WorkflowDefinition): WorkflowContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this
    return {
      session: this.session!,
      config: this.ctx.config,
      signal: this.abortController.signal,
      maxSteps: this.ctx.maxSteps,
      get aborted() {
        return host.aborted
      },
      history: () => this.history(),
      assistantStep: (opts) => this.assistantStep(workflow, opts),
      runTools: (step) => this.runTools(step),
      subAgent: (opts) => this.subAgent(opts),
      note: (label, detail) => {
        this.addStep({ agent: 'main', kind: 'note', label, detail, status: 'ok' })
      }
    }
  }

  private history(): ProviderMessage[] {
    return sanitizeHistory(getMessageBranch(this.parentId))
  }

  private systemPrompt(extra?: string): string {
    const base = resolveSystemPrompt(
      this.session?.systemPrompt || this.ctx.config.systemPrompt,
      this.ctx.config
    )
    const plugins = buildPluginInstructions(this.ctx.config)
    return [base, plugins, extra].filter(Boolean).join('\n\n')
  }

  private stepTools(opt: AssistantStepOptions['tools']): ProviderTool[] {
    if (opt === 'none') return []
    const list = Array.isArray(opt)
      ? this.tools.filter((t) => opt.includes(t.wireName))
      : this.tools
    return list.map((t) => ({
      name: t.wireName,
      description: t.tool.description,
      parameters: t.tool.parameters
    }))
  }

  /** 思考强度：会话自己的选择 → 设置里的默认 */
  private get reasoning(): ReasoningEffort {
    return normalizeEffort(this.session?.meta?.reasoning ?? this.ctx.config.reasoningEffort)
  }

  /** 插件 SDK：本次运行的上下文快照（按需计算，分支节点数要查库） */
  private toolContext(): ToolSessionContext {
    const u = this.lastUsage
    return {
      sessionId: this.ctx.sessionId,
      model: this.model,
      providerId: this.ctx.provider.id,
      step: this.stepCount,
      maxSteps: this.ctx.maxSteps,
      lastPromptTokens: u?.prompt ?? null,
      lastCompletionTokens: u?.completion ?? null,
      lastCachedTokens: u?.cached ?? null,
      runTotalTokens: this.record?.tokens ?? 0,
      branchMessages: getMessageBranch(this.parentId).length,
      toolCount: this.tools.length
    }
  }

  private get model(): string {
    return this.session?.model || this.ctx.config.activeModel
  }

  // ---------------------------------------------------------------------------
  // WorkflowContext 实现
  // ---------------------------------------------------------------------------

  private async assistantStep(
    workflow: WorkflowDefinition,
    opts: AssistantStepOptions = {}
  ): Promise<AssistantStepResult> {
    await this.gate()
    if (this.aborted) throw new Error('aborted')
    this.stepCount++
    const tools = this.stepTools(opts.tools)

    let messageId: string
    if (!this.anchorUsed) {
      this.anchorUsed = true
      messageId = this.anchorId
      updateMessage(messageId, { status: 'streaming' })
    } else {
      messageId = randomUUID()
      insertMessage({
        id: messageId,
        sessionId: this.ctx.sessionId,
        parentId: this.parentId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now()
      })
    }
    this.ctx.assistantMessageId = messageId
    this.parentId = messageId
    // 先记下本步用的模型：失败 / 中止的回答也能看出是哪个模型给的
    updateMessage(messageId, {
      meta: { ...getMessage(messageId)?.meta, model: this.model, provider: this.ctx.provider.id }
    })
    this.bufferedContent = ''
    this.bufferedReasoning = ''

    const step = this.addStep({
      agent: 'main',
      kind: 'llm',
      label:
        opts.label ??
        (tools.length > 0 && workflow.usesTools
          ? t('yaya.wf.step.think', '思考与调用工具')
          : t('yaya.wf.step.answer', '生成回答')),
      messageId,
      model: this.model,
      status: 'running'
    })
    this.setStatus('streaming')

    const result = await this.ctx.provider.generate({
      model: this.model,
      messages: [
        { role: 'system', content: this.systemPrompt(opts.extraSystem) },
        ...this.history()
      ],
      tools,
      stream: this.ctx.config.streamOutput,
      reasoning: this.reasoning,
      signal: this.abortController.signal,
      onToken: (tok) => {
        const offset = this.bufferedContent.length
        this.bufferedContent += tok
        getBroadcast()('cockpit:yaya-token', {
          sessionId: this.ctx.sessionId,
          messageId,
          token: tok,
          offset
        })
      },
      onReasoning: (chunk) => {
        const offset = this.bufferedReasoning.length
        this.bufferedReasoning += chunk
        getBroadcast()('cockpit:yaya-reasoning', {
          sessionId: this.ctx.sessionId,
          messageId,
          reasoning: chunk,
          offset
        })
      }
    })
    if (this.aborted) throw new Error('aborted')

    const content = result.content || this.bufferedContent
    const reasoning = result.reasoningContent || this.bufferedReasoning
    const toolCalls = result.toolCalls ?? []
    this.bufferedContent = content
    this.bufferedReasoning = reasoning

    updateMessage(messageId, {
      content,
      reasoningContent: reasoning || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      status: toolCalls.length > 0 ? 'tool_executing' : 'completed',
      usage: result.usage,
      meta: { ...getMessage(messageId)?.meta, model: this.model, provider: this.ctx.provider.id }
    })
    if (result.usage) this.lastUsage = result.usage
    this.endStep(step, 'ok', result.usage?.total)
    return { messageId, content, toolCalls }
  }

  private async subAgent(opts: SubAgentOptions): Promise<{ content: string }> {
    await this.gate()
    if (this.aborted) throw new Error('aborted')
    const step = this.addStep({
      agent: opts.agent,
      kind: 'subagent',
      label: opts.label,
      model: this.model,
      status: 'running'
    })
    this.setStatus('streaming')
    try {
      const result = await this.ctx.provider.generate({
        model: this.model,
        messages: [{ role: 'system', content: opts.system }, ...(opts.messages ?? this.history())],
        stream: false,
        reasoning: this.reasoning,
        signal: this.abortController.signal
      })
      const content = result.content ?? ''
      if (opts.recordOutput !== false) step.detail = content
      this.endStep(step, 'ok', result.usage?.total)
      return { content }
    } catch (e) {
      step.detail = e instanceof Error ? e.message : String(e)
      this.endStep(step, 'error')
      throw e
    }
  }

  /** 依次执行工具调用，结果节点接到对话树上 */
  private async runTools(step: AssistantStepResult): Promise<void> {
    const toolCalls = step.toolCalls
    const assistantMsgId = step.messageId
    const persist = (): void => {
      updateMessage(assistantMsgId, { toolCalls })
      this.emitSnapshot()
    }
    const fail = (call: ToolCallItem, error: string): void => {
      call.status = 'failed'
      call.error = error
      this.recordToolMessage(call, JSON.stringify({ error }))
      persist()
    }
    /** 已被打断：只在调用上标记，不再往对话树写节点（历史组装时会补「已中断」结果） */
    const markAborted = (call: ToolCallItem): void => {
      call.status = 'failed'
      call.error = t('yaya.err.aborted_before_tool', '用户停止，未执行')
      updateMessage(assistantMsgId, { toolCalls })
    }

    for (const call of toolCalls) {
      await this.gate()
      if (this.aborted) {
        markAborted(call)
        continue
      }

      const def = this.tools.find((t) => t.wireName === call.name)
      if (!def) {
        fail(call, te('yaya.err.tool_not_found', { name: call.name }, '工具 {name} 不存在'))
        continue
      }

      let args: Record<string, unknown>
      try {
        args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args
      } catch {
        fail(call, t('yaya.err.bad_args', '工具参数不是合法的 JSON'))
        continue
      }

      if (toolNeedsApproval(def, args, this.ctx.config) && !this.preApproved(call.name)) {
        call.status = 'awaiting_approval'
        this.ctx.pendingApprovalTool = call
        updateMessage(assistantMsgId, { toolCalls, status: 'waiting_approval' })
        this.setStatus('waiting_approval')

        // 用户不在对话页时，悬浮窗据此强制展开并给出批准 / 拒绝
        setSessionAttention(this.agentSessionId, { kind: 'approval', tool: call.name }, { args })
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          this.approvalResolver = resolve
        })
        setSessionAttention(this.agentSessionId, null)
        this.ctx.pendingApprovalTool = undefined
        if (decision.approved) this.rememberApproval(call.name, decision.scope)
        updateMessage(assistantMsgId, { status: 'tool_executing' })
        if (!decision.approved) {
          if (this.aborted) markAborted(call)
          else if (decision.reason) {
            call.rejectReason = decision.reason
            fail(
              call,
              te(
                'yaya.err.rejected_reason',
                { reason: decision.reason },
                '用户拒绝了执行该工具，理由：{reason}'
              )
            )
          } else fail(call, t('yaya.err.rejected', '用户拒绝了执行该工具'))
          continue
        }
      }

      // 审批等待期间也可能暂停 / 停止，批准不代表可以越过暂停闸门。
      await this.gate()
      if (this.aborted) {
        markAborted(call)
        continue
      }
      call.status = 'executing'
      this.ctx.status = 'tool_executing'
      persist()

      const start = Date.now()
      touchSession(this.agentSessionId, 'local', this.origin.client ?? 'YAYA', undefined, call.name)
      try {
        // 以 local-agent 身份执行：命令注册表里的隐私声明、脱敏、授权窗口全部生效；
        // 同时恢复发起本次运行的浏览器上下文（无头下 ui.* 只操作那个标签页）
        const raw = await withBrowserClient(
          this.browserClient,
          () =>
            withOrigin(this.origin, () =>
              runPluginTool(def, args, {
                sessionId: this.ctx.sessionId,
                signal: this.abortController.signal,
                context: () => this.toolContext()
              })
            ),
          this.abortController.signal
        )
        const out = await normalizeToolResult(raw, this.ctx.sessionId)
        call.status = out.isError ? 'failed' : 'success'
        call.result = out.display
        if (out.isError) call.error = out.text.slice(0, 2000)
        if (out.images.length) call.images = out.images.map((i) => i.assetPath)
        this.recordToolMessage(call, out.text, out.images)
      } catch (e: unknown) {
        call.status = 'failed'
        call.error = e instanceof Error ? e.message : String(e)
        this.recordToolMessage(call, JSON.stringify({ error: call.error }))
      }
      call.ms = Date.now() - start
      persist()
    }
    if (!this.aborted) updateMessage(assistantMsgId, { status: 'completed', toolCalls })
  }

  /** 工具结果节点：content = 交给模型的文本；attachments = 工具产出的图片（作为图片交给模型） */
  private recordToolMessage(call: ToolCallItem, text: string, images?: MessageAttachment[]): void {
    const id = randomUUID()
    insertMessage(
      {
        id,
        sessionId: this.ctx.sessionId,
        parentId: this.parentId,
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: text,
        attachments: images?.length ? images : undefined,
        status: 'completed',
        createdAt: Date.now()
      },
      // 打断后才跑完的工具：结果照存（审计 / 回看），但不抢 activeLeaf（用户可能已经发了新消息）
      { moveLeaf: !this.aborted }
    )
    this.parentId = id
  }

  // ---------------------------------------------------------------------------
  // 收尾 / 过程记录
  // ---------------------------------------------------------------------------

  /** 工作流没走任何 assistantStep 就结束（或首节点没用上）时，别留下 pending 的空节点 */
  private closeOpenNode(): void {
    if (!this.anchorUsed) {
      updateMessage(this.anchorId, { status: 'completed' })
    }
  }

  private failCurrentNode(error: string): void {
    const id = this.anchorUsed ? this.ctx.assistantMessageId : this.anchorId
    const node = getMessage(id)
    if (!node) return
    updateMessage(id, {
      content:
        id === this.ctx.assistantMessageId ? this.bufferedContent || node.content : node.content,
      reasoningContent:
        id === this.ctx.assistantMessageId
          ? this.bufferedReasoning || node.reasoningContent
          : node.reasoningContent,
      status: 'error',
      error
    })
  }

  private addStep(step: Omit<WorkflowStepRecord, 'id' | 'startedAt'>): WorkflowStepRecord {
    const full: WorkflowStepRecord = { id: randomUUID(), startedAt: Date.now(), ...step }
    this.record?.steps.push(full)
    this.persistRecord()
    return full
  }

  private endStep(step: WorkflowStepRecord, status: 'ok' | 'error', tokens?: number): void {
    step.status = status
    step.ms = Date.now() - step.startedAt
    if (tokens) {
      step.tokens = tokens
      if (this.record) this.record.tokens += tokens
    }
    this.persistRecord()
  }

  private finishRecord(status: WorkflowRecord['status']): void {
    if (!this.record || this.record.endedAt) return
    this.record.status = status
    this.record.endedAt = Date.now()
    for (const s of this.record.steps) {
      if (s.status === 'running') {
        s.status = status === 'ok' ? 'ok' : 'error'
        s.ms = this.record.endedAt - s.startedAt
      }
    }
    this.persistRecord()
  }

  private persistRecord(): void {
    if (!this.record) return
    const anchor = getMessage(this.anchorId)
    if (!anchor) return
    updateMessage(this.anchorId, { meta: { ...anchor.meta, workflow: this.record } })
  }
}

/**
 * 分支 → Provider 消息，并修复「打断」留下的不一致，保证打断后可以直接继续对话：
 * - 过滤空节点（中断 / 报错留下的空 assistant、空 user、空 tool）；
 * - assistant 发起的 tool_calls 缺结果（运行在执行工具前被停掉）→ 补一条「已中断」结果；
 * - 没有对应调用的 tool 结果（导入数据等）→ 丢弃（否则 OpenAI 兼容端点直接 400）。
 */
export function sanitizeHistory(nodes: import('../../types').MessageNode[]): ProviderMessage[] {
  const kept = nodes.filter((n) => {
    const hasText = Boolean(n.content?.trim())
    if (n.role === 'assistant') return hasText || Boolean(n.toolCalls?.length)
    if (n.role === 'user') return hasText || Boolean(n.attachments?.length)
    if (n.role === 'tool') return hasText || Boolean(n.attachments?.length)
    return false
  })
  const out: ProviderMessage[] = []
  let pending: string[] = []
  const flushMissing = (): void => {
    for (const id of pending) {
      out.push({
        role: 'tool',
        toolCallId: id,
        content: JSON.stringify({ error: 'interrupted by the user before this tool ran' })
      })
    }
    pending = []
  }
  for (const n of kept) {
    if (n.role === 'tool') {
      if (!n.toolCallId || !pending.includes(n.toolCallId)) continue
      pending = pending.filter((id) => id !== n.toolCallId)
      out.push({
        role: 'tool',
        content: n.content,
        name: n.name,
        toolCallId: n.toolCallId,
        attachments: n.attachments
      })
      continue
    }
    flushMissing()
    out.push({
      role: n.role,
      content: n.content,
      name: n.name,
      toolCallId: n.toolCallId,
      toolCalls: n.toolCalls,
      attachments: n.attachments
    })
    if (n.role === 'assistant') pending = (n.toolCalls ?? []).map((c) => c.id)
  }
  flushMissing()
  return out
}
