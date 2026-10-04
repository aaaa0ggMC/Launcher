/**
 * YAYA 工作流管理器 (Workflow Manager)
 * 统一管理正在运行的任务，支持断线重连、断点续传、异常恢复与人类授权。
 */
import { randomUUID } from 'node:crypto'
import { makeLogger } from '../../../../main/process/logger'
import type { MessageAttachment } from '../../types'
import { getSession, insertMessage, getYayaDb, getMessage } from '../db'
import { loadYayaConfig } from '../config'
import { getProviderInstance } from '../providers/factory'
import { WorkflowRunner } from './runner'
import type { WorkflowSnapshot } from './types'

const log = makeLogger('yaya-workflow-manager')

const activeRunners = new Map<string, WorkflowRunner>()

export function getActiveWorkflow(sessionId: string): WorkflowRunner | undefined {
  return activeRunners.get(sessionId)
}

export function getWorkflowSnapshot(sessionId: string): WorkflowSnapshot | null {
  const runner = activeRunners.get(sessionId)
  if (runner) return runner.getSnapshot()

  // 如果没有活跃的 Runner，检查 DB 中最新消息是否处于挂起/待确认态
  const session = getSession(sessionId)
  if (!session || !session.activeLeafId) return null

  const leafMsg = getMessage(session.activeLeafId)
  if (!leafMsg) return null

  if (leafMsg.status === 'waiting_approval') {
    const pendingTool = leafMsg.toolCalls?.find(
      (t) => t.status === 'pending' || t.status === 'executing'
    )
    return {
      sessionId,
      messageId: leafMsg.id,
      status: 'waiting_approval',
      currentStep: 1,
      maxSteps: 25,
      pendingApprovalTool: pendingTool,
      bufferedTokens: leafMsg.content,
      bufferedReasoning: leafMsg.reasoningContent || '',
      startedAt: leafMsg.createdAt
    }
  }

  if (leafMsg.status === 'interrupted') {
    return {
      sessionId,
      messageId: leafMsg.id,
      status: 'interrupted',
      currentStep: 1,
      maxSteps: 25,
      bufferedTokens: leafMsg.content,
      bufferedReasoning: leafMsg.reasoningContent || '',
      startedAt: leafMsg.createdAt
    }
  }

  return null
}

export async function startWorkflow(
  sessionId: string,
  userPrompt: string,
  attachments?: MessageAttachment[],
  parentMessageId?: string | null
): Promise<{ userMessageId: string; assistantMessageId: string }> {
  // 如果当前会话已有任务在跑，先中止旧任务
  const existing = activeRunners.get(sessionId)
  if (existing) {
    existing.abort()
    activeRunners.delete(sessionId)
  }

  const session = getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  let effectiveParentId = parentMessageId !== undefined ? parentMessageId : session.activeLeafId
  if (effectiveParentId) {
    const leaf = getMessage(effectiveParentId)
    // 若当前叶节点是失败/未产生任何内容的 Assistant 消息，自动回溯到该 Assistant 的父节点（即用户提问节点），
    // 使得重试或追问从正常节点分叉，而不是挂接在坏死节点下方
    if (
      leaf &&
      leaf.role === 'assistant' &&
      !leaf.content?.trim() &&
      (!leaf.toolCalls || leaf.toolCalls.length === 0)
    ) {
      effectiveParentId = leaf.parentId ?? null
    }
  }

  // 1. 插入用户消息
  const userMsgId = randomUUID()
  insertMessage({
    id: userMsgId,
    sessionId,
    parentId: effectiveParentId ?? null,
    role: 'user',
    content: userPrompt,
    attachments,
    status: 'completed',
    createdAt: Date.now()
  })

  // 2. 预插入 Assistant 消息节点
  const assistantMsgId = randomUUID()
  insertMessage({
    id: assistantMsgId,
    sessionId,
    parentId: userMsgId,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: Date.now()
  })

  // 3. 构建 Loop 上下文
  const config = loadYayaConfig()
  const providerConfig =
    config.providers.find((p) => p.id === (session.providerId || config.activeProviderId)) ||
    config.providers[0]
  const provider = getProviderInstance(providerConfig)

  const runner = new WorkflowRunner({
    sessionId,
    userMessageId: userMsgId,
    assistantMessageId: assistantMsgId,
    config,
    provider,
    tools: [],
    step: 0,
    maxSteps: config.maxLoopSteps || 25,
    status: 'pending',
    ringBuffer: []
  })

  activeRunners.set(sessionId, runner)

  // 异步在后台启动任务
  runner
    .run()
    .catch((e) => log.error('Workflow background run failed', { error: String(e) }))
    .finally(() => {
      activeRunners.delete(sessionId)
    })

  return { userMessageId: userMsgId, assistantMessageId: assistantMsgId }
}

export function abortWorkflow(sessionId: string): boolean {
  const runner = activeRunners.get(sessionId)
  if (!runner) return false
  runner.abort()
  activeRunners.delete(sessionId)
  return true
}

export function approveToolCall(sessionId: string, approved: boolean): boolean {
  const runner = activeRunners.get(sessionId)
  if (!runner) return false
  runner.resolveApproval(approved)
  return true
}

/**
 * 重启或崩溃后收敛不一致的消息状态
 */
export function reconcileInterruptedWorkflows(): void {
  try {
    const db = getYayaDb()
    db.prepare(
      `UPDATE messages SET
        status = 'interrupted',
        error = '工作流因主进程重启或意外中断而暂停'
       WHERE status IN ('streaming', 'pending', 'tool_executing')`
    ).run()
    log.info('Reconciled interrupted workflow messages on startup')
  } catch (e) {
    log.warn('Failed to reconcile interrupted messages', { error: String(e) })
  }
}
