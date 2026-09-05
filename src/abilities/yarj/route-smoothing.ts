/**
 * yarj 航线轨迹平滑与相机防抖阻尼引擎
 *
 * 1. 轨迹平滑：通过高斯核加权滑动平均滤波，消除原始 GPS 记录中的高频微观锯齿抖动，
 *    同时锁定起终点、保持原始时间戳与物理属性。
 * 2. 相机阻尼：用于航线回放镜头跟随时的平滑追随（云台防抖缓冲），防止相机在小范围内出现剧烈震颤。
 */

import type { RoutePoint } from './types'

/**
 * 构建归一化的高斯平滑权重核
 */
function getGaussianKernel(radius: number): number[] {
  const sigma = Math.max(0.8, radius / 2)
  const weights: number[] = []
  let sum = 0

  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    weights.push(w)
    sum += w
  }

  return weights.map((w) => w / sum)
}

/**
 * 对轨迹点序列进行平滑处理
 * @param points 原始轨迹点
 * @param windowSize 平滑窗口大小（推荐 3-15，默认 5）
 */
export function smoothRoutePoints(points: RoutePoint[], windowSize = 5): RoutePoint[] {
  const len = points.length
  if (len <= 2 || windowSize < 3) {
    return points.slice()
  }

  // 保证窗口大小为奇数且在合理范围
  let effectiveWindow = Math.max(3, Math.min(21, Math.round(windowSize)))
  if (effectiveWindow % 2 === 0) effectiveWindow += 1
  const radius = Math.floor(effectiveWindow / 2)

  const kernel = getGaussianKernel(radius)
  const smoothed: RoutePoint[] = new Array(len)

  // 严格固定首尾两端，保证起终点精准
  smoothed[0] = { ...points[0] }
  smoothed[len - 1] = { ...points[len - 1] }

  for (let i = 1; i < len - 1; i++) {
    const p = points[i]

    // 边界动态调整窗口
    const currentRadius = Math.min(radius, i, len - 1 - i)
    let weightSum = 0
    let sumLon = 0
    let sumLat = 0
    let sumEle = 0
    let hasEle = false

    for (let offset = -currentRadius; offset <= currentRadius; offset++) {
      const neighbor = points[i + offset]
      const w = kernel[radius + offset]
      weightSum += w
      sumLon += neighbor.lon * w
      sumLat += neighbor.lat * w
      if (neighbor.ele != null) {
        sumEle += neighbor.ele * w
        hasEle = true
      }
    }

    const norm = weightSum > 0 ? weightSum : 1

    smoothed[i] = {
      ...p,
      lon: sumLon / norm,
      lat: sumLat / norm,
      ele: hasEle ? sumEle / norm : p.ele
    }
  }

  // 重新生成平滑连续的累积里程
  let cumDist = 0
  smoothed[0].distFromStartM = 0
  for (let i = 1; i < len; i++) {
    const prev = smoothed[i - 1]
    const cur = smoothed[i]
    cumDist += approxDistM(prev.lon, prev.lat, cur.lon, cur.lat)
    cur.distFromStartM = cumDist
  }

  return smoothed
}

function approxDistM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * 屏幕空间/经纬度自适应相机平滑阻尼插值（云台防抖效果）
 * @param current 当前相机位置 [lon, lat]
 * @param target 目标跟随点位置 [lon, lat]
 * @param dtSec 帧时间差（秒）
 * @param stiffness 阻尼刚度系数（越大追随越快，推荐 8 ~ 14）
 */
export function smoothFollowCamera(
  current: [number, number],
  target: [number, number],
  dtSec: number,
  stiffness = 10
): [number, number] {
  // 当瞬时距离过大（例如跳转、拖进度条超过 ~0.05 度约 5km 时），不进行阻尼，直接归位
  const dLon = target[0] - current[0]
  const dLat = target[1] - current[1]
  const distSq = dLon * dLon + dLat * dLat

  if (distSq > 0.0025 || dtSec <= 0 || dtSec > 0.5) {
    return [target[0], target[1]]
  }

  // 基于时间的阻尼指数插值：1 - e^(-stiffness * dt)
  const factor = 1 - Math.exp(-stiffness * dtSec)

  return [current[0] + dLon * factor, current[1] + dLat * factor]
}

/**
 * 点（小车 Marker）本身在运动过程中的平滑阻尼插值
 * 滤除离散插值带来的速度与转向阶跃，消除小车在地图上的剧烈抽搐（鬼畜）
 */
export function smoothFollowMarker(
  current: [number, number],
  target: [number, number],
  dtSec: number,
  stiffness = 15
): [number, number] {
  return smoothFollowCamera(current, target, dtSec, stiffness)
}
