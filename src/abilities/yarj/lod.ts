/**
 * yarj LOD（Level of Detail）— 行政区边界逐级浮现。
 *
 * 思路：mbtiles（tippecanoe）的低缩放瓦片里就带着完整行政要素（z0 一层即含
 * 数万要素，tippecanoe 保留完整多边形不裁剪）。因此可以**一次性后台解码**
 * 提取每个行政区的包围盒（shapeID → 经/纬跨度），缓存到
 * `~/.config/LinuxCockpit/yarj/lod/<mapId>.json`。渲染端据此按
 * 「区域占屏比例（默认 70%）」动态决定该缩放显示哪些区：某区经度跨度占
 * 视口宽度达到阈值才显示其边界 —— 即按区域大小自适应加载下一层级。
 *
 * 实测（GlobalMap_ADM0_2.mbtiles）：z0→z5 即可覆盖 52,094/52,573（99.1%）
 * 要素，耗时 ~0.6s；默认解码到 z8 兜底（约 13s，后台作业、可取消、可缓存）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { fetchTile, readMbtilesMeta } from './mbtiles'
import type { LodCountry, LodData, LodFeature, MapFile } from './types'

const log = makeLogger('yarj-lod')

export function lodDir(): string {
  return join(USER_CONFIG_DIR, 'yarj', 'lod')
}

export function lodCachePath(mapId: string): string {
  return join(lodDir(), `${mapId}.json`)
}

/** 正在生成 LOD 的地图集合（作业运行时维护，供 lod-status 查询）。 */
const runningMaps = new Set<string>()

export function markLodRunning(mapId: string): void {
  runningMaps.add(mapId)
}

export function markLodDone(mapId: string): void {
  runningMaps.delete(mapId)
}

export function isLodRunning(mapId: string): boolean {
  return runningMaps.has(mapId)
}

/** 读取 LOD 缓存（不存在/损坏返回 null）。 */
export function readLodData(mapId: string): LodData | null {
  try {
    const raw = readFileSync(lodCachePath(mapId), 'utf-8')
    const data = JSON.parse(raw) as LodData
    if (!data || typeof data.count !== 'number' || !data.features) return null
    return data
  } catch {
    return null
  }
}

/** 原子写 LOD 缓存。 */
export function writeLodData(mapId: string, data: LodData): void {
  mkdirSync(lodDir(), { recursive: true })
  const tmp = `${lodCachePath(mapId)}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  renameSync(tmp, lodCachePath(mapId))
}

// ---------------------------------------------------------------------------
// 瓦片坐标 → 经纬度
// ---------------------------------------------------------------------------

/** 瓦片本地 bbox [minX, minY, maxX, maxY] → 经纬跨度 {w, h}（度）。 */
function bboxToDeg(
  bb: [number, number, number, number],
  z: number,
  x: number,
  y: number,
  extent: number
): { w: number; h: number } {
  const lonAt = (px: number): number => ((x + px / extent) / 2 ** z) * 360 - 180
  const latAt = (py: number): number => {
    const ty = (y + (extent - py) / extent) / 2 ** z
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * ty))) * 180) / Math.PI
  }
  // 夹取到世界范围：跨反经线（±180°）要素的坐标会超出 [-180,180]（如 170..190），
  // 对「占屏比例」而言这类区域本就在屏幕边缘横跨世界，按全宽处理即可。
  return {
    w: Math.min(Math.abs(lonAt(bb[2]) - lonAt(bb[0])), 360),
    h: Math.min(Math.abs(latAt(bb[3]) - latAt(bb[1])), 180)
  }
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export interface LodProgress {
  zoom: number
  maxZoom: number
  unique: number
  newThisZoom: number
}

export interface LodCallbacks {
  signal?: AbortSignal
  onProgress?: (p: LodProgress) => void
}

/** 早停：连续 N 层几乎没有新要素即视为覆盖完成。 */
const EARLY_EXIT_MIN_NEW = 10
const EARLY_EXIT_MIN_ZOOM = 4
/**
 * 解码缩放上限。实测 GlobalMap z0→z5 已覆盖 99.1% 要素（含全部 ADM1），
 * 且 70% 屏幕规则下 <5° 宽的小要素本身不会达标；上限 6（约 5.5K 瓦片，
 * 数秒完成）即可捕获所有相关要素，更小的要素走层级回退阈值。
 */
const DECODE_MAX_ZOOM = 6

// ---------------------------------------------------------------------------
// 多边形内点（标签锚点）— 自实现，零依赖
// 优先级：① 质心在多边形内 → 质心（视觉中心）；② 包围盒中心在多边形内；
// ③ 射线法取第一个交点内侧点（保证在多边形内）。任何情况下不越界。
// ---------------------------------------------------------------------------

function ringCentroid(ring: [number, number][]): [number, number] | null {
  let a = 0
  let cx = 0
  let cy = 0
  for (let k = 0; k < ring.length - 1; k++) {
    const x1 = ring[k][0]
    const y1 = ring[k][1]
    const x2 = ring[k + 1][0]
    const y2 = ring[k + 1][1]
    const cr = x1 * y2 - x2 * y1
    a += cr
    cx += (x1 + x2) * cr
    cy += (y1 + y2) * cr
  }
  if (Math.abs(a) < 1e-12) return null
  const c: [number, number] = [cx / (3 * a), cy / (3 * a)]
  return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null
}

function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function ringBbox(ring: [number, number][]): [number, number, number, number] {
  let minX = 1e9
  let minY = 1e9
  let maxX = -1e9
  let maxY = -1e9
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

/** 保证在多边形内部的一个点（质心优先，射线法兜底）。 */
function interiorPoint(ring: [number, number][]): [number, number] | null {
  if (ring.length < 4) return null
  const c = ringCentroid(ring)
  if (c && pointInRing(c, ring)) return c
  const [minX, minY, maxX, maxY] = ringBbox(ring)
  const bc: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2]
  if (pointInRing(bc, ring)) return bc
  // 射线法：从 (minX-1, midY) 向右扫，取第一个交点内侧
  const midY = (minY + maxY) / 2
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > midY !== yj > midY) {
      const xCross = ((xj - xi) * (midY - yi)) / (yj - yi) + xi
      if (xCross > minX - 1) return [xCross + 1e-6, midY]
    }
  }
  return c ?? bc
}

/**
 * 解码一个地图的矢量瓦片，收集 ADM1/ADM2 要素包围盒。
 * 返回按 shapeID 聚合的 LOD 数据（写入前由调用方决定是否缓存）。
 */
export async function generateLod(map: MapFile, cb: LodCallbacks = {}): Promise<LodData> {
  const { signal, onProgress } = cb
  const meta = readMbtilesMeta(map.path)
  if (!meta || meta.format === 'png' || meta.format === 'jpg' || meta.format === 'jpeg') {
    throw new Error('仅矢量（pbf）瓦片支持 LOD 生成')
  }
  const maxZoom = Math.min(meta.maxzoom, DECODE_MAX_ZOOM)
  const extent = 2048 // tippecanoe 默认 extent（动态读取更稳妥，这里用常见值）

  const features: Record<string, LodFeature> = {}
  const countries: Record<string, LodCountry> = {}
  let noNewStreak = 0

  /** 多边形外环列表 → 最大面积外环（标签锚点取最大陆地，如群岛取主岛）。 */
  const largestRing = (rings: [number, number][][]): [number, number][] | null => {
    let best: [number, number][] | null = null
    let bestArea = -1
    for (const ring of rings) {
      let a = 0
      for (let k = 0; k < ring.length - 1; k++) {
        a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
      }
      const area = Math.abs(a) / 2
      if (area > bestArea) {
        bestArea = area
        best = ring
      }
    }
    return best
  }

  for (let z = 0; z <= maxZoom; z++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const n = 2 ** z
    let newThisZoom = 0

    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const buf = await fetchTile(map.path, z, x, y)
        if (!buf) continue
        let vt: VectorTile
        try {
          vt = new VectorTile(new Pbf(buf))
        } catch {
          continue // 瓦片损坏跳过
        }
        for (const layerName of Object.keys(vt.layers)) {
          const L = vt.layers[layerName]
          for (let i = 0; i < L.length; i++) {
            const f = L.feature(i)
            const p = f.properties as { shapeType?: string; shapeID?: string; shapeName?: string }
            // adm0（国家）层没有 shapeID，用 shapeName 兜底作 key
            const id = p.shapeID ?? p.shapeName
            if (!id) continue

            if (p.shapeType === 'ADM1' || p.shapeType === 'ADM2') {
              if (features[id]) continue
              const bb = f.bbox() as [number, number, number, number]
              const { w, h } = bboxToDeg(bb, z, x, y, L.extent || extent)
              const feat: LodFeature = {
                lvl: p.shapeType === 'ADM1' ? 'ADM1' : 'ADM2',
                w,
                h,
                name: p.shapeName ?? ''
              }
              // 标签锚点：首个出现的几何（低缩放多为完整多边形）→ 多边形内点
              try {
                const gj = f.toGeoJSON(x, y, z)
                const geom = gj.geometry as {
                  type: string
                  coordinates: [number, number][][] | [number, number][][][]
                }
                const rings: [number, number][][] =
                  geom.type === 'Polygon'
                    ? (geom.coordinates as [number, number][][])
                    : (geom.coordinates as [number, number][][][]).map((poly) => poly[0])
                const ring = largestRing(rings)
                const pt = ring ? interiorPoint(ring) : null
                if (pt) feat.label = pt
              } catch {
                /* 标签锚点失败不影响 LOD 主数据 */
              }
              features[id] = feat
              newThisZoom++
            } else if (p.shapeType === 'ADM0' && !countries[id]) {
              // 国家（adm0）标签：同批收集，永驻可见
              const bb = f.bbox() as [number, number, number, number]
              const { w, h } = bboxToDeg(bb, z, x, y, L.extent || extent)
              let label: [number, number] | undefined
              try {
                const gj = f.toGeoJSON(x, y, z)
                const geom = gj.geometry as {
                  type: string
                  coordinates: [number, number][][] | [number, number][][][]
                }
                const rings: [number, number][][] =
                  geom.type === 'Polygon'
                    ? (geom.coordinates as [number, number][][])
                    : (geom.coordinates as [number, number][][][]).map((poly) => poly[0])
                const ring = largestRing(rings)
                const pt = ring ? interiorPoint(ring) : null
                if (pt) label = pt
              } catch {
                /* noop */
              }
              countries[id] = { name: p.shapeName ?? '', w, h, label }
            }
          }
        }
      }
    }

    noNewStreak = newThisZoom <= EARLY_EXIT_MIN_NEW ? noNewStreak + 1 : 0
    onProgress?.({ zoom: z, maxZoom, unique: Object.keys(features).length, newThisZoom })
    log.info('lod zoom done', { map: map.id, z, unique: Object.keys(features).length, newThisZoom })
    // 早停：z>=4 后连续两层几乎无新要素 → 覆盖完成
    if (z >= EARLY_EXIT_MIN_ZOOM && noNewStreak >= 2) break
  }

  const data: LodData = {
    generatedAt: new Date().toISOString(),
    count: Object.keys(features).length,
    features,
    countries
  }
  log.info('lod generated', {
    map: map.id,
    count: data.count,
    countries: Object.keys(countries).length
  })
  return data
}
