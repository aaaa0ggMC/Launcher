/**
 * yarj 行政区归属（市/县 → 省）推导。
 *
 * 数据事实：mbtiles 的 `adm1_2` 图层把 ADM1（省）与 ADM2（市/县）平级存放，
 * ADM2 要素只带国家代码（shapeGroup）与自身 name/id，**没有父级省字段**。
 * 归属关系通过空间包含推导：对每个 ADM2 取代表点（质心），找包含它的 ADM1 多边形。
 *
 * 实现要点：
 *  - ADM1 大省在高缩放会被 tippecanoe 按瓦片裁剪 → 用「碎片并集」测试
 *    （点落在某省任一碎片内 = 落在该省内），从 z4–z6 瓦片收集全部碎片。
 *  - 同国过滤（shapeGroup）大幅减少候选并杜绝跨国家误配。
 *  - 5°×5° 网格索引加速点面包含；兜底链：质心 → 包围盒中心 → 最近省。
 *  - 结果缓存到 `~/.config/LinuxCockpit/yarj/hierarchy/<mapId>.json`。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { fetchTile, readMbtilesMeta } from './mbtiles'
import type { MapFile } from './types'

const log = makeLogger('yarj-hierarchy')

export interface HierarchyData {
  generatedAt: string
  /** adm2Id → 所属省。 */
  adm2: Record<string, { adm1Id: string; adm1Name: string }>
  /** adm1Id → 省信息 + 下属市/县 id 列表（反向索引）。 */
  adm1: Record<string, { name: string; adm2Ids: string[] }>
  /** 兜底仍未归属的 ADM2（岛屿/海岸等），数量应很小。 */
  unmatched: string[]
}

export function hierarchyDir(): string {
  return join(USER_CONFIG_DIR, 'yarj', 'hierarchy')
}

export function hierarchyCachePath(mapId: string): string {
  return join(hierarchyDir(), `${mapId}.json`)
}

export function readHierarchy(mapId: string): HierarchyData | null {
  try {
    const raw = readFileSync(hierarchyCachePath(mapId), 'utf-8')
    const data = JSON.parse(raw) as HierarchyData
    if (!data || !data.adm2 || !data.adm1) return null
    return data
  } catch {
    return null
  }
}

export function writeHierarchy(mapId: string, data: HierarchyData): void {
  mkdirSync(hierarchyDir(), { recursive: true })
  const tmp = `${hierarchyCachePath(mapId)}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  renameSync(tmp, hierarchyCachePath(mapId))
}

/** 正在生成归属数据的地图集合（作业运行时维护）。 */
const runningMaps = new Set<string>()

export function markHierarchyRunning(mapId: string): void {
  runningMaps.add(mapId)
}

export function markHierarchyDone(mapId: string): void {
  runningMaps.delete(mapId)
}

export function isHierarchyRunning(mapId: string): boolean {
  return runningMaps.has(mapId)
}

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

interface Ring {
  pts: [number, number][]
  bbox: [number, number, number, number]
}

/** 射线法点面包含。 */
function inRing(pt: [number, number], ring: [number, number][]): boolean {
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

/** 多边形（取外环）质心：鞋带公式，符号一致。 */
function polygonCentroid(poly: [number, number][][]): [number, number] | null {
  const outer = poly[0]
  let a = 0
  let cx = 0
  let cy = 0
  for (let k = 0; k < outer.length - 1; k++) {
    const x1 = outer[k][0]
    const y1 = outer[k][1]
    const x2 = outer[k + 1][0]
    const y2 = outer[k + 1][1]
    const cr = x1 * y2 - x2 * y1
    a += cr
    cx += (x1 + x2) * cr
    cy += (y1 + y2) * cr
  }
  if (Math.abs(a) < 1e-12) return null
  const c: [number, number] = [cx / (3 * a), cy / (3 * a)]
  return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export interface HierarchyCallbacks {
  signal?: AbortSignal
  onLine?: (line: string) => void
  onProgress?: (done: number, total: number) => void
}

/** 扫描的缩放范围（z4–z6：足够覆盖全部 ADM1 碎片与绝大多数 ADM2）。 */
const ZOOMS = [4, 5, 6]

/**
 * 生成一个地图的「市/县 → 省」归属数据。
 * 输出未写盘（由调用方决定缓存）；unmatched 为兜底失败的 ADM2 数量。
 */
export async function generateHierarchy(
  map: MapFile,
  cb: HierarchyCallbacks = {}
): Promise<HierarchyData> {
  const { signal, onLine, onProgress } = cb
  const meta = readMbtilesMeta(map.path)
  if (!meta || meta.format === 'png' || meta.format === 'jpg' || meta.format === 'jpeg') {
    throw new Error('仅矢量（pbf）瓦片支持行政归属生成')
  }

  // 每国：省碎片（ring + bbox）+ 市/县（代表点 + 兜底点）
  const provPieces = new Map<string, { id: string; name: string; ring: Ring }[]>()
  const cities = new Map<string, { gid: string; name: string; pts: [number, number][] }>()
  const tileCount = ZOOMS.reduce((s, z) => s + 4 ** z, 0)
  let done = 0

  for (const z of ZOOMS) {
    const n = 2 ** z
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const buf = await fetchTile(map.path, z, x, y)
        if (buf) {
          let vt: VectorTile
          try {
            vt = new VectorTile(new Pbf(buf))
          } catch {
            continue
          }
          const L = vt.layers['adm1_2']
          if (L) {
            for (let i = 0; i < L.length; i++) {
              const f = L.feature(i)
              const p = f.properties as {
                shapeGroup?: string
                shapeID?: string
                shapeName?: string
                shapeType?: string
              }
              if (!p.shapeID || !p.shapeGroup) continue
              const gj = f.toGeoJSON(x, y, z)
              const geom = gj.geometry as {
                type: string
                coordinates: [number, number][][] | [number, number][][][]
              }
              // 统一为「外环列表」：Polygon → 各环；MultiPolygon → 各子多边形的外环
              const rings: [number, number][][] =
                geom.type === 'Polygon'
                  ? (geom.coordinates as [number, number][][])
                  : (geom.coordinates as [number, number][][][]).map((poly) => poly[0])
              if (p.shapeType === 'ADM1' || p.shapeType === 'DISP') {
                // 省碎片（并集 = 完整省）
                let list = provPieces.get(p.shapeGroup)
                if (!list) {
                  list = []
                  provPieces.set(p.shapeGroup, list)
                }
                for (const ring of rings) {
                  if (ring.length < 3) continue
                  list.push({
                    id: p.shapeID,
                    name: p.shapeName ?? '',
                    ring: { pts: ring, bbox: ringBbox(ring) }
                  })
                }
              } else if (p.shapeType === 'ADM2' && !cities.has(p.shapeID)) {
                // 市/县：代表点链（最大外环质心 → 整体包围盒中心）
                const pts: [number, number][] = []
                let best: [number, number] | null = null
                let bestArea = 0
                for (const ring of rings) {
                  const c = polygonCentroid([ring])
                  if (!c) continue
                  let a = 0
                  for (let k = 0; k < ring.length - 1; k++) {
                    a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
                  }
                  const area = Math.abs(a) / 2
                  if (area > bestArea) {
                    bestArea = area
                    best = c
                  }
                }
                if (best) pts.push(best)
                let minX = 1e9
                let minY = 1e9
                let maxX = -1e9
                let maxY = -1e9
                for (const ring of rings) {
                  for (const [px, py] of ring) {
                    if (px < minX) minX = px
                    if (px > maxX) maxX = px
                    if (py < minY) minY = py
                    if (py > maxY) maxY = py
                  }
                }
                if (minX <= maxX) pts.push([(minX + maxX) / 2, (minY + maxY) / 2])
                cities.set(p.shapeID, { gid: p.shapeGroup, name: p.shapeName ?? '', pts })
              }
            }
          }
        }
        done++
        if (done % 500 === 0) onProgress?.(done, tileCount)
      }
    }
    onProgress?.(done, tileCount)
  }

  // 每国建立 5°×5° 网格索引（一次建好，全量复用）
  type GridCell = { id: string; name: string; ring: Ring }[]
  const provGrids = new Map<string, Map<string, GridCell>>()
  for (const [gid, pieces] of provPieces) {
    const grid = new Map<string, GridCell>()
    for (const pc of pieces) {
      const [minX, minY, maxX, maxY] = pc.ring.bbox
      for (let gx = Math.floor(minX / 5); gx <= Math.floor(maxX / 5); gx++) {
        for (let gy = Math.floor(minY / 5); gy <= Math.floor(maxY / 5); gy++) {
          const k = `${gx},${gy}`
          const list = grid.get(k) ?? []
          list.push(pc)
          grid.set(k, list)
        }
      }
    }
    provGrids.set(gid, grid)
  }

  /** 某点 3×3 邻域的全部候选碎片（去重）。 */
  const candidatesAt = (
    grid: Map<string, GridCell>,
    pt: [number, number]
  ): { id: string; name: string; ring: Ring }[] => {
    const gx = Math.floor(pt[0] / 5)
    const gy = Math.floor(pt[1] / 5)
    const out: { id: string; name: string; ring: Ring }[] = []
    const seen = new Set<string>()
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${gx + dx},${gy + dy}`)
        if (!list) continue
        for (const pc of list) {
          if (seen.has(pc.id)) continue
          seen.add(pc.id)
          out.push(pc)
        }
      }
    }
    return out
  }

  const match = (c: {
    gid: string
    pts: [number, number][]
  }): { id: string; name: string } | null => {
    const grid = provGrids.get(c.gid)
    if (!grid) return null
    // 1) 任一代表点在省内 → 命中
    for (const pt of c.pts) {
      for (const pc of candidatesAt(grid, pt)) {
        const [minX, minY, maxX, maxY] = pc.ring.bbox
        if (pt[0] < minX || pt[0] > maxX || pt[1] < minY || pt[1] > maxY) continue
        if (inRing(pt, pc.ring.pts)) return { id: pc.id, name: pc.name }
      }
    }
    // 2) 兜底：最近碎片（点到 bbox 距离）
    let nearest: { id: string; name: string; d: number } | null = null
    for (const pt of c.pts) {
      for (const pc of candidatesAt(grid, pt)) {
        const [minX, minY, maxX, maxY] = pc.ring.bbox
        const dx = pt[0] < minX ? minX - pt[0] : pt[0] > maxX ? pt[0] - maxX : 0
        const dy = pt[1] < minY ? minY - pt[1] : pt[1] > maxY ? pt[1] - maxY : 0
        const d = Math.hypot(dx, dy)
        if (!nearest || d < nearest.d) nearest = { id: pc.id, name: pc.name, d }
      }
    }
    return nearest ? { id: nearest.id, name: nearest.name } : null
  }

  const adm2: HierarchyData['adm2'] = {}
  const adm1: HierarchyData['adm1'] = {}
  const unmatched: string[] = []
  let i = 0
  for (const [id2, c] of cities) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const owner = match(c)
    if (owner) {
      adm2[id2] = { adm1Id: owner.id, adm1Name: owner.name }
      const p = (adm1[owner.id] ??= { name: owner.name, adm2Ids: [] })
      p.adm2Ids.push(id2)
    } else {
      unmatched.push(id2)
    }
    i++
    if (i % 1000 === 0) onLine?.(`  归属匹配 ${i}/${cities.size}`)
  }

  const data: HierarchyData = { generatedAt: new Date().toISOString(), adm2, adm1, unmatched }
  log.info('hierarchy generated', {
    map: map.id,
    adm2: Object.keys(adm2).length,
    unmatched: unmatched.length
  })
  return data
}
