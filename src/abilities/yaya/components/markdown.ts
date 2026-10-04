/**
 * 聊天消息的 Markdown 渲染：markdown-it（html:false，原始 HTML 一律转义）
 * + 按需加载的 highlight.js + 代码块标题栏（语言 / 复制按钮）。
 * 复制与外链点击由 `handleMarkdownClick` 做事件委托，不往 HTML 里塞内联脚本。
 */
import { ref } from 'vue'
import MarkdownIt from 'markdown-it'
import type { HLJSApi } from 'highlight.js'

let hljs: HLJSApi | null = null
let loading: Promise<void> | null = null
/** highlight.js 加载完成后自增，渲染端 computed 依赖它以便重新高亮 */
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
  if (/```/.test(text)) ensureHighlighter()
  return md.render(text || '', { labels })
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
