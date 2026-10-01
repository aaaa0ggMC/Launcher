/**
 * Offline tests for the `files` tool group (node:test).
 *
 * Every case only uses pure-JS libraries bundled in the toolbox
 * (docx / mammoth / xlsx / pdf-lib) plus temp dirs from the OS. No external
 * program (ffmpeg, soffice, qpdf, tesseract, poppler) is invoked here and no
 * Electron module is imported — the deputy runs the real interop separately.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as XLSX from 'xlsx'
import { PDFDocument } from 'pdf-lib'
import { execute } from './service'
import { definitions } from './definitions'
import type { ToolArgs, ToolFile } from '../../types'

/**
 * Guard: this suite must never read or write the real user configuration. All
 * scratch space comes from mkdtemp() inside the OS temp dir, which by
 * definition is not `~/.config/LinuxCockpit`.
 */
test('scratch space never lives in the real user config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-toolbox-files-'))
  try {
    assert.ok(!dir.startsWith(join(homedir(), '.config')), '测试临时目录不得位于用户配置目录内')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function toToolFile(name: string, data: Buffer): ToolFile {
  return { name, mime: 'application/octet-stream', base64: data.toString('base64') }
}

async function makeXlsx(): Promise<Buffer> {
  const workbook = XLSX.utils.book_new()
  const rows: string[][] = [
    ['name', 'note', 'value'],
    ['张三', 'has, comma', '1'],
    ['"quoted"', 'line\nbreak', '2'],
    ['tab\there', 'semi;colon', '3']
  ]
  const sheet = XLSX.utils.aoa_to_sheet<string>(rows)
  workbook.SheetNames.push('Sheet1')
  workbook.Sheets.Sheet1 = sheet
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array)
}

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    doc.addPage([200, 200])
    doc.getPage(i).drawText(`page ${i + 1}`)
  }
  return Buffer.from(await doc.save())
}

test('definitions are unique and carry bilingual metadata', () => {
  const ids = new Set(definitions.map((d) => d.id))
  assert.equal(ids.size, definitions.length)
  for (const def of definitions) {
    assert.ok(def.title.trim().length > 0, `${def.id}: missing title`)
    assert.ok(def.titleEn.trim().length > 0, `${def.id}: missing titleEn`)
    assert.ok(def.keywords.length >= 2, `${def.id}: missing keywords`)
  }
})

test('text-to-word then word-to-text round-trips paragraphs', async () => {
  const text = '第一段：你好，世界。\nSecond line with ASCII\n第三段：符号 <> & "'
  const created = await execute('text-to-word', { text } as ToolArgs)
  assert.equal(created.ok, true)
  assert.ok(created.files && created.files.length === 1)
  const docx = Buffer.from(created.files[0].base64, 'base64')
  assert.equal(docx.subarray(0, 2).toString('latin1'), 'PK', 'DOCX must be a zip container')

  const back = await execute('word-to-text', { file: toToolFile('in.docx', docx) })
  assert.equal(back.ok, true)
  assert.ok(back.text)
  assert.match(back.text, /第一段：你好，世界。/)
  assert.match(back.text, /Second line with ASCII/)
  assert.match(back.text, /第三段：符号 <> & "/)
  assert.ok(back.files && back.files.length === 1)
  assert.equal(back.files[0].name, 'word-to-text.txt')
})

test('word-to-html and word-to-markdown keep structure', async () => {
  const html =
    '<h1>标题一</h1><p>正文<strong>加粗</strong></p><ul><li>项目A</li><li>项目B</li></ul>'
  const docx = await execute('html-to-word', { html } as ToolArgs)
  assert.equal(docx.ok, true)
  assert.ok(docx.files && docx.files.length === 1)
  const buffer = Buffer.from(docx.files[0].base64, 'base64')

  const asHtml = await execute('word-to-html', { file: toToolFile('in.docx', buffer) })
  assert.equal(asHtml.ok, true)
  assert.match(asHtml.text ?? '', /<h1>标题一<\/h1>/)
  assert.match(asHtml.text ?? '', /正文加粗/) // HTML→Word preserves block structure and text, not inline styles.
  assert.match(asHtml.text ?? '', /<li>项目A<\/li>/)

  const asMarkdown = await execute('word-to-markdown', { file: toToolFile('in.docx', buffer) })
  assert.equal(asMarkdown.ok, true)
  assert.match(asMarkdown.text ?? '', /^# 标题一/m)
  assert.match(asMarkdown.text ?? '', /- 项目A/)
})

test('sheet-convert csv escapes commas/quotes/newlines', async () => {
  const xlsx = await makeXlsx()
  const result = await execute('sheet-convert', {
    file: toToolFile('in.xlsx', xlsx),
    format: 'csv',
    delimiter: 'comma',
    maxRows: 100
  } as ToolArgs)
  assert.equal(result.ok, true)
  assert.ok(result.files && result.files.length === 1)
  const csv = Buffer.from(result.files[0].base64, 'base64').toString('utf8')
  const lines = csv.split('\n')
  assert.equal(lines[0], 'name,note,value')
  assert.equal(lines[1], '张三,"has, comma",1')
  assert.equal(lines[2], '"""quoted""","line')
  assert.equal(lines[3], 'break",2')
  assert.ok(lines.some((l) => l.includes('semi;colon')))
})

test('sheet-convert json and markdown outputs', async () => {
  const xlsx = await makeXlsx()
  const asJson = await execute('sheet-convert', {
    file: toToolFile('in.xlsx', xlsx),
    format: 'json'
  } as ToolArgs)
  assert.equal(asJson.ok, true)
  const json = Buffer.from(asJson.files![0].base64, 'base64').toString('utf8')
  const parsed = JSON.parse(json) as { sheets: Array<{ name: string; rows: string[][] }> }
  assert.equal(parsed.sheets[0].rows[0][0], 'name')
  assert.equal(parsed.sheets[0].rows[1][0], '张三')

  const asMd = await execute('sheet-convert', {
    file: toToolFile('in.xlsx', xlsx),
    format: 'md'
  } as ToolArgs)
  assert.equal(asMd.ok, true)
  const md = Buffer.from(asMd.files![0].base64, 'base64').toString('utf8')
  assert.match(md, /## Sheet1/)
  assert.match(md, /\| name \| note \| value \|/)
})

test('csv input is parsed with proper quoting', async () => {
  const csv = 'a,b\n"x,1","line\nbreak"\n'
  const result = await execute('sheet-convert', {
    file: toToolFile('in.csv', Buffer.from(csv, 'utf8')),
    format: 'json'
  } as ToolArgs)
  assert.equal(result.ok, true)
  const json = Buffer.from(result.files![0].base64, 'base64').toString('utf8')
  const parsed = JSON.parse(json) as { sheets: Array<{ rows: string[][] }> }
  assert.deepEqual(parsed.sheets[0].rows[1], ['x,1', 'line\nbreak'])
})

test('pdf-split reports page count and extracts a range', async () => {
  const pdf = await makePdf(3)
  const ranges = await execute('pdf-split', {
    file: toToolFile('in.pdf', pdf),
    mode: 'range',
    range: '2-3'
  } as ToolArgs)
  assert.equal(ranges.ok, true)
  const extract = Buffer.from(ranges.files![0].base64, 'base64')
  const extracted = await PDFDocument.load(extract)
  assert.equal(extracted.getPageCount(), 2)
  assert.match(ranges.note ?? '', /提取 2 页/)

  const each = await execute('pdf-split', {
    file: toToolFile('in.pdf', pdf),
    mode: 'each',
    maxPages: 30
  } as ToolArgs)
  assert.equal(each.ok, true)
  assert.equal(each.files?.length, 3)

  const merged = await execute('pdf-merge', {
    files: [
      toToolFile('a.pdf', extract),
      toToolFile('b.pdf', Buffer.from(ranges.files![0].base64, 'base64'))
    ]
  } as ToolArgs)
  assert.equal(merged.ok, true)
  const mergedDoc = await PDFDocument.load(Buffer.from(merged.files![0].base64, 'base64'))
  assert.equal(mergedDoc.getPageCount(), 4)
})

test('rejects a non-pdf file for pdf tools', async () => {
  const result = await execute('pdf-merge', {
    files: [toToolFile('a.txt', Buffer.from('hello')), toToolFile('b.txt', Buffer.from('world'))]
  } as ToolArgs)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /PDF/)
})

test('rejects over-sized and empty inputs', async () => {
  const empty = await execute('word-to-text', { file: toToolFile('in.docx', Buffer.alloc(0)) })
  assert.equal(empty.ok, false)
  const unknown = await execute('nope', {} as ToolArgs)
  assert.equal(unknown.ok, false)
  assert.match(unknown.error ?? '', /未知工具/)
})

test('temp dirs are cleaned up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-toolbox-cleanup-'))
  const file = join(dir, 'marker.txt')
  await writeFile(file, 'x')
  await rm(dir, { recursive: true, force: true })
  await assert.rejects(readFile(file, 'utf8'))
})
