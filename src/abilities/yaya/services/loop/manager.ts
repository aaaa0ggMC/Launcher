/**
 * YAYA 工作流管理器 (Workflow Manager)
 * 统一管理正在运行的任务，支持断线重连、断点续传、异常恢复与人类授权。
 */
import { randomUUID } from 'node:crypto'
import { makeLogger } from '../../../../main/process/logger'
import { getBroadcast } from '../../../../main/process/broadcast'
import { t } from '../../../../main/process/i18n'
import type { MessageAttachment, MessageNode } from '../../types'
import { getSession, insertMessage, updateMessage, getYayaDb, getMessage } from '../db'
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

  // 没有活跃 Runner 时，待审批 / 中断都只能重新生成（审批的 Promise 已随进程消失）
  if (leafMsg.status === 'interrupted' || leafMsg.status === 'waiting_approval') {
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
  const session = getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  stopExisting(sessionId)

  let parentId = parentMessageId !== undefined ? parentMessageId : session.activeLeafId
  if (parentId) {
    const leaf = getMessage(parentId)
    // 叶子是失败 / 未产生内容的 assistant 节点时回溯到它的父节点，不在坏死节点下继续接
    if (
      leaf &&
      leaf.role === 'assistant' &&
      !leaf.content?.trim() &&
      (!leaf.toolCalls || leaf.toolCalls.length === 0)
    ) {
      parentId = leaf.parentId ?? null
    }
  }

  const userMsgId = randomUUID()
  insertMessage({
    id: userMsgId,
    sessionId,
    parentId: parentId ?? null,
    role: 'user',
    content: userPrompt,
    attachments,
    status: 'completed',
    createdAt: Date.now()
  })
  const assistantMessageId = launchRunner(sessionId, userMsgId)
  return { userMessageId: userMsgId, assistantMessageId }
}

/**
 * 重新生成：从指定节点往上找到最近的 user 节点，在它下面开一个新的 assistant 分支
 * （旧回答保留为兄弟分支，可用 `< i/n >` 切回）。
 */
export function regenerateWorkflow(
  sessionId: string,
  fromMessageId: string
): { userMessageId: string; assistantMessageId: string } {
  let node = getMessage(fromMessageId)
  while (node && node.role !== 'user') node = node.parentId ? getMessage(node.parentId) : null
  if (!node || node.sessionId !== sessionId) {
    throw new Error(`no user message above ${fromMessageId}`)
  }
  stopExisting(sessionId)
  const assistantMessageId = launchRunner(sessionId, node.id)
  return { userMessageId: node.id, assistantMessageId }
}

function stopExisting(sessionId: string): void {
  const existing = activeRunners.get(sessionId)
  if (existing) {
    existing.abort()
    activeRunners.delete(sessionId)
  }
}

function launchRunner(sessionId: string, userMsgId: string): string {
  const session = getSession(sessionId)!
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

  const config = loadYayaConfig()
  const providerConfig =
    config.providers.find((p) => p.id === (session.providerId || config.activeProviderId)) ||
    config.providers.find((p) => p.enabled) ||
    config.providers[0]
  if (!providerConfig) {
    updateMessage(assistantMsgId, {
      status: 'error',
      error: t('yaya.err.no_provider', '没有可用的服务商，请先在设置里添加并启用')
    })
    return assistantMsgId
  }

  const runner = new WorkflowRunner({
    sessionId,
    userMessageId: userMsgId,
    assistantMessageId: assistantMsgId,
    config,
    provider: getProviderInstance(providerConfig),
    tools: [],
    step: 0,
    maxSteps: Math.min(100, Math.max(1, config.maxLoopSteps || 25)),
    status: 'pending',
    ringBuffer: []
  })
  activeRunners.set(sessionId, runner)
  runner
    .run()
    .catch((e) => log.error('Workflow background run failed', { error: String(e) }))
    .finally(() => {
      if (activeRunners.get(sessionId) === runner) activeRunners.delete(sessionId)
      getBroadcast()('cockpit:yaya-running', { sessionIds: runningSessionIds() })
    })
  getBroadcast()('cockpit:yaya-running', { sessionIds: runningSessionIds() })
  return assistantMsgId
}

export function runningSessionIds(): string[] {
  return [...activeRunners.keys()]
}

/** 把进行中节点的内存缓冲叠加到从 DB 读出的分支上 */
export function overlayLiveBuffer(sessionId: string, branch: MessageNode[]): MessageNode[] {
  const runner = activeRunners.get(sessionId)
  if (!runner) return branch
  const live = runner.liveBuffer()
  return branch.map((m) =>
    m.id === live.messageId && (m.status === 'streaming' || m.status === 'pending')
      ? {
          ...m,
          content: live.content.length >= m.content.length ? live.content : m.content,
          reasoningContent: live.reasoning || m.reasoningContent
        }
      : m
  )
}

export function abortWorkflow(sessionId: string): boolean {
  const runner = activeRunners.get(sessionId)
  if (!runner) return false
  runner.abort()
  activeRunners.delete(sessionId)
  getBroadcast()('cockpit:yaya-running', { sessionIds: runningSessionIds() })
  return true
}

export function approveToolCall(sessionId: string, approved: boolean, reason?: string): boolean {
  const runner = activeRunners.get(sessionId)
  if (!runner) return false
  runner.resolveApproval(approved, reason)
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
        error = ?
       WHERE status IN ('streaming', 'pending', 'tool_executing', 'waiting_approval')`
    ).run(t('yaya.err.restarted', '工作流因程序重启或意外退出而中断'))
    log.info('Reconciled interrupted workflow messages on startup')
  } catch (e) {
    log.warn('Failed to reconcile interrupted messages', { error: String(e) })
  }
}
