/**
 * Claude（claude.ai）导出解析：设置 → 隐私 → 导出数据，得到的 zip 里的 `conversations.json`。
 *
 * 结构：`[{ uuid, name, created_at, updated_at, chat_messages: [{ uuid, sender: 'human' | 'assistant',
 * text, content: [{ type: 'text' | 'thinking' | 'tool_use' | 'tool_result', … }], created_at,
 * attachments: [{ file_name, extracted_content }], files, parent_message_uuid? }] }]`。
 * 有 `parent_message_uuid` 时按它还原分支（根的父是全 0 uuid），没有时按顺序串成一条链。
 * 附件的抽取文本内联进消息（与 YAYA 文本附件内联的格式一致），图片等文件只留占位。
 */
import { t } from '../../../../main/process/i18n'
import { parseTime, type ImportedConversation, type ImportedNode } from './common'

const ROOT_UUID = '00000000-0000-4000-8000-000000000000'
const MAX_ATTACHMENT_CHARS = 200 * 1024

type Rec = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function isClaudeExport(data: unknown): boolean {
  const first = Array.isArray(data) ? data[0] : data
  return Boolean(first && typeof first === 'object' && Array.isArray((first as Rec).chat_messages))
}

function messageText(m: Rec): { content: string; reasoning: string } {
  const parts: string[] = []
  const thoughts: string[] = []
  const blocks = Array.isArray(m.content) ? (m.content as Rec[]) : []
  for (const b of blocks) {
    if (b?.type === 'text' && str(b.text)) parts.push(str(b.text))
    else if (b?.type === 'thinking' && str(b.thinking)) thoughts.push(str(b.thinking))
    else if (b?.type === 'tool_use')
      parts.push(`[${t('yaya.io.tool_call', '工具调用')}: ${str(b.name) || '?'}]`)
  }
  // 老导出只有 text 字段（content 为空或不存在）
  if (!parts.length && str(m.text)) parts.push(str(m.text))
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []) as Rec[]) {
    const body = str(a.extracted_content)
    const name = str(a.file_name) || 'attachment'
    parts.push(
      body
        ? `<attachment name="${name}">\n${body.length > MAX_ATTACHMENT_CHARS ? `${body.slice(0, MAX_ATTACHMENT_CHARS)}\n…` : body}\n</attachment>`
        : `[${name}]`
    )
  }
  const files = (Array.isArray(m.files) ? m.files : []) as Rec[]
  if (files.length) parts.push(t('yaya.io.placeholder_image', '[图片/附件未导入]'))
  return { content: parts.join('\n\n'), reasoning: thoughts.join('\n\n') }
}

export function parseClaudeExport(data: unknown): ImportedConversation[] {
  const list = (Array.isArray(data) ? data : [data]) as Rec[]
  const out: ImportedConversation[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.chat_messages)) continue
    const msgs = c.chat_messages as Rec[]
    const tree = msgs.some((m) => typeof m.parent_message_uuid === 'string')
    const nodes: ImportedNode[] = []
    let prev: string | null = null
    msgs.forEach((m, i) => {
      const id = str(m.uuid) || `m${i}`
      const parentRaw = str(m.parent_message_uuid)
      const parent = tree ? (parentRaw && parentRaw !== ROOT_UUID ? parentRaw : null) : prev
      const { content, reasoning } = messageText(m)
      nodes.push({
        id,
        parent,
        role: m.sender === 'human' || m.sender === 'user' ? 'user' : 'assistant',
        content,
        reasoning,
        createdAt: parseTime(m.created_at)
      })
      prev = id
    })
    out.push({
      source: 'claude',
      id: str(c.uuid) || `conv${out.length}`,
      title: str(c.name) || t('yaya.io.import_default_title_claude', '导入的 Claude 会话'),
      createdAt: parseTime(c.created_at),
      updatedAt: parseTime(c.updated_at),
      activeLeaf: str(c.current_leaf_message_uuid) || null,
      model: str(c.model) || undefined,
      nodes
    })
  }
  return out
}
