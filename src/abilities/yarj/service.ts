/**
 * yarj 服务 — 能力配置（config.json）读写 + 统计聚合。
 * 配置路径：~/.config/LinuxCockpit/yarj/config.json（abilityConfigPath 约定）。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { abilityConfigPath } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import type {
  GeocodeResult,
  LodStatus,
  MapFileInfo,
  ProviderItem,
  ReverseGeocodeResult,
  ScanStats,
  TileCacheStats,
  YarjConfig
} from './types'
import { GRANULARITY_PRESETS } from './types'
import {
  getMetadataDb,
  photoCount,
  photoCountByRoot,
  photoGpsCount,
  pruneDeletedPhotos,
  pruneOrphanedRoots,
  recentScanRuns
} from './db'
import { readMbtilesMeta } from './mbtiles'
import { isLodRunning, readLodData } from './lod'
import { isHierarchyRunning, readHierarchy } from './hierarchy'

import { BUILTIN_PROVIDERS, DEFAULT_GOOGLE_API_KEY } from './providers'
import {
  clearTileCache,
  getTileCacheStats as getTileCacheStatsRaw,
  pruneTileCacheLRU
} from './tile-cache'

const log = makeLogger('yarj')

const DEFAULT_CONFIG: YarjConfig = {
  galleryRoots: [],
  maps: [],
  activeProviderId: 'google-hybrid',
  googleApiKey: DEFAULT_GOOGLE_API_KEY,
  tiandituApiKey: '',
  customUrlTemplate: '',
  customSubdomains: ['0', '1', '2', '3'],
  enableTileCache: true,
  maxTileCacheMb: 1024,
  mapLanguage: 'auto',
  showPhotosLayer: true,
  showExploredLayer: true,
  exploredRadiusM: 60,
  exploredGranularity: 'standard',
  detailMinZoom: 4,
  adm1MinZoom: 4,
  adm2MinZoom: 6,
  lodScreenFraction: 0.2,
  lastView: null
}

let cached: YarjConfig | null = null

export function yarjConfigPath(): string {
  return abilityConfigPath('yarj')
}

/** 读取配置（内存缓存；缺省合并默认值，坏 JSON 回落默认并记日志）。 */
export async function loadYarjConfig(): Promise<YarjConfig> {
  if (cached) return cached
  let file: string | null = null
  try {
    file = await readFile(yarjConfigPath(), 'utf-8')
  } catch {
    cached = structuredClone(DEFAULT_CONFIG)
    return cached
  }
  try {
    const parsed = JSON.parse(file) as Partial<YarjConfig>
    cached = {
      galleryRoots: Array.isArray(parsed.galleryRoots) ? parsed.galleryRoots : [],
      maps: Array.isArray(parsed.maps) ? parsed.maps : [],
      activeProviderId:
        typeof parsed.activeProviderId === 'string' && parsed.activeProviderId
          ? parsed.activeProviderId
          : 'google-hybrid',
      googleApiKey:
        typeof parsed.googleApiKey === 'string' ? parsed.googleApiKey : DEFAULT_GOOGLE_API_KEY,
      tiandituApiKey: typeof parsed.tiandituApiKey === 'string' ? parsed.tiandituApiKey : '',
      customUrlTemplate:
        typeof parsed.customUrlTemplate === 'string' ? parsed.customUrlTemplate : '',
      customSubdomains: Array.isArray(parsed.customSubdomains)
        ? parsed.customSubdomains
        : ['0', '1', '2', '3'],
      enableTileCache: parsed.enableTileCache !== false,
      maxTileCacheMb:
        typeof parsed.maxTileCacheMb === 'number' && parsed.maxTileCacheMb >= 0
          ? parsed.maxTileCacheMb
          : 1024,
      mapLanguage: typeof parsed.mapLanguage === 'string' ? parsed.mapLanguage : 'auto',
      showPhotosLayer: parsed.showPhotosLayer !== false,
      showExploredLayer: parsed.showExploredLayer !== false,
      exploredRadiusM:
        typeof parsed.exploredRadiusM === 'number' && parsed.exploredRadiusM < 400
          ? parsed.exploredRadiusM
          : 60,
      exploredGranularity:
        parsed.exploredGranularity && parsed.exploredGranularity in GRANULARITY_PRESETS
          ? parsed.exploredGranularity
          : 'standard',
      detailMinZoom: typeof parsed.detailMinZoom === 'number' ? parsed.detailMinZoom : 4,
      adm1MinZoom: typeof parsed.adm1MinZoom === 'number' ? parsed.adm1MinZoom : 4,
      adm2MinZoom: typeof parsed.adm2MinZoom === 'number' ? parsed.adm2MinZoom : 6,
      lodScreenFraction:
        typeof parsed.lodScreenFraction === 'number' ? parsed.lodScreenFraction : 0.2,
      lastView: parsed.lastView ?? null
    }
  } catch (err) {
    log.warn('config.json 解析失败，回落默认', { error: String(err) })
    cached = structuredClone(DEFAULT_CONFIG)
  }
  return cached
}

export function invalidateYarjConfig(): void {
  cached = null
}

/** 保存配置（patch 合并；写临时文件 + rename 原子替换）。 */
export async function saveYarjConfig(patch: Partial<YarjConfig>): Promise<YarjConfig> {
  const next = { ...(await loadYarjConfig()), ...patch }
  const path = yarjConfigPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
  await rename(tmp, path)
  cached = next
  if (typeof patch.maxTileCacheMb === 'number' && patch.maxTileCacheMb > 0) {
    void pruneTileCacheLRU(patch.maxTileCacheMb * 1024 * 1024)
  }
  return next
}

// ---------------------------------------------------------------------------
// 图库目录
// ---------------------------------------------------------------------------

export async function addGalleryRoot(path: string): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  if (cfg.galleryRoots.some((r) => r.path === path)) return cfg
  return saveYarjConfig({ galleryRoots: [...cfg.galleryRoots, { path, watch: false }] })
}

export async function removeGalleryRoot(path: string): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  return saveYarjConfig({ galleryRoots: cfg.galleryRoots.filter((r) => r.path !== path) })
}

export async function moveGalleryRoot(path: string, dir: -1 | 1): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  const idx = cfg.galleryRoots.findIndex((r) => r.path === path)
  if (idx < 0) return cfg
  const target = idx + dir
  if (target < 0 || target >= cfg.galleryRoots.length) return cfg
  const roots = [...cfg.galleryRoots]
  ;[roots[idx], roots[target]] = [roots[target], roots[idx]]
  return saveYarjConfig({ galleryRoots: roots })
}

// ---------------------------------------------------------------------------
// 地图文件
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** 添加地图：校验 SQLite 头 + 读取元数据；id 自动生成（文件名+短哈希）。 */
export async function addMapFile(
  path: string,
  id?: string
): Promise<{ maps: MapFileInfo[]; error?: string }> {
  const meta = await readMbtilesMeta(path)
  if (!meta) {
    return { maps: await listMaps(), error: '不是有效的 MBTiles 文件（缺少 tiles/map 表）' }
  }
  const cfg = await loadYarjConfig()
  const base = path.split('/').pop() ?? 'map'
  const autoId = `${base.replace(/\.mbtiles$/i, '')}-${shortHash(path)}`
  const finalId = (id ?? autoId).replace(/[^a-zA-Z0-9_-]/g, '-')
  if (cfg.maps.some((m) => m.id === finalId || m.path === path)) {
    return { maps: await listMaps(), error: '该地图文件已添加' }
  }
  await saveYarjConfig({
    maps: [
      ...cfg.maps,
      { id: finalId, path, defaultZoom: Math.min(meta.maxzoom, 2), enabled: true }
    ]
  })
  return { maps: await listMaps() }
}

export async function removeMapFile(id: string): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  return saveYarjConfig({ maps: cfg.maps.filter((m) => m.id !== id) })
}

export async function setMapZoom(id: string, zoom: number): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  const maps = cfg.maps.map((m) => (m.id === id ? { ...m, defaultZoom: zoom } : m))
  return saveYarjConfig({ maps })
}

export async function setMapEnabled(id: string, enabled: boolean): Promise<YarjConfig> {
  const cfg = await loadYarjConfig()
  const maps = cfg.maps.map((m) => (m.id === id ? { ...m, enabled } : m))
  return saveYarjConfig({ maps })
}

/** 所有已配置地图 + 实时 mbtiles 元数据（读失败给 error 字段，不影响列表）。 */
export async function listMaps(): Promise<MapFileInfo[]> {
  const cfg = await loadYarjConfig()
  const out: MapFileInfo[] = []
  for (const m of cfg.maps) {
    let meta: ReturnType<typeof readMbtilesMeta> = null
    try {
      meta = readMbtilesMeta(m.path)
    } catch (err) {
      log.warn('read mbtiles meta failed', { path: m.path, error: String(err) })
    }
    out.push(
      meta
        ? {
            ...m,
            minzoom: meta.minzoom,
            maxzoom: meta.maxzoom,
            format: meta.format,
            bounds: meta.bounds,
            center: meta.center,
            tileCount: meta.tileCount,
            vectorLayers: meta.vectorLayers
          }
        : { ...m, error: '读取失败' }
    )
  }
  return out
}

export async function mapInfo(id: string): Promise<MapFileInfo | null> {
  const cfg = await loadYarjConfig()
  const m = cfg.maps.find((x) => x.id === id)
  if (!m) return null
  let meta: ReturnType<typeof readMbtilesMeta> = null
  try {
    meta = readMbtilesMeta(m.path)
  } catch {
    /* 下方按读取失败处理 */
  }
  return meta
    ? {
        ...m,
        minzoom: meta.minzoom,
        maxzoom: meta.maxzoom,
        format: meta.format,
        bounds: meta.bounds,
        center: meta.center,
        tileCount: meta.tileCount,
        vectorLayers: meta.vectorLayers
      }
    : { ...m, error: '读取失败' }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export async function scanStats(): Promise<ScanStats> {
  return {
    photoCount: photoCount(),
    withGps: photoGpsCount(),
    byRoot: photoCountByRoot(),
    lastRuns: recentScanRuns(10)
  }
}

/** 手动清理数据库中在磁盘上已不存在的照片记录。 */
export async function pruneMissingPhotos(): Promise<{ ok: boolean; deletedCount: number }> {
  const cfg = await loadYarjConfig()
  const validRootPaths = cfg.galleryRoots.map((r) => r.path)

  let deletedCount = 0
  // 1. 清理已在设置中删除的孤立图库目录
  deletedCount += pruneOrphanedRoots(validRootPaths)

  // 2. 对每个有效图库目录，比对数据库与磁盘实际文件
  const db = getMetadataDb()
  for (const root of validRootPaths) {
    try {
      const rows = db.prepare('SELECT path FROM photos WHERE root = ?').all(root) as {
        path: string
      }[]
      if (!rows.length) continue

      const existingPaths = new Set<string>()
      for (const r of rows) {
        try {
          await stat(r.path)
          existingPaths.add(r.path)
        } catch {
          // 文件在磁盘已不存在
        }
      }
      deletedCount += pruneDeletedPhotos(root, existingPaths)
    } catch (err) {
      log.warn('prune root failed', { root, error: String(err) })
    }
  }

  log.info('pruneMissingPhotos completed', { deletedCount })
  return { ok: true, deletedCount }
}

// ---------------------------------------------------------------------------
// LOD 状态
// ---------------------------------------------------------------------------

/** 各地图 LOD 生成状态（缓存是否存在 + 作业是否运行中）。 */
export async function lodStatus(): Promise<LodStatus[]> {
  const cfg = await loadYarjConfig()
  return cfg.maps.map((m) => {
    const data = readLodData(m.id)
    return {
      mapId: m.id,
      ready: !!data,
      count: data?.count ?? 0,
      generatedAt: data?.generatedAt ?? null,
      running: isLodRunning(m.id)
    }
  })
}

// ---------------------------------------------------------------------------
// 行政归属（市/县 → 省）状态
// ---------------------------------------------------------------------------

export interface HierarchyStatus {
  mapId: string
  ready: boolean
  count: number
  unmatched: number
  generatedAt: string | null
  running: boolean
}

/** 各地图行政归属生成状态。 */
export async function hierarchyStatus(): Promise<HierarchyStatus[]> {
  const cfg = await loadYarjConfig()
  return cfg.maps.map((m) => {
    const data = readHierarchy(m.id)
    return {
      mapId: m.id,
      ready: !!data,
      count: data ? Object.keys(data.adm2).length : 0,
      unmatched: data?.unmatched.length ?? 0,
      generatedAt: data?.generatedAt ?? null,
      running: isHierarchyRunning(m.id)
    }
  })
}

// ---------------------------------------------------------------------------
// 图源（Providers）管理与切换
// ---------------------------------------------------------------------------

export type { ProviderItem }

export async function listProviders(): Promise<{
  activeId: string
  providers: ProviderItem[]
}> {
  const cfg = await loadYarjConfig()
  const list: ProviderItem[] = BUILTIN_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    type: p.type,
    maxZoom: p.maxZoom,
    minZoom: p.minZoom,
    tileSize: p.tileSize,
    isCustom: p.id === 'custom',
    attribution: p.attribution
  }))

  // 合并本地已添加且启用的 MBTiles 地图
  for (const m of cfg.maps) {
    if (!m.enabled) continue
    const baseName =
      m.path
        .split('/')
        .pop()
        ?.replace(/\.mbtiles$/i, '') || m.id
    list.push({
      id: `local:${m.id}`,
      name: `本地 · ${baseName}`,
      category: 'mbtiles',
      type: 'vector',
      isLocal: true,
      maxZoom: 14,
      minZoom: 0
    })
  }

  return {
    activeId: cfg.activeProviderId || 'google-hybrid',
    providers: list
  }
}

export async function setActiveProvider(id: string): Promise<YarjConfig> {
  log.info('switch active map provider', { id })
  return saveYarjConfig({ activeProviderId: id })
}

// ---------------------------------------------------------------------------
// 谷歌 / Nominatim 地理编码服务（Forward & Reverse Geocoding）
// ---------------------------------------------------------------------------

export async function forwardGeocode(query: string, lang?: string): Promise<GeocodeResult[]> {
  const cfg = await loadYarjConfig()
  const apiKey = cfg.googleApiKey?.trim()
  const targetLang = lang || cfg.mapLanguage || 'zh-CN'

  // 1. 如果配置了 Google API Key，优先使用 Google Geocoding API
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}&language=${encodeURIComponent(targetLang)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const json = (await res.json()) as {
          status: string
          results?: Array<{
            formatted_address: string
            geometry: { location: { lat: number; lng: number } }
            place_id?: string
          }>
        }
        if (json.status === 'OK' && Array.isArray(json.results) && json.results.length > 0) {
          return json.results.map((r) => ({
            formattedAddress: r.formatted_address,
            lat: r.geometry.location.lat,
            lon: r.geometry.location.lng,
            placeId: r.place_id,
            provider: 'google'
          }))
        }
      }
    } catch (err) {
      log.warn('google forward geocode failed, falling back', { error: String(err) })
    }
  }

  // 2. Fallback: OpenStreetMap Nominatim API
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=${encodeURIComponent(targetLang)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LinuxCockpit/0.1.0' },
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const json = (await res.json()) as Array<{
        display_name: string
        lat: string
        lon: string
        place_id?: number
      }>
      if (Array.isArray(json)) {
        return json.map((r) => ({
          formattedAddress: r.display_name,
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          placeId: r.place_id ? String(r.place_id) : undefined,
          provider: 'nominatim'
        }))
      }
    }
  } catch (err) {
    log.error('nominatim forward geocode failed', { error: String(err) })
  }

  return []
}

export async function reverseGeocode(
  lat: number,
  lon: number,
  lang?: string
): Promise<ReverseGeocodeResult | null> {
  const cfg = await loadYarjConfig()
  const apiKey = cfg.googleApiKey?.trim()
  const targetLang = lang || cfg.mapLanguage || 'zh-CN'

  // 1. 优先 Google Reverse Geocoding
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}&language=${encodeURIComponent(targetLang)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const json = (await res.json()) as {
          status: string
          results?: Array<{
            formatted_address: string
            place_id?: string
            address_components?: Array<{
              long_name: string
              types: string[]
            }>
          }>
        }
        if (json.status === 'OK' && Array.isArray(json.results) && json.results.length > 0) {
          const top = json.results[0]
          const cityComp = top.address_components?.find(
            (c) =>
              c.types.includes('locality') ||
              c.types.includes('administrative_area_level_2') ||
              c.types.includes('administrative_area_level_1')
          )
          const countryComp = top.address_components?.find((c) => c.types.includes('country'))
          return {
            formattedAddress: top.formatted_address,
            city: cityComp?.long_name,
            country: countryComp?.long_name,
            placeId: top.place_id,
            provider: 'google'
          }
        }
      }
    } catch (err) {
      log.warn('google reverse geocode failed, falling back', { error: String(err) })
    }
  }

  // 2. Fallback: OpenStreetMap Nominatim Reverse
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=${encodeURIComponent(targetLang)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LinuxCockpit/0.1.0' },
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const json = (await res.json()) as {
        display_name?: string
        place_id?: number
        address?: {
          city?: string
          town?: string
          village?: string
          state?: string
          country?: string
        }
      }
      if (json.display_name) {
        return {
          formattedAddress: json.display_name,
          city:
            json.address?.city ||
            json.address?.town ||
            json.address?.village ||
            json.address?.state,
          country: json.address?.country,
          placeId: json.place_id ? String(json.place_id) : undefined,
          provider: 'nominatim'
        }
      }
    }
  } catch (err) {
    log.error('nominatim reverse geocode failed', { error: String(err) })
  }

  return null
}

export async function getTileCacheStats(): Promise<TileCacheStats> {
  const cfg = await loadYarjConfig()
  const maxMb = cfg.maxTileCacheMb ?? 1024
  return getTileCacheStatsRaw(maxMb)
}

export { clearTileCache }
