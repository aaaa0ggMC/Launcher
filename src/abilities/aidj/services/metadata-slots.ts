import { readFile, writeFile, readdir, rename, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { makeLogger } from '../../../main/process/logger'
import { readOrCreateJson, writeJsonAtomic } from '../../../main/process/util'
import type { SongMeta } from '../types'
import {
  getAidjDir,
  getMetadataDir,
  getMetadataPath,
  getBiliMetadataPath,
  ensureAidjDir
} from './config'

const log = makeLogger('aidj-metadata-slots')

export interface MetadataSlotInfo {
  id: string
  name: string
  path: string
  isDefault: boolean
  isBiliDefault: boolean
  isWriteTarget: boolean
  enabled: boolean
  totalCount: number
  selectedCount: number
  triState: 'all' | 'partial' | 'none'
}

export interface MetadataSlotEntry {
  name: string
  metadata: SongMeta
  enabled: boolean
}

export interface MetadataSlotsFileConfig {
  activeWriteSlot: string
  biliDefaultSlot?: string
  slots: Record<
    string,
    {
      enabled?: boolean
      disabledSongs?: string[]
    }
  >
}

const DEFAULT_SLOTS_CONFIG: MetadataSlotsFileConfig = {
  activeWriteSlot: 'default',
  biliDefaultSlot: 'Bilibili-Current.metadata',
  slots: {
    default: { enabled: true, disabledSongs: [] }
  }
}

function getSlotsConfigPath(): string {
  return join(getAidjDir(), 'metadata_slots.json')
}

export async function loadSlotsConfig(): Promise<MetadataSlotsFileConfig> {
  await ensureAidjDir()
  return readOrCreateJson(getSlotsConfigPath(), () => ({ ...DEFAULT_SLOTS_CONFIG }))
}

export async function saveSlotsConfig(config: MetadataSlotsFileConfig): Promise<void> {
  await ensureAidjDir()
  await writeJsonAtomic(getSlotsConfigPath(), config)
}

// In-memory parsed slot entries cache (keyed by slot path + mtime)
interface SlotCacheItem {
  mtimeMs: number
  entries: Map<string, SongMeta>
}
const _slotCache = new Map<string, SlotCacheItem>()

export function invalidateSlotCache(filePath?: string): void {
  if (filePath) {
    _slotCache.delete(filePath)
  } else {
    _slotCache.clear()
  }
}

async function readSlotEntries(filePath: string): Promise<Map<string, SongMeta>> {
  if (!existsSync(filePath)) {
    return new Map()
  }
  try {
    const fileStat = await stat(filePath)
    const cached = _slotCache.get(filePath)
    if (cached && cached.mtimeMs === fileStat.mtimeMs) {
      return cached.entries
    }

    const raw = await readFile(filePath, 'utf-8')
    const map = new Map<string, SongMeta>()
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const item = JSON.parse(trimmed)
        const name = (item.name || '').trim()
        const meta = (item.metadata || item.meta) as SongMeta
        if (name && meta) {
          map.set(name, meta)
        }
      } catch {
        /* skip invalid line */
      }
    }
    _slotCache.set(filePath, { mtimeMs: fileStat.mtimeMs, entries: map })
    return map
  } catch (e) {
    log.warn('Failed to read slot file', { filePath, error: String(e) })
    return new Map()
  }
}

export interface DiscoveredSlot {
  id: string
  name: string
  path: string
  isDefault: boolean
  isBiliDefault: boolean
}

export async function discoverAllSlotFiles(): Promise<DiscoveredSlot[]> {
  await ensureAidjDir()
  const results: DiscoveredSlot[] = []

  // 1. Root default metadata file: music_metadata.jsonl
  results.push({
    id: 'default',
    name: 'music_metadata.jsonl (默认)',
    path: getMetadataPath(),
    isDefault: true,
    isBiliDefault: false
  })

  // 2. Extra metadata folder: ~/.config/LinuxCockpit/aidj/metadata/
  const metaDir = getMetadataDir()
  const biliDefaultPath = getBiliMetadataPath()
  const biliFilename = basename(biliDefaultPath)

  let foundBili = false
  try {
    const files = await readdir(metaDir)
    for (const file of files) {
      const lower = file.toLowerCase()
      if (lower.endsWith('.metadata') || lower.endsWith('.jsonl')) {
        const fullPath = join(metaDir, file)
        const isBili = file === biliFilename
        if (isBili) foundBili = true
        results.push({
          id: file,
          name: file,
          path: fullPath,
          isDefault: false,
          isBiliDefault: isBili
        })
      }
    }
  } catch (e) {
    log.warn('Failed to read metadata dir', { metaDir, error: String(e) })
  }

  // If Bilibili-Current.metadata wasn't in metadata/ yet, include it virtual/placeholder
  if (!foundBili) {
    results.push({
      id: biliFilename,
      name: `${biliFilename} (B站默认)`,
      path: biliDefaultPath,
      isDefault: false,
      isBiliDefault: true
    })
  }

  return results
}

export async function listMetadataSlots(): Promise<{
  slots: MetadataSlotInfo[]
  activeWriteSlot: string
  biliDefaultSlot: string
  totalActiveSongs: number
}> {
  const config = await loadSlotsConfig()
  const activeWriteSlot = config.activeWriteSlot || 'default'
  const biliDefaultSlot = config.biliDefaultSlot || 'Bilibili-Current.metadata'
  const discovered = await discoverAllSlotFiles()

  const slots: MetadataSlotInfo[] = []
  const uniqueActiveSongs = new Set<string>()

  for (const item of discovered) {
    const slotState = config.slots?.[item.id] ?? { enabled: true, disabledSongs: [] }
    const enabled = slotState.enabled !== false
    const disabledSet = new Set(slotState.disabledSongs || [])

    const entriesMap = await readSlotEntries(item.path)
    const totalCount = entriesMap.size
    let selectedCount = 0

    for (const songName of entriesMap.keys()) {
      if (!disabledSet.has(songName)) {
        selectedCount++
        if (enabled) {
          uniqueActiveSongs.add(songName)
        }
      }
    }

    let triState: 'all' | 'partial' | 'none' = 'none'
    if (!enabled || selectedCount === 0) {
      triState = 'none'
    } else if (selectedCount === totalCount && totalCount > 0) {
      triState = 'all'
    } else if (selectedCount > 0 && selectedCount < totalCount) {
      triState = 'partial'
    } else if (totalCount === 0) {
      triState = enabled ? 'all' : 'none'
    }

    const isBiliDefault =
      item.id === biliDefaultSlot ||
      item.name.startsWith(biliDefaultSlot) ||
      (item.isDefault &&
        (biliDefaultSlot === 'default' || biliDefaultSlot === 'music_metadata.jsonl'))

    slots.push({
      id: item.id,
      name: item.name,
      path: item.path,
      isDefault: item.isDefault,
      isBiliDefault,
      isWriteTarget:
        activeWriteSlot === item.id || (item.isDefault && activeWriteSlot === 'default'),
      enabled,
      totalCount,
      selectedCount,
      triState
    })
  }

  return {
    slots,
    activeWriteSlot,
    biliDefaultSlot,
    totalActiveSongs: uniqueActiveSongs.size
  }
}

export async function getMetadataSlotEntries(
  slotId: string,
  filter?: string
): Promise<{
  slot: MetadataSlotInfo | null
  entries: MetadataSlotEntry[]
}> {
  const { slots } = await listMetadataSlots()
  const target = slots.find((s) => s.id === slotId)
  if (!target) return { slot: null, entries: [] }

  const config = await loadSlotsConfig()
  const disabledSet = new Set(config.slots?.[slotId]?.disabledSongs || [])
  const entriesMap = await readSlotEntries(target.path)

  const q = (filter || '').trim().toLowerCase()
  const results: MetadataSlotEntry[] = []

  for (const [name, meta] of entriesMap) {
    if (q) {
      const matchName = name.toLowerCase().includes(q)
      const matchArtist = (meta.review || '').toLowerCase().includes(q)
      const matchGenre = Array.isArray(meta.genre)
        ? meta.genre.some((g) => g.toLowerCase().includes(q))
        : String(meta.genre || '')
            .toLowerCase()
            .includes(q)
      const matchEmotion = Array.isArray(meta.emotion)
        ? meta.emotion.some((e) => e.toLowerCase().includes(q))
        : String(meta.emotion || '')
            .toLowerCase()
            .includes(q)
      if (!matchName && !matchArtist && !matchGenre && !matchEmotion) {
        continue
      }
    }

    results.push({
      name,
      metadata: meta,
      enabled: !disabledSet.has(name)
    })
  }

  return { slot: target, entries: results }
}

export async function toggleMetadataSlot(
  slotId: string,
  targetEnabled?: boolean
): Promise<{ ok: boolean; slots: MetadataSlotInfo[]; totalActiveSongs: number }> {
  const config = await loadSlotsConfig()
  if (!config.slots) config.slots = {}
  if (!config.slots[slotId]) config.slots[slotId] = { enabled: true, disabledSongs: [] }

  const curState = config.slots[slotId]
  if (typeof targetEnabled === 'boolean') {
    curState.enabled = targetEnabled
    if (targetEnabled) {
      curState.disabledSongs = []
    }
  } else {
    // Tri-state flip
    if (curState.enabled === false) {
      curState.enabled = true
      curState.disabledSongs = []
    } else if (curState.disabledSongs && curState.disabledSongs.length > 0) {
      // Partial -> All
      curState.enabled = true
      curState.disabledSongs = []
    } else {
      // All -> None
      curState.enabled = false
    }
  }

  await saveSlotsConfig(config)
  const result = await listMetadataSlots()
  return { ok: true, slots: result.slots, totalActiveSongs: result.totalActiveSongs }
}

export async function toggleMetadataSlotItem(
  slotId: string,
  songName: string,
  enabled: boolean
): Promise<{
  ok: boolean
  selectedCount: number
  triState: 'all' | 'partial' | 'none'
  totalActiveSongs: number
}> {
  const config = await loadSlotsConfig()
  if (!config.slots) config.slots = {}
  if (!config.slots[slotId]) config.slots[slotId] = { enabled: true, disabledSongs: [] }

  const slotState = config.slots[slotId]
  const disabledSet = new Set(slotState.disabledSongs || [])

  if (enabled) {
    disabledSet.delete(songName)
    slotState.enabled = true
  } else {
    disabledSet.add(songName)
  }
  slotState.disabledSongs = Array.from(disabledSet)

  await saveSlotsConfig(config)
  const { slots, totalActiveSongs } = await listMetadataSlots()
  const updatedSlot = slots.find((s) => s.id === slotId)

  return {
    ok: true,
    selectedCount: updatedSlot?.selectedCount ?? 0,
    triState: updatedSlot?.triState ?? 'none',
    totalActiveSongs
  }
}

export async function toggleMetadataSlotAllItems(
  slotId: string,
  enableAll: boolean
): Promise<{
  ok: boolean
  selectedCount: number
  triState: 'all' | 'partial' | 'none'
  totalActiveSongs: number
}> {
  const config = await loadSlotsConfig()
  if (!config.slots) config.slots = {}
  if (!config.slots[slotId]) config.slots[slotId] = { enabled: true, disabledSongs: [] }

  const discovered = await discoverAllSlotFiles()
  const match = discovered.find((s) => s.id === slotId)
  const entriesMap = match ? await readSlotEntries(match.path) : new Map()

  if (enableAll) {
    config.slots[slotId].enabled = true
    config.slots[slotId].disabledSongs = []
  } else {
    config.slots[slotId].enabled = false
    config.slots[slotId].disabledSongs = Array.from(entriesMap.keys())
  }

  await saveSlotsConfig(config)
  const { slots, totalActiveSongs } = await listMetadataSlots()
  const updatedSlot = slots.find((s) => s.id === slotId)

  return {
    ok: true,
    selectedCount: updatedSlot?.selectedCount ?? 0,
    triState: updatedSlot?.triState ?? 'none',
    totalActiveSongs
  }
}

export async function createMetadataSlot(
  rawName: string
): Promise<{ ok: boolean; error?: string; slot?: MetadataSlotInfo }> {
  const trimmed = rawName.trim().replace(/[/\\?%*:|"<>]/g, '_')
  if (!trimmed) {
    return { ok: false, error: '槽位名称不能为空' }
  }
  const filename =
    trimmed.endsWith('.metadata') || trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.metadata`

  const metaDir = getMetadataDir()
  await ensureAidjDir()
  const filePath = join(metaDir, filename)

  if (existsSync(filePath)) {
    return { ok: false, error: `槽位文件已存在: ${filename}` }
  }

  try {
    await writeFile(filePath, '', 'utf-8')
    invalidateSlotCache(filePath)

    const config = await loadSlotsConfig()
    if (!config.slots) config.slots = {}
    config.slots[filename] = { enabled: true, disabledSongs: [] }
    await saveSlotsConfig(config)

    const { slots } = await listMetadataSlots()
    const slot = slots.find((s) => s.id === filename)
    return { ok: true, slot }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, error }
  }
}

export async function deleteMetadataSlot(slotId: string): Promise<{ ok: boolean; error?: string }> {
  if (slotId === 'default' || slotId === 'music_metadata.jsonl') {
    return { ok: false, error: '不能删除默认元数据文件' }
  }

  const metaDir = getMetadataDir()
  const filePath = join(metaDir, slotId)
  if (existsSync(filePath)) {
    try {
      // Soft-delete: rename to .deleted so local data is preserved and user can manually purge
      let backupPath = `${filePath}.deleted`
      if (existsSync(backupPath)) {
        backupPath = `${filePath}.${Date.now()}.deleted`
      }
      await rename(filePath, backupPath)
      log.info('Metadata slot safely renamed to .deleted', { filePath, backupPath })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { ok: false, error }
    }
  }

  invalidateSlotCache(filePath)
  const config = await loadSlotsConfig()
  if (config.slots && config.slots[slotId]) {
    delete config.slots[slotId]
  }
  if (config.activeWriteSlot === slotId) {
    config.activeWriteSlot = 'default'
  }
  if (config.biliDefaultSlot === slotId) {
    config.biliDefaultSlot = 'Bilibili-Current.metadata'
  }
  await saveSlotsConfig(config)

  return { ok: true }
}

export async function setActiveWriteSlot(
  slotId: string
): Promise<{ ok: boolean; activeWriteSlot: string }> {
  const config = await loadSlotsConfig()
  config.activeWriteSlot = slotId || 'default'
  await saveSlotsConfig(config)
  return { ok: true, activeWriteSlot: config.activeWriteSlot }
}

export async function setBiliDefaultSlot(
  slotId: string
): Promise<{ ok: boolean; biliDefaultSlot: string }> {
  const config = await loadSlotsConfig()
  config.biliDefaultSlot = slotId || 'Bilibili-Current.metadata'
  await saveSlotsConfig(config)
  return { ok: true, biliDefaultSlot: config.biliDefaultSlot }
}

export async function getBiliDefaultSlotName(): Promise<string> {
  const config = await loadSlotsConfig()
  return config.biliDefaultSlot || 'Bilibili-Current.metadata'
}

export async function getActiveWriteSlotPath(overrideSlotId?: string): Promise<string> {
  const targetId = overrideSlotId || (await loadSlotsConfig()).activeWriteSlot || 'default'
  if (targetId === 'default' || targetId === 'music_metadata.jsonl') {
    return getMetadataPath()
  }
  return join(getMetadataDir(), targetId)
}

/**
 * Load all enabled metadata from all slots, respecting song exclusions.
 */
export async function loadAllActiveMetadata(): Promise<Map<string, SongMeta>> {
  const config = await loadSlotsConfig()
  const discovered = await discoverAllSlotFiles()
  const merged = new Map<string, SongMeta>()

  for (const item of discovered) {
    const slotState = config.slots?.[item.id] ?? { enabled: true, disabledSongs: [] }
    if (slotState.enabled === false) continue

    const disabledSet = new Set(slotState.disabledSongs || [])
    const entriesMap = await readSlotEntries(item.path)
    for (const [name, meta] of entriesMap) {
      if (!disabledSet.has(name)) {
        merged.set(name, meta)
      }
    }
  }

  return merged
}
