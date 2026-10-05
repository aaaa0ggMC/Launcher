/**
 * 内置 documents 插件（PLAN 第三节「输入预处理 Slot」）：本会话附件里的长文档按需检索。
 *
 * 超过内联上限（200KB）的文本附件、PDF 不再整篇塞进上下文；模型看到附件的 id、大小与开头摘要，
 * 需要时用 `docs_search`（BM25 检索，返回命中段落与行号）/ `docs_read`（按行读）取内容。
 *
 * - 只读**本会话**的附件（用户自己加进来的），所以不需要 `system.exec` 授权（与 read_file 不同）；
 * - 文本附件直接读；PDF 用本机 `pdftotext`（poppler）转文本，没有就明确报错；
 * - 解析结果按「资产路径 + 大小」缓存（最多 8 份），同一会话反复检索不重复解析；
 * - 工具定义与配置无关、稳定（提示词缓存）。
 */
import { execFile } from 'node:child_process'
import { getSessionMessages } from '../../services/db'
import { readAssetData, resolveAssetLocalPath, isTextMime } from '../../services/assets'
import type { MessageAttachment } from '../../types'
import type { PluginTool, ToolRunContext, YayaPlugin } from '../../services/plugins/types'
import { buildIndex, outline, readLines, searchIndex, type DocIndex } from './search'

const MAX_DOC_BYTES = 25 * 1024 * 1024
const CACHE_SIZE = 8
const cache = new Map<string, DocIndex>()

function remember(key: string, index: DocIndex): DocIndex {
  cache.delete(key)
  cache.set(key, index)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return index
}

/** 本会话出现过的全部附件（按 id 去重，保持先后顺序） */
export function sessionAttachments(sessionId: string): MessageAttachment[] {
  const seen = new Map<string, MessageAttachment>()
  for (const m of getSessionMessages(sessionId)) {
    if (m.role !== 'user') continue
    for (const a of m.attachments ?? []) if (!seen.has(a.id)) seen.set(a.id, a)
  }
  return [...seen.values()]
}

function searchable(a: MessageAttachment): boolean {
  return isTextMime(a.mimeType) || a.mimeType === 'application/pdf'
}

/** 按 id / 文件名找附件（模型可能给名字） */
function findDoc(sessionId: string, ref: unknown): MessageAttachment | null {
  const key = String(ref ?? '').trim()
  if (!key) return null
  const docs = sessionAttachments(sessionId)
  return (
    docs.find((d) => d.id === key) ??
    docs.find((d) => d.name === key) ??
    docs.find((d) => d.name.toLowerCase() === key.toLowerCase()) ??
    null
  )
}

function pdfToText(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', path, '-'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, signal },
      (err, stdout) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
          reject(
            new Error(
              missing
                ? 'PDF text extraction needs `pdftotext` (poppler-utils) on the host; it is not installed.'
                : `pdftotext failed: ${err.message}`
            )
          )
        } else resolve(stdout)
      }
    )
  })
}

async function loadIndex(doc: MessageAttachment, signal: AbortSignal): Promise<DocIndex> {
  const key = `${doc.assetPath}:${doc.size}`
  const hit = cache.get(key)
  if (hit) return remember(key, hit)
  if (doc.size > MAX_DOC_BYTES) throw new Error(`document too large (${doc.size} bytes)`)
  let text: string
  if (doc.mimeType === 'application/pdf') {
    const local = resolveAssetLocalPath(doc.assetPath)
    if (!local) throw new Error('invalid asset path')
    text = await pdfToText(local, signal)
  } else if (isTextMime(doc.mimeType)) {
    const data = await readAssetData(doc.assetPath)
    if (!data) throw new Error('document file is missing')
    text = data.toString('utf8')
  } else {
    throw new Error(`unsupported document type: ${doc.mimeType}`)
  }
  return remember(key, buildIndex(text))
}

function fail(text: string): unknown {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

function clamp(n: unknown, min: number, max: number, dflt: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return dflt
  return Math.min(max, Math.max(min, Math.floor(v)))
}

const tools: PluginTool[] = [
  {
    name: 'list',
    description:
      'List the documents the user attached to this conversation (id, name, type, size, line count, short outline). Use the id with docs_search / docs_read.',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx: ToolRunContext) => {
      const docs = sessionAttachments(ctx.sessionId).filter(searchable)
      const out: Array<Record<string, unknown>> = []
      for (const d of docs) {
        const item: Record<string, unknown> = {
          id: d.id,
          name: d.name,
          mime: d.mimeType,
          size: d.size
        }
        try {
          const idx = await loadIndex(d, ctx.signal)
          item.lines = idx.lines.length
          item.outline = outline(idx.lines.slice(0, 400).join('\n'))
        } catch (e) {
          item.error = e instanceof Error ? e.message : String(e)
        }
        out.push(item)
      }
      return { documents: out }
    }
  },
  {
    name: 'search',
    description:
      'Search inside the documents attached to this conversation (keyword / BM25 ranking, works for Chinese and English). Returns the best matching passages with line numbers; read more around a hit with docs_read.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Keywords to look for' },
        document: {
          type: 'string',
          description: 'Document id or file name; omit to search all attached documents'
        },
        max_results: {
          type: 'number',
          description: 'Number of passages to return (1-10, default 5)'
        }
      }
    },
    run: async (args, ctx) => {
      const query = String(args.query ?? '').trim()
      if (!query) return fail('query is empty')
      const limit = clamp(args.max_results, 1, 10, 5)
      let docs: MessageAttachment[]
      if (args.document) {
        const d = findDoc(ctx.sessionId, args.document)
        if (!d)
          return fail(`no attached document matches "${String(args.document)}"; call docs_list`)
        docs = [d]
      } else {
        docs = sessionAttachments(ctx.sessionId).filter(searchable)
        if (!docs.length) return fail('no searchable documents are attached to this conversation')
      }
      const hits: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const d of docs) {
        ctx.signal.throwIfAborted()
        try {
          const idx = await loadIndex(d, ctx.signal)
          for (const h of searchIndex(idx, query, limit))
            hits.push({
              document: d.id,
              name: d.name,
              lines: `${h.startLine}-${h.endLine}`,
              score: h.score,
              text: h.text
            })
        } catch (e) {
          errors.push(`${d.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      hits.sort((a, b) => Number(b.score) - Number(a.score))
      const top = hits.slice(0, limit)
      return {
        query,
        results: top,
        ...(top.length ? {} : { note: 'no passage matched; try other keywords' }),
        ...(errors.length ? { errors } : {})
      }
    }
  },
  {
    name: 'read',
    description:
      'Read a range of lines (1-based) from a document attached to this conversation. Use after docs_search to see more context around a hit.',
    parameters: {
      type: 'object',
      required: ['document'],
      properties: {
        document: { type: 'string', description: 'Document id or file name' },
        start_line: { type: 'number', description: 'First line to read, 1-based (default 1)' },
        max_lines: { type: 'number', description: 'How many lines to read (1-500, default 200)' }
      }
    },
    run: async (args, ctx) => {
      const d = findDoc(ctx.sessionId, args.document)
      if (!d) return fail(`no attached document matches "${String(args.document)}"; call docs_list`)
      try {
        const idx = await loadIndex(d, ctx.signal)
        const r = readLines(
          idx,
          clamp(args.start_line, 1, 1e9, 1),
          clamp(args.max_lines, 1, 500, 200)
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `${d.name} — lines ${r.start}-${r.end} of ${r.total}\n${r.text}`
            }
          ],
          display: { document: d.id, name: d.name, start: r.start, end: r.end, total: r.total }
        }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    }
  }
]

const DOCS = `# 长文档检索

超过 200KB 的文本附件与 PDF 不会整篇发给模型。模型只看到附件的 id、大小与开头摘要，
需要时调用：

| 工具 | 作用 |
| --- | --- |
| \`docs_list\` | 列出本会话的文档附件（id、行数、开头摘要） |
| \`docs_search\` | 按关键词检索（BM25，中英文都可），返回命中段落与行号 |
| \`docs_read\` | 按行读取一段（每次最多 500 行） |

- 只能读**本会话**里你自己添加的附件，所以不会弹出文件访问授权；
- PDF 需要宿主装有 \`pdftotext\`（poppler-utils），没有时工具会明确报错；
- 关掉这个插件后，大文件仍会以路径形式告诉模型，模型可以用 \`read_file\`（需要授权）读取。
`

const plugin: YayaPlugin = {
  id: 'documents',
  kind: 'builtin',
  label: '长文档检索',
  labelKey: 'yaya.plugin.documents.label',
  description: '大附件不进上下文，模型按需检索 / 分段读取',
  descriptionKey: 'yaya.plugin.documents.desc',
  icon: 'mdi-file-search-outline',
  namespace: 'docs',
  defaultEnabled: true,
  docs: DOCS,
  tools: () => tools
}

export default plugin
