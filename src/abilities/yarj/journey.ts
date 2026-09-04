/**
 * 「我的探索」旅途时空阶段回放与交通推测引擎
 *
 * 核心能力：
 * 1. 旅程阶段智能聚类：按时间与空间粒度（< 粒度 >）将照片序列切分为有序站点
 * 2. 智能交通工具推测：根据跃迁距离、时差与平均速度推测（飞机/高铁/自驾/漫步/轮渡/驻留）
 * 3. 大圆航线（Great Circle）与平滑空间曲线插值：生成高质感球面流线轨迹
 * 4. GeoJSON 动态图层生成：支持已完成旅程、当前航段流光与站点脉冲光晕
 */
import type {
  Photo,
  ExploredGranularity,
  JourneyData,
  JourneyStage,
  JourneyLeg,
  TransportMode,
  TransportModeMeta
} from './types'
import { GRANULARITY_PRESETS } from './types'
import { haversineDistM } from './explored-area'

export const TRANSPORT_MODES: Record<TransportMode, TransportModeMeta> = {
  plane: {
    mode: 'plane',
    nameKey: 'yarj.transport.plane',
    defaultName: '飞机飞行',
    icon: 'mdi-airplane',
    color: '#38bdf8' // 天蓝
  },
  train: {
    mode: 'train',
    nameKey: 'yarj.transport.train',
    defaultName: '高铁动车',
    icon: 'mdi-train-variant',
    color: '#10b981' // 翡翠绿
  },
  car: {
    mode: 'car',
    nameKey: 'yarj.transport.car',
    defaultName: '公路自驾',
    icon: 'mdi-car',
    color: '#f59e0b' // 暖橙
  },
  walk: {
    mode: 'walk',
    nameKey: 'yarj.transport.walk',
    defaultName: '漫步骑行',
    icon: 'mdi-walk',
    color: '#a855f7' // 紫罗兰
  },
  ship: {
    mode: 'ship',
    nameKey: 'yarj.transport.ship',
    defaultName: '游轮轮渡',
    icon: 'mdi-ferry',
    color: '#06b6d4' // 青蓝
  },
  stay: {
    mode: 'stay',
    nameKey: 'yarj.transport.stay',
    defaultName: '驻留探索',
    icon: 'mdi-camera',
    color: '#ec4899' // 玫瑰粉
  }
}

/** 智能推测相邻阶段间的交通方式。 */
export function guessTransportMode(
  distanceM: number,
  timeDiffMs: number | null
): { mode: TransportMode; speedKmH: number | null } {
  const distKm = distanceM / 1000

  // 极短距离（< 500 米）
  if (distKm < 0.5) {
    return { mode: 'stay', speedKmH: null }
  }

  if (timeDiffMs != null && timeDiffMs > 0) {
    const hours = timeDiffMs / (3600 * 1000)
    const speed = hours > 0 ? distKm / hours : 0

    // 飞机：超高速 (>= 320 km/h) 或 远距离跨大区 (>= 750km) 或 3.5小时内跨越大距离 (>= 350km)
    if (speed >= 320 || distKm >= 750 || (distKm >= 350 && hours <= 3.5)) {
      return { mode: 'plane', speedKmH: speed }
    }

    // 高铁/动车：中高速 (110 ~ 320 km/h)
    if (speed >= 110 && speed < 320) {
      return { mode: 'train', speedKmH: speed }
    }

    // 自驾/汽车：公路常规速度 (22 ~ 110 km/h)
    if (speed >= 22 && speed < 110) {
      return { mode: 'car', speedKmH: speed }
    }

    // 漫步/徒步/骑行：短距离 (< 15km) 且低速 (< 22 km/h)
    if (speed < 22 && distKm <= 15) {
      return { mode: 'walk', speedKmH: speed }
    }

    // 跨度较长但耗时更长的夜间火车/自驾大巴
    if (distKm >= 100) {
      return { mode: 'train', speedKmH: speed }
    }
    return { mode: 'car', speedKmH: speed }
  }

  // 若无时间戳，依据纯距离先验规则推测
  if (distKm >= 650) return { mode: 'plane', speedKmH: null }
  if (distKm >= 120) return { mode: 'train', speedKmH: null }
  if (distKm >= 5) return { mode: 'car', speedKmH: null }
  return { mode: 'walk', speedKmH: null }
}

/**
 * 球面大圆航线（Great Circle Slerp）弧线采样算法：
 * 将起点与终点在三维单位球面上以角距离 Slerp 平滑插值，生成如航空公司航线般的优雅弧线。
 */
export function interpolateGreatCircleArc(
  start: [number, number],
  end: [number, number],
  steps = 60
): [number, number][] {
  const [lon1, lat1] = start
  const [lon2, lat2] = end

  // 极近距离直接返回两点线段
  const dist = haversineDistM(lon1, lat1, lon2, lat2)
  if (dist < 200 || (lon1 === lon2 && lat1 === lat2)) {
    return [
      [lon1, lat1],
      [lon2, lat2]
    ]
  }

  const rad = Math.PI / 180
  const deg = 180 / Math.PI

  // 转换为 3D 笛卡尔坐标（单位球）
  const phi1 = lat1 * rad
  const lambda1 = lon1 * rad
  const phi2 = lat2 * rad
  const lambda2 = lon2 * rad

  const x1 = Math.cos(phi1) * Math.cos(lambda1)
  const y1 = Math.cos(phi1) * Math.sin(lambda1)
  const z1 = Math.sin(phi1)

  const x2 = Math.cos(phi2) * Math.cos(lambda2)
  const y2 = Math.cos(phi2) * Math.sin(lambda2)
  const z2 = Math.sin(phi2)

  // 计算夹角
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2))
  const omega = Math.acos(dot)

  if (omega < 1e-5) {
    return [
      [lon1, lat1],
      [lon2, lat2]
    ]
  }

  const sinOmega = Math.sin(omega)
  const arc: [number, number][] = []

  // 对超长距离增加采样点，短距离适当减少
  const dynamicSteps = dist > 1000000 ? Math.max(steps, 80) : Math.max(steps, 40)

  for (let i = 0; i <= dynamicSteps; i++) {
    const t = i / dynamicSteps
    const s1 = Math.sin((1 - t) * omega) / sinOmega
    const s2 = Math.sin(t * omega) / sinOmega

    const x = s1 * x1 + s2 * x2
    const y = s1 * y1 + s2 * y2
    const z = s1 * z1 + s2 * z2

    let lon = Math.atan2(y, x) * deg
    const lat = Math.asin(Math.max(-1, Math.min(1, z))) * deg

    // 经度规范化到 [-180, 180]
    lon = ((lon + 540) % 360) - 180
    arc.push([lon, lat])
  }

  return arc
}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${Y}.${M}.${D} ${h}:${m}`
}

function resolveLocationName(photos: Photo[]): string {
  // 1. 优先提取 address / city
  for (const p of photos) {
    const city = typeof p.appendix?.city === 'string' ? p.appendix.city : ''
    const addr =
      typeof p.appendix?.formatted_address === 'string' ? p.appendix.formatted_address : ''
    if (city) return city
    if (addr) return addr.split(/[,，]/)[0]
  }
  // 2. 其次提取 tags
  for (const p of photos) {
    if (Array.isArray(p.appendix?.tags) && p.appendix.tags.length) {
      return String(p.appendix.tags[0])
    }
  }
  // 3. 提取相机型号或通用名称
  for (const p of photos) {
    if (p.camera_model) return p.camera_model
  }
  return '旅途站点'
}

/**
 * 核心引擎：根据照片集、时空粒度或自定义目标站点数构建完整的「我的探索」旅途阶段与航段数据。
 * @param photos 照片列表
 * @param granularity 预设时空粒度
 * @param targetStageCount 可选：用户指定的自定义目标站点数（算法将自适应合并最近点）
 */
export function buildJourneyData(
  photos: Photo[],
  granularity: ExploredGranularity = 'standard',
  targetStageCount?: number
): JourneyData {
  const valid = photos.filter((p) => p.gps_lat != null && p.gps_lon != null)
  if (!valid.length) {
    return {
      stages: [],
      legs: [],
      totalDistanceM: 0,
      totalPhotos: 0,
      startTime: null,
      endTime: null
    }
  }

  interface ExtPhoto {
    raw: Photo
    lon: number
    lat: number
    t: number | null
  }

  // 1. 提取时间戳并排序
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

  // 按时间升序排序（无时间戳的排在最后）
  items.sort((a, b) => {
    if (a.t != null && b.t != null) return a.t - b.t
    if (a.t != null) return -1
    if (b.t != null) return 1
    return 0
  })

  const stageGroups: ExtPhoto[][] = []

  // 2. 连续时空切分（支持按用户目标站点数智能聚合，或按时空阈值切分）
  if (targetStageCount != null && targetStageCount > 0) {
    if (items.length <= targetStageCount) {
      for (const p of items) {
        stageGroups.push([p])
      }
    } else {
      // 计算所有相邻两点间的时空分离距离得分
      const cuts: { index: number; score: number }[] = []
      for (let i = 0; i < items.length - 1; i++) {
        const p1 = items[i]
        const p2 = items[i + 1]
        const dist = haversineDistM(p1.lon, p1.lat, p2.lon, p2.lat)
        const timeDiffHours =
          p1.t != null && p2.t != null ? Math.abs(p2.t - p1.t) / (3600 * 1000) : 0
        const score = dist / 1000 + timeDiffHours * 15
        cuts.push({ index: i, score })
      }

      cuts.sort((a, b) => b.score - a.score)
      const numCuts = Math.min(Math.max(1, targetStageCount) - 1, cuts.length)
      const chosenCutIndices = new Set(cuts.slice(0, numCuts).map((c) => c.index))

      let currentGroup: ExtPhoto[] = []
      for (let i = 0; i < items.length; i++) {
        currentGroup.push(items[i])
        if (chosenCutIndices.has(i) || i === items.length - 1) {
          stageGroups.push(currentGroup)
          currentGroup = []
        }
      }
    }
  } else {
    const cfg = GRANULARITY_PRESETS[granularity] || GRANULARITY_PRESETS.standard
    const timeLimitMs = cfg.timeWindowHours * 3600 * 1000
    const maxDistM = cfg.maxLinkDistM

    let currentGroup: ExtPhoto[] = []
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      if (!currentGroup.length) {
        currentGroup.push(p)
        continue
      }

      const last = currentGroup[currentGroup.length - 1]
      const dist = haversineDistM(last.lon, last.lat, p.lon, p.lat)

      let shouldSplit = false
      if (dist > maxDistM) {
        shouldSplit = true
      } else if (p.t != null && last.t != null) {
        const diff = Math.abs(p.t - last.t)
        if (diff > timeLimitMs) {
          shouldSplit = true
        }
      }

      if (shouldSplit) {
        stageGroups.push(currentGroup)
        currentGroup = [p]
      } else {
        currentGroup.push(p)
      }
    }
    if (currentGroup.length) {
      stageGroups.push(currentGroup)
    }
  }

  // 3. 构建阶段（JourneyStage）
  const stages: JourneyStage[] = []
  for (let idx = 0; idx < stageGroups.length; idx++) {
    const grp = stageGroups[idx]
    const rawPhotos = grp.map((g) => g.raw)
    const validTimes = grp.map((g) => g.t).filter((t): t is number => t != null)

    const startTime = validTimes.length ? Math.min(...validTimes) : null
    const endTime = validTimes.length ? Math.max(...validTimes) : null

    let minLon = grp[0].lon
    let maxLon = grp[0].lon
    let minLat = grp[0].lat
    let maxLat = grp[0].lat
    let sumLon = 0
    let sumLat = 0

    for (const g of grp) {
      minLon = Math.min(minLon, g.lon)
      maxLon = Math.max(maxLon, g.lon)
      minLat = Math.min(minLat, g.lat)
      maxLat = Math.max(maxLat, g.lat)
      sumLon += g.lon
      sumLat += g.lat
    }

    const center: [number, number] = [sumLon / grp.length, sumLat / grp.length]
    const bounds: [number, number, number, number] = [minLon, minLat, maxLon, maxLat]
    const locationName = resolveLocationName(rawPhotos)

    let timeRange = ''
    if (startTime && endTime) {
      const sStr = formatTime(startTime)
      const eStr = formatTime(endTime)
      timeRange = sStr === eStr ? sStr : `${sStr} ~ ${eStr.split(' ')[1] || eStr}`
    } else if (startTime) {
      timeRange = formatTime(startTime)
    }

    stages.push({
      id: `stage-${idx + 1}`,
      index: idx,
      title: locationName,
      photos: rawPhotos,
      center,
      bounds,
      startTime,
      endTime,
      formattedTimeRange: timeRange,
      locationName
    })
  }

  // 4. 构建航段（JourneyLeg）与推测交通工具
  const legs: JourneyLeg[] = []
  let totalDistanceM = 0

  for (let i = 0; i < stages.length - 1; i++) {
    const fromStage = stages[i]
    const toStage = stages[i + 1]

    const distM = haversineDistM(
      fromStage.center[0],
      fromStage.center[1],
      toStage.center[0],
      toStage.center[1]
    )
    totalDistanceM += distM

    let durationMs: number | null = null
    if (fromStage.endTime != null && toStage.startTime != null) {
      durationMs = Math.max(0, toStage.startTime - fromStage.endTime)
    } else if (fromStage.startTime != null && toStage.startTime != null) {
      durationMs = Math.max(0, toStage.startTime - fromStage.startTime)
    }

    const { mode, speedKmH } = guessTransportMode(distM, durationMs)
    const arcCoordinates = interpolateGreatCircleArc(fromStage.center, toStage.center, 50)

    legs.push({
      id: `leg-${i}->${i + 1}`,
      fromIndex: i,
      toIndex: i + 1,
      fromStage,
      toStage,
      distanceM: distM,
      durationMs,
      speedKmH,
      mode,
      modeMeta: TRANSPORT_MODES[mode],
      arcCoordinates
    })
  }

  const allTimes = items.map((g) => g.t).filter((t): t is number => t != null)

  return {
    stages,
    legs,
    totalDistanceM,
    totalPhotos: valid.length,
    startTime: allTimes.length ? Math.min(...allTimes) : null,
    endTime: allTimes.length ? Math.max(...allTimes) : null
  }
}

/**
 * 生成旅程轨迹线的 GeoJSON FeatureCollection：
 * 包含根据与当前激活站点距离进行动态淡化/剔除的自适应平滑大圆航线。
 * @param focusRange 聚焦视距（大于 0 时，远端航段自动淡化并剔除）
 */
export function generateJourneyLinesGeoJSON(
  legs: JourneyLeg[],
  activeStageIndex: number,
  focusRange = 5
): {
  allLines: GeoJSON.FeatureCollection
  activeLeg: GeoJSON.FeatureCollection
} {
  const allFeatures: GeoJSON.Feature[] = []
  const activeFeatures: GeoJSON.Feature[] = []

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const isCompleted = i < activeStageIndex
    const isCurrent = i === activeStageIndex - 1 || (activeStageIndex === 0 && i === 0)

    const legDelta = Math.min(
      Math.abs(leg.fromIndex - activeStageIndex),
      Math.abs(leg.toIndex - activeStageIndex)
    )

    let opacity = isCompleted ? 0.85 : 0.45
    if (focusRange > 0 && legs.length > 5) {
      if (legDelta > focusRange) {
        continue
      } else if (legDelta === 0) {
        opacity = 0.95
      } else if (legDelta <= 2) {
        opacity = 0.75
      } else {
        const factor = 1 - (legDelta - 2) / Math.max(1, focusRange - 2)
        opacity = Math.max(0.12, 0.75 * factor)
      }
    }

    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {
        legId: leg.id,
        fromIndex: leg.fromIndex,
        toIndex: leg.toIndex,
        mode: leg.mode,
        color: leg.modeMeta.color,
        opacity,
        isCompleted,
        isCurrent
      },
      geometry: {
        type: 'LineString',
        coordinates: leg.arcCoordinates
      }
    }

    allFeatures.push(feature)

    if (isCurrent) {
      activeFeatures.push(feature)
    }
  }

  return {
    allLines: {
      type: 'FeatureCollection',
      features: allFeatures
    },
    activeLeg: {
      type: 'FeatureCollection',
      features: activeFeatures
    }
  }
}

/**
 * 生成旅程阶段节点的 GeoJSON FeatureCollection：
 * 根据与当前激活站点的 index 差值进行动态淡化、缩放与远景剔除。
 * @param focusRange 聚焦视距（大于 0 时，远端站点自动淡化并剔除）
 */
export function generateJourneyNodesGeoJSON(
  stages: JourneyStage[],
  activeStageIndex: number,
  focusRange = 5
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []

  for (let idx = 0; idx < stages.length; idx++) {
    const st = stages[idx]
    const delta = Math.abs(idx - activeStageIndex)
    const isActive = idx === activeStageIndex
    const isPassed = idx < activeStageIndex

    let opacity = 1.0
    let glowOpacity = 0.8
    let radius = isActive ? 12 : 9
    let glowRadius = isActive ? 20 : 12

    if (focusRange > 0 && stages.length > 6) {
      if (delta > focusRange) {
        continue
      } else if (delta === 0) {
        opacity = 1.0
        glowOpacity = 0.9
        radius = 13
        glowRadius = 22
      } else if (delta <= 2) {
        opacity = 0.85
        glowOpacity = 0.5
        radius = 9
        glowRadius = 13
      } else {
        const factor = 1 - (delta - 2) / Math.max(1, focusRange - 2)
        opacity = Math.max(0.18, 0.85 * factor)
        glowOpacity = Math.max(0.08, 0.5 * factor)
        radius = Math.max(6, Math.round(9 * factor))
        glowRadius = Math.max(8, Math.round(13 * factor))
      }
    }

    features.push({
      type: 'Feature',
      properties: {
        stageId: st.id,
        index: idx,
        displayNumber: String(idx + 1),
        title: st.title,
        photoCount: st.photos.length,
        timeRange: st.formattedTimeRange,
        isActive,
        isPassed,
        opacity,
        glowOpacity,
        radius,
        glowRadius
      },
      geometry: {
        type: 'Point',
        coordinates: [st.center[0], st.center[1]]
      }
    })
  }

  return {
    type: 'FeatureCollection',
    features
  }
}
