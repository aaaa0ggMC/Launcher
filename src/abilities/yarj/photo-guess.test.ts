import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { haversineDistance, computeGuessedGpsMap, computeStaticGpsGuesses } from './photo-guess'
import type { Photo } from './types'

function makePhoto(
  path: string,
  takenAt: string,
  lat: number | null,
  lon: number | null,
  root = '/media/photos'
): Photo {
  return {
    id: 1,
    path,
    root,
    file_size: 1000,
    taken_at: takenAt,
    width: 1000,
    height: 1000,
    gps_lat: lat,
    gps_lon: lon,
    gps_alt: 0,
    camera_make: null,
    camera_model: null,
    appendix: {}
  }
}

describe('Yarj Photo GPS Guess Engine', () => {
  test('haversineDistance calculates accurate distance on spherical earth', () => {
    // Distance between (0, 0) and (0, 1) deg longitude at equator (~111.19 km)
    const d = haversineDistance(0, 0, 0, 1)
    assert.ok(d > 111000 && d < 112000, `Expected ~111km, got ${d}`)

    // Same point -> 0
    assert.strictEqual(haversineDistance(30, 120, 30, 120), 0)
  })

  test('computeGuessedGpsMap interpolates midpoint for photos without GPS within thresholds', () => {
    const p1 = makePhoto('/p1.jpg', '2024-05-01 10:00:00', 30.0, 120.0)
    const p2 = makePhoto('/p2.jpg', '2024-05-01 10:30:00', null, null) // Missing GPS
    const p3 = makePhoto('/p3.jpg', '2024-05-01 11:00:00', 30.02, 120.02)

    const map = computeGuessedGpsMap([p1, p2, p3])
    assert.strictEqual(map.size, 1)
    const guess = map.get('/p2.jpg')
    assert.ok(guess)
    assert.strictEqual(guess.lat, 30.01)
    assert.strictEqual(guess.lon, 120.01)
    assert.strictEqual(guess.prevPath, '/p1.jpg')
    assert.strictEqual(guess.nextPath, '/p3.jpg')
    assert.strictEqual(guess.timeDiffSeconds, 3600)
    assert.ok(guess.distanceM > 0)
  })

  test('computeGuessedGpsMap skips interpolation when distance or time exceeds threshold', () => {
    // Time exceeds 4 hours (default maxTimeHours=4)
    const p1 = makePhoto('/p1.jpg', '2024-05-01 08:00:00', 30.0, 120.0)
    const p2 = makePhoto('/p2.jpg', '2024-05-01 11:00:00', null, null)
    const p3 = makePhoto('/p3.jpg', '2024-05-01 14:00:00', 30.01, 120.01) // 6h diff

    const mapTime = computeGuessedGpsMap([p1, p2, p3], { maxTimeHours: 4 })
    assert.strictEqual(mapTime.size, 0, 'Should not interpolate across 6 hours')

    // Distance exceeds 10km (default maxDistanceM=10000)
    const pFar1 = makePhoto('/f1.jpg', '2024-05-01 10:00:00', 30.0, 120.0)
    const pFar2 = makePhoto('/f2.jpg', '2024-05-01 10:30:00', null, null)
    const pFar3 = makePhoto('/f3.jpg', '2024-05-01 11:00:00', 31.0, 120.0) // ~111km diff

    const mapDist = computeGuessedGpsMap([pFar1, pFar2, pFar3], { maxDistanceM: 10000 })
    assert.strictEqual(mapDist.size, 0, 'Should not interpolate across 111km')
  })

  test('computeGuessedGpsMap does not interpolate across different gallery roots', () => {
    const p1 = makePhoto('/r1/p1.jpg', '2024-05-01 10:00:00', 30.0, 120.0, '/r1')
    const p2 = makePhoto('/r2/p2.jpg', '2024-05-01 10:30:00', null, null, '/r2')
    const p3 = makePhoto('/r1/p3.jpg', '2024-05-01 11:00:00', 30.02, 120.02, '/r1')

    const map = computeGuessedGpsMap([p1, p2, p3])
    assert.strictEqual(map.size, 0, 'Different roots must not cross-interpolate')
  })

  test('computeGuessedGpsMap correctly handles 180° antimeridian crossing', () => {
    // p1 at 179.9° lon, p3 at -179.9° lon (0.2 degrees apart, crossing international date line)
    const p1 = makePhoto('/d1.jpg', '2024-05-01 10:00:00', 0.0, 179.9)
    const p2 = makePhoto('/d2.jpg', '2024-05-01 10:30:00', null, null)
    const p3 = makePhoto('/d3.jpg', '2024-05-01 11:00:00', 0.0, -179.9)

    const map = computeGuessedGpsMap([p1, p2, p3], { maxDistanceM: 50000 })
    assert.strictEqual(map.size, 1)
    const guess = map.get('/d2.jpg')
    assert.ok(guess)
    assert.strictEqual(guess.lat, 0.0)
    // 179.9 + (360.2 - 360)/2 = 180.0
    assert.ok(
      Math.abs(guess.lon - 180) < 0.001 || Math.abs(guess.lon - -180) < 0.001,
      `Expected 180 or -180, got ${guess.lon}`
    )
    assert.notStrictEqual(
      guess.lon,
      0.0,
      'Must not mistakenly place midpoint at prime meridian (0°)'
    )
  })

  test('computeStaticGpsGuesses exports array of path and guess items for database', () => {
    const p1 = makePhoto('/p1.jpg', '2024-05-01 10:00:00', 30.0, 120.0)
    const p2 = makePhoto('/p2.jpg', '2024-05-01 10:30:00', null, null)
    const p3 = makePhoto('/p3.jpg', '2024-05-01 11:00:00', 30.02, 120.02)

    const items = computeStaticGpsGuesses([p1, p2, p3])
    assert.strictEqual(items.length, 1)
    assert.strictEqual(items[0].path, '/p2.jpg')
    assert.strictEqual(typeof items[0].guess.lat, 'number')
    assert.strictEqual(typeof items[0].guess.lon, 'number')
  })
})
