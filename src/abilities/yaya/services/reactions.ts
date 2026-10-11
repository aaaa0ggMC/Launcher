/**
 * 消息表情回应（GitHub 式 react）：纯数据与纯逻辑，落库在 `MessageNode.meta.reactions`。
 *
 * - `key` 就是展示用的东西：默认表情集里它本身就是 emoji（👍），图标包里是图标名
 *   （渲染端按 `ReactionItem` 找到 `gi:` / `default/` / 图片 `src`）。
 * - `segment` 可选：拟真对话把回答切成气泡后，回应可以挂在**某个气泡**上（气泡级）；
 *   没有 `segment` 的是**整条消息级**。两份互不相扰，读写都要指明要哪一份。
 * - 界面显示与本地记录是它唯一的作用；**回传给模型**走 `reactionNote()`（在
 *   `sanitizeHistory` 里拼到对应 assistant 消息后面），除此之外不进模型上下文。
 */
import type { MessageMeta } from '../types'

export interface MessageReaction {
  /** 表情 key（默认集 = emoji 本身） */
  key: string
  /** 添加时间（ms） */
  at: number
  /** 气泡 id（拟真对话的分段）；缺省 = 整条消息级回应 */
  segment?: string
}

function readEntry(r: unknown): MessageReaction | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const key = typeof o.key === 'string' ? o.key.trim() : ''
  if (!key) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  const segment = typeof o.segment === 'string' && o.segment ? o.segment : undefined
  return segment ? { key, at, segment } : { key, at }
}

/** 全部回应（消息级 + 气泡级），脏数据忽略、同 key 同气泡去重 */
export function readAllReactions(meta: MessageMeta | null | undefined): MessageReaction[] {
  const raw = meta?.reactions
  if (!Array.isArray(raw)) return []
  const out: MessageReaction[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const v = readEntry(r)
    if (!v) continue
    const id = `${v.segment ?? ''} ${v.key}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(v)
  }
  return out
}

/**
 * 读**一份**回应：不给 `segment` 读消息级，给了读那个气泡的。
 * （消息级与气泡级分开读，选择器 / 芯片才不会串台。）
 */
export function readReactions(
  meta: MessageMeta | null | undefined,
  segment?: string
): MessageReaction[] {
  return readAllReactions(meta).filter((r) => r.segment === segment)
}

/**
 * 点按切换：`remove` 或这一份里已存在 → 移除；否则追加（带上 `segment`）。
 * 返回新数组（调用方写回 `meta.reactions`）。
 */
export function toggleReaction(
  list: MessageReaction[],
  key: string,
  opts: { remove?: boolean; now?: number; segment?: string } = {}
): MessageReaction[] {
  const k = key.trim()
  if (!k) return list
  const has = list.some((r) => r.key === k)
  if (opts.remove || has) return list.filter((r) => r.key !== k)
  const entry: MessageReaction = { key: k, at: opts.now ?? Date.now() }
  if (opts.segment) entry.segment = opts.segment
  return [...list, entry]
}

/**
 * 用某一**份**（消息级 / 某个气泡）的最新结果替换旧条目，其余保持原位与原顺序
 * ——顺序稳定，`reactionNote` 的输出才稳定，提示词前缀才不会被表情增删搅动。
 */
export function mergeReactions(
  all: MessageReaction[],
  segment: string | undefined,
  next: MessageReaction[]
): MessageReaction[] {
  const out: MessageReaction[] = []
  let replaced = false
  for (const r of all) {
    if (r.segment !== segment) {
      out.push(r)
      continue
    }
    if (replaced) continue
    replaced = true
    out.push(...next)
  }
  if (!replaced) out.push(...next)
  return out
}

/**
 * 发给模型的回传说明（**只**在 `sanitizeHistory` 里用）：英文、顺序稳定，
 * 挂在对应 assistant 消息的内容后面——AI 由此知道自己哪一段被点了什么表情。
 * 空串 = 没有回应，不改一个字节（提示词前缀照旧稳定）。
 */
export function reactionNote(meta: MessageMeta | null | undefined): string {
  const all = readAllReactions(meta)
  if (!all.length) return ''
  const lines: string[] = []
  const plain = all.filter((r) => !r.segment)
  if (plain.length)
    lines.push(`[user reacted to this message: ${plain.map((r) => r.key).join(' ')}]`)
  const bySeg = new Map<string, string[]>()
  for (const r of all) {
    if (!r.segment) continue
    const keys = bySeg.get(r.segment)
    if (keys) {
      if (!keys.includes(r.key)) keys.push(r.key)
    } else bySeg.set(r.segment, [r.key])
  }
  for (const [seg, keys] of bySeg)
    lines.push(`[user reacted to your segment "${seg}": ${keys.join(' ')}]`)
  return lines.join('\n')
}
