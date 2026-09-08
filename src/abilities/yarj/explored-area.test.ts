import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  haversineDistM,
  initialBearingRad,
  destinationPoint,
  makeCircleRing,
  makeCapsuleRing,
  simplifyCoordinates,
  getZoomLodBucket,
  getRouteToleranceForBucket,
  generateExploredGeoJSON
} from './explored-area'
import type { Photo, Route } from './types'

describe('Yarj Explored Area Fog-of-War Engine', () => {
  test('haversineDistM calculates geodesic distance accurately', () => {
    // 1 degree latitude is ~111,195 m
    const distLat = haversineDistM(0, 0, 0, 1)
    assert.ok(distLat > 111000 && distLat < 112000, `Expected ~111km, got ${distLat}`)

    // Same location -> 0
    assert.strictEqual(haversineDistM(114.4, 30.5, 114.4, 30.5), 0)
  })

  test('initialBearingRad calculates correct direction angles', () => {
    // Due North: bearing should be 0
    const bNorth = initialBearingRad(0, 0, 0, 1)
    assert.ok(Math.abs(bNorth - 0) < 1e-6)

    // Due East: bearing should be π/2 (~1.5708)
    const bEast = initialBearingRad(0, 0, 1, 0)
    assert.ok(Math.abs(bEast - Math.PI / 2) < 1e-4)

    // Due South: bearing should be π (~3.14159)
    const bSouth = initialBearingRad(0, 1, 0, 0)
    assert.ok(Math.abs(Math.abs(bSouth) - Math.PI) < 1e-4)
  })

  test('destinationPoint projects coordinates accurately', () => {
    // Starting at (0, 0), moving 1000m north (bearing 0)
    const [lon, lat] = destinationPoint(0, 0, 0, 1000)
    assert.ok(Math.abs(lon - 0) < 1e-6)
    // 1000m / 6378137m * (180 / π) deg lat
    assert.ok(lat > 0.008 && lat < 0.01)
  })

  test('makeCircleRing produces a closed polygon ring with correct step count', () => {
    const steps = 16
    const ring = makeCircleRing(120.0, 30.0, 500, steps)
    // Closed ring has steps + 1 points (last === first)
    assert.strictEqual(ring.length, steps + 1)
    const [firstLon, firstLat] = ring[0]
    const [lastLon, lastLat] = ring[ring.length - 1]
    assert.ok(Math.abs(firstLon - lastLon) < 1e-5)
    assert.ok(Math.abs(firstLat - lastLat) < 1e-5)
  })

  test('makeCapsuleRing produces valid dumbbell corridor between two points', () => {
    const arcSteps = 8
    const ring = makeCapsuleRing(120.0, 30.0, 120.01, 30.01, 300, arcSteps)
    // Capsule ring has 2 arcs of (arcSteps + 1) points + closing point
    assert.ok(ring.length > arcSteps * 2)
    // Closed ring
    const [firstLon, firstLat] = ring[0]
    const [lastLon, lastLat] = ring[ring.length - 1]
    assert.ok(Math.abs(firstLon - lastLon) < 1e-5)
    assert.ok(Math.abs(firstLat - lastLat) < 1e-5)
  })

  test('simplifyCoordinates applies Douglas-Peucker reduction while preserving endpoints', () => {
    // Collinear points along a line
    const coords: [number, number][] = [
      [120.0, 30.0],
      [120.001, 30.001],
      [120.002, 30.002],
      [120.003, 30.003],
      [120.004, 30.004]
    ]

    const simplified = simplifyCoordinates(coords, 0.0001)
    // Collinear points are simplified down to just start and end!
    assert.strictEqual(simplified.length, 2)
    assert.deepStrictEqual(simplified[0], [120.0, 30.0])
    assert.deepStrictEqual(simplified[1], [120.004, 30.004])
  })

  test('getZoomLodBucket returns appropriate discrete LOD bucket', () => {
    assert.strictEqual(getZoomLodBucket(2), 0)
    assert.strictEqual(getZoomLodBucket(4.8), 0)
    assert.strictEqual(getZoomLodBucket(7.5), 0)
    assert.strictEqual(getZoomLodBucket(8), 1)
    assert.strictEqual(getZoomLodBucket(11.9), 1)
    assert.strictEqual(getZoomLodBucket(13), 2)
    assert.strictEqual(getZoomLodBucket(18), 2)
  })

  test('getRouteToleranceForBucket returns proper simplification tolerance', () => {
    assert.strictEqual(getRouteToleranceForBucket(0), 0.001)
    assert.strictEqual(getRouteToleranceForBucket(1), 0.00015)
    assert.strictEqual(getRouteToleranceForBucket(2), 0)
  })

  test('generateExploredGeoJSON handles empty, single photo, and multi-photo sets', () => {
    // Empty
    const emptyGeo = generateExploredGeoJSON([])
    assert.strictEqual(emptyGeo.type, 'FeatureCollection')
    assert.strictEqual(emptyGeo.features.length, 0)

    // Single photo -> 1 polygon circle
    const p1: Photo = {
      id: 1,
      path: '/p1.jpg',
      root: '/photos',
      file_size: 100,
      taken_at: '2024-05-01 10:00:00',
      width: 1000,
      height: 1000,
      gps_lat: 30.0,
      gps_lon: 120.0,
      gps_alt: 0,
      camera_make: null,
      camera_model: null,
      appendix: {}
    }
    const singleGeo = generateExploredGeoJSON([p1], 'standard', 200)
    assert.strictEqual(singleGeo.features.length, 1)
    assert.strictEqual(singleGeo.features[0].geometry.type, 'Polygon')

    // Two distant photos -> 2 separate circle polygons
    const p2: Photo = {
      id: 2,
      path: '/p2.jpg',
      root: '/photos',
      file_size: 100,
      taken_at: '2024-05-01 10:00:00',
      width: 1000,
      height: 1000,
      gps_lat: 40.0, // Far away
      gps_lon: 120.0,
      gps_alt: 0,
      camera_make: null,
      camera_model: null,
      appendix: {}
    }
    const distantGeo = generateExploredGeoJSON([p1, p2], 'standard', 200)
    assert.strictEqual(distantGeo.features.length, 2)
  })

  test('generateExploredGeoJSON incorporates routes into explored corridors', () => {
    const route: Route = {
      id: 'r1',
      path: '/route.gpx',
      name: 'Cycling Lake',
      desc: null,
      activityType: 'cycling',
      startTime: '2024-05-01 08:00:00',
      endTime: '2024-05-01 09:00:00',
      durationSec: 3600,
      movingDurationSec: 3500,
      totalDistanceM: 5000,
      avgSpeedKmh: 20,
      maxSpeedKmh: 35,
      calories: 300,
      elevationGainM: 50,
      elevationLossM: 50,
      minEle: 10,
      maxEle: 60,
      avgHr: 140,
      maxHr: 170,
      bounds: [120.0, 30.0, 120.05, 30.05],
      pointCount: 3,
      geojson: JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [120.0, 30.0],
            [120.02, 30.02],
            [120.05, 30.05]
          ]
        }
      }),
      createdAt: '2024-05-01',
      updatedAt: '2024-05-01'
    }

    const geo = generateExploredGeoJSON([], 'standard', 100, [route])
    assert.ok(geo.features.length > 0)
    assert.strictEqual(geo.features[0].geometry.type, 'Polygon')
  })

  test('generateExploredGeoJSON dissolves overlapping routes into a unified polygon', () => {
    // Two overlapping routes sharing the same road segment
    const r1: Route = {
      id: 'r1',
      path: '/r1.gpx',
      name: 'Route 1',
      desc: null,
      activityType: 'cycling',
      startTime: '2024-05-01 08:00:00',
      endTime: '2024-05-01 09:00:00',
      durationSec: 1000,
      movingDurationSec: 1000,
      totalDistanceM: 500,
      avgSpeedKmh: 15,
      maxSpeedKmh: 20,
      calories: 100,
      elevationGainM: 10,
      elevationLossM: 10,
      minEle: 10,
      maxEle: 20,
      avgHr: 120,
      maxHr: 140,
      bounds: [120.0, 30.0, 120.005, 30.005],
      pointCount: 3,
      geojson: JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [120.0, 30.0],
            [120.002, 30.002],
            [120.005, 30.005]
          ]
        }
      }),
      createdAt: '2024-05-01',
      updatedAt: '2024-05-01'
    }

    const r2: Route = {
      ...r1,
      id: 'r2',
      path: '/r2.gpx',
      name: 'Route 2',
      geojson: JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [120.001, 30.001],
            [120.003, 30.003],
            [120.006, 30.006]
          ]
        }
      })
    }

    const geo = generateExploredGeoJSON([], 'standard', 100, [r1, r2])
    // The two overlapping routes must be dissolved into a single polygon
    assert.strictEqual(geo.features.length, 1)
    assert.strictEqual(geo.features[0].geometry.type, 'Polygon')
  })
})
