/**
 * YAYA Loop 执行核心 (Agent Loop Kernel)
 * 实现完整的“思考 - 工具决策 - 审批挂起 - 执行 - 观察回传 - 循环”逻辑。
 * 支持每步原子落盘与事件广播。
 */
import { randomUUID } from 'node:crypto'
import { getBroadcast } from '../../../../main/process/broadcast'
import { makeLogger } from '../../../../main/process/logger'
import type { ToolCallItem } from '../../types'
import { insertMessage, updateMessage, getMessageBranch, getSession } from '../db'
import type { LoopContext, WorkflowSnapshot, WorkflowStatus } from './types'
import { getAllTools, getTool } from '../tools/registry'
import type { ProviderMessage } from '../providers/types'

const log = makeLogger('yaya-loop')

export class WorkflowRunner {
  private ctx: LoopContext
  private approvalResolver: ((approved: boolean) => void) | null = null
  private abortController: AbortController

  constructor(ctx: LoopContext) {
    this.ctx = ctx
    this.abortController = new AbortController()
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => this.abortController.abort())
    }
  }

  get sessionId(): string {
    return this.ctx.sessionId
  }

  get status(): WorkflowStatus {
    return this.ctx.status
  }

  abort(): void {
    this.abortController.abort()
    this.ctx.status = 'interrupted'
    this.emitSnapshot()
    updateMessage(this.ctx.assistantMessageId, {
      status: 'interrupted',
      error: '用户手动中止了操作'
    })
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
      bufferedTokens: '',
      bufferedReasoning: '',
      startedAt: Date.now()
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot()
    this.ctx.onUpdate?.(snap)
    const emit = getBroadcast()
    emit('cockpit:yaya-loop', snap)
  }

  async run(): Promise<void> {
    const session = getSession(this.ctx.sessionId)
    if (!session) throw new Error(`Session ${this.ctx.sessionId} not found`)

    let currentParentId = this.ctx.userMessageId
    let assistantMsgId = this.ctx.assistantMessageId

    // 预备系统提示词
    const systemPrompt = session.systemPrompt || this.ctx.config.systemPrompt

    log.info(`Starting workflow loop for session ${this.ctx.sessionId}`)

    try {
      while (this.ctx.step < this.ctx.maxSteps) {
        if (this.abortController.signal.aborted) break

        this.ctx.step++
        this.ctx.status = 'streaming'
        this.emitSnapshot()

        // 1. 获取当前分支的完整上下文并过滤掉异常/空节点
        const historyNodes = getMessageBranch(currentParentId)
        const validHistoryNodes = historyNodes.filter((n) => {
          if (n.role === 'assistant') {
            const hasContent = Boolean(n.content && n.content.trim().length > 0)
            const hasTools = Boolean(n.toolCalls && n.toolCalls.length > 0)
            return hasContent || hasTools
          }
          if (n.role === 'user') {
            const hasContent = Boolean(n.content && n.content.trim().length > 0)
            const hasAtt = Boolean(n.attachments && n.attachments.length > 0)
            return hasContent || hasAtt
          }
          if (n.role === 'tool') {
            return Boolean(n.content && n.content.trim().length > 0)
          }
          return true
        })

        const messages: ProviderMessage[] = [
          { role: 'system', content: systemPrompt },
          ...validHistoryNodes.map((n) => ({
            role: n.role,
            content: n.content,
            name: n.name,
            toolCallId: n.toolCallId,
            toolCalls: n.toolCalls,
            attachments: n.attachments
          }))
        ]

        // 2. 收集当前启用的工具集
        const tools = this.ctx.tools.length > 0 ? this.ctx.tools : getAllTools()

        let accumulatedContent = ''
        let accumulatedReasoning = ''
        const detectedToolCalls: ToolCallItem[] = []

        // 3. 调用模型生成
        const genResult = await this.ctx.provider.generate({
          model: session.model || this.ctx.config.activeModel,
          messages,
          tools,
          stream: this.ctx.config.streamOutput,
          signal: this.abortController.signal,
          onToken: (tok) => {
            accumulatedContent += tok
            const emit = getBroadcast()
            emit('cockpit:yaya-token', {
              sessionId: this.ctx.sessionId,
              messageId: assistantMsgId,
              token: tok
            })
          },
          onReasoning: (reasoning) => {
            accumulatedReasoning += reasoning
            const emit = getBroadcast()
            emit('cockpit:yaya-reasoning', {
              sessionId: this.ctx.sessionId,
              messageId: assistantMsgId,
              reasoning
            })
          },
          onToolCall: (call) => {
            detectedToolCalls.push(call)
            this.emitSnapshot()
          }
        })

        const finalContent = genResult.content || accumulatedContent
        const finalReasoning = genResult.reasoningContent || accumulatedReasoning
        const finalToolCalls = genResult.toolCalls || detectedToolCalls

        // 更新当前 Assistant 消息到 DB
        updateMessage(assistantMsgId, {
          content: finalContent,
          reasoningContent: finalReasoning || undefined,
          toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
          status: finalToolCalls.length > 0 ? 'tool_executing' : 'completed',
          usage: genResult.usage
        })

        // 如果没有工具调用，说明本次任务回复已完毕，结束 Loop
        if (!finalToolCalls || finalToolCalls.length === 0) {
          this.ctx.status = 'completed'
          this.emitSnapshot()
          break
        }

        // 4. 处理工具调用
        currentParentId = assistantMsgId

        for (const toolCall of finalToolCalls) {
          if (this.abortController.signal.aborted) break

          const toolDef = getTool(toolCall.name)
          if (!toolDef) {
            toolCall.status = 'failed'
            toolCall.error = `Tool ${toolCall.name} not found`
            this.recordToolMessage(currentParentId, toolCall, { error: toolCall.error })
            continue
          }

          // 检查是否需要用户手动确认
          const needsApproval = toolDef.requiresApproval && !this.ctx.config.autoApproveTools
          if (needsApproval) {
            this.ctx.status = 'waiting_approval'
            this.ctx.pendingApprovalTool = toolCall
            this.emitSnapshot()
            updateMessage(assistantMsgId, { status: 'waiting_approval' })

            // 挂起等待人类审批
            const approved = await new Promise<boolean>((resolve) => {
              this.approvalResolver = resolve
            })

            this.ctx.pendingApprovalTool = undefined
            if (!approved) {
              toolCall.status = 'failed'
              toolCall.error = '用户拒绝了执行该工具'
              this.recordToolMessage(currentParentId, toolCall, { error: toolCall.error })
              continue
            }
          }

          // 执行工具
          this.ctx.status = 'tool_executing'
          toolCall.status = 'executing'
          this.emitSnapshot()

          const startTime = Date.now()
          try {
            const rawArgs =
              typeof toolCall.args === 'string' ? JSON.parse(toolCall.args) : toolCall.args
            const result = await toolDef.handler(rawArgs, {
              sessionId: this.ctx.sessionId,
              signal: this.abortController.signal
            })
            toolCall.status = 'success'
            toolCall.result = result
            toolCall.ms = Date.now() - startTime

            // 记录 tool 结果消息并更新消息树
            currentParentId = this.recordToolMessage(currentParentId, toolCall, result)
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e)
            toolCall.status = 'failed'
            toolCall.error = errMsg
            toolCall.ms = Date.now() - startTime
            currentParentId = this.recordToolMessage(currentParentId, toolCall, { error: errMsg })
          }
        }

        // 为下一轮循环创建新的 Assistant 消息占位节点
        assistantMsgId = randomUUID()
        insertMessage({
          id: assistantMsgId,
          sessionId: this.ctx.sessionId,
          parentId: currentParentId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: Date.now()
        })
        this.ctx.assistantMessageId = assistantMsgId
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('Workflow execution failed', { error: errMsg })
      this.ctx.status = 'error'
      updateMessage(assistantMsgId, {
        status: 'error',
        error: errMsg
      })
      this.emitSnapshot()
    }
  }

  private recordToolMessage(parentId: string, toolCall: ToolCallItem, result: unknown): string {
    const toolMsgId = randomUUID()
    const content = typeof result === 'string' ? result : JSON.stringify(result)
    insertMessage({
      id: toolMsgId,
      sessionId: this.ctx.sessionId,
      parentId,
      role: 'tool',
      toolCallId: toolCall.id,
      name: toolCall.name,
      content,
      status: 'completed',
      createdAt: Date.now()
    })
    return toolMsgId
  }
}
