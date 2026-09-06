/**
 * GPX / 运动航线解析与指标计算引擎
 *
 * 功能：
 * 1. 解析 GPX 1.0 / 1.1 文件结构（trk, trkseg, trkpt, ele, time, extensions 等）；
 * 2. 测地线真实距离累计、时序速度与极速滑动窗口平滑滤波；
 * 3. 分公里段（1km splits）耗时与配速统计；
 * 4. 运动卡路里（基于 MET 模型与活动类型）科学估算；
 * 5. 生成标准 GeoJSON LineString 与包围盒 (bounds)；
 * 6. 航线折线与空间圆形区域（:gps lon lat km）相交判定。
 */
import type { Route, RouteExtraMetrics, RouteHeartRateZones, RoutePoint, RouteSplit } from './types'
import { haversineDistM } from './explored-area'

/** MET 运动代谢当量参考值（按平均体重 68kg 估算卡路里） */
const MET_MAP: Record<string, number> = {
  cycling: 6.8, // 中速骑行 (~20km/h)
  running: 9.8, // 慢跑 (~9-10km/h)
  walking: 3.8, // 快走 (~5km/h)
  hiking: 6.0, // 徒步远足
  other: 5.0
}

/** 识别活动类型 */
export function detectActivityType(name: string, desc: string, gpxType?: string): string {
  const text = `${name} ${desc} ${gpxType ?? ''}`.toLowerCase()
  if (
    text.includes('cycling') ||
    text.includes('ride') ||
    text.includes('骑行') ||
    text.includes('单车')
  ) {
    return 'cycling'
  }
  if (text.includes('running') || text.includes('run') || text.includes('跑步')) {
    return 'running'
  }
  if (
    text.includes('hiking') ||
    text.includes('hike') ||
    text.includes('徒步') ||
    text.includes('登山')
  ) {
    return 'hiking'
  }
  if (
    text.includes('walking') ||
    text.includes('walk') ||
    text.includes('健走') ||
    text.includes('步行')
  ) {
    return 'walking'
  }
  return 'other'
}

/** 解析 GPX 文本内容为结构化 RoutePoint 序列及元数据 */
export function parseGpxContent(
  xml: string,
  filePath: string
): {
  name: string
  desc: string | null
  activityType: string
  points: RoutePoint[]
  totalDistanceExtensionM?: number
  extensionsMetrics?: {
    calories?: number
    avgHrm?: number
    maxHrm?: number
    steps?: number
    avgCadence?: number
    maxCadence?: number
    riseHeight?: number
    fallHeight?: number
  }
} {
  // 提取名称与描述
  const nameMatch = /<name>([\s\S]*?)<\/name>/i.exec(xml)
  const descMatch = /<desc>([\s\S]*?)<\/desc>/i.exec(xml)
  const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(xml)
  const distExtMatch = /<totalDistance>([0-9.]+)<\/totalDistance>/i.exec(xml)
  const calMatch = /<calories>([0-9.]+)<\/calories>/i.exec(xml)
  const avgHrmMatch = /<avgHrm>([0-9.]+)<\/avgHrm>/i.exec(xml)
  const maxHrmMatch = /<maxHrm>([0-9.]+)<\/maxHrm>/i.exec(xml)
  const stepsMatch = /<steps>([0-9]+)<\/steps>/i.exec(xml)
  const avgCadenceMatch = /<avgCadence>([0-9.]+)<\/avgCadence>/i.exec(xml)
  const maxCadenceMatch = /<maxCadence>([0-9.]+)<\/maxCadence>/i.exec(xml)
  const riseHeightMatch = /<riseHeight>([0-9.]+)<\/riseHeight>/i.exec(xml)
  const fallHeightMatch = /<fallHeight>([0-9.]+)<\/fallHeight>/i.exec(xml)

  const name = nameMatch
    ? nameMatch[1].trim()
    : filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.gpx$/i, '') || 'Route'
  const desc = descMatch ? descMatch[1].trim() : null
  const activityType = detectActivityType(name, desc ?? '', typeMatch ? typeMatch[1] : undefined)
  const totalDistanceExtensionM = distExtMatch ? parseFloat(distExtMatch[1]) : undefined
  const extensionsMetrics = {
    calories: calMatch ? parseFloat(calMatch[1]) : undefined,
    avgHrm: avgHrmMatch ? parseFloat(avgHrmMatch[1]) : undefined,
    maxHrm: maxHrmMatch ? parseFloat(maxHrmMatch[1]) : undefined,
    steps: stepsMatch ? parseInt(stepsMatch[1], 10) : undefined,
    avgCadence: avgCadenceMatch ? parseFloat(avgCadenceMatch[1]) : undefined,
    maxCadence: maxCadenceMatch ? parseFloat(maxCadenceMatch[1]) : undefined,
    riseHeight: riseHeightMatch ? parseFloat(riseHeightMatch[1]) : undefined,
    fallHeight: fallHeightMatch ? parseFloat(fallHeightMatch[1]) : undefined
  }

  // 提取 trkpt 列表
  // 格式：<trkpt lat="30.534887" lon="114.428581">...</trkpt>
  const trkptRegex =
    /<trkpt\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*(?:>([\s\S]*?)<\/trkpt>|\s*\/>)/gi
  const trkptReverseRegex =
    /<trkpt\s+[^>]*lon=["']([^"']+)["'][^>]*lat=["']([^"']+)["'][^>]*(?:>([\s\S]*?)<\/trkpt>|\s*\/>)/gi

  let match: RegExpExecArray | null
  const points: RoutePoint[] = []
  let cumulativeDistM = 0
  let prevPt: RoutePoint | null = null

  // 优先按 lat then lon 匹配
  let isReverse = false
  const sample = xml.slice(0, 3000)
  if (!trkptRegex.test(sample) && trkptReverseRegex.test(sample)) {
    isReverse = true
  }
  trkptRegex.lastIndex = 0
  trkptReverseRegex.lastIndex = 0

  const activeRegex = isReverse ? trkptReverseRegex : trkptRegex

  while ((match = activeRegex.exec(xml)) !== null) {
    const lat = parseFloat(isReverse ? match[2] : match[1])
    const lon = parseFloat(isReverse ? match[1] : match[2])
    const inner = match[3] || ''

    if (Number.isNaN(lat) || Number.isNaN(lon)) continue

    // 海拔
    const eleMatch = /<ele>([0-9.-]+)<\/ele>/i.exec(inner)
    const ele = eleMatch ? parseFloat(eleMatch[1]) : null

    // 时间
    const timeMatch = /<time>([\s\S]*?)<\/time>/i.exec(inner)
    const time = timeMatch ? timeMatch[1].trim() : null

    // 心率（扩展标签）
    const hrMatch = /<(?:gpxtpx:hr|hr)>([0-9]+)<\/(?:gpxtpx:hr|hr)>/i.exec(inner)
    const hr = hrMatch ? parseInt(hrMatch[1], 10) : null

    // 踏频（扩展标签）
    const cadMatch = /<(?:gpxtpx:cad|cad)>([0-9]+)<\/(?:gpxtpx:cad|cad)>/i.exec(inner)
    const cadence = cadMatch ? parseInt(cadMatch[1], 10) : null

    let stepDist = 0
    let instantaneousSpeedKmh: number | null = null

    if (prevPt) {
      stepDist = haversineDistM(prevPt.lon, prevPt.lat, lon, lat)
      cumulativeDistM += stepDist

      if (time && prevPt.time) {
        const t1 = new Date(prevPt.time).getTime()
        const t2 = new Date(time).getTime()
        const dtSec = (t2 - t1) / 1000
        if (dtSec > 0 && dtSec < 120) {
          instantaneousSpeedKmh = (stepDist / dtSec) * 3.6
        }
      }
    }

    const pt: RoutePoint = {
      lat,
      lon,
      ele: ele != null && !Number.isNaN(ele) ? ele : null,
      time,
      distFromStartM: Math.round(cumulativeDistM * 10) / 10,
      speedKmh: instantaneousSpeedKmh != null ? Math.round(instantaneousSpeedKmh * 10) / 10 : null,
      hr,
      cadence
    }

    points.push(pt)
    prevPt = pt
  }

  return {
    name,
    desc,
    activityType,
    points,
    totalDistanceExtensionM,
    extensionsMetrics
  }
}

/**
 * 极速与速度曲线平滑滤波（消除 GPS 漂移与单点瞬时异常跳点）
 * 采用 7 点中位数滤波（Rolling Median Filter，运动手表通用抗漂移算法），完美复原真实极速与平滑曲线。
 */
export function computeSmoothedMaxSpeed(points: RoutePoint[]): {
  maxSpeedKmh: number
  speeds: number[]
} {
  const n = points.length
  if (n < 2) return { maxSpeedKmh: 0, speeds: [] }

  const rawSpeeds: number[] = [0]
  for (let i = 1; i < n; i++) {
    const p1 = points[i - 1]
    const p2 = points[i]
    if (p1.time && p2.time) {
      const dt = (new Date(p2.time).getTime() - new Date(p1.time).getTime()) / 1000
      const dist = p2.distFromStartM - p1.distFromStartM
      if (dt > 0 && dt <= 10 && dist >= 0) {
        rawSpeeds.push((dist / dt) * 3.6)
      } else {
        rawSpeeds.push(0)
      }
    } else {
      rawSpeeds.push(0)
    }
  }

  // 7 点滚动中位数滤波 (radius = 3)
  const speeds: number[] = []
  const radius = 3

  for (let i = 0; i < n; i++) {
    const window: number[] = []
    const start = Math.max(0, i - radius)
    const end = Math.min(n - 1, i + radius)
    for (let j = start; j <= end; j++) {
      window.push(rawSpeeds[j])
    }
    window.sort((a, b) => a - b)
    const med = window[Math.floor(window.length / 2)]
    speeds.push(Math.round(med * 10) / 10)
  }

  let maxSpd = 0
  for (const s of speeds) {
    if (s > maxSpd) {
      maxSpd = s
    }
  }

  return { maxSpeedKmh: Math.round(maxSpd * 10) / 10, speeds }
}

/** 计算分公里分段统计 (1km splits) */
export function computeSplits(points: RoutePoint[]): RouteSplit[] {
  if (points.length < 2) return []

  const splits: RouteSplit[] = []
  let currentKm = 1
  let splitStartPt = points[0]
  let splitStartIdx = 0

  for (let i = 1; i < points.length; i++) {
    const pt = points[i]
    if (pt.distFromStartM >= currentKm * 1000 || i === points.length - 1) {
      const splitDistM = pt.distFromStartM - splitStartPt.distFromStartM
      let durationSec = 0
      let elevationGain = 0

      if (splitStartPt.time && pt.time) {
        durationSec = Math.max(
          1,
          (new Date(pt.time).getTime() - new Date(splitStartPt.time).getTime()) / 1000
        )
      }

      // 计算该分段内的爬升
      for (let j = splitStartIdx + 1; j <= i; j++) {
        const e1 = points[j - 1].ele
        const e2 = points[j].ele
        if (e1 != null && e2 != null && e2 > e1) {
          elevationGain += e2 - e1
        }
      }

      const avgSpeedKmh = durationSec > 0 ? (splitDistM / durationSec) * 3.6 : 0

      splits.push({
        km: currentKm,
        durationSec: Math.round(durationSec),
        avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
        elevationGainM: Math.round(elevationGain * 10) / 10
      })

      currentKm++
      splitStartPt = pt
      splitStartIdx = i
    }
  }

  return splits
}

/** 生成航线包围盒 [minLon, minLat, maxLon, maxLat] */
export function computeBounds(points: RoutePoint[]): [number, number, number, number] {
  if (!points.length) return [0, 0, 0, 0]
  let minLon = points[0].lon
  let maxLon = points[0].lon
  let minLat = points[0].lat
  let maxLat = points[0].lat

  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
  }

  return [minLon, minLat, maxLon, maxLat]
}

/**
 * 将 GPX 解析成完整的 Route 领域模型
 */
export function parseGpxToRoute(
  xml: string,
  filePath: string,
  routeId?: string,
  companionJson?: Record<string, unknown> | null
): Route | null {
  const parsed = parseGpxContent(xml, filePath)
  const points = parsed.points
  if (!points.length) return null

  const id = routeId || `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const bounds = computeBounds(points)

  const startTime = points[0].time ?? null
  const endTime = points[points.length - 1].time ?? null

  let durationSec = 0
  let movingDurationSec = 0

  if (startTime && endTime) {
    durationSec = Math.max(0, (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
  }

  // 估算移动时间（滤除长时间驻留）
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1]
    const p2 = points[i]
    if (p1.time && p2.time) {
      const dt = (new Date(p2.time).getTime() - new Date(p1.time).getTime()) / 1000
      const dist = p2.distFromStartM - p1.distFromStartM
      if (dt > 0 && dt < 180) {
        const spd = (dist / dt) * 3.6
        if (spd > 0.8) {
          // 速度大于 0.8 km/h 视为在移动
          movingDurationSec += dt
        }
      }
    }
  }

  if (movingDurationSec === 0 || movingDurationSec > durationSec) {
    movingDurationSec = durationSec
  }

  const totalDistanceM = parsed.totalDistanceExtensionM ?? points[points.length - 1].distFromStartM
  const avgSpeedKmh =
    movingDurationSec > 0
      ? Math.round((totalDistanceM / movingDurationSec) * 3.6 * 10) / 10
      : durationSec > 0
        ? Math.round((totalDistanceM / durationSec) * 3.6 * 10) / 10
        : 0

  const { maxSpeedKmh, speeds } = computeSmoothedMaxSpeed(points)
  // 将平滑后的速度回填进 points
  for (let i = 0; i < points.length; i++) {
    points[i].speedKmh = speeds[i] ?? points[i].speedKmh
  }

  // 计算海拔与心率指标
  let elevationGainM = 0
  let elevationLossM = 0
  let minEle: number | null = null
  let maxEle: number | null = null
  let hrSum = 0
  let hrCount = 0
  let maxHr: number | null = null

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.ele != null) {
      if (minEle === null || p.ele < minEle) minEle = p.ele
      if (maxEle === null || p.ele > maxEle) maxEle = p.ele
      if (i > 0 && points[i - 1].ele != null) {
        const dEle = p.ele - (points[i - 1].ele as number)
        if (dEle > 0.3) elevationGainM += dEle
        else if (dEle < -0.3) elevationLossM += Math.abs(dEle)
      }
    }

    if (p.hr != null) {
      hrSum += p.hr
      hrCount++
      if (maxHr === null || p.hr > maxHr) maxHr = p.hr
    }
  }

  const calculatedAvgHr = hrCount > 0 ? Math.round(hrSum / hrCount) : null

  // 卡路里估算（MET 模型）
  const met = MET_MAP[parsed.activityType] ?? 5.0
  const hours = movingDurationSec / 3600
  // 卡路里 = MET * 68kg * hours
  const calculatedCalories = Math.round(met * 68 * hours)

  // 融合伴随 JSON 与 GPX Extensions
  const ext = parsed.extensionsMetrics || {}
  const compSummary = (companionJson?.summary as Record<string, unknown>) || null
  const compZones = (companionJson?.heart_rate_zones as Record<string, unknown>) || null
  const compDevice = (companionJson?.device as Record<string, unknown>) || null

  let finalCalories = calculatedCalories
  if (compSummary?.calories_kcal != null && typeof compSummary.calories_kcal === 'number') {
    finalCalories = compSummary.calories_kcal
  } else if (ext.calories != null) {
    finalCalories = Math.round(ext.calories)
  }

  const finalAvgHr = (compSummary?.avg_hrm as number) ?? ext.avgHrm ?? calculatedAvgHr
  const finalMaxHr = (compSummary?.max_hrm as number) ?? ext.maxHrm ?? maxHr
  const finalMinHr = (compSummary?.min_hrm as number) ?? null

  const finalSteps = (compSummary?.steps as number) ?? ext.steps ?? null
  const finalAvgCadence = (compSummary?.avg_cadence as number) ?? ext.avgCadence ?? null
  const finalMaxCadence = (compSummary?.max_cadence as number) ?? ext.maxCadence ?? null
  const finalAvgStrideCm = (compSummary?.avg_stride_cm as number) ?? null

  const finalAvgPaceSec = (compSummary?.avg_pace_sec as number) ?? null
  const finalMaxPaceSec = (compSummary?.max_pace_sec as number) ?? null
  const finalMinPaceSec = (compSummary?.min_pace_sec as number) ?? null

  const finalVo2Max = (compSummary?.vo2_max as number) ?? null
  const finalTrainLoad = (compSummary?.train_load as number) ?? null
  const finalTrainEffect = (compSummary?.train_effect as number) ?? null
  const finalRecoverTimeHours = (compSummary?.recover_time_hours as number) ?? null

  const finalDeviceType = (compDevice?.type as string) ?? null
  const finalDeviceId = (compDevice?.did as string) ?? null

  let hrZones: RouteHeartRateZones | null = null
  if (compZones) {
    hrZones = {
      warmUpDurationSec: (compZones.warm_up_duration_sec as number) ?? null,
      fatBurningDurationSec: (compZones.fat_burning_duration_sec as number) ?? null,
      aerobicDurationSec: (compZones.aerobic_duration_sec as number) ?? null,
      anaerobicDurationSec: (compZones.anaerobic_duration_sec as number) ?? null,
      extremeDurationSec: (compZones.extreme_duration_sec as number) ?? null
    }
  }

  const extraMetrics: RouteExtraMetrics = {
    steps: finalSteps,
    avgCadence: finalAvgCadence,
    maxCadence: finalMaxCadence,
    avgStrideCm: finalAvgStrideCm,
    avgPaceSec: finalAvgPaceSec,
    maxPaceSec: finalMaxPaceSec,
    minPaceSec: finalMinPaceSec,
    minHr: finalMinHr,
    vo2Max: finalVo2Max,
    trainLoad: finalTrainLoad,
    trainEffect: finalTrainEffect,
    recoverTimeHours: finalRecoverTimeHours,
    deviceType: finalDeviceType,
    deviceId: finalDeviceId,
    hrZones,
    rawRecord: (companionJson?.raw_record as Record<string, unknown>) ?? null
  }

  // 计算 splits
  const splits = computeSplits(points)

  // 生成 GeoJSON Feature LineString
  const coordinates = points.map((p) => [p.lon, p.lat])
  const geojsonObj: GeoJSON.Feature = {
    type: 'Feature',
    id,
    properties: {
      id,
      name: parsed.name,
      desc: parsed.desc,
      activityType: parsed.activityType,
      startTime,
      endTime,
      durationSec,
      movingDurationSec,
      totalDistanceM,
      avgSpeedKmh,
      maxSpeedKmh,
      calories: finalCalories,
      elevationGainM: Math.round(elevationGainM),
      elevationLossM: Math.round(elevationLossM),
      pointCount: points.length
    },
    geometry: {
      type: 'LineString',
      coordinates
    }
  }

  return {
    id,
    path: filePath,
    name: parsed.name,
    desc: parsed.desc,
    activityType: parsed.activityType,
    startTime,
    endTime,
    durationSec: Math.round(durationSec),
    movingDurationSec: Math.round(movingDurationSec),
    totalDistanceM: Math.round(totalDistanceM),
    avgSpeedKmh,
    maxSpeedKmh,
    calories: finalCalories,
    elevationGainM: elevationGainM > 0 ? Math.round(elevationGainM) : null,
    elevationLossM: elevationLossM > 0 ? Math.round(elevationLossM) : null,
    minEle: minEle != null ? Math.round(minEle) : null,
    maxEle: maxEle != null ? Math.round(maxEle) : null,
    avgHr: finalAvgHr,
    maxHr: finalMaxHr,
    minHr: finalMinHr,
    avgCadence: finalAvgCadence,
    maxCadence: finalMaxCadence,
    steps: finalSteps,
    avgStrideCm: finalAvgStrideCm,
    avgPaceSec: finalAvgPaceSec,
    maxPaceSec: finalMaxPaceSec,
    minPaceSec: finalMinPaceSec,
    vo2Max: finalVo2Max,
    trainLoad: finalTrainLoad,
    trainEffect: finalTrainEffect,
    recoverTimeHours: finalRecoverTimeHours,
    deviceType: finalDeviceType,
    deviceId: finalDeviceId,
    hrZones,
    extraMetrics,
    bounds,
    pointCount: points.length,
    geojson: JSON.stringify(geojsonObj),
    splits,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

/**
 * 将无 GPS 轨迹的室内运动 JSON（如跑步机室内跑步）直接解析成 Route 记录
 */
export function parseActivityJsonToRoute(
  jsonStr: string,
  filePath: string,
  routeId?: string
): Route | null {
  try {
    const data = JSON.parse(jsonStr)
    const id = routeId || data.id || `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const summary = data.summary || {}
    const durationSec = summary.duration_seconds || 0
    const distanceM = summary.distance_meters || 0
    const avgSpeedKmh =
      summary.avg_speed_kmh || (durationSec > 0 ? (distanceM / durationSec) * 3.6 : 0)

    const extraMetrics: RouteExtraMetrics = {
      steps: summary.steps ?? null,
      avgCadence: summary.avg_cadence ?? null,
      maxCadence: summary.max_cadence ?? null,
      avgStrideCm: summary.avg_stride_cm ?? null,
      avgPaceSec: summary.avg_pace_sec ?? null,
      maxPaceSec: summary.max_pace_sec ?? null,
      minPaceSec: summary.min_pace_sec ?? null,
      minHr: summary.min_hrm ?? null,
      vo2Max: summary.vo2_max ?? null,
      trainLoad: summary.train_load ?? null,
      trainEffect: summary.train_effect ?? null,
      recoverTimeHours: summary.recover_time_hours ?? null,
      deviceType: data.device?.type ?? 'indoor',
      deviceId: data.device?.did ?? null,
      hrZones: data.heart_rate_zones
        ? {
            warmUpDurationSec: data.heart_rate_zones.warm_up_duration_sec,
            fatBurningDurationSec: data.heart_rate_zones.fat_burning_duration_sec,
            aerobicDurationSec: data.heart_rate_zones.aerobic_duration_sec,
            anaerobicDurationSec: data.heart_rate_zones.anaerobic_duration_sec,
            extremeDurationSec: data.heart_rate_zones.extreme_duration_sec
          }
        : null,
      rawRecord: data.raw_record ?? null
    }

    let bounds: [number, number, number, number] = [0, 0, 0, 0]
    let pointCount = 0
    let geojson = '{"type":"Feature","geometry":null,"properties":{}}'

    const loc =
      data.location ||
      (Array.isArray(data.start_point) && data.start_point.length >= 2
        ? { longitude: data.start_point[0], latitude: data.start_point[1] }
        : null)
    if (
      loc &&
      typeof loc.longitude === 'number' &&
      typeof loc.latitude === 'number' &&
      !Number.isNaN(loc.longitude) &&
      !Number.isNaN(loc.latitude)
    ) {
      bounds = [loc.longitude, loc.latitude, loc.longitude, loc.latitude]
      pointCount = 1
      geojson = JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [loc.longitude, loc.latitude]
        },
        properties: {
          id,
          name: data.name || '运动记录'
        }
      })
    }

    return {
      id,
      path: filePath,
      name: data.name || '运动记录',
      desc:
        data.sport_display || (pointCount === 1 ? '运动记录 (单点定位)' : '室内/无轨迹运动记录'),
      activityType: data.sport_type || 'running',
      startTime: data.start_time || null,
      endTime: data.end_time || null,
      durationSec,
      movingDurationSec: durationSec,
      totalDistanceM: distanceM,
      avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
      maxSpeedKmh: summary.max_speed_kmh || Math.round(avgSpeedKmh * 10) / 10,
      calories: summary.calories_kcal || null,
      avgHr: summary.avg_hrm ?? null,
      maxHr: summary.max_hrm ?? null,
      minHr: summary.min_hrm ?? null,
      avgCadence: summary.avg_cadence ?? null,
      maxCadence: summary.max_cadence ?? null,
      steps: summary.steps ?? null,
      avgStrideCm: summary.avg_stride_cm ?? null,
      avgPaceSec: summary.avg_pace_sec ?? null,
      maxPaceSec: summary.max_pace_sec ?? null,
      minPaceSec: summary.min_pace_sec ?? null,
      vo2Max: summary.vo2_max ?? null,
      trainLoad: summary.train_load ?? null,
      trainEffect: summary.train_effect ?? null,
      recoverTimeHours: summary.recover_time_hours ?? null,
      deviceType: data.device?.type ?? 'indoor',
      deviceId: data.device?.name ?? data.device?.did ?? null,
      hrZones: extraMetrics.hrZones,
      extraMetrics,
      bounds,
      pointCount,
      geojson,
      splits: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  } catch {
    return null
  }
}

/**
 * 空间几何相交判定：检测一条航线折线是否穿过以 (centerLon, centerLat) 为中心、半径 radiusKm 的圆形区域
 * 对应搜索指令 :gps(lon, lat, km)
 */
export function isRouteIntersectingCircle(
  route: Route,
  centerLon: number,
  centerLat: number,
  radiusKm: number
): boolean {
  const radiusM = radiusKm * 1000

  // 1. 先用包围盒快速外包拒绝（Bbox Broadphase Filter）
  const [minLon, minLat, maxLon, maxLat] = route.bounds
  const latDeltaDeg = radiusM / 111320
  const lonDeltaDeg = radiusM / (111320 * Math.cos((centerLat * Math.PI) / 180) || 1)

  if (
    centerLon < minLon - lonDeltaDeg ||
    centerLon > maxLon + lonDeltaDeg ||
    centerLat < minLat - latDeltaDeg ||
    centerLat > maxLat + latDeltaDeg
  ) {
    return false
  }

  // 2. 精确折线与圆盘相交检测（LineString narrowphase check）
  try {
    const geo = JSON.parse(route.geojson) as GeoJSON.Feature<GeoJSON.LineString>
    const coords = geo.geometry?.coordinates
    if (!coords || coords.length < 2) return false

    for (let i = 0; i < coords.length; i++) {
      const [lon, lat] = coords[i]
      const dist = haversineDistM(lon, lat, centerLon, centerLat)
      if (dist <= radiusM) return true

      // 检查相邻两点组成的线段到圆心的最近距离
      if (i > 0) {
        const [p1Lon, p1Lat] = coords[i - 1]
        if (distSegmentToPointM(p1Lon, p1Lat, lon, lat, centerLon, centerLat) <= radiusM) {
          return true
        }
      }
    }
  } catch {
    return false
  }

  return false
}

/** 计算二维点到线段的最短距离（米） */
function distSegmentToPointM(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  px: number,
  py: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return haversineDistM(x1, y1, px, py)

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  return haversineDistM(projX, projY, px, py)
}
