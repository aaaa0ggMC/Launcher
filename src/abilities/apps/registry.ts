import { join } from 'path'
import chokidar from 'chokidar'
import type { AppEntry, AppRegistryFile } from './types'
import { CONFIG_JSON, abilityConfigPath } from '../../main/process/paths'
import { readJson, writeJsonAtomic } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('apps-registry')

export interface SearchRoot {
  path: string
  watch: boolean
}

type Broadcast = (channel: string, ...args: unknown[]) => void

let broadcast: Broadcast = () => {}

export function setRegistryBroadcast(fn: Broadcast): void {
  broadcast = fn
}

const APPS_CONFIG_PATH = abilityConfigPath('apps')

export async function getAppsConfig(): Promise<{
  searchRoots: SearchRoot[]
  confirmBeforeLaunch: boolean
}> {
  const cfg = await readJson<{
    searchRoots?: SearchRoot[]
    confirmBeforeLaunch?: boolean
  }>(APPS_CONFIG_PATH)
  return {
    searchRoots: cfg?.searchRoots ?? [],
    confirmBeforeLaunch: cfg?.confirmBeforeLaunch ?? false
  }
}

async function saveAppsConfig(config: {
  searchRoots: SearchRoot[]
  confirmBeforeLaunch: boolean
}): Promise<void> {
  await writeJsonAtomic(APPS_CONFIG_PATH, config)
}

export async function addSearchRoot(path: string): Promise<SearchRoot[]> {
  const { searchRoots, confirmBeforeLaunch } = await getAppsConfig()
  if (!searchRoots.some((r) => r.path === path)) {
    searchRoots.push({ path, watch: true })
    await saveAppsConfig({ searchRoots, confirmBeforeLaunch })
    log.info('search root added', { path })
    broadcast('cockpit:apps-changed', 'roots', null)
  }
  return searchRoots
}

export async function removeSearchRoot(path: string): Promise<SearchRoot[]> {
  const { searchRoots, confirmBeforeLaunch } = await getAppsConfig()
  const next = searchRoots.filter((r) => r.path !== path)
  await saveAppsConfig({ searchRoots: next, confirmBeforeLaunch })
  log.info('search root removed', { path })
  broadcast('cockpit:apps-changed', 'roots', null)
  return next
}

function appsJsonPath(root: string): string {
  return join(root, 'apps.json')
}

/**
 * Per-root registry cache. Search / quick-launch / context menu read the same
 * apps.json repeatedly; caching avoids redundant disk I/O. The chokidar watcher
 * (watchRoots) invalidates the cache whenever apps.json changes, and every
 * write path (update/delete/writeRegistry) invalidates too — so the cache only
 * ever holds fresh data.
 */
const registryCache = new Map<string, AppRegistryFile>()

function invalidateRegistry(root: string): void {
  registryCache.delete(root)
}

async function readRegistryCached(root: string): Promise<AppRegistryFile> {
  const cached = registryCache.get(root)
  if (cached) return cached
  const fresh = await readRegistry(root)
  registryCache.set(root, fresh)
  return fresh
}

async function readRegistry(root: string): Promise<AppRegistryFile> {
  return (await readJson<AppRegistryFile>(appsJsonPath(root))) ?? { version: 1, apps: {} }
}

/** Resolve a localized value from the raw apps.json format.
 *  The field may be a plain string or an object `{ "zh": "...", "en_US": "..." }`.
 *  Returns the string for the active language (from config), falling back to
 *  en_US, then the first available translation, then undefined. */
async function resolveLocalized(value: unknown, lang: string): Promise<string | undefined> {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const map = value as Record<string, string>
    return map[lang] ?? map['en_US'] ?? map['en-US'] ?? Object.values(map)[0]
  }
  return undefined
}

/** Read the configured language from config.json (default 'zh'). */
let cachedConfigLang: string | null = null
async function readConfigLang(): Promise<string> {
  if (cachedConfigLang) return cachedConfigLang
  try {
    const cfg = await readJson<{ language?: string }>(CONFIG_JSON)
    cachedConfigLang = cfg?.language ?? 'zh'
  } catch {
    cachedConfigLang = 'zh'
  }
  return cachedConfigLang
}

/** Normalize a raw entry from apps.json: convert object-format name/description/
 *  alias into resolved strings and populate the `localized` map so the renderer
 *  can switch languages without re-fetching. */
async function normalizeEntry(raw: Record<string, unknown>): Promise<AppEntry> {
  const lang = await readConfigLang()
  const entry = { ...raw } as Record<string, unknown>

  for (const field of ['name', 'description', 'alias'] as const) {
    const val = entry[field]
    if (val && typeof val === 'object') {
      const map = val as Record<string, string>
      entry[field] = await resolveLocalized(val, lang)
      const loc: Record<string, Record<string, string>> = (entry.localized as Record<
        string,
        Record<string, string>
      >) ?? {}
      for (const [code, text] of Object.entries(map)) {
        if (typeof text === 'string' && text) {
          const norm = code.replace(/_/g, '-')
          loc[norm] = { ...(loc[norm] ?? {}), [field]: text }
        }
      }
      if (Object.keys(loc).length) entry.localized = loc
    }
  }

  // Normalize action names/descriptions.
  const actions = entry.actions as Record<string, Record<string, unknown>> | undefined
  if (actions) {
    for (const [, act] of Object.entries(actions)) {
      for (const afield of ['name', 'description'] as const) {
        const aval = act[afield]
        if (aval && typeof aval === 'object') {
          act[afield] = await resolveLocalized(aval, lang)
          const norm = act.localized as Record<string, Record<string, string>> | undefined
          if (!norm) {
            const loc: Record<string, Record<string, string>> = {}
            const map = aval as Record<string, string>
            for (const [code, text] of Object.entries(map)) {
              if (typeof text === 'string' && text) {
                loc[code.replace(/_/g, '-')] = { [afield]: text }
              }
            }
            if (Object.keys(loc).length) act.localized = loc
          }
        }
      }
    }
  }

  return entry as unknown as AppEntry
}

/** List every app across all search roots.
 * Returns { roots, apps } where apps values carry a `root` runtime field.
 */
export async function listAllApps(): Promise<{
  roots: SearchRoot[]
  apps: Record<string, AppEntry>
}> {
  const { searchRoots } = await getAppsConfig()
  const out: Record<string, AppEntry> = {}
  for (const root of searchRoots) {
    const reg = await readRegistryCached(root.path)
    for (const [id, raw] of Object.entries(reg.apps)) {
      out[id] = {
        ...(await normalizeEntry(raw as unknown as Record<string, unknown>)),
        root: root.path
      }
    }
  }
  log.debug('listed apps', { roots: searchRoots.length, apps: Object.keys(out).length })
  return { roots: searchRoots, apps: out }
}

export async function getEntry(root: string, id: string): Promise<AppEntry | null> {
  const reg = await readRegistryCached(root)
  const raw = reg.apps[id]
  return raw ? { ...(await normalizeEntry(raw as unknown as Record<string, unknown>)), root } : null
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
  if (!merged.alias) merged.alias = id
  reg.apps[id] = merged
  await writeJsonAtomic(file, reg)
  invalidateRegistry(root)
  log.info('entry saved', { root, id, patchKeys: Object.keys(patch) })
  broadcast('cockpit:apps-changed', 'update', { root, id })
  return { ...merged, root }
}

export async function deleteEntry(root: string, id: string): Promise<void> {
  const file = appsJsonPath(root)
  const reg = await readRegistry(root)
  delete reg.apps[id]
  await writeJsonAtomic(file, reg)
  invalidateRegistry(root)
  log.info('entry deleted', { root, id })
  broadcast('cockpit:apps-changed', 'delete', { root, id })
}

export async function writeRegistry(root: string, reg: AppRegistryFile): Promise<void> {
  await writeJsonAtomic(appsJsonPath(root), reg)
  invalidateRegistry(root)
  log.info('registry written (rescan broadcast)', { root, apps: Object.keys(reg.apps).length })
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
    ignorePermissionErrors: true,
    depth: 2,
    ignored:
      /(^|[/\\])\..|node_modules|\.venv|__pycache__|\.git|\.db$|\.db-journal$|\.sqlite3?$|\.log$|(^|[/\\])logs([/\\]|$)/
  })

  const STRUCTURAL = new Set(['add', 'addDir', 'unlink', 'unlinkDir'])
  let notifyTimer: NodeJS.Timeout | null = null
  const notify = (root: string): void => {
    if (notifyTimer) clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => {
      broadcast('cockpit:apps-changed', 'structure', root)
      notifyTimer = null
    }, 400)
  }

  watcher.on('all', (event, path) => {
    const root = [...roots].find((r) => path === r || path.startsWith(r + '/'))
    if (!root) return
    const rel = path === root ? '' : path.slice(root.length + 1)
    const id = rel.split('/')[0]
    if (rel.endsWith('apps.json')) {
      log.debug('watcher apps.json change', { root })
      invalidateRegistry(root)
      broadcast('cockpit:apps-changed', 'file', root)
    } else if (rel && !id.startsWith('.') && STRUCTURAL.has(event)) {
      log.debug('watcher structural event', { root, event, path: rel })
      notify(root)
    }
  })

  rebuild()
  watcher.on('error', (err) => console.error('[cockpit] watch error:', err))
}
