/**
 * `files` tool group execution — local document & media conversion.
 *
 * Ground rules (see tools/README.md):
 *  - user files arrive as ToolFile (base64); we never touch arbitrary paths
 *  - every tool runs inside its own mkdtemp() directory, with random file names
 *    (an uploaded name is never used as a filesystem path) and `rm -rf` cleanup
 *  - external programs run as fixed argv arrays (no shell) with a 2 minute
 *    timeout, output caps and an isolated HOME / LibreOffice profile
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { killToolProcess, toolSignal, trackToolProcess } from '../../execution-context'
import mammoth from 'mammoth'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun
} from 'docx'
import { PDFDocument } from 'pdf-lib'
import * as XLSX from 'xlsx'
import { parse as parseYaml } from 'yaml'
import { pathToFileURL } from 'node:url'
import { checkOfficePackage, officeProfile } from './office-safety'
import type { ToolArgs, ToolFile, ToolResult } from '../../types'
import { delimiterChar, detectDelimiter, parseCsv, toCsv } from './csv'
import { htmlToBlocks, htmlToMarkdown, textToSafeHtml, type WordBlock } from './html-doc'

/* --------------------------------------------------------------- lifecycle */

/** Thrown when a run is cancelled (tool panel stop / app quit). */
class ToolCancelled extends Error {
  constructor() {
    super('转换已取消')
    this.name = 'ToolCancelled'
  }
}

/** ffmpeg/ffprobe must never fetch over the network — file & pipe only. */
const FF_PROCESS_WHITELIST = ['-protocol_whitelist', 'file,pipe']

/** Hex-encode a value for qpdf's `--password-mode=hex-bytes` argument. */
function hexArg(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

/** qpdf exit text may echo password material; never surface it to the user. */
function qpdfSafeError(): string {
  return 'qpdf 执行失败，请确认 PDF 完整且密码正确'
}

/* ------------------------------------------------------------------ limits */

const MB = 1024 * 1024
const MAX_INPUT_FILE = 64 * MB
const MAX_INPUT_TOTAL = 128 * MB
const MAX_OUTPUT_TOTAL = 100 * MB
const MAX_OUTPUT_FILES = 40
const MAX_INLINE_TEXT = 1024 * 1024
const PROC_TIMEOUT_MS = 120000
const MAX_PROC_OUTPUT = 16 * MB
const MAX_INPUT_FILES = 30
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function mb(bytes: number): string {
  return `${Math.round(bytes / MB)}MB`
}

/* ------------------------------------------------------- args & file input */

function asToolFile(value: unknown): ToolFile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ToolFile>
  if (typeof candidate.base64 !== 'string') return null
  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'file',
    mime:
      typeof candidate.mime === 'string' && candidate.mime
        ? candidate.mime
        : 'application/octet-stream',
    base64: candidate.base64
  }
}

function requireFile(args: ToolArgs, key = 'file'): ToolFile {
  const file = asToolFile(args[key])
  if (!file) throw new Error(`缺少输入文件（${key}）`)
  return file
}

function requireFiles(args: ToolArgs, key = 'files'): ToolFile[] {
  const value = args[key]
  const list = Array.isArray(value) ? value : value ? [value] : []
  const files: ToolFile[] = []
  for (const entry of list) {
    const file = asToolFile(entry)
    if (file) files.push(file)
  }
  if (files.length === 0) throw new Error(`缺少输入文件（${key}）`)
  if (files.length > MAX_INPUT_FILES) throw new Error(`一次最多 ${MAX_INPUT_FILES} 个文件`)
  return files
}

function stripDataUrl(base64: string): string {
  const comma = base64.indexOf(',')
  if (comma > 0 && base64.slice(0, comma).includes('base64')) return base64.slice(comma + 1)
  return base64
}

function decodeFile(file: ToolFile): Buffer {
  const base64 = stripDataUrl(file.base64.trim())
  if (!base64) throw new Error('输入文件内容为空')
  const approx = Math.floor((base64.length * 3) / 4)
  if (approx > MAX_INPUT_FILE) throw new Error(`单个文件超过 ${mb(MAX_INPUT_FILE)} 上限`)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('文件内容不是合法的 Base64')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error('输入文件内容为空')
  if (buffer.length > MAX_INPUT_FILE) throw new Error(`单个文件超过 ${mb(MAX_INPUT_FILE)} 上限`)
  return buffer
}

function decodeFiles(files: ToolFile[]): Buffer[] {
  const buffers = files.map(decodeFile)
  const total = buffers.reduce((sum, b) => sum + b.length, 0)
  if (total > MAX_INPUT_TOTAL) throw new Error(`文件总量超过 ${mb(MAX_INPUT_TOTAL)} 上限`)
  return buffers
}

/* ------------------------------------------------------- format sniffing */

type Sniff = 'pdf' | 'png' | 'jpeg' | 'gif' | 'zip' | 'ole' | 'text' | 'binary' | 'unknown'

function sniff(buffer: Buffer): Sniff {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  const head = buffer.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip'
  if (buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return 'ole'
  return buffer.includes(0) ? 'binary' : 'text'
}

function requirePdf(buffer: Buffer): void {
  if (sniff(buffer) !== 'pdf') throw new Error('输入不是有效的 PDF 文件')
}

function requireDocx(buffer: Buffer): void {
  const kind = sniff(buffer)
  if (kind === 'zip') return
  if (kind === 'ole') throw new Error('暂不支持旧版 .doc，请先用「文档格式转换」转成 .docx')
  throw new Error('输入不是有效的 DOCX（.docx）文件')
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

/* --------------------------------------------------------- process runner */

interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Extra arguments (one per line) fed to the child on stdin via qpdf's `@-`. */
  stdin?: string
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  overflow: boolean
  missing: boolean
  cancelled: boolean
}

async function runProc(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const signal = toolSignal()
  if (signal?.aborted) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      overflow: false,
      missing: false,
      cancelled: true
    }
  }
  return new Promise<RunResult>((resolve) => {
    // The only secret-carrying path (qpdf passwords) uses `@-` + stdin so no
    // password ever reaches the process table; everything else stays argv-only.
    const input = opts.stdin === undefined ? undefined : `${opts.stdin.replace(/\n*$/, '')}\n`
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32'
    })
    // Own process group: one kill reaches ffmpeg's children too.
    const untrack = trackToolProcess(child, true)
    const onAbort = (): void => killToolProcess(child, true)
    signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    let stderr = ''
    let overflow = false
    let timedOut = false
    let cancelled = false
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      untrack()
      resolve(result)
    }
    const capture =
      (stream: 'out' | 'err') =>
      (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (stream === 'out') stdout += text
        else stderr += text
        if (stdout.length > MAX_PROC_OUTPUT || stderr.length > MAX_PROC_OUTPUT) {
          overflow = true
          killToolProcess(child, true)
        }
      }
    child.stdout?.on('data', capture('out'))
    child.stderr?.on('data', capture('err'))
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // The child may exit before reading stdin; EPIPE is expected here.
      if (err.code !== 'EPIPE') killToolProcess(child, true)
    })
    if (input !== undefined) child.stdin?.end(input)
    const timer = setTimeout(() => {
      timedOut = true
      killToolProcess(child, true)
    }, opts.timeoutMs ?? PROC_TIMEOUT_MS)
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish({
          code: null,
          stdout,
          stderr: '',
          timedOut,
          overflow,
          missing: true,
          cancelled
        })
        return
      }
      if (err.code === 'EPIPE') {
        finish({
          code: child.exitCode,
          stdout,
          stderr,
          timedOut,
          overflow,
          missing: false,
          cancelled
        })
        return
      }
      finish({ code: null, stdout, stderr, timedOut, overflow, missing: false, cancelled })
    })
    child.on('close', (code) => {
      cancelled = signal?.aborted === true
      finish({ code, stdout, stderr, timedOut, overflow, missing: false, cancelled })
    })
  })
}

/** Cancellation / missing-tool / timeout guard shared by every external call. */
function requireToolProcess(bin: string, result: RunResult, dependency?: string): RunResult {
  if (result.cancelled) throw new ToolCancelled()
  if (result.missing)
    throw new Error(`未找到系统工具 ${bin}（${dependency ?? bin}），请先安装该依赖`)
  if (result.timedOut) throw new Error(`外部工具 ${bin} 执行超时（超过 2 分钟）`)
  if (result.overflow) throw new Error(`外部工具 ${bin} 输出过大，已中止`)
  return result
}

function requireOk(result: RunResult, bin: string, dependency?: string): RunResult {
  const checked = requireToolProcess(bin, result, dependency)
  if (checked.code !== 0) {
    const detail = checked.stderr.trim().slice(0, 400)
    throw new Error(
      `${bin} 执行失败（退出码 ${String(checked.code)}）${detail ? `：${detail}` : ''}`
    )
  }
  return checked
}

function sanitizeMessage(message: string, dir?: string): string {
  let text = message
  if (dir) text = text.split(dir).join('<tmp>')
  text = text.split(tmpdir()).join('<os-tmp>')
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

/* ------------------------------------------------------------ temp & files */

function randomName(prefix: string, ext: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.${ext}`
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-toolbox-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function toolFile(name: string, mime: string, data: Buffer): ToolFile {
  return { name, mime, base64: data.toString('base64') }
}

function finish(files: ToolFile[], note?: string): ToolResult {
  if (files.length === 0) throw new Error('未生成任何输出文件')
  if (files.length > MAX_OUTPUT_FILES) {
    throw new Error(`输出文件过多（${files.length} 个，上限 ${MAX_OUTPUT_FILES}），请缩小范围`)
  }
  const total = files.reduce((sum, f) => sum + Math.floor((f.base64.length * 3) / 4), 0)
  if (total > MAX_OUTPUT_TOTAL) throw new Error(`输出总大小超过 ${mb(MAX_OUTPUT_TOTAL)} 上限`)
  return { ok: true, files, note }
}

function truncateText(text: string): string {
  return text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n…（已截断）` : text
}

/* ---------------------------------------------------------------- helpers */

function str(args: ToolArgs, key: string, fallback = ''): string {
  const value = args[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return fallback
}

function num(args: ToolArgs, key: string, fallback: number): number {
  const value = args[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(args: ToolArgs, key: string, fallback: boolean): boolean {
  const value = args[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function slug(name: string): string {
  const base = name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'sheet'
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const cells = (row: string[]): string[] =>
    Array.from({ length: width }, (_, i) =>
      (row[i] ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
    )
  const lines: string[] = []
  lines.push(`| ${cells(rows[0]).join(' | ')} |`)
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
  for (let i = 1; i < rows.length; i++) lines.push(`| ${cells(rows[i]).join(' | ')} |`)
  return lines.join('\n') + '\n'
}

/* ============================================================== DOCX side */

function docxBuffer(blocks: WordBlock[]): Promise<Buffer> {
  const children: Array<Paragraph | Table> = []
  const push = (node: Paragraph | Table): void => {
    children.push(node)
  }
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = clamp(block.level, 1, 6)
        push(
          new Paragraph({
            heading:
              level === 1
                ? HeadingLevel.HEADING_1
                : level === 2
                  ? HeadingLevel.HEADING_2
                  : level === 3
                    ? HeadingLevel.HEADING_3
                    : HeadingLevel.HEADING_4,
            spacing: { before: 160, after: 80 },
            children: [new TextRun(block.text)]
          })
        )
        break
      }
      case 'paragraph': {
        for (const line of block.text.split('\n')) {
          push(
            new Paragraph({
              spacing: { after: 80 },
              children: [new TextRun({ text: line, font: 'Calibri' })]
            })
          )
        }
        break
      }
      case 'bullet': {
        push(
          new Paragraph({
            bullet: { level: clamp(block.level, 0, 3) },
            spacing: { after: 40 },
            children: [new TextRun(block.text)]
          })
        )
        break
      }
      case 'numbered': {
        push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 40 },
            children: [new TextRun(`· ${block.text}`)]
          })
        )
        break
      }
      case 'quote': {
        push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: 360 },
            children: [new TextRun({ text: block.text, italics: true, color: '595959' })]
          })
        )
        break
      }
      case 'code': {
        push(
          new Paragraph({
            spacing: { after: 80 },
            children: [new TextRun({ text: block.text, font: 'Consolas', size: 20 })]
          })
        )
        break
      }
      case 'table': {
        push(tableToDocx(block.rows))
        break
      }
    }
  }
  const doc = new Document({
    creator: 'Cockpit Toolbox',
    title: 'Cockpit Toolbox export',
    sections: [{ children }]
  })
  return Packer.toBuffer(doc).then((data) => Buffer.from(data))
}

function tableToDocx(rows: string[][]): Table {
  if (rows.length === 0) rows = [['']]
  const width = Math.max(...rows.map((r) => r.length))
  const tableRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: width }, (_, i) => {
      const text = (row[i] ?? '').split('\n').join(' ')
      return new TableCell({
        children: [
          new Paragraph({
            spacing: { after: 0 },
            children: [
              new TextRun({
                text,
                bold: rowIndex === 0,
                font: 'Calibri',
                size: 18
              })
            ]
          })
        ]
      })
    })
    return new TableRow({ children: cells })
  })
  return new Table({ rows: tableRows, width: { size: 100, type: 'pct' } })
}

/* ============================================================ word tools */

async function wordToText(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requireDocx(buffer)
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value
  const notes: string[] = []
  if (result.messages.length > 0) {
    notes.push(`文档解析产生 ${result.messages.length} 条提示，可能影响极少数内容`)
  }
  return {
    ok: true,
    text: truncateText(text),
    files: [toolFile('word-to-text.txt', 'text/plain;charset=utf-8', Buffer.from(text, 'utf8'))],
    note: notes.join('；') || undefined
  }
}

async function wordToHtml(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requireDocx(buffer)
  const result = await mammoth.convertToHtml({ buffer })
  const html = result.value
  return {
    ok: true,
    text: truncateText(html),
    files: [toolFile('word-to-html.html', 'text/html;charset=utf-8', Buffer.from(html, 'utf8'))],
    note: result.messages.length > 0 ? '转换中有少量元素被跳过（如图片或复杂表格）' : undefined
  }
}

async function textToWord(args: ToolArgs): Promise<ToolResult> {
  const text = str(args, 'text')
  if (!text.trim()) throw new Error('请输入要转换的文本')
  if (text.length > 500000) throw new Error('文本过长（上限 50 万字符）')
  const lines = text.split(/\r?\n/)
  const doc = new Document({
    creator: 'Cockpit Toolbox',
    title: 'text-to-word',
    sections: [
      {
        children: lines.map(
          (line) =>
            new Paragraph({
              spacing: { after: 80 },
              children: [new TextRun({ text: line, font: 'Calibri' })]
            })
        )
      }
    ]
  })
  const data = Buffer.from(await Packer.toBuffer(doc))
  return finish([toolFile('text-to-word.docx', DOCX_MIME, data)], `共 ${lines.length} 段`)
}

async function wordToMarkdown(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requireDocx(buffer)
  const result = await mammoth.convertToHtml({ buffer })
  const markdown = htmlToMarkdown(result.value)
  if (!markdown.trim()) throw new Error('未能从文档中提取到文本内容')
  return {
    ok: true,
    text: truncateText(markdown),
    files: [
      toolFile('word-to-markdown.md', 'text/markdown;charset=utf-8', Buffer.from(markdown, 'utf8'))
    ],
    note: '仅转换文本结构（标题/列表/表格/强调），版式、字体、页眉页脚不会保留'
  }
}

async function htmlToWord(args: ToolArgs): Promise<ToolResult> {
  const html = str(args, 'html')
  if (!html.trim()) throw new Error('请输入 HTML 内容')
  if (html.length > 500000) throw new Error('HTML 内容过长（上限 50 万字符）')
  const blocks = htmlToBlocks(html)
  if (blocks.length === 0) throw new Error('未能从 HTML 中提取到正文内容')
  const data = await docxBuffer(blocks)
  return finish(
    [toolFile('html-to-word.docx', DOCX_MIME, data)],
    `生成 ${blocks.length} 个内容块；CSS、脚本、iframe、图片、表单不转换`
  )
}

/* ====================================================== swagger -> docx */

interface OpenApiSpec {
  info?: Record<string, unknown>
  paths?: Record<string, unknown>
  components?: Record<string, unknown>
  definitions?: Record<string, unknown>
}

function parseSpec(raw: string): OpenApiSpec {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('OpenAPI 内容为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    try {
      parsed = parseYaml(trimmed)
    } catch {
      throw new Error('无法解析内容：既不是合法 JSON，也不是合法 YAML')
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('OpenAPI 内容格式不正确')
  const spec = parsed as OpenApiSpec
  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('未找到 paths 字段，不像 OpenAPI/Swagger 文档')
  }
  return spec
}

function refName(ref: string): string {
  const parts = ref.split('/')
  return parts[parts.length - 1] || ref
}

function describeSchema(schema: unknown, spec: OpenApiSpec, depth = 0): string {
  if (!schema || typeof schema !== 'object') return ''
  const node = schema as Record<string, unknown>
  if (typeof node.$ref === 'string' && depth < 3) {
    const name = refName(node.$ref)
    const resolved = lookupRef(spec, node.$ref)
    if (resolved) return `${name}${describeSchema(resolved, spec, depth + 1)}`
    return name
  }
  const type =
    typeof node.type === 'string' ? node.type : Array.isArray(node.type) ? node.type.join('|') : ''
  if (type === 'array' || node.items) {
    const items = node.items ? describeSchema(node.items, spec, depth + 1) : ''
    return items ? `${items}[]` : 'array'
  }
  const parts: string[] = []
  if (type) parts.push(type)
  if (typeof node.format === 'string') parts.push(node.format)
  if (Array.isArray(node.enum)) parts.push(`枚举: ${node.enum.map(String).join('/')}`)
  if (node.properties && typeof node.properties === 'object') {
    const keys = Object.keys(node.properties as Record<string, unknown>)
    if (keys.length) parts.push(`{${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}}`)
  }
  return parts.join(' ')
}

function lookupRef(spec: OpenApiSpec, ref: string): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null
  let node: unknown = spec
  for (const part of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[decodeURIComponent(part)]
  }
  return node && typeof node === 'object' ? (node as Record<string, unknown>) : null
}

function strField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function swaggerToWord(args: ToolArgs): Promise<ToolResult> {
  let raw = str(args, 'spec')
  const file = asToolFile(args.file)
  if (file) {
    const buffer = decodeFile(file)
    if (sniff(buffer) !== 'text') throw new Error('OpenAPI 文件需要是文本（JSON/YAML）')
    raw = buffer.toString('utf8')
  }
  if (!raw.trim()) throw new Error('请上传 OpenAPI 文件或粘贴 JSON/YAML 内容')
  const spec = parseSpec(raw)
  const maxEndpoints = clamp(Math.round(num(args, 'maxEndpoints', 100)), 1, 500)

  const info = (spec.info ?? {}) as Record<string, unknown>
  const blocks: WordBlock[] = []
  const title = strField(info, 'title') || 'API 文档'
  const version = strField(info, 'version')
  blocks.push({ kind: 'heading', level: 1, text: version ? `${title} v${version}` : title })
  const infoDescription = strField(info, 'description')
  if (infoDescription) blocks.push({ kind: 'paragraph', text: infoDescription })

  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head']
  const paths = spec.paths ?? {}
  let count = 0
  let truncated = false
  for (const path of Object.keys(paths)) {
    const operations = paths[path]
    if (!operations || typeof operations !== 'object') continue
    for (const method of methods) {
      if (count >= maxEndpoints) {
        truncated = true
        break
      }
      const operation = (operations as Record<string, unknown>)[method]
      if (!operation || typeof operation !== 'object') continue
      const op = operation as Record<string, unknown>
      count++
      blocks.push({ kind: 'heading', level: 2, text: `${method.toUpperCase()} ${path}` })
      if (strField(op, 'summary')) blocks.push({ kind: 'paragraph', text: strField(op, 'summary') })
      if (strField(op, 'description'))
        blocks.push({ kind: 'paragraph', text: strField(op, 'description') })
      const tags = op.tags
      if (Array.isArray(tags) && tags.length) {
        blocks.push({ kind: 'paragraph', text: `标签：${tags.map(String).join('、')}` })
      }

      const params = op.parameters
      if (Array.isArray(params)) {
        const rows: string[][] = [['名称', '位置', '必填', '说明']]
        for (const param of params) {
          if (!param || typeof param !== 'object') continue
          const p = param as Record<string, unknown>
          const resolved = typeof p.$ref === 'string' ? lookupRef(spec, p.$ref) : p
          if (!resolved) continue
          const schema = describeSchema(resolved.schema, spec)
          rows.push([
            strField(resolved, 'name'),
            strField(resolved, 'in'),
            resolved.required === true ? '是' : '否',
            `${strField(resolved, 'description')}${schema ? `（${schema}）` : ''}`.trim()
          ])
        }
        if (rows.length > 1) blocks.push({ kind: 'table', rows })
      }

      const requestBody = op.requestBody as Record<string, unknown> | undefined
      const content = requestBody?.content as Record<string, unknown> | undefined
      if (content) {
        const rows: string[][] = [['Content-Type', '请求体']]
        for (const mediaType of Object.keys(content)) {
          const body = content[mediaType] as Record<string, unknown> | undefined
          const schema = describeSchema(body?.schema, spec)
          rows.push([mediaType, schema || '-'])
        }
        if (rows.length > 1) blocks.push({ kind: 'table', rows })
      }

      const responses = op.responses as Record<string, unknown> | undefined
      if (responses) {
        const rows: string[][] = [['状态码', '说明']]
        for (const code of Object.keys(responses)) {
          const response = responses[code] as Record<string, unknown> | undefined
          const schema = describeSchema(
            response?.content && (response.content as Record<string, unknown>)['application/json'],
            spec
          )
          rows.push([
            code,
            `${strField(response ?? {}, 'description')}${schema ? `（${schema}）` : ''}`.trim() ||
              '-'
          ])
        }
        if (rows.length > 1) blocks.push({ kind: 'table', rows })
      }
    }
    if (truncated) break
  }
  if (count === 0) throw new Error('文档中没有可读的接口（paths 下没有操作）')

  const data = await docxBuffer(blocks)
  const note = truncated ? `接口数量超过上限，仅导出前 ${maxEndpoints} 个` : undefined
  return finish([toolFile('swagger-to-word.docx', DOCX_MIME, data)], note)
}

/* ======================================================= spreadsheet side */

interface SheetData {
  name: string
  rows: string[][]
}

const SHEET_MAX_ROWS = 200000

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function readWorkbook(buffer: Buffer): XLSX.WorkBook {
  try {
    return XLSX.read(buffer, { type: 'buffer', cellDates: true, cellText: true, cellFormula: true })
  } catch {
    throw new Error('无法解析表格文件，请确认是有效的 .xlsx / .xls')
  }
}

function workbookSheets(workbook: XLSX.WorkBook, maxRows: number): SheetData[] {
  const sheets: SheetData[] = []
  for (const name of workbook.SheetNames) {
    const worksheet = workbook.Sheets[name]
    if (!worksheet) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
      dateNF: 'yyyy-mm-dd hh:mm:ss'
    })
    const stringRows = rows.slice(0, maxRows).map((row) => row.map(stringifyCell))
    while (stringRows.length > 0 && stringRows[stringRows.length - 1].every((c) => c === '')) {
      stringRows.pop()
    }
    if (stringRows.length > 0) sheets.push({ name, rows: stringRows })
  }
  return sheets
}

function readCsvSheet(buffer: Buffer, name: string): SheetData {
  const text = buffer.toString('utf8')
  const rows = parseCsv(text, detectDelimiter(text))
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  return { name: name || 'CSV', rows }
}

function loadSheets(file: ToolFile, buffer: Buffer, maxRows: number): SheetData[] {
  const ext = extensionOf(file.name)
  if (ext === 'csv' || ext === 'txt') return [readCsvSheet(buffer, ext.toUpperCase())]
  if (ext !== 'xlsx' && ext !== 'xls') {
    throw new Error('不支持的表格格式，请上传 .xlsx / .xls / .csv')
  }
  const kind = sniff(buffer)
  if (kind !== 'zip' && kind !== 'ole') throw new Error('输入不是有效的 XLSX / XLS 文件')
  const sheets = workbookSheets(readWorkbook(buffer), maxRows)
  if (sheets.length === 0) throw new Error('表格中没有数据')
  return sheets
}

async function sheetConvert(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const format = str(args, 'format', 'csv') || 'csv'
  if (!['csv', 'xlsx', 'html', 'md', 'json'].includes(format)) {
    throw new Error('不支持的输出格式')
  }
  const maxRows = clamp(Math.round(num(args, 'maxRows', 20000)), 1, 200000)
  const sheets = loadSheets(file, buffer, maxRows)
  if (sheets.length === 0) throw new Error('表格中没有数据')
  const files: ToolFile[] = []
  let text = ''
  if (format === 'csv') {
    const delimiter = delimiterChar(str(args, 'delimiter', 'comma'))
    for (const sheet of sheets) {
      const csv = toCsv(sheet.rows, delimiter)
      files.push(
        toolFile(`${slug(sheet.name)}.csv`, 'text/csv;charset=utf-8', Buffer.from(csv, 'utf8'))
      )
    }
    text = sheets.map((s) => `${s.name}：${s.rows.length} 行`).join('；')
  } else if (format === 'xlsx') {
    const workbook = XLSX.utils.book_new()
    for (const sheet of sheets) {
      workbook.SheetNames.push(sheet.name.slice(0, 31))
      workbook.Sheets[sheet.name.slice(0, 31)] = XLSX.utils.aoa_to_sheet<string>(sheet.rows)
    }
    const data = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer
    files.push(toolFile('sheet-convert.xlsx', XLSX_MIME, Buffer.from(data)))
    text = sheets.map((s) => `${s.name}：${s.rows.length} 行`).join('；')
  } else if (format === 'html') {
    const parts: string[] = []
    for (const sheet of sheets) {
      const rows = sheet.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeCell(cell)}</td>`).join('')}</tr>`)
        .join('\n')
      parts.push(`<h2>${escapeCell(sheet.name)}</h2>\n<table>\n${rows}\n</table>`)
    }
    const html = `<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n<title>表格导出</title>\n</head>\n<body>\n${parts.join('\n')}\n</body>\n</html>\n`
    files.push(toolFile('sheet-convert.html', 'text/html;charset=utf-8', Buffer.from(html, 'utf8')))
    text = sheets.map((s) => `${s.name}：${s.rows.length} 行`).join('；')
  } else if (format === 'md') {
    const parts: string[] = []
    for (const sheet of sheets) {
      parts.push(`## ${sheet.name}\n\n${markdownTable(sheet.rows)}`)
    }
    const md = parts.join('\n\n') + '\n'
    files.push(toolFile('sheet-convert.md', 'text/markdown;charset=utf-8', Buffer.from(md, 'utf8')))
    text = sheets.map((s) => `${s.name}：${s.rows.length} 行`).join('；')
  } else {
    const payload = JSON.stringify(
      { sheets: sheets.map((s) => ({ name: s.name, rows: s.rows })) },
      null,
      2
    )
    files.push(
      toolFile('sheet-convert.json', 'application/json;charset=utf-8', Buffer.from(payload, 'utf8'))
    )
    text = sheets.map((s) => `${s.name}：${s.rows.length} 行`).join('；')
  }
  return finish(files, `${text}${maxRows < SHEET_MAX_ROWS ? `（每表上限 ${maxRows} 行）` : ''}`)
}

function escapeCell(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function sheetMerge(args: ToolArgs): Promise<ToolResult> {
  const files = requireFiles(args)
  const buffers = decodeFiles(files)
  const format = str(args, 'format', 'csv') || 'csv'
  if (!['csv', 'xlsx'].includes(format)) throw new Error('不支持的输出格式')
  const maxRows = clamp(Math.round(num(args, 'maxRows', 50000)), 1, 500000)

  const header: string[] = []
  const headerIndex = new Map<string, number>()
  const addHeader = (name: string): number => {
    const key = name
    const existing = headerIndex.get(key)
    if (existing !== undefined) return existing
    header.push(key)
    headerIndex.set(key, header.length - 1)
    return header.length - 1
  }
  const merged: string[][] = []

  files.forEach((file, index) => {
    const sheets = loadSheets(file, buffers[index], maxRows)
    const sheet = sheets[0]
    if (!sheet || sheet.rows.length === 0) return
    const rows = sheet.rows
    if (index === 0) {
      for (const name of rows[0]) addHeader(name)
      for (let i = 1; i < rows.length && merged.length < maxRows; i++) {
        const row = new Array<string>(header.length).fill('')
        rows[i].forEach((cell, ci) => {
          const target = headerIndex.get(rows[0][ci] ?? '')
          if (target !== undefined) row[target] = cell
        })
        merged.push(row)
      }
      return
    }
    const localHeader = rows[0]
    const mapping = localHeader.map((name) => addHeader(name))
    for (let i = 1; i < rows.length && merged.length < maxRows; i++) {
      const row = new Array<string>(header.length).fill('')
      rows[i].forEach((cell, ci) => {
        const target = mapping[ci]
        if (target !== undefined) row[target] = cell
      })
      merged.push(row)
    }
  })

  if (header.length === 0) throw new Error('没有可合并的数据')
  const note = `共 ${merged.length} 行 × ${header.length} 列${merged.length >= maxRows ? '（已达行数上限）' : ''}`

  if (format === 'csv') {
    const delimiter = delimiterChar(str(args, 'delimiter', 'comma'))
    const csv = toCsv([header, ...merged], delimiter)
    return finish(
      [toolFile('sheet-merge.csv', 'text/csv;charset=utf-8', Buffer.from(csv, 'utf8'))],
      note
    )
  }
  const workbook = XLSX.utils.book_new()
  workbook.SheetNames.push('merged')
  workbook.Sheets.merged = XLSX.utils.aoa_to_sheet<string>([header, ...merged])
  const data = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer
  return finish([toolFile('sheet-merge.xlsx', XLSX_MIME, Buffer.from(data))], note)
}

/* ============================================================== pdf side */

async function imagesToPdf(args: ToolArgs): Promise<ToolResult> {
  const files = requireFiles(args)
  const buffers = decodeFiles(files)
  if (buffers.reduce((sum, b) => sum + b.length, 0) > 64 * MB) {
    throw new Error(`图片总量超过 ${mb(64 * MB)} 上限`)
  }
  const fit = bool(args, 'fit', false)
  const pdf = await PDFDocument.create()
  const A4: [number, number] = [595.276, 841.89]
  const MARGIN = 36
  for (const buffer of buffers) {
    const kind = sniff(buffer)
    const image =
      kind === 'png'
        ? await pdf.embedPng(buffer)
        : kind === 'jpeg'
          ? await pdf.embedJpg(buffer)
          : null
    if (!image) throw new Error('只支持 PNG / JPEG 图片')
    const pageSize: [number, number] = [image.width, image.height]
    if (fit) {
      const maxW = A4[0] - MARGIN * 2
      const maxH = A4[1] - MARGIN * 2
      const ratio = Math.min(maxW / image.width, maxH / image.height, 1)
      const width = image.width * ratio
      const height = image.height * ratio
      const page = pdf.addPage(A4)
      page.drawImage(image, {
        x: (A4[0] - width) / 2,
        y: (A4[1] - height) / 2,
        width,
        height
      })
      continue
    }
    const page = pdf.addPage(pageSize)
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  }
  const data = Buffer.from(await pdf.save())
  return finish(
    [toolFile('images-to-pdf.pdf', 'application/pdf', data)],
    `共 ${pdf.getPageCount()} 页；按图片原始像素放置，未做重压缩`
  )
}

async function pdfMerge(args: ToolArgs): Promise<ToolResult> {
  const files = requireFiles(args)
  if (files.length < 2) throw new Error('请至少上传两个 PDF')
  const buffers = decodeFiles(files)
  const out = await PDFDocument.create()
  let pages = 0
  for (const buffer of buffers) {
    requirePdf(buffer)
    const source = await PDFDocument.load(buffer, { ignoreEncryption: false })
    const copied = await out.copyPages(source, source.getPageIndices())
    for (const page of copied) out.addPage(page)
    pages += copied.length
  }
  const data = Buffer.from(await out.save())
  return finish([toolFile('pdf-merged.pdf', 'application/pdf', data)], `合并 ${pages} 页`)
}

function parsePageRanges(input: string, pageCount: number): number[] {
  const picked = new Set<number>()
  const spec = input.trim()
  if (!spec) {
    for (let i = 1; i <= pageCount; i++) picked.add(i)
    return [...picked].sort((a, b) => a - b)
  }
  for (const part of spec.split(',')) {
    const chunk = part.trim()
    if (!chunk) continue
    const match = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(chunk)
    if (!match) throw new Error(`页码范围格式不正确：${chunk}`)
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : start
    if (start < 1 || end > pageCount) throw new Error(`页码超出范围（1–${pageCount}）`)
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    for (let i = from; i <= to; i++) picked.add(i)
  }
  if (picked.size === 0) throw new Error('没有选择任何页面')
  return [...picked].sort((a, b) => a - b)
}

async function pdfSplit(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  const mode = str(args, 'mode', 'range') || 'range'
  return withTemp(async () => {
    const source = await PDFDocument.load(buffer)
    const pageCount = source.getPageCount()
    if (pageCount === 0) throw new Error('PDF 没有页面')
    const out: ToolFile[] = []
    if (mode === 'each') {
      const limit = clamp(Math.round(num(args, 'maxPages', 30)), 1, 30)
      const total = Math.min(pageCount, limit)
      for (let i = 0; i < total; i++) {
        const doc = await PDFDocument.create()
        const [page] = await doc.copyPages(source, [i])
        doc.addPage(page)
        const data = Buffer.from(await doc.save())
        out.push(toolFile(`pdf-page-${i + 1}.pdf`, 'application/pdf', data))
      }
      const note =
        pageCount > limit ? `共 ${pageCount} 页，仅导出前 ${limit} 页` : `共 ${pageCount} 页`
      return finish(out, note)
    }
    const picked = parsePageRanges(str(args, 'range'), pageCount)
    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(
      source,
      picked.map((p) => p - 1)
    )
    for (const page of pages) doc.addPage(page)
    const data = Buffer.from(await doc.save())
    out.push(toolFile('pdf-extract.pdf', 'application/pdf', data))
    return finish(out, `提取 ${picked.length} 页：${picked.join(', ')}`)
  })
}

async function pdfEncrypt(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  const password = str(args, 'password')
  const ownerPassword = str(args, 'ownerPassword') || password
  if (!password) throw new Error('请设置打开密码')
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('密码过长（UTF-8 最多 72 字节）')
  if (Buffer.byteLength(ownerPassword, 'utf8') > 72)
    throw new Error('权限密码过长（UTF-8 最多 72 字节）')
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'pdf'))
    const outputPath = join(dir, randomName('out', 'pdf'))
    await writeFile(inputPath, buffer)
    // Passwords travel on stdin as hex (qpdf `--password-mode=hex-bytes` reading
    // its `@-` arguments), so they never appear in argv, logs or error text.
    const stdin = [
      '--password-mode=hex-bytes',
      '--encrypt',
      hexArg(password),
      hexArg(ownerPassword),
      '256',
      '--',
      inputPath,
      outputPath
    ].join('\n')
    const result = await runProc('qpdf', ['@-'], { cwd: dir, stdin })
    requireToolProcess('qpdf', result, 'qpdf')
    if (result.code !== 0) throw new Error(qpdfSafeError())
    const data = await readFile(outputPath)
    return finish(
      [toolFile('pdf-encrypted.pdf', 'application/pdf', data)],
      '已用 AES-256 加密；密码只经 stdin 传给 qpdf，不写入日志'
    )
  })
}

async function pdfDecrypt(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  const password = str(args, 'password')
  if (!password) throw new Error('请输入原 PDF 的打开密码')
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('密码过长（UTF-8 最多 72 字节）')
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'pdf'))
    const outputPath = join(dir, randomName('out', 'pdf'))
    await writeFile(inputPath, buffer)
    const stdin = [
      '--password-mode=hex-bytes',
      `--password=${hexArg(password)}`,
      '--decrypt',
      '--',
      inputPath,
      outputPath
    ].join('\n')
    const result = await runProc('qpdf', ['@-'], { cwd: dir, stdin })
    requireToolProcess('qpdf', result, 'qpdf')
    if (result.code !== 0) throw new Error(qpdfSafeError())
    const data = await readFile(outputPath)
    return finish([toolFile('pdf-decrypted.pdf', 'application/pdf', data)], '已移除打开密码')
  })
}

async function pdfToText(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'pdf'))
    await writeFile(inputPath, buffer)
    const result = await runProc('pdftotext', ['-layout', '-enc', 'UTF-8', inputPath, '-'], {
      cwd: dir
    })
    requireOk(result, 'pdftotext', 'poppler-utils')
    const text = result.stdout
    if (!text.trim()) throw new Error('未提取到文本（可能是扫描件，需要用 OCR）')
    return {
      ok: true,
      text: truncateText(text),
      files: [toolFile('pdf-to-text.txt', 'text/plain;charset=utf-8', Buffer.from(text, 'utf8'))]
    }
  })
}

async function pdfToImages(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  const dpi = clamp(Math.round(num(args, 'dpi', 150)), 72, 300)
  const maxPages = clamp(Math.round(num(args, 'maxPages', 10)), 1, 30)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'pdf'))
    await writeFile(inputPath, buffer)
    const prefix = randomName('page', 'png').replace(/\.png$/, '')
    const result = await runProc(
      'pdftoppm',
      ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), inputPath, prefix],
      { cwd: dir }
    )
    requireOk(result, 'pdftoppm', 'poppler-utils')
    const entries = (await readdir(dir))
      .filter((name) => name.startsWith(`${prefix}-`))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    if (entries.length === 0) throw new Error('未生成任何图片')
    const out: ToolFile[] = []
    let total = 0
    for (const entry of entries) {
      const data = await readFile(join(dir, entry))
      total += data.length
      if (total > 96 * MB) {
        throw new Error(`渲染结果超过 ${mb(96 * MB)} 上限，请调低 DPI 或页数`)
      }
      out.push(toolFile(`pdf-page-${out.length + 1}.png`, 'image/png', data))
    }
    return finish(out, `${entries.length} 页，${dpi} DPI`)
  })
}

async function pdfToHtml(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  requirePdf(buffer)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'pdf'))
    await writeFile(inputPath, buffer)
    const result = await runProc('pdftotext', ['-enc', 'UTF-8', inputPath, '-'], { cwd: dir })
    requireOk(result, 'pdftotext', 'poppler-utils')
    if (!result.stdout.trim()) throw new Error('未提取到文本（可能是扫描件，需要用 OCR）')
    const html = textToSafeHtml(result.stdout)
    return {
      ok: true,
      text: truncateText(html),
      files: [toolFile('pdf-to-html.html', 'text/html;charset=utf-8', Buffer.from(html, 'utf8'))],
      note: '仅按文本块生成段落，不还原原始版式/图片位置'
    }
  })
}

/* ==================================================== office document side */

const DOC_SOURCES = ['docx', 'odt']
const SHEET_SOURCES = ['xlsx']
const SLIDE_SOURCES = ['pptx']
const ALL_SOURCES = [...DOC_SOURCES, ...SHEET_SOURCES, ...SLIDE_SOURCES]
const ALL_TARGETS = ['pdf', 'docx', 'odt', 'html', 'txt', 'xlsx']
/** Source/target combinations LibreOffice cannot export to. */
const BLOCKED_COMBOS: Record<string, string[]> = {
  doc: ['xlsx'],
  docx: ['xlsx'],
  odt: ['xlsx'],
  xls: ['docx', 'odt'],
  xlsx: ['docx', 'odt'],
  ppt: ['docx', 'odt', 'xlsx', 'txt'],
  pptx: ['docx', 'odt', 'xlsx', 'txt']
}
/** Macro-enabled containers are refused: macros can run during conversion. */
const MACRO_CONTAINERS = ['docm', 'xlsm', 'pptm', 'potm', 'dotm']

async function documentConvert(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const sourceExt = extensionOf(file.name)
  if (MACRO_CONTAINERS.includes(sourceExt)) {
    throw new Error(
      `不支持带宏的容器 .${sourceExt}（可能包含可自动执行的宏）；请先在 Office 中另存为 .${sourceExt.slice(0, -1)}`
    )
  }
  if (!ALL_SOURCES.includes(sourceExt)) {
    throw new Error(`不支持的源格式 .${sourceExt || '?'}（支持 ${ALL_SOURCES.join(' / ')}）`)
  }
  await checkOfficePackage(buffer)
  const target = (str(args, 'target', 'pdf') || 'pdf').toLowerCase()
  if (!ALL_TARGETS.includes(target)) {
    throw new Error(`不支持的目标格式 ${target}`)
  }
  if (BLOCKED_COMBOS[sourceExt]?.includes(target)) {
    throw new Error(`LibreOffice 不能把 .${sourceExt} 导出为 .${target}，请换一个目标格式`)
  }
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', sourceExt))
    const outDir = join(dir, 'out')
    const profile = join(dir, 'lo-profile')
    await writeFile(inputPath, buffer)
    await mkdir(outDir, { recursive: true })
    // Hardened isolated profile: macros disabled, link updates disabled.
    await mkdir(join(profile, 'user'), { recursive: true })
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), officeProfile())
    const result = await runProc(
      'soffice',
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--convert-to',
        target,
        '--outdir',
        outDir,
        inputPath
      ],
      {
        cwd: dir,
        env: { HOME: dir, SAL_USE_VCLPLUGIN: 'svp', LC_ALL: 'C.UTF-8' },
        timeoutMs: PROC_TIMEOUT_MS
      }
    )
    requireOk(result, 'soffice', 'libreoffice')
    const entries = (await readdir(outDir)).filter((name) => !name.startsWith('.'))
    const expected = entries.filter((name) => extensionOf(name) === target)
    const chosen = expected[0] ?? entries[0]
    if (!chosen) throw new Error('LibreOffice 没有生成输出文件')
    const data = await readFile(join(outDir, chosen))
    const mime =
      target === 'pdf'
        ? 'application/pdf'
        : target === 'docx'
          ? DOCX_MIME
          : target === 'xlsx'
            ? XLSX_MIME
            : target === 'html'
              ? 'text/html;charset=utf-8'
              : target === 'odt'
                ? 'application/vnd.oasis.opendocument.text'
                : 'text/plain;charset=utf-8'
    return finish(
      [toolFile(`document-convert.${target}`, mime, data)],
      extensionOf(chosen) === target ? undefined : `LibreOffice 实际输出为 .${extensionOf(chosen)}`
    )
  })
}

/* ========================================================== media side */

const AUDIO_FORMATS: Record<string, { codec: string[]; mime: string }> = {
  mp3: { codec: ['libmp3lame', '-b:a', '192k'], mime: 'audio/mpeg' },
  wav: { codec: ['pcm_s16le'], mime: 'audio/wav' },
  ogg: { codec: ['libvorbis', '-b:a', '192k'], mime: 'audio/ogg' }
}

const VIDEO_FORMATS: Record<string, { codec: string[]; mime: string }> = {
  mp4: {
    codec: [
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart'
    ],
    mime: 'video/mp4'
  },
  webm: {
    codec: [
      'libvpx-vp9',
      '-crf',
      '32',
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      '128k'
    ],
    mime: 'video/webm'
  },
  mkv: {
    codec: [
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k'
    ],
    mime: 'video/mkv'
  }
}

async function mediaConvert(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const format = (str(args, 'format', 'mp4') || 'mp4').toLowerCase()
  const isAudio = format in AUDIO_FORMATS
  const isVideo = format in VIDEO_FORMATS
  if (!isAudio && !isVideo) {
    throw new Error(
      `不支持的输出格式 ${format}（可用：${Object.keys(AUDIO_FORMATS).join('/')}、${Object.keys(VIDEO_FORMATS).join('/')}）`
    )
  }
  const scale = str(args, 'scale', 'source')
  const scaleArg =
    !isVideo || scale === 'source'
      ? []
      : ['-vf', `scale=-2:${clamp(Number(scale) || 720, 120, 4320)}`]

  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'src'))
    const outputPath = join(dir, randomName('out', format))
    await writeFile(inputPath, buffer)
    const codec = isAudio ? AUDIO_FORMATS[format].codec : VIDEO_FORMATS[format].codec
    const argv = ['-hide_banner', '-nostdin', '-y', ...FF_PROCESS_WHITELIST, '-i', inputPath]
    if (isAudio) {
      argv.push('-vn', '-map', '0:a?', '-c:a', ...codec)
    } else {
      argv.push('-map', '0:v:0', '-map', '0:a?', '-c:v', ...codec, ...scaleArg)
    }
    argv.push('-f', format, outputPath)
    const result = await runProc('ffmpeg', argv, { cwd: dir })
    requireOk(result, 'ffmpeg', 'ffmpeg')
    const data = await readFile(outputPath)
    if (data.length === 0) throw new Error('ffmpeg 没有生成输出文件')
    return finish(
      [
        toolFile(
          `media-convert.${format}`,
          isAudio ? AUDIO_FORMATS[format].mime : VIDEO_FORMATS[format].mime,
          data
        )
      ],
      isAudio
        ? `已提取音频并转为 ${format}`
        : `已转码为 ${format}${scale === 'source' ? '' : `（高度上限 ${scale}p）`}`
    )
  })
}

async function videoToGif(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const fps = clamp(Math.round(num(args, 'fps', 12)), 1, 30)
  const width = clamp(Math.round(num(args, 'width', 480)), 80, 1280)
  const start = clamp(Math.round(num(args, 'start', 0)), 0, 3600)
  const duration = clamp(Math.round(num(args, 'duration', 0)), 0, 300)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'src'))
    const outputPath = join(dir, randomName('out', 'gif'))
    await writeFile(inputPath, buffer)
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
    const argv = ['-hide_banner', '-nostdin', '-y', ...FF_PROCESS_WHITELIST]
    if (start > 0) argv.push('-ss', String(start))
    argv.push('-i', inputPath)
    if (duration > 0) argv.push('-t', String(duration))
    argv.push('-filter_complex', filter, '-loop', '0', '-an', outputPath)
    const result = await runProc('ffmpeg', argv, { cwd: dir })
    requireOk(result, 'ffmpeg', 'ffmpeg')
    const data = await readFile(outputPath)
    if (data.length === 0) throw new Error('ffmpeg 没有生成 GIF')
    return finish(
      [toolFile('video-to-gif.gif', 'image/gif', data)],
      `${fps} FPS、宽 ${width}px${start > 0 ? `、从 ${start}s 开始` : ''}${duration > 0 ? `、时长 ${duration}s` : ''}`
    )
  })
}

async function gifFrames(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const maxFrames = clamp(Math.round(num(args, 'maxFrames', 20)), 1, 120)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'gif'))
    await writeFile(inputPath, buffer)
    const base = randomName('frame', 'png').replace(/\.png$/, '')
    const pattern = join(dir, `${base}-%04d.png`)
    const result = await runProc(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        ...FF_PROCESS_WHITELIST,
        '-i',
        inputPath,
        '-vsync',
        '0',
        '-frames:v',
        String(maxFrames),
        pattern
      ],
      { cwd: dir }
    )
    requireOk(result, 'ffmpeg', 'ffmpeg')
    const entries = (await readdir(dir))
      .filter((name) => name.startsWith(`${base}-`))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    if (entries.length === 0) throw new Error('未能从 GIF 中解出帧')
    const out: ToolFile[] = []
    let index = 1
    for (const entry of entries) {
      const data = await readFile(join(dir, entry))
      out.push(toolFile(`gif-frame-${index++}.png`, 'image/png', data))
      if (out.length >= 60) break
    }
    return finish(out, `导出 ${out.length} 帧为 PNG`)
  })
}

async function gifCompress(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const width = clamp(Math.round(num(args, 'width', 480)), 80, 1280)
  const fps = clamp(Math.round(num(args, 'fps', 12)), 1, 30)
  const colors = clamp(Math.round(num(args, 'colors', 128)), 8, 256)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'gif'))
    const outputPath = join(dir, randomName('out', 'gif'))
    await writeFile(inputPath, buffer)
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${colors}:stats_mode=single[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`
    const result = await runProc(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        ...FF_PROCESS_WHITELIST,
        '-i',
        inputPath,
        '-filter_complex',
        filter,
        '-loop',
        '0',
        outputPath
      ],
      { cwd: dir }
    )
    requireOk(result, 'ffmpeg', 'ffmpeg')
    const data = await readFile(outputPath)
    if (data.length === 0) throw new Error('ffmpeg 没有生成 GIF')
    const before = buffer.length
    const after = data.length
    const ratio = before > 0 ? Math.round((1 - after / before) * 100) : 0
    const note =
      after < before
        ? `重新编码完成：${mb(before)} → ${mb(after)}（减少 ${ratio}%）`
        : `已重新编码（宽 ${width}px、${fps}FPS、${colors} 色），但体积未减小：${mb(before)} → ${mb(after)}。可再调低宽度/帧率/颜色数`
    return finish([toolFile('gif-compress.gif', 'image/gif', data)], note)
  })
}

async function mediaInfo(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'src'))
    await writeFile(inputPath, buffer)
    const result = await runProc(
      'ffprobe',
      [
        '-v',
        'quiet',
        ...FF_PROCESS_WHITELIST,
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath
      ],
      { cwd: dir }
    )
    requireOk(result, 'ffprobe', 'ffmpeg')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      throw new Error('ffprobe 输出解析失败')
    }
    const format = (parsed.format ?? {}) as Record<string, unknown>
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const lines: string[] = []
    const formatName = typeof format.format_name === 'string' ? format.format_name : '?'
    const duration = typeof format.duration === 'string' ? Number(format.duration) : NaN
    const bitRate = typeof format.bit_rate === 'string' ? Number(format.bit_rate) : NaN
    lines.push(`容器：${formatName}`)
    if (Number.isFinite(duration)) lines.push(`时长：${duration.toFixed(2)} 秒`)
    if (Number.isFinite(bitRate) && bitRate > 0) {
      lines.push(`码率：${Math.round(bitRate / 1000)} kbps`)
    }
    for (const stream of streams) {
      if (!stream || typeof stream !== 'object') continue
      const s = stream as Record<string, unknown>
      const type = typeof s.codec_type === 'string' ? s.codec_type : 'unknown'
      const codec = typeof s.codec_name === 'string' ? s.codec_name : '?'
      if (type === 'video') {
        lines.push(
          `视频：${codec} ${String(s.width)}x${String(s.height)}${s.r_frame_rate ? ` @ ${String(s.r_frame_rate)}fps` : ''}`
        )
      } else if (type === 'audio') {
        lines.push(
          `音频：${codec} ${String(s.sample_rate ?? '?')}Hz ${String(s.channels ?? '?')}ch`
        )
      } else {
        lines.push(`${type}：${codec}`)
      }
    }
    return {
      ok: true,
      text: lines.join('\n'),
      data: parsed,
      files: [
        toolFile(
          'media-info.json',
          'application/json',
          Buffer.from(JSON.stringify(parsed, null, 2), 'utf8')
        )
      ]
    }
  })
}

async function videoRemoveWatermark(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const x = Math.max(0, Math.round(num(args, 'x', 10)))
  const y = Math.max(0, Math.round(num(args, 'y', 10)))
  const w = Math.round(num(args, 'w', 120))
  const h = Math.round(num(args, 'h', 40))
  if (w < 1 || h < 1) throw new Error('水印区域宽高必须大于 0')
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'src'))
    await writeFile(inputPath, buffer)
    const probe = await runProc(
      'ffprobe',
      [
        '-v',
        'error',
        ...FF_PROCESS_WHITELIST,
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0:s=x',
        inputPath
      ],
      { cwd: dir }
    )
    requireOk(probe, 'ffprobe', 'ffmpeg')
    const [videoWidth, videoHeight] = probe.stdout.trim().split('x').map(Number)
    if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight)) {
      throw new Error('无法读取视频尺寸，请确认是有效的视频文件')
    }
    if (x + w > videoWidth || y + h > videoHeight) {
      throw new Error(`水印区域超出画面范围（${videoWidth}x${videoHeight}）`)
    }
    const outputPath = join(dir, randomName('out', 'mp4'))
    const result = await runProc(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        ...FF_PROCESS_WHITELIST,
        '-i',
        inputPath,
        '-vf',
        `delogo=x=${x}:y=${y}:w=${w}:h=${h}`,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        outputPath
      ],
      { cwd: dir }
    )
    requireOk(result, 'ffmpeg', 'ffmpeg')
    const data = await readFile(outputPath)
    if (data.length === 0) throw new Error('ffmpeg 没有生成输出文件')
    return finish(
      [toolFile('video-no-watermark.mp4', 'video/mp4', data)],
      `已覆盖区域 x=${x} y=${y} w=${w} h=${h}（画面 ${videoWidth}x${videoHeight}）。这是 delogo 的邻域像素填补，非 AI 修复：面积过大或背景复杂时会留下模糊块，建议只遮盖水印本身的最小区域`
    )
  })
}

async function ocr(args: ToolArgs): Promise<ToolResult> {
  const file = requireFile(args)
  const buffer = decodeFile(file)
  const kind = sniff(buffer)
  const ext = extensionOf(file.name)
  const allowed = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp']
  if (kind !== 'png' && kind !== 'jpeg' && !allowed.includes(ext)) {
    throw new Error('OCR 仅支持 PNG / JPEG / BMP / TIFF 图片')
  }
  const lang = str(args, 'lang', 'eng') || 'eng'
  if (!/^[a-z]{2,8}(_[a-z]{2,8})?(\+[a-z]{2,8}(_[a-z]{2,8})?)*$/i.test(lang)) {
    throw new Error('语言参数格式不正确')
  }
  return withTemp(async (dir) => {
    const inputPath = join(dir, randomName('in', 'img'))
    const outputBase = randomName('ocr', 'txt')
    await writeFile(inputPath, buffer)
    const result = await runProc('tesseract', [inputPath, outputBase, '-l', lang, '--psm', '3'], {
      cwd: dir,
      env: { OMP_THREAD_LIMIT: '4' }
    })
    if (result.missing) {
      throw new Error(
        `未找到 tesseract，请先安装该依赖（语言包：tesseract-ocr-${lang.split('+')[0]}）`
      )
    }
    if (result.timedOut) throw new Error('tesseract 执行超时（超过 2 分钟）')
    const missingLanguage = /failed loading language|error opening data file| tessdata /i.test(
      result.stderr
    )
    if (result.code !== 0 && missingLanguage) {
      const langs = await runProc('tesseract', ['--list-langs'], { cwd: dir })
      const installed = langs.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line !== 'List of available languages (1):')
        .join(', ')
      throw new Error(
        `缺少语言包 ${lang}（已安装：${installed || '未知'}）。请安装如 tesseract-ocr-${lang.split('+')[0]} 后重试`
      )
    }
    requireOk(result, 'tesseract', 'tesseract')
    const text = await readFile(join(dir, `${outputBase}.txt`), 'utf8')
    if (!text.trim()) throw new Error('未识别到文字，请确认图片清晰且包含文本')
    return {
      ok: true,
      text: truncateText(text),
      files: [toolFile('ocr.txt', 'text/plain;charset=utf-8', Buffer.from(text, 'utf8'))],
      note: `识别语言：${lang}；结果可能有误差，请校对`
    }
  })
}

/* ============================================================== dispatch */

type Handler = (args: ToolArgs) => Promise<ToolResult>

const HANDLERS: Record<string, Handler> = {
  'word-to-text': wordToText,
  'word-to-html': wordToHtml,
  'text-to-word': textToWord,
  'word-to-markdown': wordToMarkdown,
  'html-to-word': htmlToWord,
  'swagger-to-word': swaggerToWord,
  'sheet-convert': sheetConvert,
  'sheet-merge': sheetMerge,
  'images-to-pdf': imagesToPdf,
  'pdf-merge': pdfMerge,
  'pdf-split': pdfSplit,
  'pdf-encrypt': pdfEncrypt,
  'pdf-decrypt': pdfDecrypt,
  'pdf-to-text': pdfToText,
  'pdf-to-images': pdfToImages,
  'pdf-to-html': pdfToHtml,
  'document-convert': documentConvert,
  'media-convert': mediaConvert,
  'video-to-gif': videoToGif,
  'gif-frames': gifFrames,
  'gif-compress': gifCompress,
  'media-info': mediaInfo,
  'video-remove-watermark': videoRemoveWatermark,
  ocr: ocr
}

export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  const handler = HANDLERS[id]
  if (!handler) return { ok: false, error: `未知工具：${id}` }
  try {
    return await handler(args ?? {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: sanitizeMessage(message) }
  }
}
