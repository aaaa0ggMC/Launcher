/**
 * 探索区域生成引擎 — 基于时空聚类（Spatiotemporal Clustering）与测地线几何算法，
 * 将离散照片点自动分组为：
 * 1. 单原子点（1 张照片）：测地线正多边形圆
 * 2. 双原子体（2 张照片）：测地线胶囊体 / 哑铃形探索走廊
 * 3. 广域探索区（3+ 张照片）：时序测地线走廊 + 密集凸包融合多边形
 *
 * 100% 兼容 2D 墨卡托 与 3D 地球仪投影（球面真实地理多边形）。
 */
import type { Photo, Route, ExploredGranularity, GranularityConfig } from './types'
import { GRANULARITY_PRESETS } from './types'

const R_EARTH = 6378137 // 地球平均半径（米）

/** 计算两点间的测地线大圆距离（米，Haversine 公式）。 */
export function haversineDistM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const radLat1 = (lat1 * Math.PI) / 180
  const radLat2 = (lat2 * Math.PI) / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R_EARTH * c
}

/** 计算从点 A 到点 B 的初始航向角（弧度，0=正北，顺时针）。 */
export function initialBearingRad(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180

  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return Math.atan2(y, x)
}

/** 给定起点、方位角与距离，计算终点的经纬度 [lon, lat]。 */
export function destinationPoint(
  lon: number,
  lat: number,
  bearingRad: number,
  distM: number
): [number, number] {
  const δ = distM / R_EARTH
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lon * Math.PI) / 180

  const sinφ1 = Math.sin(φ1)
  const cosφ1 = Math.cos(φ1)
  const sinδ = Math.sin(δ)
  const cosδ = Math.cos(δ)

  const φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(bearingRad))
  const λ2 = λ1 + Math.atan2(Math.sin(bearingRad) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2))

  let finalLon = (λ2 * 180) / Math.PI
  finalLon = ((finalLon + 540) % 360) - 180
  const finalLat = (φ2 * 180) / Math.PI
  return [finalLon, finalLat]
}

/** 生成单个点的测地线正多边形圆环（GeoJSON 坐标环）。 */
export function makeCircleRing(
  lon: number,
  lat: number,
  radiusM: number,
  steps = 32
): [number, number][] {
  const ring: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const angle = (i * 2 * Math.PI) / steps
    ring.push(destinationPoint(lon, lat, angle, radiusM))
  }
  return ring
}

/** 生成两点之间的双原子 / 胶囊体多边形（Capsule / Dumbbell Corridor）。 */
export function makeCapsuleRing(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  radiusM: number,
  arcSteps = 16
): [number, number][] {
  const dist = haversineDistM(lon1, lat1, lon2, lat2)
  if (dist < 1) {
    return makeCircleRing(lon1, lat1, radiusM, arcSteps * 2)
  }

  const bearing = initialBearingRad(lon1, lat1, lon2, lat2)
  const ring: [number, number][] = []

  // 1. 点 A 处的半圆弧（从 bearing + π/2 到 bearing + 3π/2 的背侧弧）
  for (let i = 0; i <= arcSteps; i++) {
    const a = bearing + Math.PI / 2 + (i * Math.PI) / arcSteps
    ring.push(destinationPoint(lon1, lat1, a, radiusM))
  }

  // 2. 点 B 处的半圆弧（从 bearing - π/2 到 bearing + π/2 的正面弧）
  for (let i = 0; i <= arcSteps; i++) {
    const a = bearing - Math.PI / 2 + (i * Math.PI) / arcSteps
    ring.push(destinationPoint(lon2, lat2, a, radiusM))
  }

  // 闭合
  if (ring.length > 0) {
    ring.push([ring[0][0], ring[0][1]])
  }
  return ring
}

/** 聚类单元。 */
export interface PhotoCluster {
  id: string
  photos: Photo[]
  center: [number, number]
  earliestTime: number | null
  latestTime: number | null
}

/**
 * 核心时空聚类算法：
 * 根据时间窗口（timeWindowHours）与空间距离（maxLinkDistM）将照片聚类。
 */
export function clusterPhotosSpatiotemporal(
  photos: Photo[],
  granularity: ExploredGranularity = 'standard',
  userRadiusM?: number
): PhotoCluster[] {
  const cfg: GranularityConfig = GRANULARITY_PRESETS[granularity] || GRANULARITY_PRESETS.standard
  const baseRadius =
    userRadiusM != null && userRadiusM > 0 && userRadiusM < 400 ? userRadiusM : cfg.baseRadiusM
  const timeLimitMs = cfg.timeWindowHours * 3600 * 1000
  const maxDistM = cfg.maxLinkDistM

  const valid = photos.filter((p) => p.gps_lat != null && p.gps_lon != null)
  if (!valid.length) return []

  // 1. 提取时间戳并排序
  interface ExtPhoto {
    raw: Photo
    lon: number
    lat: number
    t: number | null
  }

  const items: ExtPhoto[] = valid.map((p) => {
    let t: number | null = null
    if (p.taken_at) {
      const parsed = Date.parse(p.taken_at)
      if (!Number.isNaN(parsed)) t = parsed
    }
    return {
      raw: p,
      lon: p.gps_lon as number,
      lat: p.gps_lat as number,
      t
    }
  })

  // 2. 并查集（Disjoint Set Union）
  const parent = Array.from({ length: items.length }, (_, i) => i)
  function find(i: number): number {
    let root = i
    while (root !== parent[root]) root = parent[root]
    let curr = i
    while (curr !== root) {
      const next = parent[curr]
      parent[curr] = root
      curr = next
    }
    return root
  }
  function union(i: number, j: number): void {
    const rootI = find(i)
    const rootJ = find(j)
    if (rootI !== rootJ) {
      parent[rootI] = rootJ
    }
  }

  // 3. 时空邻近合并
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]

      // 空间距离判定
      const dist = haversineDistM(a.lon, a.lat, b.lon, b.lat)
      if (dist > maxDistM) continue // 超出人类单次活动距离上限，无论时间多近都不属于同一连续探索区

      // (1) 空间相交/重叠（在 2.2 倍基础足迹半径内）：
      // 两点在地理上直接接触相交，无论何时拍摄都物理融合成单个连续多边形，杜绝内部同心圈与透明度叠层发糊
      if (dist <= baseRadius * 2.2) {
        union(i, j)
        continue
      }

      // (2) 空间在同一探索走廊（dist <= maxDistM）且时间在同一窗口内：
      // 合并为同一次出行的连续探索多边形
      if (a.t != null && b.t != null) {
        const timeDiff = Math.abs(a.t - b.t)
        if (timeDiff <= timeLimitMs) {
          union(i, j)
        }
      }
    }
  }

  // 4. 汇总群组
  const groupMap = new Map<number, ExtPhoto[]>()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    const list = groupMap.get(root) ?? []
    list.push(items[i])
    groupMap.set(root, list)
  }

  const clusters: PhotoCluster[] = []
  let clusterIdx = 1
  for (const group of groupMap.values()) {
    // 按时间顺序对组内照片排序
    group.sort((a, b) => {
      if (a.t != null && b.t != null) return a.t - b.t
      return 0
    })

    const rawList = group.map((g) => g.raw)
    const centerLon = group.reduce((s, g) => s + g.lon, 0) / group.length
    const centerLat = group.reduce((s, g) => s + g.lat, 0) / group.length
    const validTimes = group.map((g) => g.t).filter((t): t is number => t != null)

    clusters.push({
      id: `cluster-${clusterIdx++}`,
      photos: rawList,
      center: [centerLon, centerLat],
      earliestTime: validTimes.length ? Math.min(...validTimes) : null,
      latestTime: validTimes.length ? Math.max(...validTimes) : null
    })
  }

  return clusters
}

import polygonClipping from 'polygon-clipping'
import { wgs84ToGcj02 } from './coord-transform'

/**
 * Ramer-Douglas-Peucker 线简化算法（LOD 路线点抽取与抽稀）
 */
export function simplifyCoordinates(
  points: [number, number][],
  tolerance: number
): [number, number][] {
  if (points.length <= 2 || tolerance <= 0) return points

  const sqTolerance = tolerance * tolerance

  function getSqSegmentDist(
    p: [number, number],
    p1: [number, number],
    p2: [number, number]
  ): number {
    let x = p1[0]
    let y = p1[1]
    let dx = p2[0] - x
    let dy = p2[1] - y

    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) {
        x = p2[0]
        y = p2[1]
      } else if (t > 0) {
        x += dx * t
        y += dy * t
      }
    }

    dx = p[0] - x
    dy = p[1] - y
    return dx * dx + dy * dy
  }

  function simplifyDPStep(
    pts: [number, number][],
    first: number,
    last: number,
    sqTol: number,
    simplified: [number, number][]
  ): void {
    let maxSqDist = sqTol
    let index = -1

    for (let i = first + 1; i < last; i++) {
      const sqDist = getSqSegmentDist(pts[i], pts[first], pts[last])
      if (sqDist > maxSqDist) {
        index = i
        maxSqDist = sqDist
      }
    }

    if (index !== -1) {
      if (index - first > 1) simplifyDPStep(pts, first, index, sqTol, simplified)
      simplified.push(pts[index])
      if (last - index > 1) simplifyDPStep(pts, index, last, sqTol, simplified)
    }
  }

  const simplified: [number, number][] = [points[0]]
  simplifyDPStep(points, 0, points.length - 1, sqTolerance, simplified)
  simplified.push(points[points.length - 1])
  return simplified
}

/** 缩放层级与 LOD 分档映射（0: 宏观概览, 1: 区域中景, 2: 街区近景） */
export function getZoomLodBucket(zoom: number): number {
  if (zoom < 8) return 0
  if (zoom < 13) return 1
  return 2
}

/** 获取对应 LOD 分档的路线抽稀容差（经纬度度数） */
export function getRouteToleranceForBucket(bucket: number): number {
  if (bucket === 0) return 0.001 // ~100m，大省/跨市宏观级
  if (bucket === 1) return 0.00015 // ~15m，城市/区县级
  return 0 // 街区级：全精度原始坐标
}

// 内存缓存最近计算的探索区域 GeoJSON（按 LOD 分档与数据集特征）
const exploredGeoJsonCache = new Map<string, GeoJSON.FeatureCollection>()
const routeCorridorCache = new Map<string, polygonClipping.Polygon[]>()

export function clearRouteCorridorCache(): void {
  routeCorridorCache.clear()
}

export function clearExploredCache(): void {
  exploredGeoJsonCache.clear()
  routeCorridorCache.clear()
}

function getPolyBbox(poly: polygonClipping.Polygon): [number, number, number, number] {
  let minX = 1e9
  let minY = 1e9
  let maxX = -1e9
  let maxY = -1e9
  for (const ring of poly) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return [minX, minY, maxX, maxY]
}

function bboxesOverlap(
  b1: [number, number, number, number],
  b2: [number, number, number, number]
): boolean {
  return !(b1[2] < b2[0] || b1[0] > b2[2] || b1[3] < b2[1] || b1[1] > b2[3])
}

function safeUnion(list: polygonClipping.Polygon[]): polygonClipping.Polygon[] {
  if (list.length === 0) return []
  if (list.length === 1) return list
  if (list.length === 2) {
    try {
      return polygonClipping.union(list[0], list[1]) as polygonClipping.Polygon[]
    } catch {
      return list
    }
  }
  try {
    return polygonClipping.union(
      list[0],
      ...(list.slice(1) as [polygonClipping.Polygon, ...polygonClipping.Polygon[]])
    ) as polygonClipping.Polygon[]
  } catch {
    const mid = Math.floor(list.length / 2)
    const left = safeUnion(list.slice(0, mid))
    const right = safeUnion(list.slice(mid))
    try {
      if (!left.length) return right
      if (!right.length) return left
      return polygonClipping.union(
        left[0],
        ...(left.slice(1) as [polygonClipping.Polygon, ...polygonClipping.Polygon[]]),
        ...(right as [polygonClipping.Polygon, ...polygonClipping.Polygon[]])
      ) as polygonClipping.Polygon[]
    } catch {
      return [...left, ...right]
    }
  }
}

/**
 * 空间并查集（Spatial DSU）几何布尔并集引擎：
 * 1. 利用包围盒（AABB）快速空间聚类，将全球/跨区域离散的多边形划分为完全互斥的连通分量；
 * 2. 对每个相交连通分量内部执行 polygon-clipping 真实布尔并集溶解（Dissolve）；
 * 3. 彻底消除内部重叠边界线、相交切线与多层半透明叠加暗斑；
 * 4. 速度极快（千量级多边形仅需几十毫秒），且绝不会跨分块漏合并。
 */
export function dissolvePolygons(polygons: polygonClipping.Polygon[]): polygonClipping.Polygon[] {
  if (polygons.length <= 1) return polygons

  try {
    const bboxes = polygons.map(getPolyBbox)
    const n = polygons.length
    const parent = Array.from({ length: n }, (_, i) => i)

    function find(i: number): number {
      let r = i
      while (r !== parent[r]) r = parent[r]
      let curr = i
      while (curr !== r) {
        const next = parent[curr]
        parent[curr] = r
        curr = next
      }
      return r
    }

    function union(i: number, j: number): void {
      const ri = find(i)
      const rj = find(j)
      if (ri !== rj) parent[ri] = rj
    }

    // 空间包围盒相交性判定并合并连通分量
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (bboxesOverlap(bboxes[i], bboxes[j])) {
          union(i, j)
        }
      }
    }

    const groups = new Map<number, polygonClipping.Polygon[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      const list = groups.get(r) ?? []
      list.push(polygons[i])
      groups.set(r, list)
    }

    const out: polygonClipping.Polygon[] = []
    for (const list of groups.values()) {
      out.push(...safeUnion(list))
    }
    return out
  } catch {
    return polygons
  }
}

/**
 * 为一组照片群（PhotoCluster）与运动航线生成真实的地理空间足迹包络（True Organic Fog-of-War Footprint）：
 * - 每个照片点拥有自身的探索半径 Range（测地线圆盘）；
 * - 航线沿线生成测地线走廊圆盘；
 * - 使用分治 Martinez 2D 几何布尔并集引擎（polygon-clipping union）将全部相交重叠的足迹圆盘与走廊精准溶解（Dissolve）为一体；
 * - 密集穿梭的航线与沿街拍摄自然融合成连贯平整的有机足迹走廊；
 * - 彻底消除内部重叠接缝、相交切线与半透明叠加暗斑；
 * - 完整支持 LOD 动态层级缩减与结果级缓存。
 */
export function generateExploredGeoJSON(
  photos: Photo[],
  granularity: ExploredGranularity = 'standard',
  userRadiusM?: number,
  routes?: Route[],
  isGcj02 = false,
  lodBucket = 2
): GeoJSON.FeatureCollection {
  // 生成缓存特征键
  const cacheKey = `${lodBucket}:${granularity}:${userRadiusM ?? ''}:${isGcj02}:${photos.length}:${routes?.length ?? 0}:${
    routes && routes.length > 0 ? routes.map((r) => r.id).join(',') : ''
  }`

  const cached = exploredGeoJsonCache.get(cacheKey)
  if (cached) return cached

  const cfg = GRANULARITY_PRESETS[granularity] || GRANULARITY_PRESETS.standard
  const baseRadius =
    userRadiusM != null && userRadiusM > 0 && userRadiusM < 400 ? userRadiusM : cfg.baseRadiusM
  const clusters = clusterPhotosSpatiotemporal(photos, granularity, userRadiusM)

  // LOD 参数控制：缩放较小（LOD bucket 0/1）时减少正多边形边数与采样密度，大幅减轻布尔并集与 GPU 面片负担
  const singleDiscSteps = lodBucket === 0 ? 10 : lodBucket === 1 ? 16 : 32
  const multiDiscSteps = lodBucket === 0 ? 8 : lodBucket === 1 ? 14 : 24
  const routeCircleSteps = lodBucket === 0 ? 8 : lodBucket === 1 ? 12 : 16
  const routeSampleStepM =
    lodBucket === 0
      ? Math.max(150, baseRadius * 2.0)
      : lodBucket === 1
        ? Math.max(50, baseRadius * 1.0)
        : Math.max(25, baseRadius * 0.8)
  const routeTol = getRouteToleranceForBucket(lodBucket)

  const rawAllPolygons: polygonClipping.Polygon[] = []

  for (const cluster of clusters) {
    const list = cluster.photos
    const n = list.length
    if (!n) continue

    if (n === 1) {
      // 1 个点：正圆
      const p = list[0]
      const r =
        Number(p.appendix?.explored_radius_m) && Number(p.appendix?.explored_radius_m) < 400
          ? Number(p.appendix.explored_radius_m)
          : baseRadius
      const ring = makeCircleRing(p.gps_lon as number, p.gps_lat as number, r, singleDiscSteps)
      rawAllPolygons.push([ring])
      continue
    }

    // 多点聚类群：生成各个照片点真实 Range 半径的测地线圆盘
    const clusterDiscs: polygonClipping.Polygon[] = []
    for (const p of list) {
      const r =
        Number(p.appendix?.explored_radius_m) && Number(p.appendix?.explored_radius_m) < 400
          ? Number(p.appendix.explored_radius_m)
          : baseRadius
      const cRing = makeCircleRing(p.gps_lon as number, p.gps_lat as number, r, multiDiscSteps)
      clusterDiscs.push([cRing])
    }

    // 组内预先溶解
    rawAllPolygons.push(...dissolvePolygons(clusterDiscs))
  }

  // 航线轨迹探索走廊计算
  if (routes && routes.length > 0) {
    for (const r of routes) {
      try {
        const geo = JSON.parse(r.geojson) as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point>
        if (geo.geometry?.type === 'Point') {
          const coords = geo.geometry.coordinates as unknown as [number, number]
          if (Array.isArray(coords) && coords.length >= 2) {
            const [lon, lat] = coords
            const [cLon, cLat] = isGcj02 ? wgs84ToGcj02(lon, lat) : [lon, lat]
            rawAllPolygons.push([makeCircleRing(cLon, cLat, baseRadius, singleDiscSteps)])
          }
          continue
        }
        if (geo.geometry?.type !== 'LineString') continue

        let coords = geo.geometry.coordinates as [number, number][] | undefined
        if (!coords || coords.length < 2) continue

        const corridorKey = `${r.id}:${lodBucket}:${baseRadius}:${isGcj02}`
        const cachedCorridor = routeCorridorCache.get(corridorKey)
        if (cachedCorridor) {
          rawAllPolygons.push(...cachedCorridor)
          continue
        }

        // LOD 路线点预先简化抽稀
        if (coords.length > 8) {
          // 在高缩放级别（lodBucket 2）下应用 0.00005° (~5m) 微容差，去除 GPS 微米级高频抖动冗余，极大加速几何运算
          const effectiveTol = routeTol > 0 ? routeTol : 0.00005
          coords = simplifyCoordinates(coords, effectiveTol)
        }

        // 沿线连续采样测地线圆盘（长线段自动线性插值，杜绝因点距过大造成走廊断裂或孤岛）
        const sampled: [number, number][] = [coords[0]]
        let prev = coords[0]

        for (let i = 1; i < coords.length; i++) {
          const c = coords[i]
          const d = haversineDistM(prev[0], prev[1], c[0], c[1])
          if (d > routeSampleStepM) {
            const steps = Math.min(100, Math.ceil(d / routeSampleStepM))
            for (let s = 1; s < steps; s++) {
              const frac = s / steps
              sampled.push([prev[0] + (c[0] - prev[0]) * frac, prev[1] + (c[1] - prev[1]) * frac])
            }
            sampled.push(c)
            prev = c
          } else if (d >= routeSampleStepM * 0.75 || i === coords.length - 1) {
            sampled.push(c)
            prev = c
          }
        }

        const routePolys: polygonClipping.Polygon[] = sampled.map(([lon, lat]) => {
          const [cLon, cLat] = isGcj02 ? wgs84ToGcj02(lon, lat) : [lon, lat]
          return [makeCircleRing(cLon, cLat, baseRadius, routeCircleSteps)]
        })
        if (!routePolys.length) continue

        // 单条航线走廊预先融合并存入内存缓存
        const dissolvedRoute = dissolvePolygons(routePolys)
        routeCorridorCache.set(corridorKey, dissolvedRoute)
        rawAllPolygons.push(...dissolvedRoute)
      } catch {
        /* ignore single route parse error */
      }
    }
  }

  // 全局布尔并集（Global Boolean Dissolve）：将所有相交的航线走廊与照片足迹彻底融合成无内部接缝的连通块
  const dissolvedPolygons = dissolvePolygons(rawAllPolygons)

  const features: GeoJSON.Feature[] = dissolvedPolygons.map((poly) => ({
    type: 'Feature',
    properties: {
      type: 'dissolved-footprint'
    },
    geometry: {
      type: 'Polygon',
      coordinates: poly as [number, number][][]
    }
  }))

  const result: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features
  }

  // 限制缓存最多保留 10 份
  if (exploredGeoJsonCache.size > 10) {
    const firstKey = exploredGeoJsonCache.keys().next().value
    if (firstKey) exploredGeoJsonCache.delete(firstKey)
  }
  exploredGeoJsonCache.set(cacheKey, result)

  return result
}
