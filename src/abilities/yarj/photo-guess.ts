import type { Photo, GuessedGps } from './types'

const EARTH_RADIUS_METERS = 6371000

/** 计算两个 WGS-84 经纬度点之间的地球大圆球面距离（米）。 */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_METERS * c
}

export interface PhotoGuessOptions {
  /** 最大距离阈值（米），默认 10000（10公里） */
  maxDistanceM?: number
  /** 最大时间跨度阈值（小时），默认 4 */
  maxTimeHours?: number
}

/**
 * 计算无 GPS 数据的照片在时空序列中的中点猜测。
 *
 * 算法规则：
 * 1. 按图库根目录（root）分组，保证仅在同一图库/设备来源内进行插值；
 * 2. 筛选具有有效拍摄时间（taken_at）的照片并按时序升序排序；
 * 3. 对无 GPS 定位的照片，检索其紧邻的前一张含 GPS 照片 (prev) 与后一张含 GPS 照片 (next)；
 * 4. 校验前后两点间距（默认 <= 10km）与时间跨度（默认 <= 4小时）；
 * 5. 计算两张参考照片的中点坐标：(lat1 + lat2) / 2, (lon1 + lon2) / 2；
 * 6. 返回以 photo.path 为键的 GuessedGps 映射表。
 */
export function computeGuessedGpsMap(
  photos: Photo[],
  options?: PhotoGuessOptions
): Map<string, GuessedGps> {
  const result = new Map<string, GuessedGps>()
  if (!photos || photos.length < 3) return result

  const maxDist = options?.maxDistanceM ?? 10000
  const maxTimeSec = (options?.maxTimeHours ?? 4) * 3600

  // 1. 按 root 分组
  const byRoot = new Map<string, Photo[]>()
  for (const p of photos) {
    const rootKey = p.root || ''
    let group = byRoot.get(rootKey)
    if (!group) {
      group = []
      byRoot.set(rootKey, group)
    }
    group.push(p)
  }

  // 2. 对每个分组分别进行时序分析
  for (const group of byRoot.values()) {
    // 筛选出有有效 taken_at 的照片
    const timedPhotos: { photo: Photo; time: number }[] = []
    for (const p of group) {
      if (!p.taken_at) continue
      const t = Date.parse(p.taken_at)
      if (!Number.isNaN(t)) {
        timedPhotos.push({ photo: p, time: t })
      }
    }

    if (timedPhotos.length < 3) continue

    // 升序排序
    timedPhotos.sort((a, b) => a.time - b.time)

    // 记录含有效 GPS 照片的索引列表
    const gpsIndices: number[] = []
    for (let i = 0; i < timedPhotos.length; i++) {
      const p = timedPhotos[i].photo
      if (p.gps_lat != null && p.gps_lon != null) {
        gpsIndices.push(i)
      }
    }

    if (gpsIndices.length < 2) continue

    // 遍历每张没有 GPS 的照片
    for (let i = 0; i < timedPhotos.length; i++) {
      const current = timedPhotos[i]
      if (current.photo.gps_lat != null && current.photo.gps_lon != null) {
        continue
      }

      // 二分查找或扫描找到时间最接近的前后 GPS 照片
      // 寻找最后一个索引 < i 的 gpsIndex
      let prevGpsIdx = -1
      for (let g = gpsIndices.length - 1; g >= 0; g--) {
        if (gpsIndices[g] < i) {
          prevGpsIdx = gpsIndices[g]
          break
        }
      }

      // 寻找第一个索引 > i 的 gpsIndex
      let nextGpsIdx = -1
      for (let g = 0; g < gpsIndices.length; g++) {
        if (gpsIndices[g] > i) {
          nextGpsIdx = gpsIndices[g]
          break
        }
      }

      if (prevGpsIdx === -1 || nextGpsIdx === -1) {
        continue
      }

      const prevItem = timedPhotos[prevGpsIdx]
      const nextItem = timedPhotos[nextGpsIdx]

      // 检查时间跨度
      const timeDiffSec = (nextItem.time - prevItem.time) / 1000
      if (timeDiffSec <= 0 || timeDiffSec > maxTimeSec) {
        continue
      }

      const prevLat = prevItem.photo.gps_lat!
      const prevLon = prevItem.photo.gps_lon!
      const nextLat = nextItem.photo.gps_lat!
      const nextLon = nextItem.photo.gps_lon!

      // 检查两点实际距离
      const distM = haversineDistance(prevLat, prevLon, nextLat, nextLon)
      if (distM > maxDist) {
        continue
      }

      // 自动选择两张图片的中点（兼容跨越 180° 日界线的大圆中点经度）
      const midLat = (prevLat + nextLat) / 2
      let dLon = nextLon - prevLon
      if (dLon > 180) dLon -= 360
      else if (dLon < -180) dLon += 360
      let midLon = prevLon + dLon / 2
      if (midLon > 180) midLon -= 360
      else if (midLon < -180) midLon += 360

      result.set(current.photo.path, {
        lat: Number(midLat.toFixed(6)),
        lon: Number(midLon.toFixed(6)),
        distanceM: Math.round(distM),
        timeDiffSeconds: Math.round(timeDiffSec),
        prevPath: prevItem.photo.path,
        nextPath: nextItem.photo.path,
        prevTakenAt: prevItem.photo.taken_at || '',
        nextTakenAt: nextItem.photo.taken_at || ''
      })
    }
  }

  return result
}

/**
 * 扫描作业后端专用的静态 GPS 推算：
 * 对传入的照片列表执行推算，返回待写入数据库的 `{ path, guess }` 数组。
 */
export function computeStaticGpsGuesses(
  photos: Photo[],
  options?: PhotoGuessOptions
): { path: string; guess: GuessedGps }[] {
  const map = computeGuessedGpsMap(photos, options)
  return [...map.entries()].map(([path, guess]) => ({ path, guess }))
}
