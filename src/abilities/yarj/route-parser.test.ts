import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'fs'
import {
  parseGpxToRoute,
  parseActivityJsonToRoute,
  isRouteIntersectingCircle
} from './route-parser'

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

  test('parses single-point activity JSON (e.g. Vivo Health) into Point route', () => {
    const vivoJson = JSON.stringify({
      id: 'vivo_test_1',
      name: '2024-04-23 17:39:24 户外跑步 (0.51km)',
      sport_type: 'running',
      sport_display: '户外跑步 (vivo 运动健康)',
      summary: {
        duration_seconds: 559,
        distance_meters: 512.78,
        calories_kcal: 28,
        steps: 701
      },
      location: {
        latitude: 28.18596,
        longitude: 112.94935
      }
    })

    const route = parseActivityJsonToRoute(vivoJson, '/path/to/vivo.json')
    assert.ok(route != null, 'Route should not be null')
    assert.equal(route.id, 'vivo_test_1')
    assert.equal(route.pointCount, 1)
    assert.deepEqual(route.bounds, [112.94935, 28.18596, 112.94935, 28.18596])
    assert.equal(route.steps, 701)
    assert.equal(route.calories, 28)

    const geojson = JSON.parse(route.geojson)
    assert.equal(geojson.type, 'Feature')
    assert.equal(geojson.geometry.type, 'Point')
    assert.deepEqual(geojson.geometry.coordinates, [112.94935, 28.18596])
  })

  test('parses pure indoor activity JSON without location into 0-point route', () => {
    const indoorJson = JSON.stringify({
      id: 'indoor_test_1',
      name: '2024-05-01 10:00:00 室内跑步机',
      sport_type: 'running',
      summary: {
        duration_seconds: 600,
        distance_meters: 1200,
        calories_kcal: 85
      }
    })

    const route = parseActivityJsonToRoute(indoorJson, '/path/to/indoor.json')
    assert.ok(route != null, 'Route should not be null')
    assert.equal(route.pointCount, 0)
    assert.deepEqual(route.bounds, [0, 0, 0, 0])
    assert.equal(route.durationSec, 600)
    assert.equal(route.totalDistanceM, 1200)

    const geojson = JSON.parse(route.geojson)
    assert.equal(geojson.type, 'Feature')
    assert.equal(geojson.geometry, null)
  })
})
