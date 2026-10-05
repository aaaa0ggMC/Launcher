/**
 * mention 插件（输入框 `@` 点名）的纯逻辑：候选过滤、键盘环绕索引、文本触发区间校验。
 *
 * 这些函数不依赖 Vue / DOM / 命令注册表，可以离线单测（`select.test.ts`）。
 * 「选哪个、删哪段文字」的判断都在这里，`MentionInput.vue` 只负责接线。
 */
import type { MentionCandidate } from '../../services/plugins/mention'

/** 本插件自己的 id：用户 `@` 的就是这个功能本身，候选里不能再出现它（后端同样会跳过） */
export const SELF_PLUGIN_ID = 'mention'

/** 输入框里用来触发点名的前缀（与注册给宿主的 triggers 一致） */
export const TRIGGER_PREFIX = '@'

/** `@` 后面允许的查询长度上限（超过就不再当作点名触发，见 matchInputTrigger） */
export const MAX_QUERY_LENGTH = 32

/** 触发时保存的 `@query` 精确区间（相对草稿的下标） */
export interface TriggerRange {
  start: number
  end: number
  text: string
}

/**
 * 可选候选：滤掉本插件自己，以及已经点过的（同一个插件点一次就够）。
 * 顺序保持服务端返回的顺序。
 */
export function usableCandidates(
  items: readonly MentionCandidate[],
  selected: readonly MentionCandidate[]
): MentionCandidate[] {
  const taken = new Set(selected.map((m) => m.ref))
  return items.filter((c) => c.ref !== SELF_PLUGIN_ID && !taken.has(c.ref))
}

/** 上下键移动的环绕索引；列表为空时恒为 0 */
export function cycleIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const next = (current + delta) % length
  return next < 0 ? next + length : next
}

/**
 * 触发时保存的 `@query` 区间现在还能不能安全替换掉。
 *
 * 从触发到确认之间草稿可能已经变了（用户继续输入、改了这段文字、把光标移到区间中间），
 * 这时宁可不删，也不能把用户的新文字吃掉。判定标准：
 * - 区间在草稿范围内且非空；
 * - 这段文字仍以触发前缀开头、中间没有空白、起始处仍在边界上（行首或空白之后）；
 * - 当前选区整体在区间末尾之后（光标没有退回区间里）。
 */
export function validTriggerRange(
  draft: string,
  range: TriggerRange,
  caret: { start: number; end: number }
): boolean {
  if (range.start < 0 || range.end > draft.length || range.end <= range.start) return false
  const text = draft.slice(range.start, range.end)
  if (text !== range.text || !text.startsWith(TRIGGER_PREFIX)) return false
  if (/\s/.test(text)) return false
  if (range.start > 0 && !/\s/.test(draft[range.start - 1])) return false
  return caret.start === range.end && caret.end === range.end
}
