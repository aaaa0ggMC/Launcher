/**
 * 消息表情回应（GitHub 式 react）：纯数据与纯逻辑，落库在 `MessageNode.meta.reactions`。
 *
 * - `key` 就是展示用的东西：默认表情集里它本身就是 emoji（👍），图标包里是图标名
 *   （渲染端按 `ReactionItem` 找到 `gi:` / `default/` 图标）。
 * - 只影响显示与本地记录：**不进模型上下文**，除非某个插件（拟真对话）把它写成
 *   `meta.reactionNote` 回传给 AI。
 */
import type { MessageMeta } from '../types'

export interface MessageReaction {
  /** 表情 key（默认集 = emoji 本身） */
  key: string
  /** 添加时间（ms） */
  at: number
}

function readKey(r: unknown): { key: string; at: number } | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const key = typeof o.key === 'string' ? o.key.trim() : ''
  if (!key) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  return { key, at }
}

/** 读出一条消息的表情（脏数据一律忽略，同 key 去重） */
export function readReactions(meta: MessageMeta | null | undefined): MessageReaction[] {
  const raw = meta?.reactions
  if (!Array.isArray(raw)) return []
  const out: MessageReaction[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const v = readKey(r)
    if (!v || seen.has(v.key)) continue
    seen.add(v.key)
    out.push(v)
  }
  return out
}

/**
 * 点按切换：`remove` 或已存在 → 移除；否则追加到末尾。
 * 返回新数组（调用方写回 `meta.reactions`）。
 */
export function toggleReaction(
  list: MessageReaction[],
  key: string,
  opts: { remove?: boolean; now?: number } = {}
): MessageReaction[] {
  const k = key.trim()
  if (!k) return list
  const has = list.some((r) => r.key === k)
  if (opts.remove || has) return list.filter((r) => r.key !== k)
  return [...list, { key: k, at: opts.now ?? Date.now() }]
}
