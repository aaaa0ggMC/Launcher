import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  guessTransportMode,
  buildJourneyData,
  generateJourneyLinesGeoJSON,
  generateJourneyNodesGeoJSON,
  TRANSPORT_MODES
} from './journey'
import type { Photo } from './types'

function makeTimedPhoto(path: string, takenAt: string, lon: number, lat: number): Photo {
  return {
    id: 1,
    path,
    root: '/photos',
    file_size: 1000,
    taken_at: takenAt,
    width: 1000,
    height: 1000,
    gps_lon: lon,
    gps_lat: lat,
    gps_alt: 0,
    camera_make: null,
    camera_model: null,
    appendix: {}
  }
}

describe('Yarj Journey & Exploration Engine', () => {
  test('TRANSPORT_MODES contains all standard transportation categories', () => {
    assert.ok(TRANSPORT_MODES.plane)
    assert.ok(TRANSPORT_MODES.train)
    assert.ok(TRANSPORT_MODES.car)
    assert.ok(TRANSPORT_MODES.walk)
    assert.ok(TRANSPORT_MODES.ship)
    assert.ok(TRANSPORT_MODES.stay)
  })

  test('guessTransportMode accurately detects stay, walk, car, train, and plane', () => {
    // 1. Stay: distance < 500m
    const stay = guessTransportMode(300, 3600 * 1000)
    assert.strictEqual(stay.mode, 'stay')

    // 2. Walk: short distance (< 15km) and low speed (< 22 km/h)
    // 3km in 30min -> 6 km/h
    const walk = guessTransportMode(3000, 30 * 60 * 1000)
    assert.strictEqual(walk.mode, 'walk')
    assert.ok(walk.speedKmH && Math.abs(walk.speedKmH - 6) < 0.1)

    // 3. Car: distance 50km in 1 hour -> 50 km/h (22 ~ 110 km/h)
    const car = guessTransportMode(50000, 3600 * 1000)
    assert.strictEqual(car.mode, 'car')
    assert.ok(car.speedKmH && Math.abs(car.speedKmH - 50) < 0.1)

    // 4. Train: 300km in 1.5 hours -> 200 km/h (110 ~ 320 km/h)
    const train = guessTransportMode(300000, 1.5 * 3600 * 1000)
    assert.strictEqual(train.mode, 'train')

    // 5. Plane: 1200km in 2 hours -> 600 km/h
    const plane = guessTransportMode(1200000, 2 * 3600 * 1000)
    assert.strictEqual(plane.mode, 'plane')

    // 6. Long distance (> 750km) defaults to plane even if time is long
    const longDist = guessTransportMode(800000, 10 * 3600 * 1000)
    assert.strictEqual(longDist.mode, 'plane')
  })

  test('buildJourneyData clusters photos into sequential stages and legs', () => {
    // Empty
    const emptyJourney = buildJourneyData([])
    assert.strictEqual(emptyJourney.stages.length, 0)
    assert.strictEqual(emptyJourney.legs.length, 0)
    assert.strictEqual(emptyJourney.totalDistanceM, 0)

    // Multi-city trip
    // Stage 1: Beijing (2 photos)
    const p1 = makeTimedPhoto('/bj1.jpg', '2024-05-01 08:00:00', 116.4, 39.9)
    const p2 = makeTimedPhoto('/bj2.jpg', '2024-05-01 09:00:00', 116.41, 39.91)
    // Stage 2: Shanghai (2 photos taken on 2024-05-02)
    const p3 = makeTimedPhoto('/sh1.jpg', '2024-05-02 12:00:00', 121.47, 31.23)
    const p4 = makeTimedPhoto('/sh2.jpg', '2024-05-02 14:00:00', 121.48, 31.24)

    const journey = buildJourneyData([p1, p2, p3, p4], 'trip')
    assert.strictEqual(journey.stages.length, 2)
    assert.strictEqual(journey.legs.length, 1)

    // Verify stage 1
    assert.strictEqual(journey.stages[0].photos.length, 2)
    assert.strictEqual(journey.stages[0].index, 0)

    // Verify stage 2
    assert.strictEqual(journey.stages[1].photos.length, 2)
    assert.strictEqual(journey.stages[1].index, 1)

    // Verify leg between BJ and SH (~1000km, plane or high-speed)
    const leg = journey.legs[0]
    assert.strictEqual(leg.fromIndex, 0)
    assert.strictEqual(leg.toIndex, 1)
    assert.ok(leg.distanceM > 900000 && leg.distanceM < 1300000)
    assert.strictEqual(leg.mode, 'plane')

    // Total distance matches leg
    assert.strictEqual(journey.totalDistanceM, leg.distanceM)
  })

  test('generateJourneyLinesGeoJSON creates Great Circle curves for completed and active legs', () => {
    const p1 = makeTimedPhoto('/p1.jpg', '2024-05-01 08:00:00', 116.4, 39.9)
    const p2 = makeTimedPhoto('/p2.jpg', '2024-05-02 12:00:00', 121.47, 31.23)

    const journey = buildJourneyData([p1, p2], 'trip')
    const { allLines, activeLeg } = generateJourneyLinesGeoJSON(journey.legs, 1)

    assert.strictEqual(allLines.type, 'FeatureCollection')
    assert.ok(allLines.features.length > 0)
    const firstFeature = allLines.features[0]
    assert.strictEqual(firstFeature.geometry.type, 'LineString')
    // Great Circle interpolation should create smooth curve (> 10 vertices)
    const coords = (firstFeature.geometry as GeoJSON.LineString).coordinates
    assert.ok(coords.length >= 10, 'Should interpolate spherical great circle arc')

    assert.strictEqual(activeLeg.type, 'FeatureCollection')
    assert.ok(activeLeg.features.length > 0)
  })

  test('generateJourneyNodesGeoJSON creates point features for stages with appropriate halo properties', () => {
    const p1 = makeTimedPhoto('/p1.jpg', '2024-05-01 08:00:00', 116.4, 39.9)
    const p2 = makeTimedPhoto('/p2.jpg', '2024-05-02 12:00:00', 121.47, 31.23)

    const journey = buildJourneyData([p1, p2], 'trip')
    const geo = generateJourneyNodesGeoJSON(journey.stages, 0)

    assert.strictEqual(geo.type, 'FeatureCollection')
    assert.strictEqual(geo.features.length, 2)
    assert.strictEqual(geo.features[0].geometry.type, 'Point')
    assert.strictEqual(geo.features[0].properties?.isActive, true)
    assert.strictEqual(geo.features[1].properties?.isActive, false)
  })
})
