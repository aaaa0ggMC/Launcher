import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { AppEntry, AppRegistryFile, RiskLevel } from './types'
import { readJson } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'
import { assessDir } from './security'

const log = makeLogger('apps-scanner')

export interface DraftEntry {
  id: string
  entry: AppEntry
}

function safeParseToml(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const sec = t.match(/^\[([^\]]+)\]/)
    if (sec) {
      section = sec[1]
      out[section] = out[section] ?? {}
      continue
    }
    const kv = t.match(/^([\w-]+)\s*=\s*"([^"]*)"/)
    if (kv && section) out[section][kv[1]] = kv[2]
  }
  return out
}

/** Detect the `uv` entry name from a pyproject's [project.scripts]. */
async function detectPyproject(root: string): Promise<AppEntry | null> {
  const raw = await readFile(join(root, 'pyproject.toml'), 'utf-8').catch(() => '')
  if (!raw) return null
  const parsed = safeParseToml(raw)
  const scripts = parsed['project.scripts'] ?? {}
  const name = parsed['project']?.name ?? ''
  const cmd = Object.keys(scripts)[0] ?? (name || 'main')
  return {
    name: name || cmd,
    description: parsed['project']?.description,
    path: root,
    // [project.scripts] entries are CLI tools → launch in a terminal by default.
    exec: { type: 'uv', command: [cmd], cwd: '{self}', terminal: true },
    icon: 'auto'
  }
}

/** Detect a node project (package.json with a main/start). */
async function detectPackageJson(root: string): Promise<AppEntry | null> {
  const pkg = await readJson<{ name?: string; description?: string; main?: string; type?: string }>(
    join(root, 'package.json')
  )
  if (!pkg) return null
  const main = pkg.main ?? 'app.js'
  return {
    name: pkg.name ?? '',
    description: pkg.description,
    path: root,
    exec: { type: 'node', command: [main], cwd: '{self}' },
    icon: 'auto'
  }
}

/** Build a best-effort draft entry for one item inside a search root. */
export async function draftFor(
  root: string,
  name: string,
  isDir: boolean
): Promise<AppEntry | null> {
  const full = join(root, name)
  const id =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || name

  if (isDir) {
    const py = await detectPyproject(full)
    if (py) {
      log.debug('detected pyproject', { root, name: py.name, id })
      return { ...py, alias: id }
    }
    const node = await detectPackageJson(full)
    if (node) {
      log.debug('detected package.json', { root, name: node.name, id })
      return { ...node, alias: id }
    }
    const hasVenv = await stat(join(full, '.venv')).catch(() => null)
    if (hasVenv) {
      log.debug('detected venv', { root, id })
      return {
        alias: id,
        name,
        path: name,
        exec: { type: 'python', command: ['main.py'], cwd: '{self}' },
        icon: 'auto'
      }
    }
    const hasDocker = await stat(join(full, 'Dockerfile')).catch(() => null)
    if (hasDocker) {
      log.debug('detected docker', { root, id })
      return {
        alias: id,
        name,
        path: name,
        exec: { type: 'custom', command: ['docker', 'compose', 'up', '-d'], cwd: '{self}' },
        icon: 'auto'
      }
    }
    // Unknown project → best-guess, medium risk (user reviews every entry anyway)
    return {
      alias: id,
      name,
      path: name,
      exec: { type: 'custom', command: ['xdg-open', '.'], cwd: '{self}' },
      icon: 'auto'
    }
  }

  // Script / binary file
  const st = await stat(full)
  const executable = (st.mode & 0o111) !== 0
  return {
    alias: id,
    name,
    path: name,
    exec: { type: 'script', command: [], cwd: '{self}' },
    icon: 'auto',
    ...(executable ? {} : { managed: false })
  }
}

/** Normalize a name for fuzzy matching (case + separators ignored). */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Strip a known source/script extension, e.g. "foo.sh" → "foo". */
function stripExt(name: string): string {
  const ext = name.toLowerCase().match(/\.(sh|bash|py|js|ts|mjs|cjs|cpp|c|rs|go)$/)?.[1]
  return ext ? name.slice(0, -(ext.length + 1)) : name
}

/** Rescan a root: auto-draft every detected entry, merge per the safe policy. */
export async function rescanRoot(root: string): Promise<AppRegistryFile> {
  log.info('rescan start', { root })
  const reg = (await readJson<AppRegistryFile>(join(root, 'apps.json'))) ?? { version: 1, apps: {} }
  const items = await readdir(root).catch(() => [])
  const found: { name: string; isDir: boolean }[] = []

  for (const name of items) {
    if (name.startsWith('.') || name === 'apps.json') continue
    const full = join(root, name)
    const st = await stat(full).catch(() => null)
    if (!st) continue
    found.push({ name, isDir: st.isDirectory() })
  }

  // Deduplicate wrapper scripts vs project dirs: "foo.sh" next to a "foo" dir
  // is a launcher for the dir project, not a separate app. Same for same-name
  // variants (balance-checker file + balance_checker dir).
  const dirKeys = new Set(found.filter((e) => e.isDir).map((e) => normalizeKey(e.name)))
  const deduped = found.filter((e) => {
    if (e.isDir) return true
    return !dirKeys.has(normalizeKey(stripExt(e.name)))
  })

  const drafts: Record<string, AppEntry> = {}

  for (const { name, isDir } of deduped) {
    const draft = await draftFor(root, name, isDir)
    if (!draft) continue
    // derive id from draft (dir projects use pyproject name; override with alias-derived id)
    const id = (draft.alias ?? name).toLowerCase()
    // On id collision, prefer the directory project over a loose script.
    if (isDir || !drafts[id]) drafts[id] = draft
  }

  for (const [id, draft] of Object.entries(drafts)) {
    const a = await assessDir(join(root, id))
    drafts[id] = {
      ...draft,
      tags_auto: autoTagsFor(draft, join(root, id)),
      security: { risk: a.risk, auto_note: a.auto_note }
    }
  }

  const next: Record<string, AppEntry> = {}

  for (const [id, existing] of Object.entries(reg.apps)) {
    const draft = drafts[id]
    if (!draft) {
      // Undetected → keep, mark missing
      next[id] = { ...existing, missing: true }
      continue
    }
    if (existing.managed === false) {
      next[id] = existing
      continue
    }
    // Merge policy: update ONLY tags_auto + security.auto_note; fill the rest
    // only if absent/null. Never clobber user edits.
    const security = {
      risk: (existing.security?.risk as RiskLevel) ?? draft.security!.risk,
      auto_note: draft.security!.auto_note,
      ...(existing.security?.note ? { note: existing.security.note } : {}),
      acknowledged: existing.security?.acknowledged ?? false
    }
    next[id] = {
      ...existing,
      missing: false,
      tags_auto: draft.tags_auto ?? [],
      security,
      description: existing.description || draft.description,
      icon: existing.icon ?? draft.icon,
      path: existing.path ?? draft.path,
      exec: existing.exec ?? draft.exec,
      name: existing.name || draft.name
    }
  }

  for (const [id, draft] of Object.entries(drafts)) {
    if (!reg.apps[id]) {
      next[id] = { ...draft }
    }
  }

  reg.version = 1
  reg.apps = next
  const total = Object.keys(next).length
  const missing = Object.values(next).filter((e) => e.missing).length
  const created = Object.keys(drafts).filter((id) => !reg.apps[id]).length
  log.info('rescan summary', {
    root,
    found: found.length,
    drafts: Object.keys(drafts).length,
    created,
    kept: total - created - missing,
    missing
  })
  return reg
}

function autoTagsFor(draft: AppEntry, full: string): string[] {
  const tags: string[] = []
  if (draft.exec.type === 'uv' || draft.exec.type === 'python') tags.push('python')
  if (draft.exec.type === 'node') tags.push('node')
  if (draft.exec.type === 'script') tags.push('script')
  if (draft.exec.type === 'docker' || full.includes('docker')) tags.push('docker')
  if (draft.exec.type === 'custom' && draft.exec.command?.[0] === 'xdg-open') tags.push('data')
  return tags
}
