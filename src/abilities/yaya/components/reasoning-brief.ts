/**
 * 思考摘要的结构：Gemini（includeThoughts）、OpenAI（reasoning summary）、部分 Claude 摘要
 * 都是「**小标题**」独占一行 + 一段说明。拆成段落给界面显示，最后一个小标题当「正在想什么」。
 */

export interface ReasoningSection {
  title: string
  body: string
}

const HEADING = /^\s*\*\*([^*\n]{1,120})\*\*\s*$/

/**
 * Gemini 流式摘要有时把下一段的小标题直接接在上一段句号后面（`…done.**Next step**\n`），
 * 句末标点后紧跟、且独占到行尾的加粗才拆成新行；普通行内加粗不动。
 */
function unglue(text: string): string {
  return text.replace(/([.!?。！？])(\*\*[^*\n]{1,120}\*\*)(?=\n|$)/g, '$1\n$2')
}

/** 拆段：小标题独占一行才算；没有小标题 = 一整段 */
export function reasoningSections(text: string): ReasoningSection[] {
  const out: Array<{ title: string; lines: string[] }> = []
  let cur: { title: string; lines: string[] } = { title: '', lines: [] }
  for (const line of unglue(text).split('\n')) {
    const m = HEADING.exec(line)
    if (!m) {
      cur.lines.push(line)
      continue
    }
    if (cur.title || cur.lines.join('').trim()) out.push(cur)
    cur = { title: m[1].trim(), lines: [] }
  }
  out.push(cur)
  return out
    .map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
    .filter((s, _i, all) => s.title || s.body || all.length === 1)
}

/** 最新的小标题（流式时显示成「思考中：…」）；没有返回空串 */
export function latestReasoningTitle(text: string | undefined): string {
  if (!text) return ''
  // 只看尾部，思考可能很长
  const tail = unglue(text.slice(-4000)).split('\n')
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = HEADING.exec(tail[i])
    if (m) return m[1].trim()
  }
  return ''
}
