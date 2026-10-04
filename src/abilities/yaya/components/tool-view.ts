/**
 * 工具参数 / 结果的展示结构（纯函数）。目标是「人能读」而不是原样吐 JSON：
 * - 命令类参数（command / script / code）按 Shell 原文显示并高亮，不再是带 `\"` 转义的 JSON 字符串；
 * - 短的标量字段并成一行「键: 值」，长文本单独成块；
 * - 结果里的 stdout / stderr / content 这类正文字段单独成块，其余字段做摘要。
 */

export interface FieldView {
  key: string
  /** inline = 行内「键: 值」；block = 独立文本块；code = 高亮代码块；json = 高亮 JSON */
  kind: 'inline' | 'block' | 'code' | 'json'
  value: string
  lang?: string
  /** 标红（stderr / error） */
  danger?: boolean
}

const MAX_CHARS = 20_000
const CODE_KEYS: Record<string, string> = { command: 'bash', script: 'bash', cmd: 'bash' }
const BODY_KEYS = ['stdout', 'stderr', 'content', 'output', 'text', 'body']

function clip(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…` : s
}

function scalar(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

function stringField(key: string, v: string, danger = false): FieldView {
  if (CODE_KEYS[key]) return { key, kind: 'code', lang: CODE_KEYS[key], value: clip(v) }
  const kind = v.includes('\n') || v.length > 80 ? 'block' : 'inline'
  return danger ? { key, kind, value: clip(v), danger } : { key, kind, value: clip(v) }
}

function tryJson(s: string): unknown {
  const t = s.trim()
  if (!/^[[{]/.test(t)) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

export function argFields(args: unknown): FieldView[] {
  if (typeof args === 'string') {
    const parsed = tryJson(args)
    if (parsed === undefined) return args.trim() ? [stringField('', args)] : []
    args = parsed
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return [{ key: '', kind: 'json', lang: 'json', value: clip(JSON.stringify(args, null, 2)) }]
  }
  return Object.entries(args as Record<string, unknown>).map(([k, v]) =>
    typeof v === 'string'
      ? stringField(k, v)
      : isScalar(v)
        ? { key: k, kind: 'inline', value: scalar(v) }
        : { key: k, kind: 'json', lang: 'json', value: clip(JSON.stringify(v, null, 2)) }
  )
}

export function resultFields(result: unknown): FieldView[] {
  if (result === undefined || result === null) return []
  if (typeof result === 'string') {
    const parsed = tryJson(result)
    if (parsed === undefined) return result ? [{ key: '', kind: 'block', value: clip(result) }] : []
    result = parsed
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    return [{ key: '', kind: 'json', lang: 'json', value: clip(JSON.stringify(result, null, 2)) }]
  }
  const obj = result as Record<string, unknown>
  const hasBody = BODY_KEYS.some((k) => typeof obj[k] === 'string')
  // 没有正文字段：短小对象逐项显示，复杂对象整体 JSON
  if (!hasBody) {
    const entries = Object.entries(obj)
    if (entries.length <= 8 && entries.every(([, v]) => isScalar(v))) {
      return entries.map(([k, v]) =>
        typeof v === 'string'
          ? stringField(k, v, k === 'error')
          : { key: k, kind: 'inline', value: scalar(v) }
      )
    }
    return [{ key: '', kind: 'json', lang: 'json', value: clip(JSON.stringify(obj, null, 2)) }]
  }
  const out: FieldView[] = []
  const bodies: FieldView[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (BODY_KEYS.includes(k) && typeof v === 'string') {
      if (v.trim()) bodies.push({ key: k, kind: 'block', value: clip(v), danger: k === 'stderr' })
    } else if (typeof v === 'string') out.push(stringField(k, v, k === 'error'))
    else if (isScalar(v)) out.push({ key: k, kind: 'inline', value: scalar(v) })
    else out.push({ key: k, kind: 'json', lang: 'json', value: clip(JSON.stringify(v, null, 2)) })
  }
  return [...out, ...bodies]
}
