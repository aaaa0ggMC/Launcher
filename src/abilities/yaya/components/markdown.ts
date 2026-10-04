/**
 * 聊天消息的 Markdown 渲染：markdown-it（html:false，原始 HTML 一律转义）
 * + 按需加载的 highlight.js + 代码块标题栏（语言 / 复制按钮）
 * + 按需加载的 KaTeX 数学公式（见 markdown-math.ts）。
 * 复制与外链点击由 `handleMarkdownClick` 做事件委托，不往 HTML 里塞内联脚本。
 */
import { ref } from 'vue'
import MarkdownIt from 'markdown-it'
import type { HLJSApi } from 'highlight.js'
import { mathPlugin } from './markdown-math'

let hljs: HLJSApi | null = null
let loading: Promise<void> | null = null
/** highlight.js / KaTeX 加载完成后自增，渲染端 computed 依赖它以便重新渲染 */
export const highlightEpoch = ref(0)

export function ensureHighlighter(): void {
  if (hljs || loading) return
  loading = import('highlight.js/lib/common')
    .then((m) => {
      hljs = m.default
      highlightEpoch.value++
    })
    .catch(() => {
      /* 没有高亮也能正常显示纯文本代码块 */
    })
}

type Katex = typeof import('katex').default
let katex: Katex | null = null
let katexLoading: Promise<void> | null = null

function ensureKatex(): void {
  if (katex || katexLoading) return
  katexLoading = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([m]) => {
      katex = m.default
      highlightEpoch.value++
    })
    .catch(() => {
      /* 加载失败就一直显示公式源码 */
    })
}

/** KaTeX 未加载 / 公式有误时显示源码，不抛错 */
function renderMath(tex: string, display: boolean): string {
  if (!katex) {
    ensureKatex()
    const escaped = md.utils.escapeHtml(tex)
    return `<code class="md-math-src">${display ? `$$${escaped}$$` : `$${escaped}$`}</code>`
  }
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    output: 'html',
    strict: 'ignore'
  })
  // 较长的行内公式包一层可横向滚动的盒子，窄屏不撑破气泡
  return !display && tex.length > 40 ? `<span class="md-math-wide">${html}</span>` : html
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (str, lang) => {
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* 回落到转义后的纯文本 */
      }
    }
    return ''
  }
})

mathPlugin(md, renderMath)

const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const lang = md.utils.escapeHtml(token.info.trim().split(/\s+/)[0] || '')
  const body = defaultFence(tokens, idx, options, env, self)
  const labels = (env as { labels?: { copy: string } }).labels
  return (
    `<div class="md-code">` +
    `<div class="md-code-head"><span class="md-code-lang">${lang || 'text'}</span>` +
    `<button type="button" class="md-code-copy" data-md-copy="${idx}">${labels?.copy ?? 'Copy'}</button></div>` +
    body +
    `</div>`
  )
}

export function renderMarkdown(text: string, labels: { copy: string }): string {
  // 依赖 epoch：高亮器加载完后让调用方的 computed 失效重算
  void highlightEpoch.value
  if (/```|~~~/.test(text)) ensureHighlighter()
  const blocks = splitBlocks(text || '')
  return blocks.map((b, i) => cachedHtml(b, labels, i < blocks.length - 1)).join('')
}

// ---------------------------------------------------------------------------
// 分块渲染缓存：流式输出时每来一个 token 都要重渲染整段回答，长回答会越来越卡（O(n²)）。
// 把文本按「顶层空行」切成互不影响的块，已完成的块按原文缓存，只有最后一块（还在写）每次重渲染。
// ---------------------------------------------------------------------------

const BLOCK_CACHE_MAX = 600
const blockCache = new Map<string, unknown>()
let cacheEpoch = -1

function cacheGet<T>(key: string): T | undefined {
  if (cacheEpoch !== highlightEpoch.value) {
    // 高亮器 / KaTeX 刚加载完：旧的 HTML 是没高亮的版本，作废
    blockCache.clear()
    cacheEpoch = highlightEpoch.value
  }
  const v = blockCache.get(key)
  if (v !== undefined) {
    // 最近使用的移到末尾（Map 按插入顺序淘汰）
    blockCache.delete(key)
    blockCache.set(key, v)
  }
  return v as T | undefined
}

function cacheSet(key: string, v: unknown): void {
  blockCache.set(key, v)
  if (blockCache.size > BLOCK_CACHE_MAX) {
    const oldest = blockCache.keys().next().value
    if (oldest !== undefined) blockCache.delete(oldest)
  }
}

function cachedHtml(block: string, labels: { copy: string }, cache: boolean): string {
  if (!cache) return md.render(block, { labels })
  const key = `h|${labels.copy}|${block}`
  const hit = cacheGet<string>(key)
  if (hit !== undefined) return hit
  const html = md.render(block, { labels })
  cacheSet(key, html)
  return html
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])\s/
/** 列表块里，空行之后这些开头仍属于这个列表（下一项 / 缩进的续行段落），不能切开 */
const CONTINUES_RE = /^(\s|[-*+]\s|\d{1,9}[.)]\s)/

/**
 * 按顶层空行切块：代码块、`$$` / `\[` 数学块内部不切；列表块里空行后紧跟缩进行或列表项时不切
 * （松散列表、列表项的续行段落保持在同一块）。各块单独渲染与整段渲染等价（引用式链接定义
 * 跨块时除外——模型几乎不用）。
 */
export function splitBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence: { ch: string; len: number } | null = null
  let math: '$$' | '\\]' | null = null
  let blank = false
  const flush = (): void => {
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
  }
  for (const line of lines) {
    if (fence) {
      cur.push(line)
      const m = FENCE_RE.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !line.slice(m[0].length).trim())
        fence = null
      continue
    }
    if (math) {
      cur.push(line)
      if (line.includes(math)) math = null
      continue
    }
    if (!line.trim()) {
      blank = cur.length > 0
      if (blank) cur.push(line)
      continue
    }
    if (blank && !(LIST_RE.test(cur[0]) && CONTINUES_RE.test(line))) {
      // 去掉块尾的空行再切
      while (cur.length && !cur[cur.length - 1].trim()) cur.pop()
      flush()
    }
    blank = false
    cur.push(line)
    const m = FENCE_RE.exec(line)
    if (m) fence = { ch: m[1][0], len: m[1].length }
    else if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) math = '$$'
    else if (line.includes('\\[') && !line.includes('\\]')) math = '\\]'
  }
  while (cur.length && !cur[cur.length - 1].trim()) cur.pop()
  flush()
  return blocks
}

/**
 * 委托点击：代码块复制、外链交给系统浏览器。
 * 返回 true 表示已处理（调用方据此 preventDefault）。
 */
export function handleMarkdownClick(ev: MouseEvent, copiedLabel: string): boolean {
  const target = ev.target as HTMLElement | null
  if (!target) return false
  const copyBtn = target.closest<HTMLButtonElement>('[data-md-copy]')
  if (copyBtn) {
    const code = copyBtn.closest('.md-code')?.querySelector('pre code, pre')
    if (code) {
      const original = copyBtn.textContent
      void window.cockpit.copyText(code.textContent ?? '').then(() => {
        copyBtn.textContent = copiedLabel
        setTimeout(() => (copyBtn.textContent = original), 1500)
      })
    }
    return true
  }
  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (link) {
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void window.cockpit.openExternal(href)
    return true
  }
  return false
}

/**
 * 高亮一段代码，返回可直接 v-html 的 HTML（已转义）。highlight.js 还没加载时返回转义后的纯文本，
 * 并触发加载；调用方的 computed 读 `highlightEpoch` 即可在加载完成后自动重算。
 */
export function highlightCode(code: string, lang: string): string {
  void highlightEpoch.value
  ensureHighlighter()
  if (hljs && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      /* 回落纯文本 */
    }
  }
  return md.utils.escapeHtml(code)
}

export type MarkdownSegment =
  { kind: 'html'; html: string } | { kind: 'fence'; lang: string; source: string; closed: boolean }

/**
 * 按「插件接管的代码块」把回答切段：顶层的 ```<lang> 代码块（lang 在 `langs` 里）成为组件段，
 * 其余照常渲染成 HTML。没有命中时只有一个 html 段（与 renderMarkdown 结果一致）。
 */
export function renderSegments(
  text: string,
  langs: Set<string>,
  labels: { copy: string }
): MarkdownSegment[] {
  void highlightEpoch.value
  if (!langs.size || !/```|~~~/.test(text))
    return [{ kind: 'html', html: renderMarkdown(text, labels) }]
  ensureHighlighter()
  // 分块：只有含代码块的块才需要按 token 切段，其余块走 HTML 缓存；相邻 HTML 段合并
  const blocks = splitBlocks(text || '')
  const out: MarkdownSegment[] = []
  const pushHtml = (html: string): void => {
    const last = out[out.length - 1]
    if (last?.kind === 'html') last.html += html
    else out.push({ kind: 'html', html })
  }
  blocks.forEach((block, i) => {
    const done = i < blocks.length - 1
    if (!/```|~~~/.test(block)) {
      pushHtml(cachedHtml(block, labels, done))
      return
    }
    const key = `s|${labels.copy}|${[...langs].join(',')}|${block}`
    let segs = done ? cacheGet<MarkdownSegment[]>(key) : undefined
    if (!segs) {
      segs = segmentBlock(block, langs, labels)
      if (done) cacheSet(key, segs)
    }
    for (const seg of segs) {
      if (seg.kind === 'html') pushHtml(seg.html)
      else out.push({ ...seg })
    }
  })
  return out
}

function segmentBlock(
  text: string,
  langs: Set<string>,
  labels: { copy: string }
): MarkdownSegment[] {
  const env = { labels }
  const tokens = md.parse(text || '', env)
  const out: MarkdownSegment[] = []
  let buf: typeof tokens = []
  const flush = (): void => {
    if (buf.length) out.push({ kind: 'html', html: md.renderer.render(buf, md.options, env) })
    buf = []
  }
  for (const tok of tokens) {
    const lang = tok.type === 'fence' ? tok.info.trim().split(/\s+/)[0].toLowerCase() : ''
    if (tok.type === 'fence' && tok.level === 0 && langs.has(lang)) {
      flush()
      // 流式输出时最后一个代码块可能还没写完（markdown-it 会把它延伸到文末）：看它的最后一行是不是闭合围栏
      const lines = text.split('\n')
      const [from, to] = tok.map ?? [0, 0]
      const lastLine = (lines[to - 1] ?? '').trim()
      const closed =
        to - from >= 2 &&
        lastLine.length >= tok.markup.length &&
        [...lastLine].every((char) => char === tok.markup[0])
      out.push({ kind: 'fence', lang, source: tok.content, closed })
    } else buf.push(tok)
  }
  flush()
  return out
}
