import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import chokidar from 'chokidar'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AbilitiesManifest, AppEntry, AppRegistryFile } from '../shared/types'
import { ABILITIES_YAML } from './paths'
import { readJson, writeJsonAtomic } from './util'

export interface SearchRoot {
  path: string
  watch: boolean
}

type Broadcast = (channel: string, ...args: unknown[]) => void

let broadcast: Broadcast = () => {}

export function setRegistryBroadcast(fn: Broadcast): void {
  broadcast = fn
}

/** Read + parse config/abilities.yaml. */
export async function getManifest(): Promise<AbilitiesManifest | null> {
  try {
    const raw = await readFile(ABILITIES_YAML, 'utf-8')
    return parseYaml(raw) as AbilitiesManifest
  } catch {
    return null
  }
}

export async function getAppsConfig(): Promise<{ searchRoots: SearchRoot[]; confirmBeforeLaunch: boolean }> {
  const manifest = await getManifest()
  const apps = manifest?.abilities.find((a) => a.id === 'apps')
  const cfg = (apps?.config ?? {}) as {
    searchRoots?: SearchRoot[]
    confirmBeforeLaunch?: boolean
  }
  return {
    searchRoots: cfg.searchRoots ?? [],
    confirmBeforeLaunch: cfg.confirmBeforeLaunch ?? false
  }
}

async function saveSearchRoots(roots: SearchRoot[]): Promise<void> {
  const manifest = (await getManifest()) as AbilitiesManifest
  const apps = manifest.abilities.find((a) => a.id === 'apps')
  if (!apps) return
  apps.config = { ...(apps.config ?? {}), searchRoots: roots }
  await writeFile(ABILITIES_YAML, stringifyYaml(manifest), 'utf-8')
}

export async function addSearchRoot(path: string): Promise<SearchRoot[]> {
  const { searchRoots } = await getAppsConfig()
  if (!searchRoots.some((r) => r.path === path)) {
    searchRoots.push({ path, watch: true })
    await saveSearchRoots(searchRoots)
    broadcast('cockpit:apps-changed', 'roots', null)
  }
  return searchRoots
}

export async function removeSearchRoot(path: string): Promise<SearchRoot[]> {
  const { searchRoots } = await getAppsConfig()
  const next = searchRoots.filter((r) => r.path !== path)
  await saveSearchRoots(next)
  broadcast('cockpit:apps-changed', 'roots', null)
  return next
}

function appsJsonPath(root: string): string {
  return join(root, 'apps.json')
}

async function readRegistry(root: string): Promise<AppRegistryFile> {
  return (await readJson<AppRegistryFile>(appsJsonPath(root))) ?? { version: 1, apps: {} }
}

/** List every app across all search roots.
 * Returns { roots, apps } where apps values carry a `root` runtime field.
 */
export async function listAllApps(): Promise<{ roots: SearchRoot[]; apps: Record<string, AppEntry> }> {
  const { searchRoots } = await getAppsConfig()
  const out: Record<string, AppEntry> = {}
  for (const root of searchRoots) {
    const reg = await readRegistry(root.path)
    for (const [id, entry] of Object.entries(reg.apps)) {
      out[id] = { ...entry, root: root.path }
    }
  }
  return { roots: searchRoots, apps: out }
}

export async function getEntry(root: string, id: string): Promise<AppEntry | null> {
  const reg = await readRegistry(root)
  const entry = reg.apps[id]
  return entry ? { ...entry, root } : null
}

/**
 * Update (or create) an entry. `patch` is merged shallowly; exec/security/tags
 * objects are merged field-by-field so the UI can edit single fields.
 */
export async function updateEntry(
  root: string,
  id: string,
  patch: Partial<AppEntry>
): Promise<AppEntry> {
  const file = appsJsonPath(root)
  const reg = await readRegistry(root)
  const current = reg.apps[id] ?? {
    name: id,
    path: id,
    exec: { type: 'custom', command: [] }
  }
  const merged: AppEntry = {
    ...current,
    ...patch,
    exec: { ...current.exec, ...(patch.exec ?? {}) },
    security: {
      ...(current.security ?? {}),
      ...(patch.security ?? {})
    } as AppEntry['security'],
    tags: patch.tags ?? current.tags ?? [],
    tags_auto: patch.tags_auto ?? current.tags_auto ?? []
  }
  // id is the object key; alias falls back to id per schema
  if (!merged.alias) merged.alias = id
  reg.apps[id] = merged
  await writeJsonAtomic(file, reg)
  broadcast('cockpit:apps-changed', 'update', { root, id })
  return { ...merged, root }
}

export async function deleteEntry(root: string, id: string): Promise<void> {
  const file = appsJsonPath(root)
  const reg = await readRegistry(root)
  delete reg.apps[id]
  await writeJsonAtomic(file, reg)
  broadcast('cockpit:apps-changed', 'delete', { root, id })
}

export async function writeRegistry(root: string, reg: AppRegistryFile): Promise<void> {
  await writeJsonAtomic(appsJsonPath(root), reg)
  broadcast('cockpit:apps-changed', 'rescan', root)
}

/**
 * Watch search roots + apps.json. On changes, notify renderer so the Apps page
 * refreshes live. Returns the watcher (kept alive for app lifetime).
 */
export function watchRoots(): void {
  const roots = new Set<string>()
  const rebuild = async (): Promise<void> => {
    const { searchRoots } = await getAppsConfig()
    const next = searchRoots.filter((r) => r.watch).map((r) => r.path)
    for (const p of roots) {
      if (!next.includes(p)) watcher.unwatch(p)
    }
    for (const p of next) {
      if (!roots.has(p)) watcher.add(p)
    }
    roots.clear()
    next.forEach((p) => roots.add(p))
  }

  const watcher = chokidar.watch([], {
    ignoreInitial: true,
    depth: 2,
    ignored: /(^|[/\\])\..|node_modules|\.venv|__pycache__/
  })
  watcher.on('all', (event, path) => {
    const root = [...roots].find((r) => path === r || path.startsWith(r + '/'))
    if (!root) return
    const rel = path === root ? '' : path.slice(root.length + 1)
    const id = rel.split('/')[0]
    if (rel.endsWith('apps.json')) {
      broadcast('cockpit:apps-changed', 'file', root)
    } else if (rel && !id.startsWith('.')) {
      broadcast('cockpit:apps-changed', event, root)
    }
  })

  rebuild()
  watcher.on('error', (err) => console.error('[cockpit] watch error:', err))
}
