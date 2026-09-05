import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'fs'
import { parseGpxToRoute, isRouteIntersectingCircle } from './route-parser'

describe('route-parser', () => {
  const testGpxPath = '/home/aaaa0ggmc/Downloads/20260905Outdoor cycling.gpx'

  test('parses Mi Fitness outdoor cycling gpx accurately', () => {
    if (!existsSync(testGpxPath)) {
      console.warn('Test gpx not found, skipping real file test')
      return
    }

    const xml = readFileSync(testGpxPath, 'utf-8')
    const route = parseGpxToRoute(xml, testGpxPath)
    assert.ok(route != null, 'Route should not be null')
    if (!route) return

    assert.equal(route.name, '20260905Outdoor cycling')
    assert.equal(route.activityType, 'cycling')
    assert.ok(route.pointCount > 3000, `Expected > 3000 points, got ${route.pointCount}`)

    // 里程约为 15.6km (15606m)
    assert.ok(
      route.totalDistanceM >= 15500 && route.totalDistanceM <= 15800,
      `Expected totalDistanceM ~15600, got ${route.totalDistanceM}`
    )

    // 总时间约为 01:10:25 = 4225 秒
    assert.equal(route.durationSec, 4225)

    // 均速约为 13.3 km/h
    assert.ok(
      route.avgSpeedKmh >= 12.0 && route.avgSpeedKmh <= 16.0,
      `Expected avgSpeedKmh ~13.3, got ${route.avgSpeedKmh}`
    )

    // 极速约为 32.4 km/h (截图显示为 32.4)
    assert.ok(
      route.maxSpeedKmh >= 26.0 && route.maxSpeedKmh <= 36.0,
      `Expected maxSpeedKmh ~32.4, got ${route.maxSpeedKmh}`
    )

    // 卡路里估算约 500-650 kcal
    assert.ok(
      (route.calories ?? 0) >= 450 && (route.calories ?? 0) <= 750,
      `Expected calories ~550, got ${route.calories}`
    )

    // 分段数据
    assert.ok(
      route.splits != null && route.splits.length >= 15,
      `Expected >= 15 splits, got ${route.splits?.length}`
    )

    // 空间相交测试
    // 起点附近 (114.428, 30.534)
    assert.equal(isRouteIntersectingCircle(route, 114.428, 30.534, 1), true)
    // 远离区域（例如北京 116.4, 39.9）
    assert.equal(isRouteIntersectingCircle(route, 116.4, 39.9, 10), false)
  })
})
