/**
 * YAYA Loop 执行核心 (Agent Loop Kernel)
 * 「思考 - 工具决策 - 审批挂起 - 执行 - 观察回传 - 循环」。
 *
 * 状态约定：
 * - 每一步的 assistant 节点在步开始时才插入，结束时一定落到终态
 *   （completed / tool_executing→下一步 / interrupted / error），不留悬空的 streaming 节点。
 * - 流式内容先进内存缓冲（`buffered*`），`yaya.messages-branch` 读取时叠加到 DB 内容上，
 *   所以渲染端任何时候重新拉取都拿到完整的进行中文本；结束 / 中止时落盘。
 */
import { randomUUID } from 'node:crypto'
import { getBroadcast } from '../../../../main/process/broadcast'
import { makeLogger } from '../../../../main/process/logger'
import { t, te } from '../../../../main/process/i18n'
import type { ToolCallItem } from '../../types'
import { insertMessage, updateMessage, getMessageBranch, getSession } from '../db'
import { resolveSystemPrompt } from '../config'
import type { LoopContext, WorkflowSnapshot, WorkflowStatus } from './types'
import { getEnabledTools, getTool, toolNeedsApproval } from '../tools/registry'
import type { ProviderMessage } from '../providers/types'

const log = makeLogger('yaya-loop')

/** 用户主动停止时写进 message.error 的标记，界面据此显示「已停止」而不是错误横幅 */
export const ABORTED_MARK = 'aborted'

export class WorkflowRunner {
  private ctx: LoopContext
  private approvalResolver: ((approved: boolean) => void) | null = null
  private abortController = new AbortController()
  private readonly startedAt = Date.now()
  private bufferedContent = ''
  private bufferedReasoning = ''

  constructor(ctx: LoopContext) {
    this.ctx = ctx
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
    // 挂起中的审批视为拒绝，让循环自然收尾
    this.resolveApproval(false)
    this.ctx.status = 'interrupted'
    updateMessage(this.ctx.assistantMessageId, {
      content: this.bufferedContent,
      reasoningContent: this.bufferedReasoning || undefined,
      status: 'interrupted',
      error: ABORTED_MARK
    })
    this.emitSnapshot()
  }

  resolveApproval(approved: boolean): void {
    if (this.approvalResolver) {
      this.approvalResolver(approved)
      this.approvalResolver = null
    }
  }

  getSnapshot(): WorkflowSnapshot {
    return {
      sessionId: this.ctx.sessionId,
      messageId: this.ctx.assistantMessageId,
      status: this.ctx.status,
      currentStep: this.ctx.step,
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

  async run(): Promise<void> {
    const session = getSession(this.ctx.sessionId)
    if (!session) throw new Error(`Session ${this.ctx.sessionId} not found`)

    const config = this.ctx.config
    const systemPrompt = resolveSystemPrompt(session.systemPrompt || config.systemPrompt, config)
    const model = session.model || config.activeModel
    // 第一步的 assistant 节点由 manager 预先插入；之后每一步开头插入新节点
    let assistantMsgId = this.ctx.assistantMessageId
    let parentId = this.ctx.userMessageId
    let finished = false

    log.info('workflow start', { session: this.ctx.sessionId, model })

    try {
      while (this.ctx.step < this.ctx.maxSteps && !this.aborted) {
        this.ctx.step++
        if (this.ctx.step > 1) {
          assistantMsgId = randomUUID()
          insertMessage({
            id: assistantMsgId,
            sessionId: this.ctx.sessionId,
            parentId,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: Date.now()
          })
          this.ctx.assistantMessageId = assistantMsgId
        } else {
          updateMessage(assistantMsgId, { status: 'streaming' })
        }
        this.bufferedContent = ''
        this.bufferedReasoning = ''
        this.setStatus('streaming')

        const result = await this.ctx.provider.generate({
          model,
          messages: this.buildMessages(systemPrompt, parentId),
          tools: this.ctx.tools.length > 0 ? this.ctx.tools : getEnabledTools(config.disabledTools),
          stream: config.streamOutput,
          signal: this.abortController.signal,
          onToken: (tok) => {
            const offset = this.bufferedContent.length
            this.bufferedContent += tok
            getBroadcast()('cockpit:yaya-token', {
              sessionId: this.ctx.sessionId,
              messageId: assistantMsgId,
              token: tok,
              offset
            })
          },
          onReasoning: (chunk) => {
            const offset = this.bufferedReasoning.length
            this.bufferedReasoning += chunk
            getBroadcast()('cockpit:yaya-reasoning', {
              sessionId: this.ctx.sessionId,
              messageId: assistantMsgId,
              reasoning: chunk,
              offset
            })
          }
        })
        if (this.aborted) break

        const content = result.content || this.bufferedContent
        const reasoning = result.reasoningContent || this.bufferedReasoning
        const toolCalls = result.toolCalls ?? []
        this.bufferedContent = content
        this.bufferedReasoning = reasoning

        updateMessage(assistantMsgId, {
          content,
          reasoningContent: reasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          status: toolCalls.length > 0 ? 'tool_executing' : 'completed',
          usage: result.usage
        })

        if (toolCalls.length === 0) {
          finished = true
          this.setStatus('completed')
          break
        }

        parentId = await this.runTools(assistantMsgId, toolCalls)
        if (this.aborted) break
        updateMessage(assistantMsgId, { status: 'completed', toolCalls })
      }

      if (!finished && !this.aborted) {
        // 达到步数上限：最后一步的节点已落盘为 completed，补一个说明性的错误终态
        updateMessage(assistantMsgId, {
          status: 'error',
          error: te(
            'yaya.err.max_steps',
            { n: String(this.ctx.maxSteps) },
            '已达到最大循环步数（{n}），工作流停止'
          )
        })
        this.setStatus('error')
      }
    } catch (err: unknown) {
      if (this.aborted) return // abort() 已落盘 interrupted
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('workflow failed', { error: errMsg })
      updateMessage(assistantMsgId, {
        content: this.bufferedContent,
        reasoningContent: this.bufferedReasoning || undefined,
        status: 'error',
        error: errMsg
      })
      this.setStatus('error')
    }
  }

  /** 当前分支 → Provider 消息，过滤掉中断 / 报错留下的空节点 */
  private buildMessages(systemPrompt: string, leafId: string): ProviderMessage[] {
    const nodes = getMessageBranch(leafId).filter((n) => {
      const hasText = Boolean(n.content?.trim())
      if (n.role === 'assistant') return hasText || Boolean(n.toolCalls?.length)
      if (n.role === 'user') return hasText || Boolean(n.attachments?.length)
      if (n.role === 'tool') return hasText
      return true
    })
    return [
      { role: 'system', content: systemPrompt },
      ...nodes.map((n) => ({
        role: n.role,
        content: n.content,
        name: n.name,
        toolCallId: n.toolCallId,
        toolCalls: n.toolCalls,
        attachments: n.attachments
      }))
    ]
  }

  /** 依次执行工具调用，返回最后一个 tool 结果节点的 id（下一步的 parent） */
  private async runTools(assistantMsgId: string, toolCalls: ToolCallItem[]): Promise<string> {
    let parentId = assistantMsgId
    const persist = (): void => {
      updateMessage(assistantMsgId, { toolCalls })
      this.emitSnapshot()
    }

    for (const call of toolCalls) {
      if (this.aborted) {
        call.status = 'failed'
        call.error = t('yaya.err.aborted_before_tool', '用户停止，未执行')
        parentId = this.recordToolMessage(parentId, call, { error: call.error })
        continue
      }

      const def = getTool(call.name)
      if (!def) {
        call.status = 'failed'
        call.error = te('yaya.err.tool_not_found', { name: call.name }, '工具 {name} 不存在')
        parentId = this.recordToolMessage(parentId, call, { error: call.error })
        persist()
        continue
      }

      let args: Record<string, unknown>
      try {
        args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args
      } catch {
        call.status = 'failed'
        call.error = t('yaya.err.bad_args', '工具参数不是合法的 JSON')
        parentId = this.recordToolMessage(parentId, call, { error: call.error })
        persist()
        continue
      }

      if (toolNeedsApproval(def, args) && !this.ctx.config.autoApproveTools) {
        call.status = 'awaiting_approval'
        this.ctx.pendingApprovalTool = call
        updateMessage(assistantMsgId, { toolCalls, status: 'waiting_approval' })
        this.setStatus('waiting_approval')

        const approved = await new Promise<boolean>((resolve) => {
          this.approvalResolver = resolve
        })
        this.ctx.pendingApprovalTool = undefined
        updateMessage(assistantMsgId, { status: 'tool_executing' })
        if (!approved) {
          call.status = 'failed'
          call.error = this.aborted
            ? t('yaya.err.aborted_before_tool', '用户停止，未执行')
            : t('yaya.err.rejected', '用户拒绝了执行该工具')
          parentId = this.recordToolMessage(parentId, call, { error: call.error })
          persist()
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
        parentId = this.recordToolMessage(parentId, call, result)
      } catch (e: unknown) {
        call.status = 'failed'
        call.error = e instanceof Error ? e.message : String(e)
        parentId = this.recordToolMessage(parentId, call, { error: call.error })
      }
      call.ms = Date.now() - start
      persist()
    }
    return parentId
  }

  private recordToolMessage(parentId: string, call: ToolCallItem, result: unknown): string {
    const id = randomUUID()
    insertMessage({
      id,
      sessionId: this.ctx.sessionId,
      parentId,
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
      status: 'completed',
      createdAt: Date.now()
    })
    return id
  }
}
