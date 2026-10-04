/**
 * SKILL.md 解析：开头的 YAML frontmatter（`---` 包围）+ Markdown 正文。
 *
 * 只实现 skill 真正用到的 YAML 子集——`key: value`、单/双引号值、`>` 折叠与
 * `|` 字面多行块标量、`#` 注释行、未知键忽略——不引入 YAML 依赖。
 * 解析出 `name` 才算一个可用 skill，否则返回 null，由调用方跳过该目录。
 */

export interface SkillMd {
  /** frontmatter 的 name（模型用它调用 skill_load） */
  name: string
  /** frontmatter 的 description（进系统提示词的那一行） */
  description: string
  /** 正文（frontmatter 与首尾空白已去掉） */
  body: string
}

/** 解析 SKILL.md 原文；没有 frontmatter 或缺 name 时返回 null */
export function parseSkillMd(raw: string): SkillMd | null {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)

  // 起始处允许空行，之后必须是开界的 `---`
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() !== '---') return null
  i++

  const fields = new Map<string, string>()
  let closed = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') {
      closed = true
      i++
      break
    }
    if (/^\s*#/.test(line)) continue
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    const value = m[2].trim()
    // `>` / `|` 块标量（可带 `+` / `-` 收尾标记）：后续缩进行都属于它
    if (/^[>|][+-]?$/.test(value)) {
      const block = readBlock(lines, i + 1, value.startsWith('>'))
      fields.set(key, block.text)
      i = block.next - 1 // for 循环会再 ++
      continue
    }
    fields.set(key, unquote(value))
  }
  if (!closed) return null

  const name = (fields.get('name') ?? '').trim()
  if (!name) return null
  return {
    name,
    description: (fields.get('description') ?? '').trim(),
    body: lines.slice(i).join('\n').trim()
  }
}

/** 读 `>` / `|` 块标量：收集缩进行（空白行算内容，尾部空白行丢弃），停在第一个顶格行 */
function readBlock(lines: string[], from: number, folded: boolean): { text: string; next: number } {
  const collected: string[] = []
  let indent = -1
  let i = from
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      collected.push('')
      continue
    }
    const lead = /^[ \t]*/.exec(line)![0].length
    if (lead === 0) break
    if (indent < 0) indent = lead
    if (lead < indent) break
    collected.push(line.slice(indent))
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()

  let text: string
  if (!folded) {
    text = collected.join('\n')
  } else {
    // 折叠：段内换行变空格，空白行分段
    const paras: string[] = []
    let cur: string[] = []
    for (const line of collected) {
      if (line === '') {
        paras.push(cur.join(' '))
        cur = []
      } else {
        cur.push(line)
      }
    }
    paras.push(cur.join(' '))
    text = paras.join('\n').trim()
  }
  return { text, next: i }
}

/** 去掉 `key: value` 值上的外层引号（双引号认 `\"` / `\\`，单引号认 `''`） */
function unquote(value: string): string {
  if (value.length < 2) return value
  const q = value[0]
  if ((q === '"' || q === "'") && value.endsWith(q)) {
    const inner = value.slice(1, -1)
    return q === "'" ? inner.split("''").join("'") : inner.replace(/\\(["\\])/g, '$1')
  }
  return value
}
