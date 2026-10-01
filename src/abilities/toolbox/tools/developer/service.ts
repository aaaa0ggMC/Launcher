import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import CleanCSS from 'clean-css'
import { minify as minifyHtmlTerser } from 'html-minifier-terser'
import { marked } from 'marked'
import { format as formatCode } from 'prettier/standalone'
import * as prettierBabel from 'prettier/plugins/babel'
import * as prettierEstree from 'prettier/plugins/estree'
import * as prettierHtml from 'prettier/plugins/html'
import * as prettierPostcss from 'prettier/plugins/postcss'
import * as prettierTypescript from 'prettier/plugins/typescript'
import { minify } from 'terser'
import { format as formatSql } from 'sql-formatter'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml'
import type { Options as PrettierOptions } from 'prettier'
import type { ToolArgs, ToolFile, ToolResult } from '../../types'

/**
 * Standalone prettier plugins — imported statically so the ability keeps
 * working when it is bundled without node_modules (zip distribution).
 */
const PRETTIER_PLUGINS = [
  prettierEstree,
  prettierBabel,
  prettierTypescript,
  prettierHtml,
  prettierPostcss
] as unknown as NonNullable<PrettierOptions['plugins']>

/**
 * Developer tool implementations (main process only).
 *
 * Conventions:
 * - Never log user input, file contents or results.
 * - Every tool validates its input and returns { ok: false, error } with a
 *   human-readable reason instead of throwing.
 * - Result files are ToolFile ({ name, mime, base64 }); saving is the UI's job.
 */

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const MAX_INPUT_CHARS = 200_000

type Fn = (args: ToolArgs) => ToolResult | Promise<ToolResult>

function str(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value)
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(str(value).trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function ok(text: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, text, ...extra }
}

function fail(error: string): ToolResult {
  return { ok: false, error }
}

/** Short, user-facing reason for a thrown value — never includes the input. */
function why(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

function textFile(name: string, content: string, mime = 'text/plain;charset=utf-8'): ToolFile {
  return { name, mime, base64: Buffer.from(content, 'utf8').toString('base64') }
}

function requireText(input: string, what = '内容'): ToolResult | null {
  if (!input.trim()) return fail(`请输入${what}`)
  if (input.length > MAX_INPUT_CHARS) return fail(`输入超过 ${MAX_INPUT_CHARS} 字符上限`)
  return null
}

function pick(value: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(value) ? value : fallback
}

// ---------------------------------------------------------------------------
// json-format
// ---------------------------------------------------------------------------

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    // Null prototype: a literal "__proto__" key stays data instead of being
    // swallowed by Object assignment.
    const sorted: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(source).sort()) sorted[key] = sortJsonValue(source[key])
    return sorted
  }
  return value
}

function jsonFormat(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const guard = requireText(input, 'JSON')
  if (guard) return guard
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (e) {
    return fail(`JSON 解析失败：${why(e)}`)
  }
  const jsonValue = bool(args.sortKeys, false) ? sortJsonValue(parsed) : parsed
  if (bool(args.compact, false)) return ok(JSON.stringify(jsonValue))
  const indent = str(args.indent) || '2'
  const space = indent === 'tab' ? '\t' : Math.max(0, Math.trunc(num(indent, 2)))
  return ok(JSON.stringify(jsonValue, null, space))
}

// ---------------------------------------------------------------------------
// json-escape
// ---------------------------------------------------------------------------

function jsonEscape(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const mode = pick(str(args.mode), ['escape', 'unescape'], 'escape')
  if (mode === 'unescape') {
    const raw = input.trim()
    if (!raw) return fail('请输入要反转义的 JSON 字符串')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return fail('不是合法的 JSON 字符串：需用英文双引号包裹并符合 JSON 语法')
    }
    if (typeof parsed !== 'string') return fail('JSON 解析结果不是字符串（例如数字、对象都不合法）')
    return ok(parsed)
  }
  if (!input) return fail('请输入要转义的内容')
  return ok(JSON.stringify(input))
}

// ---------------------------------------------------------------------------
// config-convert (JSON / YAML / TOML / Properties)
// ---------------------------------------------------------------------------

type ConfigFormat = 'json' | 'yaml' | 'toml' | 'properties'

const CONFIG_FORMATS: ConfigFormat[] = ['json', 'yaml', 'toml', 'properties']

function unescapeProperties(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, code: string) => {
    if (code.length === 5 && code.startsWith('u'))
      return String.fromCharCode(parseInt(code.slice(1), 16))
    switch (code) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'f':
        return '\f'
      default:
        return code
    }
  })
}

function escapePropertiesValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/^([\s=:#!])/, '\\$1')
}

function escapePropertiesKey(key: string): string {
  return key
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/:/g, '\\:')
    .replace(/^([\s#!])/, '\\$1')
}

/**
 * Join physical lines into logical ones: a trailing backslash (odd count)
 * continues the line, per the .properties spec.
 */
function joinLogicalLines(raw: string): string[] {
  const logical: string[] = []
  let buffer: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    // A continuation line keeps its content (leading whitespace skipped); no
    // newline is injected into the value, matching the .properties spec.
    const current = buffer === null ? line : `${buffer}${line.replace(/^[ \t]+/, '')}`
    const trailing = /(\\+)$/.exec(current)
    if (trailing && trailing[1].length % 2 === 1) {
      buffer = current.slice(0, -1) // drop the escaping backslash, keep joining
    } else {
      logical.push(current)
      buffer = null
    }
  }
  if (buffer !== null) logical.push(buffer)
  return logical
}

/** First unescaped separator: '=' / ':' or whitespace followed by '=' / ':'. */
function findKeySeparator(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '=' || ch === ':') return i
    if (ch === ' ' || ch === '\t') {
      let j = i
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++
      if (line[j] === '=' || line[j] === ':') return j
    }
  }
  return -1
}

function parseProperties(raw: string): Record<string, string> {
  // Null prototype: hostile keys such as `__proto__` stay own data and never
  // reach Object.prototype, so nothing has to be silently dropped.
  const out: Record<string, string> = Object.create(null)
  joinLogicalLines(raw).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return
    const sep = findKeySeparator(trimmed)
    if (sep === -1) throw new Error(`第 ${index + 1} 行不是有效的 key=value 或 key:value`)
    const key = unescapeProperties(trimmed.slice(0, sep).trim())
    if (!key) throw new Error(`第 ${index + 1} 行的键为空`)
    out[key] = unescapeProperties(trimmed.slice(sep + 1).trim())
  })
  return out
}

function joinPropertiesPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key
}

function propertiesText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return ''
  return String(value)
}

function flattenForProperties(value: unknown, prefix: string, sink: [string, string][]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenForProperties(item, joinPropertiesPath(prefix, String(index)), sink)
    )
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flattenForProperties(item, joinPropertiesPath(prefix, key), sink)
    }
    return
  }
  if (prefix === '') throw new Error('Properties 只支持对象（键值对）顶层结构')
  sink.push([prefix, propertiesText(value)])
}

function dumpProperties(value: unknown): string {
  if (value === null || typeof value !== 'object')
    throw new Error('Properties 顶层必须是对象（键值对）')
  const sink: [string, string][] = []
  flattenForProperties(value, '', sink)
  if (!sink.length) return ''
  return `${sink.map(([key, text]) => `${escapePropertiesKey(key)}=${escapePropertiesValue(text)}`).join('\n')}\n`
}

function parseConfig(format: ConfigFormat, raw: string): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(raw)
    case 'yaml':
      return parseYaml(raw)
    case 'toml':
      return parseToml(raw)
    case 'properties':
      return parseProperties(raw)
  }
}

function serializeConfig(format: ConfigFormat, value: unknown): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(value, null, 2)}\n`
    case 'yaml':
      return stringifyYaml(value)
    case 'toml':
      return stringifyToml(value as unknown as Parameters<typeof stringifyToml>[0])
    case 'properties':
      return dumpProperties(value)
  }
}

function configConvert(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const guard = requireText(input, '配置内容')
  if (guard) return guard
  const from = pick(str(args.from) || 'json', CONFIG_FORMATS, 'json') as ConfigFormat
  const to = pick(str(args.to) || 'json', CONFIG_FORMATS, 'json') as ConfigFormat
  if (from === to) return fail('源格式与目标格式相同，无需转换')

  let value: unknown
  try {
    value = parseConfig(from, input)
  } catch (e) {
    return fail(`${from.toUpperCase()} 解析失败：${why(e)}`)
  }
  let text: string
  try {
    text = serializeConfig(to, value)
  } catch (e) {
    return fail(`转为 ${to.toUpperCase()} 失败：${why(e)}`)
  }
  const note =
    to === 'properties'
      ? 'Properties 只支持扁平文本：嵌套对象会展开为 a.b.c=1 形式的点分键，数字/布尔转为字符串。'
      : undefined
  return ok(text, note ? { note } : {})
}

// ---------------------------------------------------------------------------
// code-format (prettier standalone)
// ---------------------------------------------------------------------------

const PRETTIER_PARSERS: Record<string, string> = {
  javascript: 'babel',
  typescript: 'typescript',
  html: 'html',
  css: 'css'
}

async function codeFormat(args: ToolArgs): Promise<ToolResult> {
  const input = str(args.input)
  const guard = requireText(input, '代码')
  if (guard) return guard
  const parser = PRETTIER_PARSERS[str(args.language) || 'javascript'] ?? PRETTIER_PARSERS.javascript
  try {
    const formatted = await formatCode(input, { parser, plugins: PRETTIER_PLUGINS })
    return ok(formatted)
  } catch (e) {
    return fail(`格式化失败：${why(e)}`)
  }
}

// ---------------------------------------------------------------------------
// js-minify (terser)
// ---------------------------------------------------------------------------

async function jsMinify(args: ToolArgs): Promise<ToolResult> {
  const input = str(args.input)
  const guard = requireText(input, 'JavaScript 代码')
  if (guard) return guard
  const mangle = bool(args.mangle, true)
  try {
    const result = await minify(input, { compress: true, mangle, format: { comments: false } })
    const failure = result as { error?: unknown }
    if (failure && failure.error) throw failure.error
    if (!result.code) return fail('压缩失败：没有产出')
    return ok(result.code, { note: 'terser 压缩结果：已删除注释与空白，仅做等价变形。' })
  } catch (e) {
    return fail(`压缩失败：${why(e)}`)
  }
}

// ---------------------------------------------------------------------------
// css-format
// ---------------------------------------------------------------------------

/**
 * clean-css minification. `inline: false` disables @import processing, so no
 * local or remote file is ever read; level 1 keeps rewriting conservative
 * (descendant combinators, calc() spacing, content strings and url() survive).
 */
function minifyCss(input: string): string {
  const output = new CleanCSS({ level: 1, inline: false }).minify(input)
  if (output.errors.length > 0) throw new Error(String(output.errors[0]))
  return output.styles
}

async function cssFormat(args: ToolArgs): Promise<ToolResult> {
  const input = str(args.input)
  const guard = requireText(input, 'CSS')
  if (guard) return guard
  const mode = pick(str(args.mode), ['format', 'minify'], 'format')
  if (mode === 'minify') {
    try {
      return ok(minifyCss(input), {
        note: '压缩由 clean-css 完成：保留选择器结构、calc 空格、content 字符串与 url()。'
      })
    } catch (e) {
      return fail(`压缩失败：${why(e)}`)
    }
  }
  try {
    return ok(await formatCode(input, { parser: 'css', plugins: PRETTIER_PLUGINS }))
  } catch (e) {
    return fail(`格式化失败：${why(e)}`)
  }
}

// ---------------------------------------------------------------------------
// html-format
// ---------------------------------------------------------------------------

/**
 * Conservative HTML minification via html-minifier-terser. Whitespace is NOT
 * collapsed and JS/CSS are not minified, so pre/textarea/script/style
 * contents, inline `style="white-space:pre"` text and page <style> blocks stay
 * byte-identical; only HTML comments are dropped. caseSensitive keeps camelCase
 * attributes (viewBox, preserveAspectRatio) intact.
 */
async function minifyHtml(input: string): Promise<string> {
  return minifyHtmlTerser(input, {
    collapseWhitespace: false,
    removeComments: true,
    minifyJS: false,
    minifyCSS: false,
    caseSensitive: true
  })
}

async function htmlFormat(args: ToolArgs): Promise<ToolResult> {
  const input = str(args.input)
  const guard = requireText(input, 'HTML')
  if (guard) return guard
  const mode = pick(str(args.mode), ['format', 'minify'], 'format')
  if (mode === 'minify') {
    try {
      return ok(await minifyHtml(input), {
        note: '保守压缩：仅移除 HTML 注释；未折叠空白、未压缩 JS/CSS，pre / textarea / script / style 与内联样式均原样保留。'
      })
    } catch (e) {
      return fail(`压缩失败：${why(e)}`)
    }
  }
  try {
    return ok(await formatCode(input, { parser: 'html', plugins: PRETTIER_PLUGINS }))
  } catch (e) {
    return fail(`格式化失败：${why(e)}`)
  }
}

// ---------------------------------------------------------------------------
// sql-format
// ---------------------------------------------------------------------------

const SQL_DIALECTS = ['sql', 'mysql', 'mariadb', 'postgresql', 'sqlite', 'tsql', 'plsql'] as const

async function sqlFormatTool(args: ToolArgs): Promise<ToolResult> {
  const input = str(args.input)
  const guard = requireText(input, 'SQL')
  if (guard) return guard
  const language = pick(str(args.dialect) || 'sql', SQL_DIALECTS, 'sql')
  const keywordCase = pick(str(args.keywordCase), ['upper', 'lower', 'preserve'], 'upper')
  try {
    const formatted = formatSql(input, {
      language,
      keywordCase
    } as unknown as Parameters<typeof formatSql>[1])
    return ok(formatted)
  } catch (e) {
    return fail(`SQL 解析失败：${why(e)}`)
  }
}

// ---------------------------------------------------------------------------
// regex-test (isolated worker + timeout)
// ---------------------------------------------------------------------------

/**
 * Fixed worker bootstrap. It only receives pattern/flags/text and posts back
 * matches; no user-supplied code is ever evaluated.
 */
const REGEX_WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
parentPort.on('message', (m) => {
  const { pattern, flags, text, maxMatches, hardLimit } = m
  let re
  try {
    re = new RegExp(pattern, flags)
  } catch (e) {
    parentPort.postMessage({ ok: false, error: '正则语法错误: ' + String((e && e.message) || e) })
    return
  }
  const out = []
  let count = 0
  try {
    if (flags.indexOf('g') !== -1) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text)) !== null) {
        count++
        if (out.length < maxMatches) out.push({ index: m.index, match: m[0], groups: m.slice(1) })
        if (m[0] === '') re.lastIndex++
        if (count >= hardLimit) break
      }
    } else {
      const m = re.exec(text)
      if (m) {
        count = 1
        out.push({ index: m.index, match: m[0], groups: m.slice(1) })
      }
    }
    parentPort.postMessage({ ok: true, count, matches: out, truncated: count > out.length })
  } catch (e) {
    parentPort.postMessage({ ok: false, error: '执行失败: ' + String((e && e.message) || e) })
  }
})
`.trim()

const REGEX_HARD_LIMIT = 100000
const REGEX_MAX_INPUT = 100000

interface RegexOutcome {
  ok: boolean
  error?: string
  count?: number
  matches?: { index: number; match: string; groups: (string | undefined)[] }[]
  truncated?: boolean
}

function runRegex(
  pattern: string,
  flags: string,
  text: string,
  timeoutMs: number,
  maxMatches: number
): Promise<RegexOutcome> {
  return new Promise<RegexOutcome>((resolve) => {
    let settled = false
    let worker: Worker | undefined
    try {
      worker = new Worker(REGEX_WORKER_SOURCE, { eval: true })
    } catch (e) {
      resolve({ ok: false, error: `无法启动隔离线程：${why(e)}` })
      return
    }
    if (!worker) {
      resolve({ ok: false, error: '无法启动隔离线程' })
      return
    }
    const runner = worker
    const finish = (value: RegexOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void runner.terminate().catch(() => undefined)
      resolve(value)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `执行超过 ${timeoutMs}ms 已被强制终止（疑似灾难性回溯 / ReDoS）`
        }),
      timeoutMs
    )
    runner.on('message', (message: RegexOutcome) => finish(message))
    runner.on('error', (error: Error) =>
      finish({ ok: false, error: `隔离线程异常：${error.message}` })
    )
    runner.on('exit', (code) => finish({ ok: false, error: `隔离线程提前退出（code=${code}）` }))
    runner.postMessage({ pattern, flags, text, maxMatches, hardLimit: REGEX_HARD_LIMIT })
  })
}

function normalizeFlags(raw: string): string {
  const seen: string[] = []
  for (const flag of raw.trim()) {
    if (!'dgimsuvy'.includes(flag))
      throw new Error(`不支持的修饰符 "${flag}"（可用 g i m s u y d v）`)
    if (!seen.includes(flag)) seen.push(flag)
  }
  return seen.join('')
}

async function regexTest(args: ToolArgs): Promise<ToolResult> {
  const pattern = str(args.pattern)
  if (!pattern) return fail('请输入正则表达式')
  const text = str(args.text)
  const guard = requireText(text, '测试文本')
  if (guard) return guard
  if (text.length > REGEX_MAX_INPUT) return fail(`测试文本超过 ${REGEX_MAX_INPUT} 字符上限`)
  let flags = str(args.flags)
  try {
    flags = normalizeFlags(flags)
  } catch (e) {
    return fail(why(e))
  }
  const maxMatches = Math.min(Math.max(1, Math.trunc(num(args.maxMatches, 50))), 500)
  const timeoutMs = Math.min(Math.max(100, Math.trunc(num(args.timeout, 1000))), 20000)
  const outcome = await runRegex(pattern, flags, text, timeoutMs, maxMatches)
  if (!outcome.ok) return fail(outcome.error ?? '执行失败')
  const matches = outcome.matches ?? []
  const lines = [
    `匹配到 ${outcome.count ?? 0} 处${outcome.truncated ? `（仅显示前 ${matches.length} 处）` : ''}`,
    ''
  ]
  matches.forEach((match, index) => {
    lines.push(`[${index + 1}] index=${match.index}  ${JSON.stringify(match.match)}`)
    match.groups.forEach((group, g) => {
      if (group !== undefined) lines.push(`      组${g + 1}: ${JSON.stringify(group)}`)
    })
  })
  if (!matches.length) lines.push('（没有任何匹配）')
  return ok(lines.join('\n').trimEnd(), {
    data: { count: outcome.count ?? 0, truncated: Boolean(outcome.truncated), matches }
  })
}

// ---------------------------------------------------------------------------
// uuid
// ---------------------------------------------------------------------------

function uuidTool(args: ToolArgs): ToolResult {
  const count = Math.min(Math.max(1, Math.trunc(num(args.count, 1))), 100)
  const upper = bool(args.uppercase, false)
  const compact = bool(args.compact, false)
  const values: string[] = []
  for (let i = 0; i < count; i++) {
    // randomUUID() returns a template-literal type; keep the variable `string`.
    let value: string = randomUUID()
    if (upper) value = value.toUpperCase()
    if (compact) value = value.replace(/-/g, '')
    values.push(value)
  }
  return ok(values.join('\n'), { data: { count, values } })
}

// ---------------------------------------------------------------------------
// mock-data
// ---------------------------------------------------------------------------

const MOCK_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都']

function mockTimestamp(index: number): string {
  const base = Date.UTC(2026, 0, 1) + index * 36e5
  return new Date(base).toISOString().replace('T', ' ').slice(0, 19)
}

function mockRow(kind: string, index: number): Record<string, string | number> {
  const phone = `1380000${String(index % 10000).padStart(4, '0')}`
  switch (kind) {
    case 'product':
      return {
        id: index,
        name: `示例商品-${index}`,
        category: ['数码', '图书', '家居', '服饰'][index % 4],
        price: Math.round((index * 7.5 + 9.9) * 100) / 100,
        stock: (index * 13) % 500,
        created_at: mockTimestamp(index)
      }
    case 'order':
      return {
        order_no: `MOCK${String(index).padStart(8, '0')}`,
        user_id: index,
        product_id: index,
        quantity: (index % 5) + 1,
        amount: Math.round(((index % 5) + 1) * 9.9 * 100) / 100,
        status: ['paid', 'shipped', 'done'][index % 3],
        created_at: mockTimestamp(index)
      }
    case 'user':
    default:
      return {
        id: index,
        name: `用户${index}`,
        email: `user${index}@example.com`,
        phone,
        city: MOCK_CITIES[index % MOCK_CITIES.length],
        created_at: mockTimestamp(index)
      }
  }
}

/** Heuristic fake value for user-supplied custom field names. */
function mockValue(key: string, index: number): string | number {
  const k = key.trim().toLowerCase()
  if (!k) return ''
  if (k.includes('mail')) return `user${index}@example.com`
  if (k.includes('phone') || k.includes('mobile'))
    return `1380000${String(index % 10000).padStart(4, '0')}`
  if (k === 'id' || k.endsWith('_id')) return index
  if (k.includes('city')) return MOCK_CITIES[index % MOCK_CITIES.length]
  if (k.includes('date') || k.includes('time')) return mockTimestamp(index)
  if (k.includes('name') || k.includes('title')) return `示例${key.trim()}-${index}`
  if (k.includes('price') || k.includes('amount')) return Math.round((index * 3.3 + 1) * 100) / 100
  if (k.includes('count') || k.includes('stock') || k.includes('num')) return index
  return `mock-${key.trim()}-${index}`
}

function mockCustomFields(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /["\n\r,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  const columns: string[] = []
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  const lines = [columns.map((column) => csvCell(column)).join(',')]
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','))
  return `${lines.join('\n')}\n`
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  return `'${String(value).replace(/'/g, "''")}'`
}

function rowsToSql(rows: Record<string, unknown>[], table: string): string {
  if (!rows.length) return ''
  const columns = Object.keys(rows[0])
  const list = columns.map((column) => `\`${column}\``).join(', ')
  const values = rows.map((row) => columns.map((column) => sqlLiteral(row[column])).join(', '))
  return `INSERT INTO \`${table}\` (${list}) VALUES\n${values.map((v) => `  (${v})`).join(',\n')};\n`
}

function mockData(args: ToolArgs): ToolResult {
  const kind = pick(str(args.type) || 'user', ['user', 'product', 'order', 'custom'], 'user')
  const count = Math.min(Math.max(1, Math.trunc(num(args.count, 5))), 200)
  const format = pick(str(args.format) || 'json', ['json', 'csv', 'sql'], 'json')

  let keys: string[] | null = null
  if (kind === 'custom') {
    keys = mockCustomFields(str(args.fields))
    if (!keys.length) return fail('自定义字段类型需要填写字段名（逗号或换行分隔）')
  }

  const rows: Record<string, unknown>[] = []
  for (let i = 1; i <= count; i++) {
    rows.push(
      keys ? Object.fromEntries(keys.map((key) => [key, mockValue(key, i)])) : mockRow(kind, i)
    )
  }

  const note = '数据均为本地虚构（example.com / 1380000xxxx 等），不包含任何真实凭据。'
  if (format === 'csv') return ok(rowsToCsv(rows), { note })
  if (format === 'sql')
    return ok(rowsToSql(rows, `mock_${kind}`), { note: `${note}（MySQL 风格反引号标识符）` })
  return ok(JSON.stringify(rows, null, 2), { note })
}

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
}

const CRON_DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
}

function cronValue(
  raw: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>
): number {
  const token = raw.trim().toLowerCase()
  if (!token) throw new Error(`${label}字段存在空值`)
  if (names && token in names) return names[token]
  if (!/^\d+$/.test(token)) throw new Error(`${label}字段“${raw.trim()}”不是合法数字`)
  const value = Number(token)
  if (value < min || value > max)
    throw new Error(`${label}字段“${raw.trim()}”超出范围 ${min}-${max}`)
  return value
}

function cronField(
  raw: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>
): Set<number> {
  const field = raw.trim()
  if (!field) throw new Error(`${label}字段为空`)
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart, ...rest] = part.split('/')
    if (rest.length > 0) throw new Error(`${label}字段“${part}”只能包含一个 / 步长`)
    const step =
      stepPart === undefined ? 1 : cronValue(stepPart, 1, Math.max(1, max - min), `${label}步长`)
    let start: number
    let end: number
    if (rangePart === '*' || rangePart === '') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-')
      start = cronValue(from, min, max, label, names)
      end = cronValue(to, min, max, label, names)
      if (start > end) throw new Error(`${label}字段“${part}”的区间起点大于终点`)
    } else {
      start = cronValue(rangePart, min, max, label, names)
      end = stepPart === undefined ? start : max
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (!values.size) throw new Error(`${label}字段没有有效取值`)
  return values
}

interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  months: Set<number>
  dom: Set<number> | null
  dow: Set<number> | null
  raw: string[]
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('需要 5 个字段：分 时 日 月 周（用空格分隔）')
  const minutes = cronField(parts[0], 0, 59, '分钟')
  const hours = cronField(parts[1], 0, 23, '小时')
  const domRaw = cronField(parts[2], 1, 31, '日')
  const months = cronField(parts[3], 1, 12, '月', CRON_MONTH_NAMES)
  const dowRaw = cronField(parts[4], 0, 7, '星期', CRON_DOW_NAMES)
  const dow = new Set([...dowRaw].map((value) => (value === 7 ? 0 : value)))
  return {
    minutes,
    hours,
    months,
    dom: parts[2] === '*' ? null : domRaw,
    dow: parts[4] === '*' ? null : dow,
    raw: parts
  }
}

function cronDayMatches(fields: CronFields, date: Date): boolean {
  const dom = date.getDate()
  const dow = date.getDay()
  // Vixie cron: when both day fields are restricted they are OR-ed.
  if (fields.dom && fields.dow) return fields.dom.has(dom) || fields.dow.has(dow)
  if (fields.dom && !fields.dom.has(dom)) return false
  if (fields.dow && !fields.dow.has(dow)) return false
  return true
}

function nextCronRuns(fields: CronFields, from: Date, count: number): Date[] {
  const runs: Date[] = []
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000 * 5
  let guard = 0
  while (runs.length < count && guard++ < 200000 && cursor.getTime() <= limit) {
    if (!fields.months.has(cursor.getMonth() + 1)) {
      // Reset the day first: "Jan 31 + 1 month" silently becomes March.
      cursor.setDate(1)
      cursor.setMonth(cursor.getMonth() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!cronDayMatches(fields, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!fields.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!fields.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    runs.push(new Date(cursor))
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
  }
  return runs
}

function describeCronValues(values: Set<number>): string {
  const list = [...values]
  if (list.length <= 12) return list.join(', ')
  return `${list.slice(0, 12).join(', ')} … 共 ${list.length} 个`
}

function cronTool(args: ToolArgs): ToolResult {
  const preset = str(args.preset).trim()
  const expression = (preset || str(args.expression)).trim()
  if (!expression) return fail('请选择预设或输入 Cron 表达式')
  let from = new Date()
  const fromRaw = str(args.from).trim()
  if (fromRaw) {
    const parsed = new Date(fromRaw)
    if (Number.isNaN(parsed.getTime()))
      return fail('起始时间不是合法日期（如 2026-01-31T08:00:00）')
    from = parsed
  }
  let fields: CronFields | null = null
  try {
    fields = parseCron(expression)
  } catch (e) {
    return fail(`表达式无效：${why(e)}`)
  }
  if (!fields) return fail('表达式无效')
  const count = Math.min(Math.max(1, Math.trunc(num(args.nextCount, 5))), 20)
  const runs = nextCronRuns(fields, from, count)
  if (!runs.length) return fail('5 年内没有匹配的执行时间（表达式可能永远不触发）')

  const labels = ['分钟', '小时', '日', '月', '星期']
  const summaries = [fields.minutes, fields.hours, fields.dom, fields.months, fields.dow]
  const lines = [`表达式: ${expression}`, '', '结构:']
  fields.raw.forEach((part, index) => {
    const set = summaries[index]
    const detail = set
      ? `${labels[index]} = ${part}  →  ${describeCronValues(set)}`
      : `${labels[index]} = ${part}  →  不限`
    lines.push(`  ${detail}`)
  })
  lines.push('', `接下来 ${runs.length} 次执行（本机时间）:`)
  const now = Date.now()
  runs.forEach((run) => {
    const offset = Math.max(0, Math.round((run.getTime() - now) / 60000))
    lines.push(`  ${run.toLocaleString('zh-CN', { hour12: false })}  (约 ${offset} 分钟后)`)
  })
  return ok(lines.join('\n'), {
    data: { expression, runs: runs.map((run) => run.toISOString()) },
    note: '按本机本地时间推算；系统 cron 的 %、@daily 等扩展语法不在解析范围内。'
  })
}

// ---------------------------------------------------------------------------
// markdown -> html
// ---------------------------------------------------------------------------

function markdownTool(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const guard = requireText(input, 'Markdown')
  if (guard) return guard
  let body: string
  try {
    body = marked.parse(input, { gfm: true, async: false })
  } catch (e) {
    return fail(`转换失败：${why(e)}`)
  }
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Markdown 输出</title>
</head>
<body>
${body}
</body>
</html>
`
  return ok(body, { files: [textFile('document.html', document, 'text/html;charset=utf-8')] })
}

// ---------------------------------------------------------------------------
// json-tree
// ---------------------------------------------------------------------------

const TREE_MAX_NODES = 2000
const TREE_MAX_DEPTH = 10

function treeTypeInline(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object{${Object.keys(value as object).length}}`
  if (typeof value === 'string') {
    const json = JSON.stringify(value)
    return `string ${json.length > 60 ? `${json.slice(0, 60)}…` : json}`
  }
  return `${typeof value} ${String(value)}`
}

function treeChildren(value: unknown): [string, unknown][] {
  if (Array.isArray(value))
    return value.map((item, index) => [String(index), item] as [string, unknown])
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
  return []
}

interface TreeContext {
  lines: string[]
  count: number
  truncated: boolean
  maxDepthHit: boolean
}

function renderTreeNode(
  value: unknown,
  prefix: string,
  label: string,
  isLast: boolean,
  ctx: TreeContext,
  depth: number
): void {
  const hasLabel = label !== ''
  const connector = hasLabel ? (isLast ? '└─ ' : '├─ ') : ''
  ctx.lines.push(`${prefix}${connector}${hasLabel ? `${label}: ` : ''}${treeTypeInline(value)}`)
  ctx.count++
  if (ctx.count > TREE_MAX_NODES) {
    if (!ctx.truncated) {
      ctx.truncated = true
      ctx.lines.push('… 节点过多，已截断')
    }
    return
  }
  const children = treeChildren(value)
  if (!children.length) return
  if (depth >= TREE_MAX_DEPTH) {
    if (!ctx.maxDepthHit) {
      ctx.maxDepthHit = true
      ctx.lines.push('… 超过最大层级，未继续展开')
    }
    return
  }
  const childPrefix = `${prefix}${hasLabel ? (isLast ? '   ' : '│  ') : ''}`
  children.forEach(([key, child], index) => {
    renderTreeNode(child, childPrefix, key, index === children.length - 1, ctx, depth + 1)
  })
}

function jsonTree(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const guard = requireText(input, 'JSON')
  if (guard) return guard
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch (e) {
    return fail(`JSON 解析失败：${why(e)}`)
  }
  const ctx: TreeContext = { lines: [], count: 0, truncated: false, maxDepthHit: false }
  renderTreeNode(value, '', '', true, ctx, 0)
  const notes: string[] = []
  if (ctx.truncated) notes.push(`节点过多，仅显示前 ${TREE_MAX_NODES} 个节点`)
  if (ctx.maxDepthHit) notes.push(`超过 ${TREE_MAX_DEPTH} 层未继续展开`)
  return ok(ctx.lines.join('\n'), {
    files: [textFile('data.json', `${JSON.stringify(value, null, 2)}\n`, 'application/json')],
    note: notes.length ? `${notes.join('；')}。` : undefined
  })
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function base64Tool(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const mode = pick(str(args.mode), ['encode', 'decode'], 'encode')
  if (!input) return fail('请输入内容')
  if (mode === 'decode') {
    const cleaned = input.replace(/\s+/g, '')
    if (!cleaned) return fail('请输入 Base64 文本')
    if (cleaned.length % 4 !== 0)
      return fail('不是合法的 Base64：长度不是 4 的倍数（可能缺补齐的 =）')
    if (!BASE64_PATTERN.test(cleaned))
      return fail('不是合法的 Base64：含有 Base64 字符集之外的字符')
    return ok(Buffer.from(cleaned, 'base64').toString('utf8'))
  }
  return ok(Buffer.from(input, 'utf8').toString('base64'))
}

// ---------------------------------------------------------------------------
// url-codec
// ---------------------------------------------------------------------------

function urlCodec(args: ToolArgs): ToolResult {
  const input = str(args.input)
  const mode = pick(str(args.mode), ['encode', 'decode'], 'encode')
  const kind = pick(str(args.kind), ['component', 'full'], 'component')
  if (!input) return fail('请输入内容')
  try {
    if (mode === 'encode')
      return ok(kind === 'component' ? encodeURIComponent(input) : encodeURI(input))
    return ok(kind === 'component' ? decodeURIComponent(input) : decodeURI(input))
  } catch {
    return fail('解码失败：存在不完整或非法的百分号转义序列（如 %E0%A4）')
  }
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

function hashTool(args: ToolArgs): ToolResult {
  const algorithm = pick(str(args.algorithm) || 'sha256', ['sha256', 'sha512', 'md5'], 'sha256')
  const upper = bool(args.uppercase, false)
  const file = args.file as ToolFile | undefined
  // Presence of the field — not emptiness — decides what gets hashed, so an
  // empty string / empty file still yields its standard (legal) digest.
  const hasFile =
    !!file &&
    typeof file === 'object' &&
    (typeof file.base64 === 'string' || typeof file.name === 'string')
  const hasText = typeof args.input === 'string'
  if (!hasFile && !hasText) return fail('请输入文本或选择文件')
  let source: Buffer
  let label: string
  if (hasFile) {
    source = Buffer.from(typeof file?.base64 === 'string' ? file.base64 : '', 'base64')
    label =
      typeof file?.name === 'string' && file.name
        ? `文件 ${file.name}（${source.length} 字节）`
        : `文件内容（${source.length} 字节）`
  } else {
    source = Buffer.from(args.input as string, 'utf8')
    label = `文本（${source.length} 字节）`
  }
  const digest = createHash(algorithm).update(source).digest('hex')
  return ok(upper ? digest.toUpperCase() : digest, {
    data: { algorithm, bytes: source.length, digest: upper ? digest.toUpperCase() : digest },
    note: `${algorithm.toUpperCase()}(${label})；输入内容不会写入任何日志。`
  })
}

// ---------------------------------------------------------------------------
// radix
// ---------------------------------------------------------------------------

const RADIX_PREFIXES: Record<string, number> = {
  '0x': 16,
  '0X': 16,
  '0b': 2,
  '0B': 2,
  '0o': 8,
  '0O': 8
}

function digitValue(char: string): number {
  const code = char.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 97 && code <= 122) return code - 97 + 10
  if (code >= 65 && code <= 90) return code - 65 + 10
  return -1
}

function radixTool(args: ToolArgs): ToolResult {
  const raw = str(args.input).trim().replace(/[\s_]/g, '')
  const from = Math.trunc(num(args.from, 10))
  const to = Math.trunc(num(args.to, 16))
  for (const [base, which] of [
    [from, '源'],
    [to, '目标']
  ] as [number, string][]) {
    if (!Number.isInteger(base) || base < 2 || base > 36)
      return fail(`${which}进制必须在 2-36 之间`)
  }
  if (!raw) return fail('请输入要转换的数值')
  let body = raw
  let negative = false
  if (body[0] === '+' || body[0] === '-') {
    negative = body[0] === '-'
    body = body.slice(1)
  }
  const prefix = body.slice(0, 2)
  if (prefix in RADIX_PREFIXES) {
    if (RADIX_PREFIXES[prefix] !== from) return fail(`前缀 ${prefix} 与源进制 ${from} 不符`)
    body = body.slice(2)
  }
  if (!body) return fail('请输入有效数字')
  if (body.length > 4096) return fail('数字过长（超过 4096 位）')
  let value = 0n
  const bigBase = BigInt(from)
  for (const char of body) {
    const digit = digitValue(char)
    if (digit < 0 || digit >= from) return fail(`字符 "${char}" 不是合法的 ${from} 进制数字`)
    value = value * bigBase + BigInt(digit)
  }
  if (negative) value = -value
  let output = value.toString(to)
  if (bool(args.uppercase, false) && to > 10) output = output.toUpperCase()
  return ok(output, { data: { input: raw, from, to, output } })
}

// ---------------------------------------------------------------------------
// color
// ---------------------------------------------------------------------------

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseColor(raw: string): Rgba | null {
  const input = raw.trim()
  if (!input) return null

  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(input)
  if (hex) {
    const digits = hex[1]
    const pairs =
      digits.length === 3 || digits.length === 4
        ? [
            digits[0] + digits[0],
            digits[1] + digits[1],
            digits[2] + digits[2],
            digits[3] ? digits[3] + digits[3] : 'ff'
          ]
        : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6), digits.slice(6, 8) || 'ff']
    return {
      r: parseInt(pairs[0], 16),
      g: parseInt(pairs[1], 16),
      b: parseInt(pairs[2], 16),
      a: parseInt(pairs[3], 16) / 255
    }
  }

  const fn = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(input)
  if (!fn) return null
  const kind = fn[1].toLowerCase()
  const parts = fn[2].split(/[,/\s]+/).filter((part) => part !== '')
  if (parts.length < 3) return null
  const scale = (part: string, max: number): number => {
    if (part.endsWith('%')) return (parseFloat(part) / 100) * max
    return parseFloat(part)
  }
  const alpha = (): number => {
    if (parts.length < 4) return 1
    const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
    return clamp(Number.isFinite(a) ? a : 1, 0, 1)
  }
  if (kind === 'rgb' || kind === 'rgba') {
    const rgb = {
      r: scale(parts[0], 255),
      g: scale(parts[1], 255),
      b: scale(parts[2], 255),
      a: alpha()
    }
    if ([rgb.r, rgb.g, rgb.b, rgb.a].some((v) => !Number.isFinite(v))) return null
    return {
      r: Math.round(clamp(rgb.r, 0, 255)),
      g: Math.round(clamp(rgb.g, 0, 255)),
      b: Math.round(clamp(rgb.b, 0, 255)),
      a: clamp(rgb.a, 0, 1)
    }
  }
  const h = ((parseFloat(parts[0]) % 360) + 360) % 360
  const s = clamp((parseFloat(parts[1].endsWith('%') ? parts[1] : `${parts[1]}%`) || 0) / 100, 0, 1)
  const l = clamp((parseFloat(parts[2].endsWith('%') ? parts[2] : `${parts[2]}%`) || 0) / 100, 0, 1)
  if ([h, s, l].some((v) => !Number.isFinite(v))) return null
  return hslToRgb(h, s, l, alpha())
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const segment = Math.floor(h / 60) % 6
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ]
  const [r, g, b] = table[segment]
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  else if (max === gn) h = ((bn - rn) / d + 2) * 60
  else h = ((rn - gn) / d + 4) * 60
  return [h, s, l]
}

function toHex(value: Rgba): string {
  const byte = (n: number): string =>
    Math.round(clamp(n, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(value.r)}${byte(value.g)}${byte(value.b)}${byte(value.a * 255)}`
}

function colorTool(args: ToolArgs): ToolResult {
  const input = str(args.input).trim()
  if (!input) return fail('请输入颜色值')
  const rgba = parseColor(input)
  if (!rgba)
    return fail('无法识别的颜色写法，支持 #rgb/#rrggbb/#rrggbbaa、rgb()、rgba()、hsl()、hsla()')
  const [h, s, l] = rgbToHsl(rgba.r, rgba.g, rgba.b)
  const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`
  const hasAlpha = rgba.a < 1
  const lines = [
    `输入 : ${input}`,
    `HEX : ${toHex(rgba)}`,
    `RGB : ${hasAlpha ? 'rgba' : 'rgb'}(${rgba.r}, ${rgba.g}, ${rgba.b}${hasAlpha ? `, ${Math.round(rgba.a * 100) / 100}` : ''})`,
    `HSL : ${hasAlpha ? 'hsla' : 'hsl'}(${Math.round(h * 10) / 10}, ${pct(s)}, ${pct(l)}${hasAlpha ? `, ${Math.round(rgba.a * 100) / 100}` : ''})`
  ]
  return ok(lines.join('\n'), {
    data: {
      hex: toHex(rgba),
      rgb: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a },
      hsl: {
        h: Math.round(h * 10) / 10,
        s: Math.round(s * 1000) / 1000,
        l: Math.round(l * 1000) / 1000,
        a: rgba.a
      }
    }
  })
}

// ---------------------------------------------------------------------------
// linux-dictionary (static, offline)
// ---------------------------------------------------------------------------

interface CommandEntry {
  name: string
  alias?: string[]
  group: string
  summary: string
  usage: string
  caution?: string
}

const LINUX_COMMANDS: CommandEntry[] = [
  {
    name: 'ls',
    group: '文件',
    alias: ['dir'],
    summary: '列出目录内容，-l 长格式、-a 含隐藏文件、-h 人类可读体积。',
    usage: 'ls -lah /var/log'
  },
  {
    name: 'cd',
    group: '文件',
    summary: '切换当前目录，cd - 回到上一个目录，无参数回 home。',
    usage: 'cd /etc/nginx'
  },
  { name: 'pwd', group: '文件', summary: '打印当前工作目录（-P 解析软链接）。', usage: 'pwd -P' },
  {
    name: 'cp',
    group: '文件',
    summary: '复制文件/目录，-r 递归，-a 保留属性，-i 覆盖前询问。',
    usage: 'cp -a src/ dst/',
    caution: '-f 会强制覆盖，确认目标路径后再用。'
  },
  {
    name: 'mv',
    group: '文件',
    summary: '移动或重命名文件与目录。',
    usage: 'mv report.txt archive/'
  },
  {
    name: 'rm',
    group: '文件',
    summary: '删除文件或目录，-r 递归、-f 强制、-i 逐个确认。',
    usage: 'rm -i build.tmp',
    caution: 'rm -rf 不可恢复，执行前先 ls 确认目标。'
  },
  {
    name: 'mkdir',
    group: '文件',
    summary: '创建目录，-p 自动创建多级父目录。',
    usage: 'mkdir -p ~/proj/docs'
  },
  {
    name: 'cat',
    group: '文件',
    summary: '拼接并输出文件内容，-n 显示行号，适合小文件。',
    usage: 'cat -n /etc/hosts'
  },
  {
    name: 'less',
    group: '文件',
    summary: '分页查看大文件，支持搜索（/）、跳转（g/G），只读。',
    usage: 'less /var/log/syslog'
  },
  {
    name: 'head',
    group: '文件',
    summary: '输出文件开头若干行，-n 指定行数。',
    usage: 'head -n 50 big.log'
  },
  {
    name: 'tail',
    group: '文件',
    summary: '输出文件结尾若干行，-f 实时跟踪追加内容，调试日志常用。',
    usage: 'tail -f -n 100 app.log'
  },
  {
    name: 'find',
    group: '文件',
    summary: '按名称/类型/时间/大小查找文件，可 -exec 组合操作。',
    usage: 'find . -name "*.log" -mtime +7 -size +10M'
  },
  {
    name: 'grep',
    group: '文本',
    alias: ['egrep', 'fgrep'],
    summary: '按正则过滤文本，-r 递归、-i 忽略大小写、-n 行号、-v 反选。',
    usage: 'grep -rn "error" /var/log'
  },
  {
    name: 'sed',
    group: '文本',
    summary: '流编辑器：替换、删除、插入行。-i 直接原地改写文件。',
    usage: "sed -i 's/old/new/g' file.txt",
    caution: '-i 就地改写，先备份或用 -i.bak。'
  },
  {
    name: 'awk',
    group: '文本',
    summary: '按字段处理文本，适合统计报表与列运算。',
    usage: "awk '{sum += $2} END {print sum}' score.txt"
  },
  {
    name: 'xargs',
    group: '文本',
    summary: '把标准输入转为命令行参数，配合 find/grep 批量处理。',
    usage: "find . -name '*.tmp' | xargs rm -i"
  },
  {
    name: 'sort',
    group: '文本',
    summary: '排序文本行，-n 数值、-r 逆序、-u 去重、-k 指定列。',
    usage: 'sort -k2 -nr data.csv'
  },
  {
    name: 'uniq',
    group: '文本',
    summary: '去除相邻重复行，常配合 sort 使用，-c 统计次数。',
    usage: 'sort words.txt | uniq -c | sort -nr'
  },
  {
    name: 'tar',
    group: '打包',
    summary: '打包/解包 .tar 与 .tar.gz，-c 打包、-x 解包、-z gzip、-f 指定文件。',
    usage: 'tar -czf backup.tar.gz ~/data'
  },
  {
    name: 'gzip',
    group: '打包',
    summary: 'gzip 单文件压缩，-k 保留原文件，-d 解压。',
    usage: 'gzip -k access.log'
  },
  {
    name: 'zip',
    group: '打包',
    summary: '创建/更新 zip 包，-r 递归，-e 加密。',
    usage: 'zip -r project.zip project/'
  },
  {
    name: 'chmod',
    group: '权限',
    summary: '修改文件权限位：u/g/o/a 配合 +/-/= 与 rwx，或八进制。',
    usage: 'chmod 644 config.json'
  },
  {
    name: 'chown',
    group: '权限',
    summary: '修改文件所有者与所属组（:group），需 root 或 sudo。',
    usage: 'chown www-data:www-data data/',
    caution: '改错所有者可能导致服务无法读取数据，-R 前先确认范围。'
  },
  {
    name: 'ln',
    group: '权限',
    summary: '创建链接，-s 软链接（最常用），不带 -s 为硬链接。',
    usage: 'ln -s /opt/tools/bin/tool ~/.local/bin/tool'
  },
  {
    name: 'ps',
    group: '进程',
    summary: '查看进程快照，-ef 全量、aux 按资源，可管道 grep。',
    usage: 'ps -ef | grep nginx'
  },
  {
    name: 'top',
    group: '进程',
    summary: '实时进程资源面板，P 按 CPU、M 按内存排序，q 退出。',
    usage: 'top'
  },
  {
    name: 'kill',
    group: '进程',
    summary: '向进程发信号，默认 TERM；-9 为强制 KILL，先尝试正常终止。',
    usage: 'kill -TERM 12345',
    caution: 'kill -9 不给进程清理机会，可能丢失数据。'
  },
  {
    name: 'pkill',
    group: '进程',
    summary: '按进程名/命令行模式批量发信号，慎用 -f。',
    usage: 'pkill -f "python server.py"'
  },
  {
    name: 'df',
    group: '磁盘',
    summary: '查看文件系统磁盘使用，-h 人类可读，-T 显示类型。',
    usage: 'df -hT /'
  },
  {
    name: 'du',
    group: '磁盘',
    summary: '统计目录/文件占用，-h 可读，-s 仅汇总，--max-depth 控制层级。',
    usage: 'du -sh --max-depth=1 ~/Downloads'
  },
  {
    name: 'mount',
    group: '磁盘',
    summary: '挂载文件系统；umount 卸载。无设备权限时需 sudo。',
    usage: 'mount | grep /mnt',
    caution: 'mount/umount 需要 root，操作前确认设备名。'
  },
  {
    name: 'ssh',
    group: '网络',
    summary: '加密远程登录，-p 端口、-i 密钥，-L 本地端口转发。',
    usage: 'ssh -p 2222 user@10.0.0.8'
  },
  {
    name: 'scp',
    group: '网络',
    summary: '基于 SSH 的文件复制，-r 递归目录，-P 指定端口。',
    usage: 'scp -P 22 file.txt user@host:/tmp/'
  },
  {
    name: 'rsync',
    group: '网络',
    summary: '增量同步/备份，-a 归档、-v 详细、--delete 镜像删除。',
    usage: 'rsync -av --delete src/ backup/',
    caution: '--delete 会删除目标端多余文件，先用 -n 试跑。'
  },
  {
    name: 'curl',
    group: '网络',
    summary: '命令行 HTTP 客户端，-o 保存、-L 跟随跳转、-I 只看响应头。',
    usage: 'curl -fsSL -o out.html https://example.com'
  },
  {
    name: 'wget',
    group: '网络',
    summary: '下载文件/镜像站点，-c 断点续传、-r 递归。',
    usage: 'wget -c https://example.com/file.zip'
  },
  {
    name: 'ping',
    group: '网络',
    summary: 'ICMP 连通性测试，-c 指定次数（无限次需手动停）。',
    usage: 'ping -c 4 223.5.5.5'
  },
  {
    name: 'ss',
    group: '网络',
    summary: '查看 socket 连接与监听端口（netstat 的现代替代），-tlnp 看 TCP 监听。',
    usage: 'ss -tlnp'
  },
  {
    name: 'systemctl',
    group: '系统',
    summary: '管理 systemd 服务：status/start/stop/restart/enable，--user 操作用户级。',
    usage: 'systemctl --user status pipewire',
    caution: '修改系统服务需要 sudo，先 --user 分清层级。'
  },
  {
    name: 'journalctl',
    group: '系统',
    summary: '查询 systemd 日志，-u 限定单元、-f 实时、--since 时间范围。',
    usage: 'journalctl -u nginx -f --since "1 hour ago"'
  },
  {
    name: 'whoami',
    group: '系统',
    summary: '打印当前用户名；id 额外显示 uid/gid 与所属组。',
    usage: 'id'
  },
  {
    name: 'sudo',
    group: '系统',
    summary: '以其他身份（默认 root）执行命令，会记录审计日志并要求授权。',
    usage: 'sudo pacman -Syu',
    caution: '只在可信命令上加 sudo，避免管道远程脚本。'
  },
  {
    name: 'pacman',
    group: '软件包',
    summary: 'Arch Linux 包管理：-S 安装、-Ss 搜索、-Syu 升级、-R 删除、-Qi 信息。',
    usage: 'pacman -Ss neovim',
    caution: '属于本词典中的 Arch 项目说明，具体到你的发行版请查对应包管理器。'
  },
  { name: 'man', group: '系统', summary: '查看命令手册；--help 可快速看用法。', usage: 'man rsync' }
]

function linuxDictionary(args: ToolArgs): ToolResult {
  const query = str(args.query).trim().toLowerCase()
  const matches = query
    ? LINUX_COMMANDS.filter((entry) => {
        const haystack = [entry.name, entry.group, entry.summary, ...(entry.alias ?? [])]
          .join(' ')
          .toLowerCase()
        return haystack.includes(query)
      })
    : LINUX_COMMANDS
  if (!matches.length) return fail(`没有找到与「${query}」相关的命令，换个关键词试试`)

  const lines: string[] = []
  const currentGroup: string[] = []
  matches.forEach((entry, index) => {
    if (index > 0 && entry.group !== currentGroup[currentGroup.length - 1]) lines.push('')
    currentGroup.push(entry.group)
    lines.push(
      `${entry.name}${entry.alias?.length ? ` (${entry.alias.join(', ')})` : ''} — ${entry.summary}`
    )
    lines.push(`  分组: ${entry.group}    用法: ${entry.usage}`)
    if (entry.caution) lines.push(`  注意: ${entry.caution}`)
  })
  return ok(lines.join('\n'), {
    data: { total: LINUX_COMMANDS.length, matched: matches.length, entries: matches },
    note: '静态离线说明，仅作速查；本工具不会执行任何命令。'
  })
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS: Record<string, Fn> = {
  'json-format': jsonFormat,
  'json-escape': jsonEscape,
  'config-convert': configConvert,
  'code-format': codeFormat,
  'js-minify': jsMinify,
  'css-format': cssFormat,
  'html-format': htmlFormat,
  'sql-format': sqlFormatTool,
  'regex-test': regexTest,
  uuid: uuidTool,
  'mock-data': mockData,
  cron: cronTool,
  markdown: markdownTool,
  'json-tree': jsonTree,
  base64: base64Tool,
  'url-codec': urlCodec,
  hash: hashTool,
  radix: radixTool,
  color: colorTool,
  'linux-dictionary': linuxDictionary
}

export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  const impl = IMPLEMENTATIONS[id]
  if (!impl) return fail(`未知工具：${id}`)
  const safeArgs: ToolArgs = args && typeof args === 'object' ? args : {}
  try {
    return await impl(safeArgs)
  } catch (e) {
    // Never include raw user input in the message.
    return fail(`执行失败：${why(e)}`)
  }
}
