/**
 * 从 GitHub 链接下载 Skill 目录。
 *
 * 接受：仓库首页（`github.com/o/r`、`o/r`）、子目录 / 文件（`/tree/<ref>/<path>`、`/blob/<ref>/<path>`）、
 * raw 文件（`raw.githubusercontent.com/o/r/<ref>/<path>`）。
 * 不用 codeload 的 zip（部分网络封了它）：Git Trees API 列一次文件，再逐个从 raw 下载。
 * 分支名可能带斜杠（`feature/x`），所以 ref 与路径的分界靠逐个试 Trees API 确定。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
/** 与 provider.ts 的 SKILL_FILE_NAME 相同；不 import provider，免得测试拉起 logger 写盘 */
const SKILL_FILE_NAME = 'SKILL.md'

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface GithubLink {
  owner: string
  repo: string
  /** 仓库名之后的段（`tree|blob` 已去掉）：ref 段 + 路径段，分界待定 */
  rest: string[]
  /** 链接指向的是文件（blob / raw），取其所在目录 */
  file: boolean
}

/** 单个 Skill 下载上限：与本地导入一致 50MB；文件数另设上限防止误指到整个大仓库 */
export const MAX_GITHUB_BYTES = 50 * 1024 * 1024
export const MAX_GITHUB_FILES = 1000
/** ref 最多试几段（`a/b/c/d/e`） */
const MAX_REF_SEGMENTS = 6

const NAME_RE = /^[A-Za-z0-9_.-]+$/

/** 解析链接；不是 GitHub 仓库链接返回 null */
export function parseGithubUrl(input: string): GithubLink | null {
  let text = input.trim()
  if (!text) return null
  // `owner/repo` 简写
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) text = `https://github.com/${text}`
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const segs = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  if (segs.length < 2) return null
  const owner = segs[0]
  const repo = segs[1].replace(/\.git$/i, '')
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null
  if (segs.some((s) => s === '..' || s === '.')) return null

  if (host === 'raw.githubusercontent.com') {
    let rest = segs.slice(2)
    // raw 的新式写法：/refs/heads/<branch>/... → ref 段就是 <branch>（再带 refs/heads 前缀交给 API 也认）
    if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) rest = rest.slice(2)
    if (rest.length < 2) return null
    return { owner, repo, rest, file: true }
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const kind = segs[2]
  if (kind === undefined) return { owner, repo, rest: [], file: false }
  if ((kind === 'tree' || kind === 'blob') && segs.length >= 4) {
    return { owner, repo, rest: segs.slice(3), file: kind === 'blob' }
  }
  return null
}

interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  mode?: string
  size?: number
}

export interface GithubSkillResult {
  /** 下载到的本地 Skill 目录（tmpRoot 之下） */
  dir?: string
  /** 链接下有多个 Skill：仓库内路径列表，让用户选一个（再带 `path` 调） */
  candidates?: string[]
}

/**
 * 导入失败；`code` 也是翻译键后缀（`yaya.skill.err.gh_<code>`），`template` 是中文兜底模板，
 * 命令层用 te(key, vars, template) 出本地化文本。
 */
export class GithubImportError extends Error {
  constructor(
    readonly code: string,
    readonly template: string,
    readonly vars: Record<string, string> = {}
  ) {
    super(template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))
  }
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'linux-cockpit-yaya'
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) h.authorization = `Bearer ${token}`
  return h
}

/** 逐个试 ref 段数，拿到整棵树；返回 ref 与剩下的仓库内路径 */
async function resolveTree(
  link: GithubLink,
  fetchImpl: FetchLike
): Promise<{ ref: string; path: string; tree: TreeEntry[] }> {
  const candidates: { ref: string; path: string }[] = []
  if (link.rest.length === 0) candidates.push({ ref: 'HEAD', path: '' })
  for (let i = 1; i <= Math.min(link.rest.length, MAX_REF_SEGMENTS); i++) {
    candidates.push({ ref: link.rest.slice(0, i).join('/'), path: link.rest.slice(i).join('/') })
  }
  let lastStatus = 404
  for (const c of candidates) {
    const url = `https://api.github.com/repos/${link.owner}/${link.repo}/git/trees/${encodeURIComponent(c.ref)}?recursive=1`
    const res = await fetchImpl(url, { headers: apiHeaders() })
    if (res.ok) {
      const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean }
      if (body.truncated) {
        throw new GithubImportError(
          'truncated',
          '仓库文件太多，GitHub 只返回了部分文件列表；请改用指向 Skill 子目录的链接'
        )
      }
      return { ...c, tree: body.tree ?? [] }
    }
    lastStatus = res.status
    // 403 / 429：限流，换 ref 也没用
    if (res.status === 403 || res.status === 429) {
      throw new GithubImportError(
        'rate_limited',
        'GitHub API 限流（未登录每小时 60 次）；稍后再试，或在宿主环境设置 GITHUB_TOKEN'
      )
    }
    if (res.status !== 404 && res.status !== 422) break
  }
  if (lastStatus === 404 || lastStatus === 422) {
    throw new GithubImportError(
      'not_found',
      '找不到该仓库 / 分支 / 路径（私有仓库需设置 GITHUB_TOKEN）'
    )
  }
  throw new GithubImportError('http', 'GitHub API 请求失败（HTTP {status}）', {
    status: String(lastStatus)
  })
}

/** 仓库内路径要跳过的条目：node_modules、隐藏目录、子模块与符号链接 */
function skipPath(rel: string, entry: TreeEntry): boolean {
  if (entry.type !== 'blob' || entry.mode === '120000') return true
  const parts = rel.split('/')
  if (parts.some((p) => p === '..' || p === '' || p === 'node_modules')) return true
  return parts.slice(0, -1).some((p) => p.startsWith('.'))
}

/** 在树里找出链接指向的 Skill 目录（仓库内路径，根为 ''） */
export function locateSkillDir(
  tree: TreeEntry[],
  path: string,
  isFile: boolean,
  pick?: string
): GithubSkillResult & { skillDir?: string } {
  const clean = (p: string): string => p.replace(/^\/+|\/+$/g, '')
  let base = clean(path)
  const hit = base ? tree.find((e) => e.path === base) : undefined
  if (base && !hit)
    throw new GithubImportError('no_path', '仓库里没有这个路径：{path}', { path: base })
  if (hit?.type === 'blob' || (isFile && hit?.type !== 'tree')) base = posix.dirname(base)
  if (base === '.') base = ''

  const skillFileOf = (dir: string): string => (dir ? `${dir}/${SKILL_FILE_NAME}` : SKILL_FILE_NAME)
  const has = (p: string): boolean => tree.some((e) => e.type === 'blob' && e.path === p)
  if (has(skillFileOf(base))) return { skillDir: base }

  const prefix = base ? `${base}/` : ''
  const found = tree
    .filter(
      (e) =>
        e.type === 'blob' &&
        e.path.startsWith(prefix) &&
        posix.basename(e.path) === SKILL_FILE_NAME &&
        !skipPath(e.path.slice(prefix.length), e)
    )
    .map((e) => posix.dirname(e.path))
    .sort()
  if (pick) {
    const want = clean(pick)
    if (found.includes(want)) return { skillDir: want }
    throw new GithubImportError('no_skill_at', '该路径下没有 SKILL.md：{path}', { path: want })
  }
  if (found.length === 1) return { skillDir: found[0] }
  if (found.length > 1) return { candidates: found }
  throw new GithubImportError('no_skill', '链接指向的位置没有找到 SKILL.md')
}

function rawUrl(link: GithubLink, ref: string, path: string): string {
  const enc = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${link.owner}/${link.repo}/${ref
    .split('/')
    .map(encodeURIComponent)
    .join('/')}/${enc}`
}

/**
 * 下载链接指向的 Skill 目录到 `tmpRoot/<目录名>`。
 * 链接下有多个 Skill 且没给 `pick` 时不下载，返回 candidates。
 */
export async function downloadGithubSkill(
  input: string,
  tmpRoot: string,
  opts: { pick?: string; fetchImpl?: FetchLike } = {}
): Promise<GithubSkillResult> {
  const link = parseGithubUrl(input)
  if (!link) throw new GithubImportError('bad_url', '不是 GitHub 仓库链接：{url}', { url: input })
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const { ref, path, tree } = await resolveTree(link, fetchImpl)
  const located = locateSkillDir(tree, path, link.file, opts.pick)
  if (located.candidates) return { candidates: located.candidates }
  const skillDir = located.skillDir ?? ''

  const prefix = skillDir ? `${skillDir}/` : ''
  const files = tree.filter(
    (e) => e.path.startsWith(prefix) && !skipPath(e.path.slice(prefix.length), e)
  )
  if (files.length > MAX_GITHUB_FILES) {
    throw new GithubImportError('too_many', '文件数超过 {n} 个上限', {
      n: String(MAX_GITHUB_FILES)
    })
  }
  const total = files.reduce((n, e) => n + (e.size ?? 0), 0)
  if (total > MAX_GITHUB_BYTES) throw new GithubImportError('too_large', '目录体积超过 50MB 上限')

  const dest = join(tmpRoot, skillDir ? posix.basename(skillDir) : link.repo)
  mkdirSync(dest, { recursive: true })
  // 小并发：raw 不限流，但别一下子开几百个连接
  const queue = [...files]
  const worker = async (): Promise<void> => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const rel = e.path.slice(prefix.length)
      const res = await fetchImpl(rawUrl(link, ref, e.path), {
        headers: { 'user-agent': 'linux-cockpit-yaya' }
      })
      if (!res.ok) {
        throw new GithubImportError('download', '下载失败（HTTP {status}）：{path}', {
          status: String(res.status),
          path: e.path
        })
      }
      const out = join(dest, ...rel.split('/'))
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker))
  return { dir: dest }
}
