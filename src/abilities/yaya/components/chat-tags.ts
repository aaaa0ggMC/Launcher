/**
 * 聊天标记 → 气泡分段（纯函数，无 Vue 依赖，有单测）。
 *
 * 模型在回答里写命名空间标记，界面把它切成多个气泡（拟真对话 / Waifu 等插件用）：
 *
 * ```
 * 今晚月色真美<||s1/>
 * 风也温柔<||1.2s/>
 * 你呢？
 * ```
 *
 * 语义（见 PLAN.md §7.3）：
 * - `<||>`      结束当前气泡（缺省 id 按顺序 `b1/b2/…`，按位置稳定，流式中不漂）
 * - `<||s2>`    结束并把**前面这段**命名成 `s2`
 * - `<||1.2s>`  结束，下一段延迟 1.2s 出现（`1.2s` / `300ms` / 纯数字=秒，上限 10s）
 * - `<||-s1>`   撤回气泡 `s1`（不切分）
 *
 * 约束：
 * - 只由调用方决定作用角色（`AssistantTurn` 只在 assistant 输出上解析）；
 * - **代码块与行内代码里的标记不解析**（同名文本出现在代码里就是普通代码）；
 * - 只影响显示：数据库与发给模型的历史永远保留标记原文，复制 / 导出走 `plain`。
 */

/** 标记前缀 → 语义。SDK 按前缀分派（同前缀按 pluginId 字母序取第一个，见 plugin-ui.ts） */
export interface InlineTagRule {
  /** 标记前缀，如 `<||` */
  prefix: string
  /**
   * `split` = 分隔标记（可带 id / 延迟）；`mark` = 指令标记（不切分，如撤回）；
   * `block` = 成对标签（InteractGame 用，解析暂未实现）
   */
  kind: 'split' | 'mark' | 'block'
}

export interface ChatTagHit {
  kind: 'split' | 'mark'
  prefix: string
  /** 原始标记文本（含 `<` `>`） */
  raw: string
  /** 标记体（去掉前缀与结尾 `>`，已 trim、去掉尾部 `/`） */
  body: string
  start: number
  end: number
}

export interface ChatBubble {
  /** AI 命名的 id，或按位置的缺省 `b<n>` */
  id: string
  /** 正文原文（不含标记），还没做 Markdown 渲染 */
  text: string
  /** 进入延迟（毫秒，来自本段之前的 `<||1.2s>`），0 = 无 */
  delay: number
  /** 被 `<||-id>` 标记撤回 */
  retracted: boolean
}

export interface BubbleSplit {
  bubbles: ChatBubble[]
  /** 指令标记（撤回等）的标记体 */
  marks: string[]
  /** 剥掉标记后的原文（复制 / 导出 / 菜单用） */
  plain: string
  /** 正文里确实有标记（决定要不要走分段渲染） */
  hadTags: boolean
}

/** 代码区占位字符：不可见、不参与标记匹配，长度与原文一致以保持位置 */
const MASK = ' '
const MAX_DELAY_MS = 10_000

/** 把代码块与行内代码的内容换成等长占位字符：位置不变，标记匹配不到它们 */
export function maskCodeRegions(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  let fenceMark = ''
  const out = lines.map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open) {
      if (!inFence) {
        inFence = true
        fenceMark = open[1]
        return MASK.repeat(line.length)
      }
      // 闭合围栏：同种反引号 / 波浪线且不短于开头，后面只剩空白
      if (open[1][0] === fenceMark[0] && open[1].length >= fenceMark.length && !open[2].trim()) {
        inFence = false
        return MASK.repeat(line.length)
      }
      return MASK.repeat(line.length)
    }
    if (inFence) return MASK.repeat(line.length)
    // 行内代码（同长反引号包裹）
    return line.replace(/(`+)([^]*?)\1/g, (m) => MASK.repeat(m.length))
  })
  return out.join('\n')
}

/** 正文里所有标记（已跳过代码块 / 行内代码），按位置排序 */
export function findChatTags(text: string, rules: InlineTagRule[]): ChatTagHit[] {
  const active = rules.filter((r) => r.kind === 'split' || r.kind === 'mark')
  if (!active.length || !text) return []
  const masked = maskCodeRegions(text)
  // 前缀长的先匹配：`<||` 不能被更短的前缀截胡
  const ordered = [...active].sort((a, b) => b.prefix.length - a.prefix.length)
  const hits: ChatTagHit[] = []
  for (const rule of ordered) {
    let from = 0
    for (;;) {
      const at = masked.indexOf(rule.prefix, from)
      if (at < 0) break
      const close = masked.indexOf('>', at + rule.prefix.length)
      const nextOpen = masked.indexOf('<', at + 1)
      // 没闭合（流式还没写完）或中间又开了个 `<` → 不当标记，继续往后找
      if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
        from = at + rule.prefix.length
        continue
      }
      hits.push({
        kind: rule.kind === 'mark' ? 'mark' : 'split',
        prefix: rule.prefix,
        raw: text.slice(at, close + 1),
        body: text
          .slice(at + rule.prefix.length, close)
          .trim()
          .replace(/\/$/, '')
          .trim(),
        start: at,
        end: close + 1
      })
      from = close + 1
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

export interface TagAttrs {
  id?: string
  delay?: number
  /** 要撤回的气泡 id（`-s1` 写法） */
  retract: string[]
}

/** 解析标记体：`s2` / `id=s2` / `1.2s` / `300ms` / `-s1` / `wait` 关键字都收 */
export function parseTagBody(body: string): TagAttrs {
  const out: TagAttrs = { retract: [] }
  for (const token of body.split(/\s+/).filter(Boolean)) {
    if (token === 'wait' || token === 'id' || token === 'delay') continue
    if (token[0] === '-' || token[0] === '~') {
      const id = token.slice(1).replace(/^id=/, '')
      if (id) out.retract.push(id)
      continue
    }
    const dur = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(token)
    if (dur) {
      const n = Number(dur[1])
      const ms = dur[2] ? (dur[2].toLowerCase() === 'ms' ? n : n * 1000) : n * 1000
      out.delay = Math.min(Math.max(Math.round(ms), 0), MAX_DELAY_MS)
      continue
    }
    const kv = /^(?:id|name)=(.+)$/.exec(token)
    const id = kv ? kv[1] : token
    if (id && !out.id) out.id = id
  }
  return out
}

/**
 * 流式中还没写完的尾部标记（`<||s`）先不显示，等闭合后再出现——否则打字过程中
 * 会露出半截标记原文。只认已声明的前缀，正文里的普通 `<` 不受影响。
 */
export function trimPartialTag(text: string, rules: InlineTagRule[]): string {
  if (!rules.length) return text
  const lt = text.lastIndexOf('<')
  if (lt < 0) return text
  const tail = text.slice(lt)
  if (tail.includes('>')) return text
  return rules.some((r) => r.prefix.startsWith(tail) || tail.startsWith(r.prefix))
    ? text.slice(0, lt)
    : text
}

/**
 * 把回答正文切成气泡。**标记关闭并命名它前面的那一段**；标记前面没内容时不产生
 * 空气泡，id 与延迟顺延给下一段——于是开头写 `<||s1/>` 就是给第一段命名。
 */
export function splitBubbles(text: string, rules: InlineTagRule[]): BubbleSplit {
  const hits = findChatTags(text, rules)
  if (!hits.length)
    return {
      bubbles: [{ id: 'b1', text, delay: 0, retracted: false }],
      marks: [],
      plain: text,
      hadTags: false
    }

  const bubbles: ChatBubble[] = []
  const marks: string[] = []
  const retractIds: string[] = []
  let curId: string | undefined
  let curText = ''
  let curDelay = 0
  let pendId: string | undefined
  let pendDelay = 0

  const close = (): void => {
    if (!curText.trim()) {
      // 空段：命名与延迟都顺延给下一段
      if (curId) pendId = curId
      pendDelay = Math.max(pendDelay, curDelay)
    } else {
      bubbles.push({
        id: curId ?? `b${bubbles.length + 1}`,
        text: curText,
        delay: curDelay,
        retracted: false
      })
    }
    curId = pendId
    curText = ''
    curDelay = pendDelay
    pendId = undefined
    pendDelay = 0
  }

  let at = 0
  for (const hit of hits) {
    curText += text.slice(at, hit.start)
    at = hit.end
    const attrs = parseTagBody(hit.body)
    // 撤回标记（`<||-s1>`）不切分：只记指令。同一前缀下靠标记体区分，
    // 插件也可以另注册一个 kind: 'mark' 的专用前缀。
    const isMark =
      hit.kind === 'mark' || (attrs.retract.length > 0 && !attrs.id && attrs.delay === undefined)
    if (isMark) {
      marks.push(hit.body)
      retractIds.push(...attrs.retract)
      continue
    }
    if (attrs.id) curId = attrs.id
    if (attrs.delay !== undefined) pendDelay = attrs.delay
    retractIds.push(...attrs.retract)
    close()
  }
  curText += text.slice(at)
  close()

  // 撤回按 id 认（AI 先撤回后命名也认）
  if (retractIds.length) {
    const set = new Set(retractIds)
    for (const b of bubbles) if (set.has(b.id)) b.retracted = true
  }

  let plain = text
  for (const h of hits) if (h.raw) plain = plain.replace(h.raw, '')
  return { bubbles, marks, plain, hadTags: true }
}
