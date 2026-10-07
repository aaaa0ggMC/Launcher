/**
 * OpenRouter 等聚合端点的 `reasoning_details`：闭源模型（OpenAI o 系列 / GPT-5、Claude、Gemini）
 * 不给原始思维链，只给**思考摘要**（`reasoning.summary`）和加密的思考状态（`reasoning.encrypted`），
 * 开源模型给原文（`reasoning.text`）。
 *
 * - 摘要 / 原文拿来显示；
 * - 整个数组（含加密块与签名）要在同一模型继续工具循环时原样放回 assistant 消息，
 *   否则 Gemini 3 / Claude 的多步工具调用会被拒或丢掉思考上下文。
 */

export interface ReasoningDetail {
  type: string
  index?: number
  text?: string
  summary?: string
  data?: string
  signature?: string
  [key: string]: unknown
}

/** 流式增量按 index 合并（同一块的 text / summary 是分段来的） */
export function mergeReasoningDetails(acc: ReasoningDetail[], delta: unknown): ReasoningDetail[] {
  if (!Array.isArray(delta)) return acc
  for (const raw of delta) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as ReasoningDetail
    const prev =
      typeof d.index === 'number'
        ? acc.find((x) => x.index === d.index && x.type === d.type)
        : undefined
    if (!prev) {
      acc.push({ ...d })
      continue
    }
    for (const [k, v] of Object.entries(d)) {
      if (
        (k === 'text' || k === 'summary' || k === 'data' || k === 'signature') &&
        typeof v === 'string'
      )
        prev[k] = String(prev[k] ?? '') + v
      else if (v !== undefined && v !== null) prev[k] = v
    }
  }
  return acc
}

/** 一段增量里能显示的文字（摘要 / 原文；加密块没有） */
export function detailsText(delta: unknown): string {
  if (!Array.isArray(delta)) return ''
  let out = ''
  for (const raw of delta) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as ReasoningDetail
    if (d.type === 'reasoning.summary' && typeof d.summary === 'string') out += d.summary
    else if (d.type === 'reasoning.text' && typeof d.text === 'string') out += d.text
  }
  return out
}

/** 有摘要块 = 闭源模型的思考摘要 */
export function isSummaryDetails(details: ReasoningDetail[]): boolean {
  return details.some((d) => d.type === 'reasoning.summary' || d.type === 'reasoning.encrypted')
}
