/**
 * YAYA 工作流宿主 (Workflow Host)
 *
 * 为一次运行实现 `WorkflowContext`（见 `../workflow/types.ts`），再把控制权交给选中的工作流。
 * 宿主保证：
 * - 每个 assistant 节点结束时一定落到终态（completed / interrupted / error），不留悬空的 streaming；
 * - 流式内容先进内存缓冲（`buffered*`），`yaya.messages-branch` 读取时叠加到 DB 内容上，
 *   渲染端任何时候重拉都拿到完整的进行中文本；
 * - 过程记录（WorkflowRecord）挂在本次运行的第一个 assistant 节点的 `meta.workflow` 上，
 *   每次变化落盘并广播快照。
 */
import { randomUUID } from 'node:crypto'
import { getBroadcast } from '../../../../main/process/broadcast'
import { makeLogger } from '../../../../main/process/logger'
import { t, te } from '../../../../main/process/i18n'
import type {
  Session,
  ToolCallItem,
  ToolDefinition,
  WorkflowRecord,
  WorkflowStepRecord
} from '../../types'
import { insertMessage, updateMessage, getMessage, getMessageBranch, getSession } from '../db'
import { resolveSystemPrompt } from '../config'
import { getEnabledTools, getTool, toolNeedsApproval } from '../tools/registry'
import type { ProviderMessage } from '../providers/types'
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

  constructor(ctx: LoopContext) {
    this.ctx = ctx
    this.anchorId = ctx.assistantMessageId
    this.parentId = ctx.userMessageId
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

  abort(): void {
    if (this.aborted) return
    this.abortController.abort()
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

  /** 用户对挂起工具调用的决定；拒绝时可附理由（会作为工具结果回传给模型） */
  resolveApproval(approved: boolean, reason?: string): void {
    if (this.approvalResolver) {
      this.approvalResolver({ approved, reason: reason?.trim().slice(0, 2000) || undefined })
      this.approvalResolver = null
    }
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

    try {
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
    return getMessageBranch(this.parentId)
      .filter((n) => {
        const hasText = Boolean(n.content?.trim())
        if (n.role === 'assistant') return hasText || Boolean(n.toolCalls?.length)
        if (n.role === 'user') return hasText || Boolean(n.attachments?.length)
        if (n.role === 'tool') return hasText
        return false
      })
      .map((n) => ({
        role: n.role,
        content: n.content,
        name: n.name,
        toolCallId: n.toolCallId,
        toolCalls: n.toolCalls,
        attachments: n.attachments
      }))
  }

  private systemPrompt(extra?: string): string {
    const base = resolveSystemPrompt(
      this.session?.systemPrompt || this.ctx.config.systemPrompt,
      this.ctx.config
    )
    return extra ? `${base}\n\n${extra}` : base
  }

  private resolveTools(opt: AssistantStepOptions['tools']): ToolDefinition[] {
    if (opt === 'none') return []
    if (Array.isArray(opt)) return opt
    return getEnabledTools(this.ctx.config.disabledTools)
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
    if (this.aborted) throw new Error('aborted')
    this.stepCount++
    const tools = this.resolveTools(opts.tools)

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
    this.endStep(step, 'ok', result.usage?.total)
    return { messageId, content, toolCalls }
  }

  private async subAgent(opts: SubAgentOptions): Promise<{ content: string }> {
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
      this.recordToolMessage(call, { error })
      persist()
    }

    for (const call of toolCalls) {
      if (this.aborted) {
        fail(call, t('yaya.err.aborted_before_tool', '用户停止，未执行'))
        continue
      }

      const def = getTool(call.name)
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

      if (toolNeedsApproval(def, args, this.ctx.config)) {
        call.status = 'awaiting_approval'
        this.ctx.pendingApprovalTool = call
        updateMessage(assistantMsgId, { toolCalls, status: 'waiting_approval' })
        this.setStatus('waiting_approval')

        const decision = await new Promise<ApprovalDecision>((resolve) => {
          this.approvalResolver = resolve
        })
        this.ctx.pendingApprovalTool = undefined
        updateMessage(assistantMsgId, { status: 'tool_executing' })
        if (!decision.approved) {
          if (this.aborted) fail(call, t('yaya.err.aborted_before_tool', '用户停止，未执行'))
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

      call.status = 'executing'
      this.ctx.status = 'tool_executing'
      persist()

      const start = Date.now()
      try {
        const result = await def.handler(args, {
          sessionId: this.ctx.sessionId,
          signal: this.abortController.signal
        })
        call.status = 'success'
        call.result = result
        this.recordToolMessage(call, result)
      } catch (e: unknown) {
        call.status = 'failed'
        call.error = e instanceof Error ? e.message : String(e)
        this.recordToolMessage(call, { error: call.error })
      }
      call.ms = Date.now() - start
      persist()
    }
    if (!this.aborted) updateMessage(assistantMsgId, { status: 'completed', toolCalls })
  }

  private recordToolMessage(call: ToolCallItem, result: unknown): void {
    const id = randomUUID()
    insertMessage({
      id,
      sessionId: this.ctx.sessionId,
      parentId: this.parentId,
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
      status: 'completed',
      createdAt: Date.now()
    })
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
