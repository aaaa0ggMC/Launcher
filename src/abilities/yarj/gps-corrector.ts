import type { Photo, CorrectedGps } from './types'
import { haversineDistance } from './photo-guess'

export interface GpsCorrectionOptions {
  /** 最大合理移动速度（km/h），默认 800 km/h（航空上限） */
  maxSpeedKmh?: number
  /** 最小漂移判定距离（km），默认 80 km（避免误纠同城正常活动） */
  minDriftKm?: number
  /** 时间窗口上限（小时），默认 24 小时 */
  maxTimeGapHours?: number
  /** 可选：仅处理指定 root 目录 */
  root?: string
}

export interface GpsCorrectionResultItem {
  photo: Photo
  correction: CorrectedGps
}

interface TimedCoordPhoto {
  photo: Photo
  time: number
  lat: number
  lon: number
}

/** 将大圆距离（米）转换为公里 */
function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistance(lat1, lon1, lat2, lon2) / 1000
}

/**
 * 分析照片的时序轨迹与速度合理性，检测异常跨区/跨国大漂移跳点并计算纠正坐标。
 */
export function analyzeAndCorrectGpsDrifts(
  photos: Photo[],
  options?: GpsCorrectionOptions
): GpsCorrectionResultItem[] {
  const maxSpeedKmh = options?.maxSpeedKmh ?? 800
  const minDriftKm = options?.minDriftKm ?? 80
  const maxTimeGapMs = (options?.maxTimeGapHours ?? 24) * 3600 * 1000
  const targetRoot = options?.root

  const results: GpsCorrectionResultItem[] = []
  if (!photos || photos.length < 3) return results

  // 1. 按 root 分组，若指定了 targetRoot 则只分析目标目录
  const byRoot = new Map<string, Photo[]>()
  for (const p of photos) {
    if (targetRoot && p.root !== targetRoot) continue
    const rKey = p.root || ''
    let group = byRoot.get(rKey)
    if (!group) {
      group = []
      byRoot.set(rKey, group)
    }
    group.push(p)
  }

  for (const group of byRoot.values()) {
    // 2. 提取有有效拍摄时间和有效初始坐标的照片
    const seq: TimedCoordPhoto[] = []
    for (const p of group) {
      if (!p.taken_at) continue
      const t = new Date(p.taken_at).getTime()
      if (Number.isNaN(t)) continue

      // 提取基准坐标（纠正前原始坐标）
      const rawLat = p.gps_corrected?.original_lat ?? p.gps_lat
      const rawLon = p.gps_corrected?.original_lon ?? p.gps_lon

      if (
        rawLat != null &&
        rawLon != null &&
        Number.isFinite(rawLat) &&
        Number.isFinite(rawLon) &&
        rawLat >= -90 &&
        rawLat <= 90 &&
        rawLon >= -180 &&
        rawLon <= 180
      ) {
        seq.push({ photo: p, time: t, lat: rawLat, lon: rawLon })
      }
    }

    if (seq.length < 3) continue

    // 按时间严格升序排序
    seq.sort((a, b) => a.time - b.time)

    // 3. 迭代检测漂移离群点（支持连续 1~3 个点的离群跳跃块）
    const correctedIndices = new Set<number>()

    // 第一阶段：检测中间孤立尖刺或小突发漂移块 A -> B1..Bk -> C
    for (let i = 1; i < seq.length - 1; i++) {
      if (correctedIndices.has(i)) continue

      // 尝试匹配单点或连续多点漂移块 (k = 1, 2, 3)
      for (let burstLen = 1; burstLen <= 3; burstLen++) {
        const prevIdx = i - 1
        const nextIdx = i + burstLen
        if (nextIdx >= seq.length) break

        const A = seq[prevIdx]
        const C = seq[nextIdx]

        const dtTotalHours = (C.time - A.time) / 3600000
        if (dtTotalHours <= 0 || C.time - A.time > maxTimeGapMs) break

        const distAC = distKm(A.lat, A.lon, C.lat, C.lon)
        const speedAC = distAC / dtTotalHours

        // 基准点 A 与 C 之间的速度必须是合理的（例如在同一区域或正常交通工具可达）
        if (speedAC > maxSpeedKmh) continue

        // 检查中间的 burst 是否全部呈现离群大漂移
        let allOutliers = true
        let maxObservedSpeed = 0
        let maxObservedDrift = 0

        for (let b = 0; b < burstLen; b++) {
          const B = seq[i + b]
          const dtAB = (B.time - A.time) / 3600000
          const dtBC = (C.time - B.time) / 3600000

          const distAB = distKm(A.lat, A.lon, B.lat, B.lon)
          const distBC = distKm(B.lat, B.lon, C.lat, C.lon)

          const speedAB = dtAB > 0.0001 ? distAB / dtAB : 99999
          const speedBC = dtBC > 0.0001 ? distBC / dtBC : 99999

          const isDriftAB = distAB >= minDriftKm && speedAB > maxSpeedKmh
          const isDriftBC = distBC >= minDriftKm && speedBC > maxSpeedKmh

          if (isDriftAB || isDriftBC) {
            maxObservedSpeed = Math.max(maxObservedSpeed, speedAB, speedBC)
            maxObservedDrift = Math.max(maxObservedDrift, distAB, distBC)
          } else {
            allOutliers = false
            break
          }
        }

        if (allOutliers && maxObservedSpeed > maxSpeedKmh) {
          // 确认此块为异常漂移，对该块内的每个点进行时间插值纠正
          for (let b = 0; b < burstLen; b++) {
            const curIdx = i + b
            const B = seq[curIdx]
            const ratio = (B.time - A.time) / (C.time - A.time)
            const clampedRatio = Math.max(0, Math.min(1, ratio))

            const corrLat = A.lat + clampedRatio * (C.lat - A.lat)
            const corrLon = A.lon + clampedRatio * (C.lon - A.lon)

            const driftDist = Math.round(distKm(B.lat, B.lon, corrLat, corrLon))
            const recordedSpeed = Math.round(maxObservedSpeed)

            const correction: CorrectedGps = {
              lat: Number(corrLat.toFixed(6)),
              lon: Number(corrLon.toFixed(6)),
              reason: `时空速度异常漂移 (${recordedSpeed} km/h > ${maxSpeedKmh} km/h，偏离 ${driftDist} km)`,
              original_lat: B.lat,
              original_lon: B.lon,
              drift_distance_km: driftDist,
              speed_kmh: recordedSpeed,
              prevPath: A.photo.path,
              nextPath: C.photo.path,
              corrected_at: new Date().toISOString()
            }

            results.push({
              photo: B.photo,
              correction
            })

            correctedIndices.add(curIdx)
            // 更新虚拟坐标以便后续点计算
            B.lat = corrLat
            B.lon = corrLon
          }

          i += burstLen - 1
          break
        }
      }
    }

    // 第二阶段：检测首部或尾部单侧孤立离群点（Edge Spikes）
    // 检查首点 seq[0]
    if (!correctedIndices.has(0) && seq.length >= 3) {
      const B = seq[0]
      const C1 = seq[1]
      const C2 = seq[2]
      const dtC1C2 = (C2.time - C1.time) / 3600000
      const distC1C2 = distKm(C1.lat, C1.lon, C2.lat, C2.lon)
      const speedC1C2 = dtC1C2 > 0 ? distC1C2 / dtC1C2 : 0

      // 如果后面的点是稳定的
      if (speedC1C2 <= maxSpeedKmh) {
        const dtBC = (C1.time - B.time) / 3600000
        const distBC = distKm(B.lat, B.lon, C1.lat, C1.lon)
        const speedBC = dtBC > 0 ? distBC / dtBC : 99999

        if (dtBC * 3600000 <= maxTimeGapMs && distBC >= minDriftKm && speedBC > maxSpeedKmh) {
          const driftDist = Math.round(distBC)
          const recordedSpeed = Math.round(speedBC)
          const correction: CorrectedGps = {
            lat: C1.lat,
            lon: C1.lon,
            reason: `首端时空速度异常漂移 (${recordedSpeed} km/h > ${maxSpeedKmh} km/h，偏离 ${driftDist} km)`,
            original_lat: B.lat,
            original_lon: B.lon,
            drift_distance_km: driftDist,
            speed_kmh: recordedSpeed,
            nextPath: C1.photo.path,
            corrected_at: new Date().toISOString()
          }
          results.push({ photo: B.photo, correction })
          correctedIndices.add(0)
        }
      }
    }

    // 检查末点 seq[seq.length - 1]
    const lastIdx = seq.length - 1
    if (!correctedIndices.has(lastIdx) && seq.length >= 3) {
      const B = seq[lastIdx]
      const A1 = seq[lastIdx - 1]
      const A0 = seq[lastIdx - 2]
      const dtA0A1 = (A1.time - A0.time) / 3600000
      const distA0A1 = distKm(A0.lat, A0.lon, A1.lat, A1.lon)
      const speedA0A1 = dtA0A1 > 0 ? distA0A1 / dtA0A1 : 0

      if (speedA0A1 <= maxSpeedKmh) {
        const dtAB = (B.time - A1.time) / 3600000
        const distAB = distKm(A1.lat, A1.lon, B.lat, B.lon)
        const speedAB = dtAB > 0 ? distAB / dtAB : 99999

        if (dtAB * 3600000 <= maxTimeGapMs && distAB >= minDriftKm && speedAB > maxSpeedKmh) {
          const driftDist = Math.round(distAB)
          const recordedSpeed = Math.round(speedAB)
          const correction: CorrectedGps = {
            lat: A1.lat,
            lon: A1.lon,
            reason: `末端时空速度异常漂移 (${recordedSpeed} km/h > ${maxSpeedKmh} km/h，偏离 ${driftDist} km)`,
            original_lat: B.lat,
            original_lon: B.lon,
            drift_distance_km: driftDist,
            speed_kmh: recordedSpeed,
            prevPath: A1.photo.path,
            corrected_at: new Date().toISOString()
          }
          results.push({ photo: B.photo, correction })
          correctedIndices.add(lastIdx)
        }
      }
    }
  }

  return results
}
