import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { USER_CONFIG_DIR } from './paths'
import { makeLogger } from './logger'
import { getBroadcast } from './broadcast'

const log = makeLogger('usage-stats')

/**
 * Usage statistics — sidebar sort frequency tracking.
 *
 * Backed by a single CSV at `~/.config/LinuxCockpit/apps.csv`:
 *
 *   id,count,last_used
 *   apps,42,1723456789012
 *   app:/home/.../Apps:bili-viewer,7,1723456789012
 *
 * Rows are keyed by an opaque id:
 *  - ability ids (`stats.record { id: 'apps' }`) feed the sidebar "使用频次" /
 *    "最近使用" sort rules;
 *  - app launches are recorded as `app:<root>:<id>` rows — pure statistics,
 *    they don't affect the sidebar but share the same file and the "清空记录"
 *    button.
 *
 * The renderer reloads after every write via the `cockpit:usage-changed`
 * broadcast, so the sidebar re-sorts live.
 */

export interface UsageStat {
  count: number
  lastUsed: number
}

const STATS_PATH = join(USER_CONFIG_DIR, 'apps.csv')

let _cache: Record<string, UsageStat> | null = null

/** Read all usage stats (cached; use `clearUsageStats` to reset). */
export async function loadUsageStats(): Promise<Record<string, UsageStat>> {
  if (_cache) return _cache
  const out: Record<string, UsageStat> = {}
  try {
    const raw = await readFile(STATS_PATH, 'utf-8')
    for (const line of raw.split('\n')) {
      const [id, count, lastUsed] = line.split(',')
      if (!id || id === 'id') continue
      out[id] = { count: Number(count) || 0, lastUsed: Number(lastUsed) || 0 }
    }
  } catch {
    // no stats file yet — empty table
  }
  _cache = out
  return out
}

async function writeStats(stats: Record<string, UsageStat>): Promise<void> {
  const lines = ['id,count,last_used']
  for (const [id, s] of Object.entries(stats)) {
    lines.push(`${id},${s.count},${s.lastUsed}`)
  }
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeFile(STATS_PATH, lines.join('\n') + '\n', 'utf-8')
  getBroadcast()('cockpit:usage-changed', 'changed', null)
}

/** Record one usage of `id` (sidebar ability open or app launch). */
export async function recordUsage(id: string): Promise<void> {
  if (!id || id.includes(',')) return
  const stats = await loadUsageStats()
  const cur = stats[id] ?? { count: 0, lastUsed: 0 }
  stats[id] = { count: cur.count + 1, lastUsed: Date.now() }
  try {
    await writeStats(stats)
  } catch (e) {
    log.warn('record usage failed', { id, error: e instanceof Error ? e.message : String(e) })
  }
}

/** Reset every counter (sidebar frequency / app launch stats). */
export async function clearUsageStats(): Promise<void> {
  _cache = {}
  try {
    await writeStats({})
  } catch (e) {
    log.warn('clear usage failed', { error: e instanceof Error ? e.message : String(e) })
  }
}
