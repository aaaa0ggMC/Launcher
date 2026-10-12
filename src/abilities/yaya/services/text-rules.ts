/**
 * Regex 自定义规则的纯逻辑：解析 / 校验 / 执行。
 *
 * 主进程（用户输入入库 `hooks.userText`、AI 输出落库 `hooks.assistantText`）与
 * 渲染端（仅视觉替换）**共用**这一个模块，所以这里不能 import 任何 node/fs 依赖。
 *
 * 规则字段（存插件配置的 `rules` JSON 字符串里）：
 * - `target`：`user` / `ai` / `both`（缺省 `ai`）——替换人、替换 AI 还是两边都换；
 * - `mode`：`visual`（只改显示）/ `raw`（改原文：用户侧入库前、AI 侧落库前）；
 * - `format`：`regex`（纯文本替换）/ `html`（把替换结果当 HTML 片段注入——**只给 AI 输出用**，
 *   用户侧渲染不是 HTML 管线，含 html 的规则在那一侧直接跳过）。
 *
 * `$1` / `$&` / `$$` 支持；**html 规则里被匹配到的内容（可能来自模型）会先转义**，
 * 只有规则模板自己的文字原样注入——模板能写标签，模型文本却不能借它注入 HTML。
 */
export type TextRuleTarget = 'user' | 'ai' | 'both'
export type TextRuleMode = 'visual' | 'raw'
export type TextRuleFormat = 'regex' | 'html'

export interface TextRule {
  id?: string
  enabled?: boolean
  pattern: string
  /** 正则标志；缺省补 `g` */
  flags?: string
  replacement: string
  /** 缺省 `ai` */
  target?: TextRuleTarget
  /** 缺省 `visual` */
  mode?: TextRuleMode
  /** 缺省 `regex` */
  format?: TextRuleFormat
}

const SIDE_TARGETS: Record<'user' | 'ai', TextRuleTarget[]> = {
  user: ['user', 'both'],
  ai: ['ai', 'both']
}

/** 从插件配置的 JSON 字符串解析规则；脏数据 / 解析失败一律当没有规则 */
export function parseTextRules(raw: unknown): TextRule[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: TextRule[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.pattern !== 'string' || !r.pattern) continue
    out.push({
      id: typeof r.id === 'string' ? r.id : undefined,
      enabled: r.enabled !== false,
      pattern: r.pattern,
      flags: typeof r.flags === 'string' ? r.flags : undefined,
      replacement: typeof r.replacement === 'string' ? r.replacement : '',
      target: r.target === 'user' || r.target === 'ai' || r.target === 'both' ? r.target : 'ai',
      mode: r.mode === 'raw' ? 'raw' : 'visual',
      format: r.format === 'html' ? 'html' : 'regex'
    })
  }
  return out
}

/** 编译正则（缺省补 `g`）；非法返回 null —— 调用方据此跳过，绝不抛 */
export function compileRule(rule: TextRule): RegExp | null {
  const base = rule.flags ?? ''
  const flags = base.includes('g') ? base : `${base}g`
  try {
    return new RegExp(rule.pattern, flags)
  } catch {
    return null
  }
}

/** 保存前的校验：返回错误说明，null = 通过 */
export function checkTextRule(rule: TextRule): string | null {
  if (!rule.pattern?.trim()) return 'pattern 不能为空'
  if (!compileRule(rule)) return `pattern 不是合法正则：${rule.pattern}`
  // 剔掉合法引用（$$ / $& / $1..$99）后还剩 $ → 说明写错了
  const rest = (rule.replacement ?? '').replace(/\$(\$|&|\d{1,2})/g, '')
  if (rest.includes('$')) return `replacement 里有无效的 $ 引用：${rule.replacement}`
  return null
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

/** 展开 `$1` / `$&` / `$$`；`esc` 只作用于匹配内容（html 规则 = 转义，普通规则 = 原样） */
function expand(replacement: string, m: RegExpExecArray, esc: (s: string) => string): string {
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_all, sym: string) => {
    if (sym === '$') return '$'
    if (sym === '&') return esc(m[0])
    const g = m[Number(sym)]
    return g === undefined ? '' : esc(g)
  })
}

/** 执行单条规则（全局）；非法正则原样返回 */
export function applyTextRule(rule: TextRule, text: string): string {
  const re = compileRule(rule)
  if (!re || !text) return text
  const esc = rule.format === 'html' ? escapeHtml : (s: string): string => s
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out += text.slice(last, m.index) + expand(rule.replacement, m, esc)
    last = m.index + m[0].length
    if (!m[0].length) re.lastIndex++ // 空匹配不自旋
    if (!re.global) break
  }
  return out + text.slice(last)
}

/**
 * 按「哪一侧 / 哪种模式」筛出生效的规则并依次执行。
 * `mode: 'visual'` 给渲染端，`'raw'` 给入库 / 落库两条链。
 */
export function applyTextRules(
  text: string,
  rules: TextRule[],
  opts: { side: 'user' | 'ai'; mode: TextRuleMode }
): string {
  if (!text || !rules.length) return text
  const allowed = SIDE_TARGETS[opts.side]
  let out = text
  for (const r of rules) {
    if (r.enabled === false) continue
    if ((r.mode ?? 'visual') !== opts.mode) continue
    if (!allowed.includes(r.target ?? 'ai')) continue
    if (r.format === 'html' && opts.side === 'user') continue // 用户侧不是 HTML 管线
    out = applyTextRule(r, out)
  }
  return out
}
