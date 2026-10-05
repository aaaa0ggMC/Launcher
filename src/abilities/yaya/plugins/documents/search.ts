/**
 * 长文档检索（纯函数，无 I/O）：按行切块 + BM25 打分。
 *
 * - 分词：ASCII 单词（小写，≥ 2 字符）+ 中日韩字符二元组（单字查询退回单字），不依赖分词库；
 * - 切块：按行滑动窗口（默认 40 行一块、重叠 10 行），超长单行（压缩过的 JSON 等）按字数切；
 * - 命中块的文本截在第一个命中词附近，行号是原文行号（1 起），可直接交给 `read` 按行读取。
 */

export interface DocChunk {
  /** 1 起的原文行号（含） */
  startLine: number
  endLine: number
  text: string
  tf: Map<string, number>
  length: number
}

export interface DocIndex {
  lines: string[]
  chunks: DocChunk[]
  df: Map<string, number>
  avgLength: number
}

export interface DocHit {
  startLine: number
  endLine: number
  score: number
  text: string
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/

export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0])
  // 连续的中日韩字符段 → 二元组；只有一个字时用单字
  for (const m of lower.matchAll(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g)) {
    const run = [...m[0]]
    if (run.length === 1) out.push(run[0])
    for (let i = 0; i + 1 < run.length; i++) out.push(run[i] + run[i + 1])
  }
  return out
}

/** 查询分词：单个中文字也要能搜到 */
function queryTokens(query: string): string[] {
  const toks = tokenize(query)
  if (toks.length) return [...new Set(toks)]
  return [...new Set([...query.toLowerCase()].filter((c) => CJK.test(c)))]
}

const MAX_LINE = 400

export function buildIndex(text: string, windowLines = 40, overlap = 10): DocIndex {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: DocChunk[] = []
  const step = Math.max(1, windowLines - overlap)
  const addChunk = (start: number, end: number, body: string): void => {
    const toks = tokenize(body)
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    chunks.push({ startLine: start + 1, endLine: end + 1, text: body, tf, length: toks.length })
  }
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines) - 1
    const slice = lines.slice(start, end + 1)
    if (slice.length === 1 && slice[0].length > MAX_LINE * 4) {
      // 一整行就很长：按字数再切
      for (let i = 0; i < slice[0].length; i += MAX_LINE * 4)
        addChunk(start, start, slice[0].slice(i, i + MAX_LINE * 4))
    } else {
      addChunk(start, end, slice.join('\n'))
    }
    if (end >= lines.length - 1) break
  }
  const df = new Map<string, number>()
  let total = 0
  for (const c of chunks) {
    total += c.length
    for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { lines, chunks, df, avgLength: chunks.length ? total / chunks.length : 0 }
}

/** 截出命中词附近的一段（不超过 max 字） */
function excerpt(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  const start = Math.max(0, Math.min(text.length - max, at - Math.floor(max / 4)))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`
}

export function searchIndex(index: DocIndex, query: string, limit = 5, maxChars = 1500): DocHit[] {
  const terms = queryTokens(query)
  if (!terms.length || !index.chunks.length) return []
  const n = index.chunks.length
  const k1 = 1.2
  const b = 0.75
  const scored: DocHit[] = []
  for (const c of index.chunks) {
    let score = 0
    for (const t of terms) {
      let f = c.tf.get(t) ?? 0
      // 单字查询：分词里没有单字，退回子串计数
      if (!f && [...t].length === 1 && CJK.test(t)) f = c.text.split(t).length - 1
      if (!f) continue
      const df = index.df.get(t) ?? 1
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      const norm = 1 - b + (b * c.length) / (index.avgLength || 1)
      score += (idf * f * (k1 + 1)) / (f + k1 * norm)
    }
    if (score > 0)
      scored.push({
        startLine: c.startLine,
        endLine: c.endLine,
        score: Math.round(score * 1000) / 1000,
        text: excerpt(c.text, terms, maxChars)
      })
  }
  scored.sort((a, b2) => b2.score - a.score || a.startLine - b2.startLine)
  // 去掉与更高分块大面积重叠的块（滑动窗口有重叠）
  const out: DocHit[] = []
  for (const h of scored) {
    if (out.some((o) => h.startLine <= o.endLine && o.startLine <= h.endLine)) continue
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}

/** 按行读取：1 起，返回带行号的文本 */
export function readLines(
  index: DocIndex,
  startLine: number,
  maxLines: number
): { start: number; end: number; total: number; text: string } {
  const total = index.lines.length
  const start = Math.min(Math.max(1, Math.floor(startLine) || 1), Math.max(1, total))
  const end = Math.min(total, start + Math.max(1, Math.floor(maxLines)) - 1)
  const width = String(end).length
  const text = index.lines
    .slice(start - 1, end)
    .map(
      (l, i) =>
        `${String(start + i).padStart(width)}│${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`
    )
    .join('\n')
  return { start, end, total, text }
}

/** 开头的一小段：Markdown 标题优先，否则前几行非空文本（给模型的「摘要」） */
export function outline(text: string, maxChars = 300): string {
  const lines = text.split(/\r?\n/)
  const heads = lines.filter((l) => /^#{1,3}\s+\S/.test(l)).slice(0, 12)
  const src = heads.length >= 3 ? heads : lines.filter((l) => l.trim()).slice(0, 8)
  const joined = src.map((l) => l.trim()).join(' / ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}
