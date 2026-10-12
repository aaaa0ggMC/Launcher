/**
 * 消息表情回应（GitHub 式 react）：纯数据与纯逻辑，落库在 `MessageMeta.reactions`。
 *
 * - `key` 就是展示用的东西：默认表情集里它本身就是 emoji（👍），图标包里是图标名
 *   （渲染端按 `ReactionItem` 找到 `gi:` / `default/` / 图片 `src`）。
 * - `segment` 可选：拟真对话把回答切成气泡后，回应可以挂在**某个气泡**上（气泡级）；
 *   没有 `segment` 的是**整条消息级**。两份互不相扰，读写都要指明要哪一份。
 * - `by`：缺省 = 用户点的（老数据兼容，不落字段）；`'ai'` = AI 经 `react_to_user`
 *   点在**用户消息**上——AI 的表态是 AI 自己的动作，与「替用户表态」无关。
 * - **取消也要让 AI 知情**：取消时把条目移进 `Meta.reactionTombstones`（墓碑，留最近 8 条），
 *   `reactionNote()` 会把它表达成 `[user removed their reaction: …]`——否则取消后模型
 *   只看到沉默，无从分辨「从没点过」和「点过又取消了」（用户实测反馈 R3）。
 * - **回传给模型**走 `reactionNote(meta, role)`（在 `sanitizeHistory` 里拼到对应消息后面），
 *   按角色措辞：assistant 消息 = 用户点的；用户消息 = 自己点的（`user`）或 AI 点的（`ai`）。
 * - 模型偶尔会把 note 复读进自己的回复（用户实测反馈 R4）：保存前用
 *   `stripEchoedReactionNotes()` 把这类行剥掉，界面与落库都不会出现内部记号。
 */
import type { MessageMeta } from '../types'

export interface MessageReaction {
  /** 表情 key（默认集 = emoji 本身） */
  key: string
  /** 添加时间（ms） */
  at: number
  /** 气泡 id（拟真对话的分段）；缺省 = 整条消息级回应 */
  segment?: string
  /** 谁点的：缺省（undefined）= 用户；'ai' = AI 点在用户消息上 */
  by?: 'ai'
}

/** 取消墓碑：与 MessageReaction 同形状，存在 `MessageMeta.reactionTombstones` 里 */
export type ReactionTombstone = MessageReaction

/** 墓碑最多留几条（先进先出，防止长期对话无限膨胀） */
export const MAX_TOMBSTONES = 8

function readEntry(r: unknown): MessageReaction | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const key = typeof o.key === 'string' ? o.key.trim() : ''
  if (!key) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  const segment = typeof o.segment === 'string' && o.segment ? o.segment : undefined
  const by = o.by === 'ai' ? ('ai' as const) : undefined
  const out: MessageReaction = segment ? { key, at, segment } : { key, at }
  if (by) out.by = by
  return out
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

/** 取消墓碑（读）：脏数据忽略、同 key 同气泡去重、最多 MAX_TOMBSTONES 条 */
export function readTombstones(meta: MessageMeta | null | undefined): ReactionTombstone[] {
  const raw = meta?.reactionTombstones
  if (!Array.isArray(raw)) return []
  const out: ReactionTombstone[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const v = readEntry(r)
    if (!v) continue
    const id = `${v.segment ?? ''} ${v.by ?? ''} ${v.key}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(v)
  }
  return out.slice(-MAX_TOMBSTONES)
}

/**
 * 记一次取消：同 key 同气泡同来源的旧墓碑换成新的（以最新为准），
 * 超过 MAX_TOMBSTONES 丢最老的。返回新数组（调用方写回 meta）。
 */
export function addTombstone(
  list: ReactionTombstone[],
  entry: ReactionTombstone
): ReactionTombstone[] {
  const kept = list.filter(
    (r) => !(r.key === entry.key && r.segment === entry.segment && r.by === entry.by)
  )
  return [...kept, entry].slice(-MAX_TOMBSTONES)
}

/**
 * 重新点上某个表情时清掉它对应的墓碑（当前状态已在，就不再说「取消过」）；
 * 按 key + segment + 来源精确匹配，别的墓碑不动。
 */
export function clearTombstone(
  list: ReactionTombstone[],
  key: string,
  segment?: string,
  by?: 'ai'
): ReactionTombstone[] {
  return list.filter((r) => !(r.key === key && r.segment === segment && r.by === by))
}

/**
 * 点按切换：`remove` 或这一份里已存在 → 移除；否则追加（带上 `segment` 与 `by`）。
 * 返回新数组（调用方写回 `meta.reactions`）。
 */
export function toggleReaction(
  list: MessageReaction[],
  key: string,
  opts: { remove?: boolean; now?: number; segment?: string; by?: 'ai' } = {}
): MessageReaction[] {
  const k = key.trim()
  if (!k) return list
  const has = list.some((r) => r.key === k)
  if (opts.remove || has) return list.filter((r) => r.key !== k)
  const entry: MessageReaction = { key: k, at: opts.now ?? Date.now() }
  if (opts.segment) entry.segment = opts.segment
  if (opts.by) entry.by = opts.by
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

/** 按 (segment, by) 分组收集 key，顺序 = 首次出现顺序（稳定 → 缓存稳定） */
function groupKeys(
  list: MessageReaction[]
): Map<string, { segment?: string; by?: 'ai'; keys: string[] }> {
  const groups = new Map<string, { segment?: string; by?: 'ai'; keys: string[] }>()
  for (const r of list) {
    const id = `${r.segment ?? ''}|${r.by ?? ''}`
    let g = groups.get(id)
    if (!g) {
      g = { segment: r.segment, by: r.by, keys: [] }
      groups.set(id, g)
    }
    if (!g.keys.includes(r.key)) g.keys.push(r.key)
  }
  return groups
}

/**
 * 发给模型的回传说明（**只**在 `sanitizeHistory` 里用）：英文、顺序稳定，
 * 挂在对应消息的内容后面；空串 = 没有回应也没有取消，不改一个字节。
 *
 * 措辞按角色与来源区分（`role` 缺省 `'assistant'` = 旧行为）：
 * - assistant 消息：`[user reacted to this message: …]` / 气泡 `[user reacted to your segment "s": …]`
 * - 用户消息（用户自己点的）：`[user reacted to their own message: …]`
 * - 用户消息（AI 点的）：`[you reacted to this user's message: …]`
 * - 取消墓碑：`[user removed their reaction: …]` 等对应措辞
 */
export function reactionNote(
  meta: MessageMeta | null | undefined,
  role: 'user' | 'assistant' = 'assistant'
): string {
  const lines: string[] = []
  const current = groupKeys(readAllReactions(meta))
  for (const g of current.values()) {
    // AI 只会点在用户消息上（react_to_user）：assistant 消息里出现 by=ai 属于不可能态，静默跳过
    if (role === 'assistant' && g.by === 'ai') continue
    const keys = g.keys.join(' ')
    if (role === 'assistant') {
      lines.push(
        g.segment
          ? `[user reacted to your segment "${g.segment}": ${keys}]`
          : `[user reacted to this message: ${keys}]`
      )
    } else if (g.by === 'ai') {
      lines.push(
        g.segment
          ? `[you reacted to this user's message (segment "${g.segment}"): ${keys}]`
          : `[you reacted to this user's message: ${keys}]`
      )
    } else {
      lines.push(
        g.segment
          ? `[user reacted to their own message (segment "${g.segment}"): ${keys}]`
          : `[user reacted to their own message: ${keys}]`
      )
    }
  }
  const tombs = groupKeys(readTombstones(meta))
  for (const g of tombs.values()) {
    if (role === 'assistant' && g.by === 'ai') continue
    const keys = g.keys.join(' ')
    if (role === 'assistant') {
      lines.push(
        g.segment
          ? `[user removed their reaction from your segment "${g.segment}": ${keys}]`
          : `[user removed their reaction: ${keys}]`
      )
    } else if (g.by === 'ai') {
      lines.push(`[you removed your reaction from this user's message: ${keys}]`)
    } else {
      lines.push(`[user removed their reaction from their own message: ${keys}]`)
    }
  }
  return lines.join('\n')
}

/**
 * 剥掉模型把自己回复里的 note **复读**出来的部分（R4：内部记号不该出现在消息流里）。
 * 只认我们自己的四种前缀（user/you × reacted/removed），只作用于 assistant 输出：
 * - 整行都是 note → 丢弃该行；
 * - 行首粘着 note（`[note]正文`）→ 只剥前缀，正文照留。
 * 普通文本（不含这些前缀）一个字节都不动。
 */
export function stripEchoedReactionNotes(text: string): string {
  if (!text || !text.includes('[')) return text
  const NOTE = /^\[(?:user (?:reacted|removed)|you (?:reacted|removed))[^\]]*\]/
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (NOTE.test(line)) {
      const rest = line.replace(NOTE, '')
      if (!rest.trim()) continue
      out.push(rest)
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}
