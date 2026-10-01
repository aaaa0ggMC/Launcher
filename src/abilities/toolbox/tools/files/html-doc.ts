/**
 * Dependency-free, size-bounded HTML reader for local document conversion.
 *
 * It is deliberately a *tag-soup* parser (like a browser), not a validating
 * one: the goal is to salvage the structure of a pasted HTML fragment into
 * Markdown or DOCX blocks. Scripts, styles and comments are dropped, entities
 * are decoded, and hrefs are restricted to safe schemes.
 */

export interface HtmlElement {
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
}
export interface HtmlText {
  text: string
}
export type HtmlNode = HtmlElement | HtmlText

export type WordBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string; level: number }
  | { kind: 'numbered'; text: string; level: number }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] }

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** Tags whose whole subtree is dropped (never user-visible content). */
const DROP_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'audio',
  'video'
])

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const SAFE_SCHEME = /^(https?|mailto|tel|ftp):/i
const RELATIVE = /^[./#]/

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  deg: '°'
}

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()]
    return named ?? match
  })
}

function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') return i
  }
  return -1
}

function parseTagBody(body: string): HtmlElement | null {
  const match = /^([a-zA-Z][^\s/>]*)/.exec(body)
  if (!match) return null
  const tag = match[1].toLowerCase()
  const attrs: Record<string, string> = {}
  const rest = body.slice(match[0].length)
  const attrRe = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest))) {
    const name = m[1].toLowerCase()
    if (!name) continue
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[name] = decodeEntities(value)
  }
  return { tag, attrs, children: [] }
}

/** Parse an HTML document/fragment into a node forest. */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = []
  const stack: Array<{ tag: string; children: HtmlNode[] }> = []
  const push = (node: HtmlNode): void => {
    const top = stack[stack.length - 1]
    if (top) top.children.push(node)
    else root.push(node)
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      push({ text: decodeEntities(html.slice(i)) })
      break
    }
    if (lt > i) push({ text: decodeEntities(html.slice(i, lt)) })
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const gt = findTagEnd(html, lt)
    if (gt < 0) {
      push({ text: decodeEntities(html.slice(lt)) })
      break
    }
    const raw = html.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().toLowerCase()
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k
          break
        }
      }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const element = parseTagBody(selfClosing ? raw.slice(0, -1) : raw)
    if (!element) continue
    push(element)
    if (!selfClosing && !VOID_TAGS.has(element.tag)) stack.push(element)
  }
  return root
}

function isText(node: HtmlNode): node is HtmlText {
  return 'text' in node
}

function safeHref(value: string | undefined): string {
  if (!value) return ''
  const href = value.trim()
  if (!href) return ''
  if (SAFE_SCHEME.test(href) || RELATIVE.test(href)) return href
  return ''
}

/** Collapse a run of inline text whitespace the way HTML rendering does. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

type InlineMode = 'markdown' | 'plain' | 'html'

function renderInline(nodes: HtmlNode[], mode: InlineMode): string {
  let out = ''
  for (const node of nodes) {
    if (isText(node)) {
      out += mode === 'markdown' || mode === 'plain' ? collapse(node.text) : escapeHtml(node.text)
      continue
    }
    const { tag } = node
    if (DROP_TAGS.has(tag) || tag === 'br') {
      if (tag === 'br') out += mode === 'markdown' ? '\n' : ' '
      continue
    }
    if (tag === 'img') continue
    const inner = renderInline(node.children, mode)
    if (!inner) continue
    switch (tag) {
      case 'strong':
      case 'b':
        out += mode === 'markdown' ? `**${inner}**` : inner
        break
      case 'em':
      case 'i':
      case 'cite':
      case 'var':
        out += mode === 'markdown' ? `*${inner}*` : inner
        break
      case 'del':
      case 's':
      case 'strike':
        out += mode === 'markdown' ? `~~${inner}~~` : inner
        break
      case 'code':
      case 'kbd':
      case 'samp':
        out += mode === 'markdown' ? '`' + inner.replace(/`/g, '') + '`' : inner
        break
      case 'a': {
        const href = safeHref(node.attrs.href)
        out +=
          mode === 'markdown' && href && !node.children.length
            ? `[${inner}](${href})`
            : inner || href
        break
      }
      default:
        out +=
          mode === 'html' && node.attrs.style
            ? `<span style="color: inherit">${inner}</span>`
            : inner
        break
    }
  }
  return out.trim() === '' && mode !== 'html' ? '' : out
}

/** Concatenate all text of a subtree (used for table cells / quotes). */
function rawText(node: HtmlNode): string {
  if (isText(node)) return node.text
  const parts: string[] = []
  for (const child of node.children) {
    if (!isText(child) && child.tag === 'br') {
      parts.push('\n')
      continue
    }
    parts.push(rawText(child))
  }
  return parts.join('')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tableRowsFrom(node: HtmlElement): string[][] {
  const rows: string[][] = []
  let current: string[] | null = null
  const walk = (nodes: HtmlNode[]): void => {
    for (const child of nodes) {
      if (isText(child)) continue
      if (child.tag === 'tr') {
        current = []
        rows.push(current)
        walk(child.children)
        continue
      }
      if (child.tag === 'td' || child.tag === 'th') {
        if (!current) {
          current = []
          rows.push(current)
        }
        current.push(collapse(rawText(child)).trim())
        continue
      }
      walk(child.children)
    }
  }
  walk(node.children)
  return rows
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const cells = (r: string[]): string[] =>
    Array.from({ length: width }, (_, i) =>
      (r[i] ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
    )
  const lines: string[] = []
  lines.push(`| ${cells(rows[0]).join(' | ')} |`)
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
  for (let i = 1; i < rows.length; i++) lines.push(`| ${cells(rows[i]).join(' | ')} |`)
  return lines.join('\n')
}

/** Render HTML as Markdown. */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = []
  const walk = (nodes: HtmlNode[]): void => {
    let inline = ''
    const flushInline = (): void => {
      const text = inline.trim()
      if (text) blocks.push(text)
      inline = ''
    }
    for (const node of nodes) {
      if (isText(node)) {
        inline += collapse(node.text)
        continue
      }
      const { tag } = node
      if (DROP_TAGS.has(tag)) continue
      if (HEADING_TAGS.has(tag)) {
        flushInline()
        const text = renderInline(node.children, 'markdown')
        if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
        continue
      }
      if (
        tag === 'p' ||
        tag === 'div' ||
        tag === 'section' ||
        tag === 'article' ||
        tag === 'main'
      ) {
        flushInline()
        const text = renderInline(node.children, 'markdown')
        if (text) blocks.push(text)
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        flushInline()
        const ordered = tag === 'ol'
        for (const line of markdownItems(node, ordered, '')) blocks.push(line)
        continue
      }
      if (tag === 'blockquote') {
        flushInline()
        const text = renderInline(node.children, 'markdown')
        if (text)
          blocks.push(
            text
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          )
        continue
      }
      if (tag === 'pre') {
        flushInline()
        blocks.push('```\n' + rawText(node).replace(/\n+$/, '') + '\n```')
        continue
      }
      if (tag === 'table') {
        flushInline()
        const rows = tableRowsFrom(node)
        if (rows.length) blocks.push(markdownTable(rows))
        continue
      }
      if (tag === 'hr') {
        flushInline()
        blocks.push('---')
        continue
      }
      inline += renderInline([node], 'markdown')
    }
    flushInline()
  }
  walk(parseHtml(html))
  return blocks.join('\n\n').trim()
}

function markdownItems(node: HtmlElement, ordered: boolean, prefix: string): string[] {
  const out: string[] = []
  const items = listItems(node)
  items.forEach((item, index) => {
    const marker = ordered ? `${index + 1}.` : '-'
    const head = renderInline(item.content, 'markdown')
    out.push(`${prefix}${marker} ${head}`)
    for (const child of item.children) {
      if (!isText(child) && (child.tag === 'ul' || child.tag === 'ol')) {
        for (const line of markdownItems(child, child.tag === 'ol', `${prefix}  `)) out.push(line)
      }
    }
  })
  return out
}

interface ListItem {
  content: HtmlNode[]
  children: HtmlNode[]
}

/** Split a <ul>/<ol> into items, keeping nested lists separate. */
function listItems(node: HtmlElement): ListItem[] {
  const items: ListItem[] = []
  let current: ListItem | null = null
  const add = (child: HtmlNode, isList: boolean): void => {
    if (!current) {
      current = { content: [], children: [] }
      items.push(current)
    }
    if (isList) current.children.push(child)
    else current.content.push(child)
  }
  const walk = (nodes: HtmlNode[]): void => {
    for (const child of nodes) {
      if (isText(child)) {
        add(child, false)
        continue
      }
      if (child.tag === 'li') {
        current = { content: [], children: [] }
        items.push(current)
        walk(child.children)
        continue
      }
      if (child.tag === 'ul' || child.tag === 'ol') {
        add(child, true)
        continue
      }
      add(child, false)
    }
  }
  walk(node.children)
  return items.filter((item) => item.content.length > 0 || item.children.length > 0)
}

/** Render HTML as DOCX-ready structural blocks. */
export function htmlToBlocks(html: string): WordBlock[] {
  const blocks: WordBlock[] = []
  const walk = (nodes: HtmlNode[], level: number): void => {
    let inline = ''
    const flushInline = (): void => {
      const text = inline.trim()
      if (text) blocks.push({ kind: 'paragraph', text })
      inline = ''
    }
    for (const node of nodes) {
      if (isText(node)) {
        inline += collapse(node.text)
        continue
      }
      const { tag } = node
      if (DROP_TAGS.has(tag)) continue
      if (tag === 'br') {
        inline += '\n'
        continue
      }
      if (HEADING_TAGS.has(tag)) {
        flushInline()
        const text = renderInline(node.children, 'plain')
        if (text) blocks.push({ kind: 'heading', level: Number(tag[1]), text })
        continue
      }
      if (tag === 'p') {
        flushInline()
        const text = renderInline(node.children, 'plain')
        if (text) blocks.push({ kind: 'paragraph', text })
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        flushInline()
        itemsBlocks(node, tag === 'ol', level, blocks)
        continue
      }
      if (tag === 'blockquote') {
        flushInline()
        const text = renderInline(node.children, 'plain')
        if (text) blocks.push({ kind: 'quote', text })
        continue
      }
      if (tag === 'pre') {
        flushInline()
        const text = rawText(node).replace(/\n+$/, '')
        if (text) blocks.push({ kind: 'code', text })
        continue
      }
      if (tag === 'table') {
        flushInline()
        const rows = tableRowsFrom(node)
        if (rows.length) blocks.push({ kind: 'table', rows })
        continue
      }
      if (tag === 'hr') {
        flushInline()
        continue
      }
      if (
        tag === 'div' ||
        tag === 'section' ||
        tag === 'article' ||
        tag === 'main' ||
        tag === 'body'
      ) {
        flushInline()
        walk(node.children, level)
        continue
      }
      inline += renderInline([node], 'plain')
    }
    flushInline()
  }
  walk(parseHtml(html), 0)
  return blocks
}

function itemsBlocks(node: HtmlElement, ordered: boolean, level: number, out: WordBlock[]): void {
  const items = listItems(node)
  items.forEach((item) => {
    const text = renderInline(item.content, 'plain')
    if (text) {
      out.push(ordered ? { kind: 'numbered', text, level } : { kind: 'bullet', text, level })
    }
    if (item.children.length) {
      for (const child of item.children) {
        if (!isText(child) && (child.tag === 'ul' || child.tag === 'ol')) {
          itemsBlocks(child, child.tag === 'ol', level + 1, out)
        }
      }
    }
  })
}

/** Escape text and wrap it into simple paragraphs (used by pdf-to-html). */ export function textToSafeHtml(
  text: string
): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const body = blocks.map((b) => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`).join('\n')
  return (
    '<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n' +
    '<title>PDF 文本导出</title>\n</head>\n<body>\n' +
    body +
    '\n</body>\n</html>\n'
  )
}

/** Bare text of an HTML fragment (used by swagger descriptions). */
export function htmlToPlainText(html: string): string {
  const nodes = parseHtml(html)
  return renderInline(nodes, 'plain')
}
