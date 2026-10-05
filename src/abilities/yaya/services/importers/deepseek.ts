/**
 * DeepSeek（chat.deepseek.com）导出解析：设置 → 数据管理 → 导出，zip 里的 `conversations.json`。
 *
 * 结构与 ChatGPT 类似是 `mapping` 树，但消息体是 `fragments`：
 * `{ id, title, inserted_at, updated_at, current_message_id?, mapping: { [id]: { id, parent, children,
 *   message: { model, inserted_at, fragments: [{ type: 'REQUEST' | 'RESPONSE' | 'THINK' | 'SEARCH', content }] } } } }`。
 * REQUEST = 用户，RESPONSE = 回答，THINK = 推理过程（进 reasoningContent）；SEARCH 等其它片段跳过。
 * 也兼容消息直接带 `role` + `content` / `thinking_content` 的旧格式。
 */
import { t } from '../../../../main/process/i18n'
import { parseTime, type ImportedConversation, type ImportedNode } from './common'

type Rec = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstConv(data: unknown): Rec | null {
  const first = Array.isArray(data) ? data[0] : data
  return first && typeof first === 'object' ? (first as Rec) : null
}

/** mapping 里的消息带 fragments（或 DeepSeek 的 role 写法）而不是 ChatGPT 的 author */
export function isDeepseekExport(data: unknown): boolean {
  const c = firstConv(data)
  const mapping = c?.mapping
  if (!mapping || typeof mapping !== 'object') return false
  for (const n of Object.values(mapping as Record<string, Rec>)) {
    const m = n?.message as Rec | undefined
    if (!m) continue
    if (Array.isArray(m.fragments)) return true
    if (m.author) return false
    if (typeof m.role === 'string') return true
  }
  return false
}

function nodeOf(id: string, parent: string | null, m: Rec): ImportedNode | null {
  let role: 'user' | 'assistant' | null = null
  const content: string[] = []
  const reasoning: string[] = []
  if (Array.isArray(m.fragments)) {
    for (const f of m.fragments as Rec[]) {
      const type = str(f.type).toUpperCase()
      const text = str(f.content)
      if (type === 'REQUEST') {
        role = 'user'
        if (text) content.push(text)
      } else if (type === 'RESPONSE') {
        role = role ?? 'assistant'
        if (text) content.push(text)
      } else if (type === 'THINK' || type === 'THINKING') {
        role = role ?? 'assistant'
        if (text) reasoning.push(text)
      }
    }
  } else {
    const r = str(m.role).toLowerCase()
    role = r === 'user' ? 'user' : r === 'assistant' ? 'assistant' : null
    if (str(m.content)) content.push(str(m.content))
    if (str(m.thinking_content)) reasoning.push(str(m.thinking_content))
  }
  if (!role) return null
  const files = Array.isArray(m.files) ? (m.files as Rec[]) : []
  for (const f of files) content.push(`[${str(f.file_name) || str(f.name) || 'file'}]`)
  return {
    id,
    parent,
    role,
    content: content.join('\n\n'),
    reasoning: reasoning.join('\n\n'),
    createdAt: parseTime(m.inserted_at ?? m.created_at),
    model: str(m.model) || undefined
  }
}

export function parseDeepseekExport(data: unknown): ImportedConversation[] {
  const list = (Array.isArray(data) ? data : [data]) as Rec[]
  const out: ImportedConversation[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object' || !c.mapping || typeof c.mapping !== 'object') continue
    const mapping = c.mapping as Record<string, Rec>
    const nodes: ImportedNode[] = []
    for (const [key, n] of Object.entries(mapping)) {
      const id = str(n?.id) || key
      const parent = n?.parent === null || n?.parent === undefined ? null : String(n.parent)
      const m = n?.message as Rec | null | undefined
      // 没有消息的根 / 占位节点也保留（空内容，写库时被跳过，子节点自动接到上层）
      const node = m ? nodeOf(id, parent, m) : null
      nodes.push(node ?? { id, parent, role: 'assistant', content: '' })
    }
    const current = c.current_message_id ?? c.current_node
    out.push({
      source: 'deepseek',
      id: str(c.id) || `conv${out.length}`,
      title: str(c.title) || t('yaya.io.import_default_title_deepseek', '导入的 DeepSeek 会话'),
      createdAt: parseTime(c.inserted_at ?? c.created_at),
      updatedAt: parseTime(c.updated_at),
      activeLeaf: current === undefined || current === null ? null : String(current),
      nodes
    })
  }
  return out
}
