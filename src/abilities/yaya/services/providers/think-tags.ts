/**
 * 正文里夹带的思考：部分端点不走 `reasoning_content`，而是把思考包在正文开头的标签里——
 * Gemini 的 OpenAI 兼容接口（`include_thoughts` 时是 `<thought>…</thought>` 思考摘要）、
 * 不少自建 / 中转的 R1 / QwQ（`<think>…</think>`）。
 *
 * 只认**回答开头**的标签（可连续几块，中间允许空白）：正文中间出现的 `<think>` 当普通文字，
 * 免得模型讲 HTML / 写代码时被误吞。流式逐块喂入，标签被拆在两块之间也能识别。
 */

const OPEN_TAGS = ['<think>', '<thought>', '<thinking>'] as const
const CLOSE_OF: Record<string, string> = {
  '<think>': '</think>',
  '<thought>': '</thought>',
  '<thinking>': '</thinking>'
}

export interface ThinkTagOutput {
  content: string
  reasoning: string
}

export class ThinkTagSplitter {
  /** detect = 还在回答开头（可能出现标签）；inside = 标签里；pass = 之后全是正文 */
  private state: 'detect' | 'inside' | 'pass' = 'detect'
  private buf = ''
  private close = ''
  /** 见过思考标签（Gemini 兼容接口的 `<thought>` 是思考摘要） */
  public sawTag: string | null = null

  push(chunk: string): ThinkTagOutput {
    const out: ThinkTagOutput = { content: '', reasoning: '' }
    if (this.state === 'pass') {
      out.content = chunk
      return out
    }
    this.buf += chunk
    for (;;) {
      if (this.state === 'detect') {
        const lead = this.buf.trimStart()
        if (!lead) return out // 只有空白：再等等
        const tag = OPEN_TAGS.find((t) => lead.startsWith(t))
        if (tag) {
          this.sawTag = tag
          this.close = CLOSE_OF[tag]
          this.buf = lead.slice(tag.length)
          this.state = 'inside'
          continue
        }
        if (OPEN_TAGS.some((t) => t.startsWith(lead))) return out // 半个标签：再等等
        // 第一块思考之后的空白不算正文开头
        out.content += this.sawTag ? lead : this.buf
        this.buf = ''
        this.state = 'pass'
        return out
      }
      if (this.state === 'inside') {
        const end = this.buf.indexOf(this.close)
        if (end >= 0) {
          out.reasoning += this.buf.slice(0, end)
          this.buf = this.buf.slice(end + this.close.length)
          this.state = 'detect'
          continue
        }
        // 末尾可能是半个结束标签，留着
        const keep = partialSuffix(this.buf, this.close)
        out.reasoning += this.buf.slice(0, this.buf.length - keep)
        this.buf = this.buf.slice(this.buf.length - keep)
        return out
      }
      out.content += this.buf
      this.buf = ''
      return out
    }
  }

  /** 流结束：没闭合的标签里的内容算思考，开头残留的半个标签算正文 */
  flush(): ThinkTagOutput {
    const rest = this.buf
    this.buf = ''
    if (this.state === 'inside') return { content: '', reasoning: rest }
    if (this.state === 'detect' && this.sawTag) return { content: rest.trimStart(), reasoning: '' }
    return { content: rest, reasoning: '' }
  }
}

/** `text` 末尾与 `tag` 开头重合的最长长度（不含整个 tag） */
function partialSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n
  }
  return 0
}

/** 非流式：一次性拆开 */
export function splitThinkTags(text: string): ThinkTagOutput & { tag: string | null } {
  const s = new ThinkTagSplitter()
  const a = s.push(text)
  const b = s.flush()
  return { content: a.content + b.content, reasoning: a.reasoning + b.reasoning, tag: s.sawTag }
}
