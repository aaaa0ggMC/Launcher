import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Photo } from './types'
import { resolvePhotoGps } from './types'
import { analyzeAndCorrectGpsDrifts } from './gps-corrector'

function makePhoto(
  id: number,
  taken_at: string,
  lat: number | null,
  lon: number | null,
  extra?: Partial<Photo>
): Photo {
  return {
    id,
    path: `/photos/img_${id}.jpg`,
    root: '/photos',
    width: null,
    height: null,
    taken_at,
    gps_lat: lat,
    gps_lon: lon,
    gps_alt: null,
    camera_make: 'Sony',
    camera_model: 'A7M4',
    appendix: {},
    ...extra
  }
}

describe('Yarj GPS Drift Corrector & Priority Resolution', () => {
  test('priority resolution: corrected > guess > db > exif', () => {
    // 1. All 4 present -> should return corrected
    const pAll: Photo = makePhoto(1, '2024-01-01T12:00:00', 30.0, 120.0, {
      gps_guess: {
        lat: 31.0,
        lon: 121.0,
        distanceM: 500,
        timeDiffSeconds: 60,
        prevPath: '',
        nextPath: '',
        prevTakenAt: '',
        nextTakenAt: ''
      },
      gps_corrected: {
        lat: 32.0,
        lon: 122.0,
        reason: 'test',
        corrected_at: '2024-01-01T12:00:00'
      },
      appendix: { exif_gps: { lat: 29.0, lon: 119.0 } }
    })
    const resAll = resolvePhotoGps(pAll)
    assert.ok(resAll)
    assert.equal(resAll.source, 'corrected')
    assert.equal(resAll.lat, 32.0)
    assert.equal(resAll.lon, 122.0)

    // 2. guess + db + exif -> should return guess
    const pGuess: Photo = makePhoto(2, '2024-01-01T12:00:00', 30.0, 120.0, {
      gps_guess: {
        lat: 31.0,
        lon: 121.0,
        distanceM: 500,
        timeDiffSeconds: 60,
        prevPath: '',
        nextPath: '',
        prevTakenAt: '',
        nextTakenAt: ''
      },
      appendix: { exif_gps: { lat: 29.0, lon: 119.0 } }
    })
    const resGuess = resolvePhotoGps(pGuess)
    assert.ok(resGuess)
    assert.equal(resGuess.source, 'guess')
    assert.equal(resGuess.lat, 31.0)
    assert.equal(resGuess.lon, 121.0)

    // 3. db + exif -> should return db
    const pDb: Photo = makePhoto(3, '2024-01-01T12:00:00', 30.0, 120.0, {
      appendix: { exif_gps: { lat: 29.0, lon: 119.0 } }
    })
    const resDb = resolvePhotoGps(pDb)
    assert.ok(resDb)
    assert.equal(resDb.source, 'db')
    assert.equal(resDb.lat, 30.0)

    // 4. exif only (gps_lat/lon is null) -> should return exif
    const pExif: Photo = makePhoto(4, '2024-01-01T12:00:00', null, null, {
      appendix: { exif_gps: { lat: 29.0, lon: 119.0 } }
    })
    const resExif = resolvePhotoGps(pExif)
    assert.ok(resExif)
    assert.equal(resExif.source, 'exif')
    assert.equal(resExif.lat, 29.0)

    // 5. None -> null
    const pNone: Photo = makePhoto(5, '2024-01-01T12:00:00', null, null)
    assert.equal(resolvePhotoGps(pNone), null)
  })

  test('normal city photos have 0 false positive corrections', () => {
    const photos: Photo[] = [
      makePhoto(1, '2024-06-01T10:00:00', 39.9042, 116.4074), // Forbidden City
      makePhoto(2, '2024-06-01T10:30:00', 39.9142, 116.4084), // Jingshan
      makePhoto(3, '2024-06-01T11:00:00', 39.9242, 116.4184), // Beihai
      makePhoto(4, '2024-06-01T11:30:00', 39.9342, 116.4284)
    ]
    const corrections = analyzeAndCorrectGpsDrifts(photos, { maxSpeedKmh: 800, minDriftKm: 80 })
    assert.equal(corrections.length, 0)
  })

  test('detects single country-scale drift and interpolates correctly', () => {
    const photos: Photo[] = [
      // 10:00 in Beijing
      makePhoto(1, '2024-06-01T10:00:00', 39.9, 116.4),
      // 10:30 suddenly in Paris (lat 48.85, lon 2.35) -> over 8000km away in 30min!
      makePhoto(2, '2024-06-01T10:30:00', 48.8566, 2.3522),
      // 11:00 back in Beijing
      makePhoto(3, '2024-06-01T11:00:00', 39.92, 116.42)
    ]

    const corrections = analyzeAndCorrectGpsDrifts(photos, {
      maxSpeedKmh: 800,
      minDriftKm: 80,
      maxTimeGapHours: 24
    })

    assert.equal(corrections.length, 1)
    const c = corrections[0]
    assert.equal(c.photo.id, 2)
    assert.equal(c.correction.original_lat, 48.8566)
    assert.equal(c.correction.original_lon, 2.3522)
    // The midpoint between (39.9, 116.4) and (39.92, 116.42) at 50% time ratio is (39.91, 116.41)
    assert.ok(Math.abs(c.correction.lat - 39.91) < 0.001)
    assert.ok(Math.abs(c.correction.lon - 116.41) < 0.001)
    assert.ok(c.correction.drift_distance_km! > 5000)
    assert.ok(c.correction.speed_kmh! > 5000)
  })

  test('detects burst of 2 drifted photos', () => {
    const photos: Photo[] = [
      makePhoto(1, '2024-06-01T10:00:00', 31.23, 121.47), // Shanghai
      makePhoto(2, '2024-06-01T10:20:00', 0.0, 0.0), // Null Island (drifts ~11000km)
      makePhoto(3, '2024-06-01T10:40:00', 0.05, 0.05), // Null Island
      makePhoto(4, '2024-06-01T11:00:00', 31.25, 121.49) // Shanghai
    ]

    const corrections = analyzeAndCorrectGpsDrifts(photos, {
      maxSpeedKmh: 800,
      minDriftKm: 80
    })

    assert.equal(corrections.length, 2)
    assert.equal(corrections[0].photo.id, 2)
    assert.equal(corrections[1].photo.id, 3)
    assert.ok(corrections[0].correction.lat > 31.2)
    assert.ok(corrections[1].correction.lat > 31.2)
  })
})
