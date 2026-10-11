/**
 * 内联表情短码（Discord 同款）——让 AI 能在正文里直接放出图标包表情 / 表情包。
 *
 * 语法 `:key:`：**只有命中已注册表情集**（`PluginUi.reactionSets`）里的 `key` 或
 * `shortcode` 才会被替换，没命中原样显示——所以 `12:30:`、`http://x` 这类普通冒号文本
 * 不会被吃掉，也不需要 AI 记住「不能写冒号」。
 *
 * 两处共用同一条规则（`plugin-ui-registry` 注册进 `inlineTokens`）：
 * - 助手回答：`applyInlineTokensHtml` 作用在 Markdown 转义后的 HTML 上（代码块里的
 *   `:key:` 已经是 `&#58;…` 之类的安全形态，不会被误伤）；
 * - 用户消息：`inlineTokenParts` 作用在原文上。
 *
 * 渲染形态（Discord 式的「多样化 emoji」）：
 * - `src` = **图片表情包**（`file/<绝对路径>` 走 cockpit-icon 协议，其余是 URL / data URL）；
 * - `icon` = mdi 单色图标（跟随文字颜色）；
 * - 都没有 → key 本身就是 emoji 文本。
 * 内联不认 `gi:` / `default/` 单色 SVG：那类要靠组件渲染才跟随主题色，用 `<img>` 会变黑，
 * 于是返回 null 保留短码原文（它们照样能出现在表情选择器里）。
 */
import type { InlineTokenView, ReactionItem, ReactionSet } from './plugin-ui'

/** 短码匹配：`:name:`（不含空白与冒号，1–40 字符）。必须带 g 标志（注册表逐个 exec） */
export const EMOTE_PATTERN = /:([^\s:]{1,40}):/g

/** 只放行能安全进 `<img src>` 的协议（插件配置是用户自己写的，仍做一层兜底） */
const SAFE_SRC = /^(https?:|data:image\/|blob:|cockpit-icon:|\/)/

/** `file/<绝对路径>` → 可加载 URL；其余原样（URL / data URL / 构建出的资源地址） */
export function emoteSrcUrl(src: string, toUrl: (path: string) => string): string {
  if (!src.startsWith('file/')) return src
  // 与 parseIcon 同规则：file/ 后面必须是绝对路径，少了开头的斜杠就补上
  const path = src.slice('file/'.length)
  return toUrl(path.startsWith('/') ? path : `/${path}`)
}

/** 在表情集里找这个短码（`inline: false` 的组不参与内联） */
export function findEmote(key: string, sets: ReactionSet[]): ReactionItem | null {
  for (const set of sets) {
    if (set.inline === false) continue
    const item = set.items.find(
      (i) => i.key === key || (i.shortcode !== undefined && i.shortcode === key)
    )
    if (item) return item
  }
  return null
}

/**
 * 短码 → 显示（没有命中返回 null = 这一处不处理，原文照旧）。
 * `toUrl` 把 `file/` 路径转成可加载地址（`fileIconUrl`），测试里可以传恒等函数。
 */
export function emoteView(
  key: string,
  sets: ReactionSet[],
  toUrl: (path: string) => string,
  t?: (k: string, fallback?: string) => string
): InlineTokenView | null {
  const item = findEmote(key, sets)
  if (!item) return null
  const title = item.labelKey
    ? t
      ? t(item.labelKey, item.label ?? item.key)
      : (item.label ?? item.key)
    : (item.label ?? undefined)

  if (item.src) {
    const url = emoteSrcUrl(item.src, toUrl)
    if (!SAFE_SRC.test(url)) return null
    return { img: url, text: item.key, title, tone: 'bare' }
  }
  if (item.icon) {
    // 内联只认 mdi 单色图标；其它图标语法交给选择器里的组件渲染
    if (!item.icon.startsWith('mdi-')) return null
    return { icon: item.icon, text: item.label ?? item.key, title, tone: 'bare' }
  }
  return { text: item.key, title, tone: 'bare' }
}

/**
 * 给图标包插件的固定英文说明（放它的 `instructions()` 里，AI 才知道有哪些短码可用）。
 * 稳定输出（顺序固定、不随语言 / 时间变），码太多时截断，避免撑大系统提示词。
 */
export function emoteInstruction(sets: ReactionSet[], max = 60): string {
  const codes: string[] = []
  for (const set of sets) {
    if (set.inline === false) continue
    for (const item of set.items) {
      const code = item.shortcode ?? item.key
      if (!codes.includes(code)) codes.push(code)
    }
  }
  if (!codes.length) return ''
  const shown = codes.slice(0, max)
  const more = codes.length > shown.length ? `, …(+${codes.length - shown.length})` : ''
  return [
    'Inline emotes: write `:code:` anywhere in your reply and the chat UI replaces it with an',
    'emote from the injected packs (images / icons), unlike plain unicode emoji which you can',
    `also use directly. Available codes: ${shown.join(', ')}${more}.`
  ].join('\n')
}
