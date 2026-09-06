import { mkdir } from 'fs/promises'
import { join } from 'path'
import { makeLogger } from '../../../main/process/logger'
import { USER_CONFIG_DIR, abilityConfigPath } from '../../../main/process/paths'
import {
  readOrCreateJson,
  writeJsonAtomic,
  writeJsonAtomicSerialized
} from '../../../main/process/util'
import type { AidjConfig, AidjLyricsPageConfig, EqProfile, SessionMeta } from '../types'
import {
  AIDJ_DATA_DIR,
  METADATA_FILE,
  LYRICS_FILE,
  FREQ_FILE,
  PLAYLISTS_DIR,
  EQ_FILE,
  EQ_BAND_COUNT,
  EQ_GAIN_RANGE_DEFAULT,
  DEFAULT_LYRICS_PAGE_CFG,
  DEFAULT_AIDJ_CONFIG
} from '../types'

const log = makeLogger('aidj-config')

export const AIDJ_DIR = join(USER_CONFIG_DIR, AIDJ_DATA_DIR)
export const SESSIONS_DIR = join(AIDJ_DIR, 'sessions')
export const SESSIONS_INDEX = join(SESSIONS_DIR, 'main.json')

/** Session index — auto-created with an empty list on first read */
export async function loadSessionsIndex(): Promise<{ sessions: SessionMeta[] }> {
  return readOrCreateJson(SESSIONS_INDEX, () => ({ sessions: [] }))
}

export async function loadAidjConfig(): Promise<AidjConfig | null> {
  return readOrCreateJson(abilityConfigPath('aidj'), () => DEFAULT_AIDJ_CONFIG)
}

/**
 * Persist the current AIDJ config to ~/.config/LinuxCockpit/aidj/config.json.
 * Serialized: multiple saves in one tick are ordered.
 */
export async function saveAidjConfig(config: AidjConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeJsonAtomicSerialized(abilityConfigPath('aidj'), config)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('saveAidjConfig failed', { error })
    return { ok: false, error }
  }
}

const LYRICS_PAGE_CONFIG_PATH = abilityConfigPath('aidj-lyrics')

export async function loadLyricsPageConfig(): Promise<AidjLyricsPageConfig> {
  return readOrCreateJson(LYRICS_PAGE_CONFIG_PATH, () => DEFAULT_LYRICS_PAGE_CFG)
}

export async function saveLyricsPageConfig(
  config: AidjLyricsPageConfig
): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeJsonAtomic(LYRICS_PAGE_CONFIG_PATH, config)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('saveLyricsPageConfig failed', { error })
    return { ok: false, error }
  }
}

export function getAidjDir(): string {
  return AIDJ_DIR
}

export function getMetadataPath(): string {
  return join(AIDJ_DIR, METADATA_FILE)
}

export function getLyricsPath(): string {
  return join(AIDJ_DIR, LYRICS_FILE)
}

export function getFreqPath(): string {
  return join(AIDJ_DIR, FREQ_FILE)
}

export function getPlaylistsDir(): string {
  return join(AIDJ_DIR, PLAYLISTS_DIR)
}

export function getEqPath(): string {
  return join(AIDJ_DIR, EQ_FILE)
}

export const BUILTIN_EQ_PROFILES: EqProfile[] = [
  { id: 'flat', name: '原声 (Flat)', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], builtin: true },
  {
    id: 'bass',
    name: '低音增强 (Bass Boost)',
    gains: [5.5, 4.5, 3.5, 2.0, 0.5, 0, 0, 0, 0, 0],
    builtin: true
  },
  {
    id: 'vocal',
    name: '人声突出 (Vocal)',
    gains: [-1.5, -1.0, 0, 2.0, 3.5, 3.0, 1.5, 0.5, 0, -0.5],
    builtin: true
  },
  {
    id: 'treble',
    name: '清亮高音 (Treble)',
    gains: [-1.0, -0.5, 0, 0, 0.5, 1.5, 3.0, 4.5, 5.0, 4.5],
    builtin: true
  },
  {
    id: 'electronic',
    name: '电子/舞曲 (EDM)',
    gains: [4.5, 3.5, 1.5, -0.5, -1.0, 1.0, 2.5, 3.5, 4.0, 3.5],
    builtin: true
  },
  {
    id: 'rock',
    name: '摇滚 (Rock)',
    gains: [4.0, 3.0, 1.5, 0, -1.0, -0.5, 1.5, 3.0, 3.5, 4.0],
    builtin: true
  },
  {
    id: 'classical',
    name: '古典 (Classical)',
    gains: [3.0, 2.5, 2.0, 1.0, -0.5, -0.5, 0.5, 1.5, 2.5, 3.0],
    builtin: true
  },
  {
    id: 'pop',
    name: '流行 (Pop)',
    gains: [-1.0, 1.0, 2.5, 3.5, 2.5, 0.5, -0.5, -1.0, -1.0, -1.0],
    builtin: true
  }
]

export async function getEqGainRange(): Promise<number> {
  try {
    const config = await loadAidjConfig()
    const r = config?.preferences?.eq_gain_range
    if (typeof r === 'number' && Number.isFinite(r) && r >= 12 && r <= 60) {
      return Math.round(r)
    }
  } catch {
    /* fallback to default */
  }
  return EQ_GAIN_RANGE_DEFAULT
}

export async function loadEqProfiles(): Promise<EqProfile[]> {
  const file = getEqPath()
  const custom = await readOrCreateJson<EqProfile[]>(file, () => [])
  const validCustom = Array.isArray(custom)
    ? custom.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.gains))
    : []
  const map = new Map<string, EqProfile>()
  for (const b of BUILTIN_EQ_PROFILES) {
    map.set(b.id, { ...b, gains: [...b.gains] })
  }
  for (const c of validCustom) {
    const existing = map.get(c.id)
    if (existing && existing.builtin) {
      existing.gains = c.gains.slice(0, EQ_BAND_COUNT)
      if (c.name) existing.name = c.name
    } else {
      map.set(c.id, {
        id: c.id,
        name: c.name || c.id,
        gains: c.gains.slice(0, EQ_BAND_COUNT),
        builtin: false
      })
    }
  }
  return [...map.values()]
}

export async function saveEqProfiles(profiles: EqProfile[]): Promise<void> {
  await ensureAidjDir()
  await writeJsonAtomic(getEqPath(), profiles)
}

export async function findEqProfile(id: string): Promise<EqProfile | null> {
  const all = await loadEqProfiles()
  return all.find((p) => p.id === id) ?? null
}

export async function loadFrequency(): Promise<Map<string, number>> {
  const file = getFreqPath()
  const map = new Map<string, number>()
  const data = await readOrCreateJson<Record<string, number>>(file, () => ({}))
  for (const [k, v] of Object.entries(data)) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) map.set(k, n)
  }
  return map
}

export async function saveFrequency(freq: Map<string, number>): Promise<void> {
  await ensureAidjDir()
  const obj: Record<string, number> = {}
  for (const [k, v] of freq.entries()) {
    if (v > 0) obj[k] = v
  }
  await writeJsonAtomic(getFreqPath(), obj)
}

export async function bumpFrequency(names: string[]): Promise<void> {
  if (!names.length) return
  const freq = await loadFrequency()
  for (const name of names) {
    freq.set(name, (freq.get(name) ?? 0) + 1)
  }
  await saveFrequency(freq)
}

export async function ensureAidjDir(): Promise<void> {
  await mkdir(AIDJ_DIR, { recursive: true })
  await mkdir(SESSIONS_DIR, { recursive: true })
  await mkdir(getPlaylistsDir(), { recursive: true })
}
