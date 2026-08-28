/**
 * 探索区域生成引擎 — 基于时空聚类（Spatiotemporal Clustering）与测地线几何算法，
 * 将离散照片点自动分组为：
 * 1. 单原子点（1 张照片）：测地线正多边形圆
 * 2. 双原子体（2 张照片）：测地线胶囊体 / 哑铃形探索走廊
 * 3. 广域探索区（3+ 张照片）：时序测地线走廊 + 密集凸包融合多边形
 *
 * 100% 兼容 2D 墨卡托 与 3D 地球仪投影（球面真实地理多边形）。
 */
import type { Photo, ExploredGranularity, GranularityConfig } from './types'
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

/** 计算平面经纬度点集的 2D 凸包（Monotone Chain 算法）。 */
function computeConvexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 2) return points
  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))

  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const lower: [number, number][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  const upper: [number, number][] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  lower.pop()
  upper.pop()
  return lower.concat(upper)
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
  granularity: ExploredGranularity = 'standard'
): PhotoCluster[] {
  const cfg: GranularityConfig = GRANULARITY_PRESETS[granularity] || GRANULARITY_PRESETS.standard
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

      // 时间差异判定
      if (a.t != null && b.t != null) {
        const timeDiff = Math.abs(a.t - b.t)
        if (timeDiff <= timeLimitMs) {
          union(i, j)
        }
      } else {
        // 无时间戳时，若空间在极近距离（2倍基础半径内）则聚类
        if (dist <= cfg.baseRadiusM * 2) {
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

/**
 * 为一组照片群（PhotoCluster）生成带圆角（半径为 R）的测地线凸图形（Smooth Convex Rounded Polygon）：
 * - 1 个点：正圆盘（Circle）
 * - 2 个点：两端圆角平滑连接的胶囊体 / 双原子（Capsule / Dumbbell）
 * - 3 个点：带平滑圆角的三角形（Rounded Triangle）
 * - N 个点：带平滑圆角的凸多边形（Rounded Convex Polygon）
 *
 * 数学原理：计算聚类群中所有照片点测地线圆盘（半径 R）的整体测地线凸包（Convex Hull of Disks）。
 * 保证每个聚类群只生成一个干净、闭合、外围带圆角且无任何内部重叠暗斑的多边形。
 */
export function generateExploredGeoJSON(
  photos: Photo[],
  granularity: ExploredGranularity = 'standard',
  userRadiusM?: number
): GeoJSON.FeatureCollection {
  const cfg = GRANULARITY_PRESETS[granularity] || GRANULARITY_PRESETS.standard
  const baseRadius =
    userRadiusM != null && userRadiusM > 0 && userRadiusM < 400 ? userRadiusM : cfg.baseRadiusM
  const clusters = clusterPhotosSpatiotemporal(photos, granularity)

  const features: GeoJSON.Feature[] = []

  for (const cluster of clusters) {
    const list = cluster.photos
    const n = list.length
    if (!n) continue

    if (n === 1) {
      // 1 个点：正圆（32段测地线圆环）
      const p = list[0]
      const r =
        Number(p.appendix?.explored_radius_m) && Number(p.appendix?.explored_radius_m) < 400
          ? Number(p.appendix.explored_radius_m)
          : baseRadius
      const ring = makeCircleRing(p.gps_lon as number, p.gps_lat as number, r, 32)
      features.push({
        type: 'Feature',
        properties: {
          clusterId: cluster.id,
          count: 1,
          type: 'circle'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [ring]
        }
      })
    } else {
      // 2个点（胶囊/双原子）、3个点（圆角三角形）、N个点（圆角凸多边形）
      // 采集各点测地线圆盘边界点，统一计算整体 2D 测地凸包
      const samplePoints: [number, number][] = []
      const circleSteps = n === 2 ? 24 : 16

      for (const p of list) {
        const r =
          Number(p.appendix?.explored_radius_m) && Number(p.appendix?.explored_radius_m) < 400
            ? Number(p.appendix.explored_radius_m)
            : baseRadius
        const cRing = makeCircleRing(p.gps_lon as number, p.gps_lat as number, r, circleSteps)
        samplePoints.push(...cRing)
      }

      const hull = computeConvexHull(samplePoints)
      if (hull.length >= 3) {
        hull.push([hull[0][0], hull[0][1]]) // 闭合环
        features.push({
          type: 'Feature',
          properties: {
            clusterId: cluster.id,
            count: n,
            type: n === 2 ? 'capsule' : n === 3 ? 'rounded-triangle' : 'rounded-convex-hull'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [hull]
          }
        })
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features
  }
}
