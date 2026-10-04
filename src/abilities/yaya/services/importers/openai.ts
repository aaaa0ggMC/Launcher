/**
 * OpenAI (ChatGPT) 导出会话数据导入器
 * 将 ChatGPT 的 conversations.json 树状数据无缝迁移至 YAYA SQLite。
 */
import { randomUUID } from 'node:crypto'
import { createSession, insertMessage } from '../db'
import { makeLogger } from '../../../../main/process/logger'

const log = makeLogger('yaya-importer-openai')

interface OpenAiExportNode {
  id: string
  parent: string | null
  children: string[]
  message?: {
    id: string
    author: { role: string; name?: string }
    create_time: number | null
    content?: {
      content_type: string
      parts?: (string | unknown)[]
      text?: string
    }
    status?: string
  }
}

interface OpenAiConversation {
  id: string
  title: string
  create_time: number
  update_time: number
  mapping: Record<string, OpenAiExportNode>
  current_node?: string
}

export function importOpenAiConversations(conversations: OpenAiConversation[]): {
  importedSessions: number
  importedMessages: number
} {
  let sessionCount = 0
  let messageCount = 0

  for (const conv of conversations) {
    try {
      const sessionId = conv.id || randomUUID()
      createSession({
        id: sessionId,
        title: conv.title || '导入的 ChatGPT 会话',
        createdAt: Math.floor((conv.create_time || Date.now() / 1000) * 1000),
        updatedAt: Math.floor((conv.update_time || Date.now() / 1000) * 1000),
        activeLeafId: conv.current_node || null,
        meta: { source: 'openai_export' }
      })
      sessionCount++

      if (conv.mapping) {
        for (const [nodeId, node] of Object.entries(conv.mapping)) {
          const msg = node.message
          if (!msg || !msg.author || msg.author.role === 'system') continue

          let content = ''
          if (msg.content?.parts) {
            content = msg.content.parts.filter((p) => typeof p === 'string').join('\n')
          } else if (msg.content?.text) {
            content = msg.content.text
          }

          if (!content && (!msg.author.role || msg.author.role === 'tool')) continue

          const role =
            msg.author.role === 'user' ||
            msg.author.role === 'assistant' ||
            msg.author.role === 'tool'
              ? msg.author.role
              : 'assistant'

          insertMessage({
            id: nodeId,
            sessionId,
            parentId: node.parent,
            role,
            content,
            status: 'completed',
            createdAt: Math.floor((msg.create_time || Date.now() / 1000) * 1000)
          })
          messageCount++
        }
      }
    } catch (e) {
      log.error('Failed to import conversation', { id: conv.id, error: String(e) })
    }
  }

  return { importedSessions: sessionCount, importedMessages: messageCount }
}
