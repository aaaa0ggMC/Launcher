import type { CommandSpec } from '../../main/process/commands/types'
import type { HelpMessageResult, HelpNode, HelpTreeResult } from '../../shared/types'

/**
 * 帮助系统后端 — 外壳的帮助浮窗通过它读取各能力的 `help/` 目录。
 *
 * 约定（与 ability 的 `help/` 目录一一对应）：
 *  - `help/main.md` 是根页面，打开帮助时默认显示它；
 *  - `help/` 下任意 `*.md` 都是一个帮助页，可以是子目录里的文件；
 *  - 子目录即导航分组 —— `help/Video/guide.md` 会在浮窗左侧多出 `Video` 分组；
 *  - 页面显示标题取文件中第一个 `# 标题`，没有则回退文件名；
 *  - Markdown 之间的相对链接（如 `[下一步](Video/guide.md)`）由渲染端解析为
 *    浮窗内跳转，因此这里只需给出路径与原文。
 *
 * Markdown 在构建期以 `?raw` 内联进主进程产物（与 commands.ts 一样），
 * 所以打包后无需在磁盘上保留各能力的 help 目录。
 */

const helpModules = import.meta.glob<string>('../../abilities/*/help/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default'
})

interface HelpFile {
  /** 相对该语言 `help/` 根的路径，`/` 分隔，如 `main.md` / `Video/guide.md`。 */
  rel: string
  title: string
  content: string
}

/**
 * 帮助目录约定：正文都放在语言目录下，例如
 *   help/zh-cn/main.md          help/zh-cn/平台类型/概览.md
 *   help/en-us/main.md          help/en-us/Platforms/Overview.md
 * 语言目录名大小写不敏感，并按语言族归一化到 `zh-cn` / `en-us`（框架语言码是
 * `zh` / `en-US`，这里统一成 BCP-47 小写）。不在语言目录下的 `help/*.md` 视为
 * 语言中立的基准版本，作为最后兜底。
 */
const HELP_LOCALE_FAMILY: Record<string, string> = {
  zh: 'zh-cn',
  'zh-cn': 'zh-cn',
  'zh-hans': 'zh-cn',
  'zh-hant': 'zh-cn',
  en: 'en-us',
  'en-us': 'en-us',
  'en-gb': 'en-us'
}
const DEFAULT_HELP_LOCALE = 'zh-cn'

/** 目录段 → 归一化语言 id（不是语言目录则返回 null，当作普通导航分组）。 */
function helpLocaleOf(seg: string): string | null {
  return HELP_LOCALE_FAMILY[seg.toLowerCase()] ?? null
}

/** 能力文件夹 id → 语言 → 帮助页列表（`''` 为语言中立的基准版本）。 */
const helpFiles = new Map<string, Map<string, HelpFile[]>>()

/** 路径解析：glob key 形如 `../<id>/help/<rel...>`（Vite 会相对声明文件规范化）。 */
function parseModuleKey(key: string): { id: string; lang: string; rel: string } | null {
  const seg = key.split('/')
  const i = seg.indexOf('help')
  if (i <= 0) return null
  const id = seg[i - 1]
  let rest = seg.slice(i + 1)
  // 首段命中语言目录 → 该文件属于该语言；path 里去掉语言段。
  let lang = ''
  const loc = rest.length > 1 ? helpLocaleOf(rest[0]) : null
  if (loc) {
    lang = loc
    rest = rest.slice(1)
  }
  const rel = rest.join('/')
  if (!id || !rel || !rel.toLowerCase().endsWith('.md')) return null
  return { id, lang, rel }
}

/** 显示标题：优先第一个一级标题，否则用文件名（`main` 原样返回，由界面兜底翻译）。 */
function titleOf(raw: string, rel: string): string {
  const m = raw.match(/^\s*#\s+(.+?)\s*$/m)
  if (m) return m[1].trim()
  return (rel.split('/').pop() ?? rel).replace(/\.md$/i, '')
}

for (const [key, raw] of Object.entries(helpModules)) {
  const parsed = parseModuleKey(key)
  if (!parsed) continue
  const byLang = helpFiles.get(parsed.id) ?? new Map<string, HelpFile[]>()
  const list = byLang.get(parsed.lang) ?? []
  list.push({ rel: parsed.rel, title: titleOf(raw, parsed.rel), content: raw })
  byLang.set(parsed.lang, list)
  helpFiles.set(parsed.id, byLang)
}
for (const byLang of helpFiles.values()) {
  for (const list of byLang.values()) list.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 选出一门语言的帮助页，回退链（保证只要该能力有任意 help 内容就显示得出来）：
 *   请求语言目录 → 根目录（语言中立基准）→ 默认 `zh-cn` → 任意已有语言。
 * 语言目录**整体替换**（允许文件夹名也本地化，如 `平台类型/` ↔ `Platforms/`），
 * 不做逐文件合并——两种语言目录名不同时逐文件合并会产生重复的树。
 */
function resolveFiles(id: string, lang?: string): HelpFile[] {
  const byLang = helpFiles.get(id)
  if (!byLang || byLang.size === 0) return []
  const want = lang ? (helpLocaleOf(lang) ?? lang.toLowerCase()) : ''
  if (want && byLang.has(want)) return byLang.get(want)!
  // 没有对应语言目录 → 直接映射根目录（不在语言目录下的语言中立基准）
  if (byLang.has('')) return byLang.get('')!
  // 连基准都没有 → 退默认 zh-cn，再退任意已有语言
  if (byLang.has(DEFAULT_HELP_LOCALE)) return byLang.get(DEFAULT_HELP_LOCALE)!
  const first = [...byLang.keys()].sort()[0]
  return first ? byLang.get(first)! : []
}

/** 目录树中间结构。 */
interface Dir {
  dirs: Map<string, Dir>
  files: HelpFile[]
}

function emptyDir(): Dir {
  return { dirs: new Map(), files: [] }
}

/** 由文件清单构造导航树与默认根页面。 */
function buildTree(files: HelpFile[]): { root: string | null; tree: HelpNode[] } {
  if (!files.length) return { root: null, tree: [] }
  const hasMain = files.some((f) => f.rel === 'main.md')
  const root = hasMain ? 'main.md' : files[0].rel

  const rootDir = emptyDir()
  for (const f of files) {
    const parts = f.rel.split('/')
    parts.pop()
    let d = rootDir
    for (const p of parts) {
      const next = d.dirs.get(p) ?? emptyDir()
      d.dirs.set(p, next)
      d = next
    }
    d.files.push(f)
  }

  const toNodes = (d: Dir): HelpNode[] => {
    const fileNodes: HelpNode[] = [...d.files]
      .sort((a, b) => {
        if (a.rel === root) return -1
        if (b.rel === root) return 1
        return a.title.localeCompare(b.title)
      })
      .map((f) => ({ title: f.title, path: f.rel }))
    const groupNodes: HelpNode[] = [...d.dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, sub]) => ({ title: name, group: true, children: toNodes(sub) }))
    return [...fileNodes, ...groupNodes]
  }

  return { root, tree: toNodes(rootDir) }
}

/** 归一化请求的路径：去 `./` 前缀、反斜杠转正斜杠。 */
function normalizeRel(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export default [
  {
    name: 'help.tree',
    description:
      '读取某个能力的帮助目录结构（--ability <能力文件夹 id> [--lang <语言>]），按语言选树、缺失回退基准版',
    usage: 'help.tree --ability balance --lang en-US',
    run: (ctx): HelpTreeResult => {
      const ability = String(ctx.named.ability ?? '').trim()
      const lang = String(ctx.named.lang ?? '').trim()
      if (!ability)
        return {
          ok: false,
          ability: '',
          hasHelp: false,
          root: null,
          tree: [],
          error: '需要 --ability'
        }
      const files = resolveFiles(ability, lang)
      const { root, tree } = buildTree(files)
      return { ok: true, ability, hasHelp: files.length > 0, root, tree }
    }
  },
  {
    name: 'help.read',
    description:
      '读取某个能力帮助页面的 Markdown 原文（--ability <id> --path <相对路径> [--lang <语言>]）',
    usage: 'help.read --ability balance --path Video/guide.md --lang en-US',
    run: (ctx): HelpMessageResult => {
      const ability = String(ctx.named.ability ?? '').trim()
      const rawPath = String(ctx.named.path ?? '').trim()
      const lang = String(ctx.named.lang ?? '').trim()
      if (!ability || !rawPath) {
        return { ok: false, ability, path: rawPath, content: '', error: '需要 --ability 与 --path' }
      }
      const path = normalizeRel(rawPath)
      const file = resolveFiles(ability, lang).find((f) => f.rel === path)
      if (!file) return { ok: false, ability, path, content: '', error: `未找到帮助页面: ${path}` }
      return { ok: true, ability, path: file.rel, content: file.content }
    }
  }
] satisfies CommandSpec[]
