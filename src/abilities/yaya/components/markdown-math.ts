/**
 * markdown-it 数学公式插件：`$…$` / `\(…\)` 行内，`$$…$$` / `\[…\]` 块级（也允许写在段落里）。
 *
 * 渲染器由调用方注入（`renderMath`），这样 katex 可以按需加载：还没加载好时调用方先输出
 * 源码占位，加载完成后让 computed 失效重渲染。
 *
 * 规则（避免把价格、Shell 变量误判成公式）：
 * - `$` 开头后不能紧跟空白，结尾 `$` 前不能是空白、后面不能紧跟数字（`$5 和 $10` 不是公式）；
 * - `\(` `\[` 必须在 markdown-it 的转义规则之前处理，否则反斜杠会被吃掉。
 */
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it'

export type MathRenderer = (tex: string, display: boolean) => string

function findClosing(src: string, from: number, close: string): number {
  let i = from
  while (i < src.length) {
    const at = src.indexOf(close, i)
    if (at < 0) return -1
    // 跳过被转义的分隔符（如 \$）
    let backslashes = 0
    for (let j = at - 1; j >= 0 && src[j] === '\\'; j--) backslashes++
    if (backslashes % 2 === 0) return at
    i = at + 1
  }
  return -1
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  let open: string
  let close: string
  let display = false
  if (src.startsWith('$$', start)) {
    open = '$$'
    close = '$$'
    display = true
  } else if (src[start] === '$') {
    open = '$'
    close = '$'
  } else if (src.startsWith('\\(', start)) {
    open = '\\('
    close = '\\)'
  } else if (src.startsWith('\\[', start)) {
    open = '\\['
    close = '\\]'
    display = true
  } else return false

  const contentStart = start + open.length
  const end = findClosing(src, contentStart, close)
  if (end < 0 || end === contentStart) return false
  const tex = src.slice(contentStart, end)

  if (open === '$') {
    if (/\s/.test(tex[0]) || /\s/.test(tex[tex.length - 1])) return false
    if (/\d/.test(src[end + 1] ?? '')) return false
  }

  if (!silent) {
    const token = state.push(display ? 'math_display_inline' : 'math_inline', 'math', 0)
    token.content = tex
    token.markup = open
  }
  state.pos = end + close.length
  return true
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine]
  const lineEnd = state.eMarks[startLine]
  const first = state.src.slice(lineStart, lineEnd)
  let open: string
  let close: string
  if (first.startsWith('$$')) {
    open = '$$'
    close = '$$'
  } else if (first.startsWith('\\[')) {
    open = '\\['
    close = '\\]'
  } else return false

  const rest = first.slice(open.length)
  let content: string
  let nextLine = startLine + 1
  // 单行：$$ x $$ / \[ x \]
  const sameLine = rest.trimEnd()
  if (sameLine.endsWith(close) && sameLine.length >= close.length) {
    content = sameLine.slice(0, -close.length)
  } else {
    const lines = [rest]
    let found = false
    for (; nextLine < endLine; nextLine++) {
      const s = state.bMarks[nextLine] + state.tShift[nextLine]
      const text = state.src.slice(s, state.eMarks[nextLine])
      const trimmed = text.trimEnd()
      if (trimmed.endsWith(close)) {
        lines.push(trimmed.slice(0, -close.length))
        found = true
        nextLine++
        break
      }
      lines.push(text)
    }
    if (!found) return false
    content = lines.join('\n')
  }
  if (silent) return true

  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = content.trim()
  token.markup = open
  token.map = [startLine, nextLine]
  state.line = nextLine
  return true
}

export function mathPlugin(md: MarkdownIt, render: MathRenderer): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline)
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  md.renderer.rules.math_inline = (tokens, idx) => render(tokens[idx].content, false)
  md.renderer.rules.math_display_inline = (tokens, idx) =>
    `<span class="md-math-display">${render(tokens[idx].content, true)}</span>`
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="md-math-display">${render(tokens[idx].content, true)}</div>\n`
}
