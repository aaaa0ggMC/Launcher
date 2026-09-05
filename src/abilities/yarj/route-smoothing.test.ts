import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RoutePoint } from './types'
import { smoothRoutePoints, smoothFollowCamera, smoothFollowMarker } from './route-smoothing'

describe('route smoothing', () => {
  it('preserves start and end points and handles short paths', () => {
    const pts: RoutePoint[] = [
      { lon: 114.1, lat: 30.1, distFromStartM: 0 },
      { lon: 114.2, lat: 30.2, distFromStartM: 100 }
    ]
    const res = smoothRoutePoints(pts, 5)
    assert.equal(res.length, 2)
    assert.deepEqual(res[0], pts[0])
    assert.deepEqual(res[1], pts[1])
  })

  it('filters out jitter and returns smoothed internal points', () => {
    // 假设直线上出现了一个明显的突变噪点
    const pts: RoutePoint[] = [
      { lon: 114.0, lat: 30.0, distFromStartM: 0, ele: 10 },
      { lon: 114.1, lat: 30.5, distFromStartM: 50, ele: 50 }, // 严重横跳抖动点
      { lon: 114.2, lat: 30.0, distFromStartM: 100, ele: 10 },
      { lon: 114.3, lat: 30.0, distFromStartM: 150, ele: 10 }
    ]
    const smoothed = smoothRoutePoints(pts, 3)
    assert.equal(smoothed.length, 4)
    // 首尾严格锁定
    assert.equal(smoothed[0].lat, 30.0)
    assert.equal(smoothed[3].lat, 30.0)
    // 内部抖动点被高斯加权平滑拉回（小于原始 30.5）
    assert.ok(smoothed[1].lat < 30.5)
    assert.ok(smoothed[1].lat > 30.0)
    // 海拔也被平滑
    assert.ok(smoothed[1].ele! < 50)
    // 累积里程单调递增
    assert.equal(smoothed[0].distFromStartM, 0)
    assert.ok(smoothed[1].distFromStartM > 0)
    assert.ok(smoothed[2].distFromStartM > smoothed[1].distFromStartM)
  })

  it('smoothFollowCamera eases smoothly toward target', () => {
    const start: [number, number] = [114.0, 30.0]
    const target: [number, number] = [114.001, 30.001]
    const step = smoothFollowCamera(start, target, 0.016, 10)
    assert.ok(step[0] > start[0])
    assert.ok(step[0] < target[0])
    assert.ok(step[1] > start[1])
    assert.ok(step[1] < target[1])
  })

  it('smoothFollowMarker smooths motion towards target', () => {
    const start: [number, number] = [114.0, 30.0]
    const target: [number, number] = [114.002, 30.002]
    const step = smoothFollowMarker(start, target, 0.016, 15)
    assert.ok(step[0] > start[0])
    assert.ok(step[0] < target[0])
  })

  it('smoothFollowCamera snaps on huge jump distance', () => {
    const start: [number, number] = [114.0, 30.0]
    const farTarget: [number, number] = [116.0, 39.0] // 远距离跨度
    const step = smoothFollowCamera(start, farTarget, 0.016, 10)
    assert.deepEqual(step, farTarget)
  })
})
