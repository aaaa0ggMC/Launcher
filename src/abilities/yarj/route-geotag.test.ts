import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'fs'
import { parseGpxToRoute } from './route-parser'
import { matchPhotoToRoute, previewRouteGeotag, getRoutePoints } from './route-geotag'
import type { Photo } from './types'

function makePhoto(
  id: number,
  taken_at: string,
  lat: number | null = null,
  lon: number | null = null
): Photo {
  return {
    id,
    path: `/test/img_${id}.jpg`,
    root: '/test',
    width: null,
    height: null,
    taken_at,
    gps_lat: lat,
    gps_lon: lon,
    gps_alt: null,
    camera_make: 'Xiaomi',
    camera_model: 'Redmi K80',
    appendix: {}
  }
}

describe('route-geotag', () => {
  const gpxPath = '/home/aaaa0ggmc/Downloads/20260905Outdoor cycling.gpx'

  test('interpolates coordinates accurately along track', () => {
    if (!existsSync(gpxPath)) return

    const xml = readFileSync(gpxPath, 'utf-8')
    const route = parseGpxToRoute(xml, gpxPath)
    assert.ok(route != null)
    if (!route) return

    const points = getRoutePoints(route)
    assert.ok(points.length > 0)

    // 照片拍摄于 18:25:12 (GPX 时间范围内：18:01:20 - 19:11:45)
    // 假设某张照片没有 GPS (lat = null, lon = null)
    const photoNoGps = makePhoto(1, '2026-09-05T18:25:12Z')
    const matched = matchPhotoToRoute(photoNoGps, route, points, 0)

    assert.ok(matched != null, 'Photo taken during activity should be matched')
    if (!matched) return

    assert.equal(matched.routeName, '20260905Outdoor cycling')
    // 坐标应该在 (30.535, 114.429) 附近
    assert.ok(matched.lat >= 30.5 && matched.lat <= 30.6)
    assert.ok(matched.lon >= 114.4 && matched.lon <= 114.5)

    // 照片拍摄于活动开始之前（例如 17:00:00）-> 应该不匹配
    const photoBefore = makePhoto(2, '2026-09-05T17:00:00Z')
    assert.equal(matchPhotoToRoute(photoBefore, route, points, 0), null)

    // 预览多张照片
    const photoWithGps = makePhoto(3, '2026-09-05T18:25:12Z', matched.lat, matched.lon)
    const preview = previewRouteGeotag([photoNoGps, photoWithGps, photoBefore], route, 0)
    assert.equal(preview.matchedCount, 2)
    assert.equal(preview.unmatchedCount, 1)
    // 验证偏差距离（photoWithGps 与 matched 坐标一致，diff 应小于 1 米）
    assert.ok((preview.matchedItems[1].diffDistM ?? 999) < 1.0)
  })
})
