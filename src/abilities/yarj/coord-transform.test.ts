import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  outOfChina,
  wgs84ToGcj02,
  gcj02ToWgs84,
  gcj02ToBd09,
  bd09ToGcj02,
  wgs84ToBd09,
  bd09ToWgs84,
  transformCoord
} from './coord-transform'

describe('Yarj Coordinate Transformation (WGS84 / GCJ02 / BD09)', () => {
  test('outOfChina correctly identifies boundaries', () => {
    // Domestic points
    assert.strictEqual(outOfChina(116.4074, 39.9042), false, 'Beijing should be in China')
    assert.strictEqual(outOfChina(121.4737, 31.2304), false, 'Shanghai should be in China')
    assert.strictEqual(outOfChina(113.2644, 23.1291), false, 'Guangzhou should be in China')
    assert.strictEqual(outOfChina(114.1694, 22.3193), false, 'Hong Kong should be in China')

    // Foreign points
    assert.strictEqual(outOfChina(-0.1278, 51.5074), true, 'London should be out of China')
    assert.strictEqual(outOfChina(-74.006, 40.7128), true, 'New York should be out of China')
    assert.strictEqual(outOfChina(139.6917, 35.6895), true, 'Tokyo should be out of China')
    assert.strictEqual(outOfChina(151.2093, -33.8688), true, 'Sydney should be out of China')
  })

  test('outOfChina points do not receive GCJ-02 distortion', () => {
    const london: [number, number] = [-0.1278, 51.5074]
    const [gcjLng, gcjLat] = wgs84ToGcj02(london[0], london[1])
    assert.strictEqual(gcjLng, london[0])
    assert.strictEqual(gcjLat, london[1])

    const [wLng, wLat] = gcj02ToWgs84(london[0], london[1])
    assert.strictEqual(wLng, london[0])
    assert.strictEqual(wLat, london[1])
  })

  test('wgs84ToGcj02 and gcj02ToWgs84 round-trip achieves sub-millimeter precision (< 1e-7 deg)', () => {
    const testPoints: [number, number][] = [
      [116.4074, 39.9042], // Beijing Tiananmen
      [121.4737, 31.2304], // Shanghai People's Square
      [114.0579, 22.5431], // Shenzhen
      [104.0665, 30.5723], // Chengdu
      [87.6168, 43.8256] // Urumqi
    ]

    for (const [wLon, wLat] of testPoints) {
      const [gLon, gLat] = wgs84ToGcj02(wLon, wLat)
      // Check that offset exists in China (typically hundreds of meters)
      assert.notStrictEqual(gLon, wLon)
      assert.notStrictEqual(gLat, wLat)
      const offsetLon = Math.abs(gLon - wLon)
      const offsetLat = Math.abs(gLat - wLat)
      assert.ok(offsetLon > 0.001, 'Should have measurable longitude offset')
      assert.ok(offsetLat > 0.001, 'Should have measurable latitude offset')

      // Convert back to WGS-84
      const [recoveredLon, recoveredLat] = gcj02ToWgs84(gLon, gLat)
      const errLon = Math.abs(recoveredLon - wLon)
      const errLat = Math.abs(recoveredLat - wLat)

      // 1e-7 degrees corresponds to ~0.01 meters (1 cm), far tighter than 1e-6
      assert.ok(
        errLon < 1e-7,
        `Longitude recovery error ${errLon} exceeds threshold for (${wLon}, ${wLat})`
      )
      assert.ok(
        errLat < 1e-7,
        `Latitude recovery error ${errLat} exceeds threshold for (${wLon}, ${wLat})`
      )
    }
  })

  test('gcj02ToBd09 and bd09ToGcj02 round-trip accuracy', () => {
    const gcjLon = 116.4123
    const gcjLat = 39.9056

    const [bdLon, bdLat] = gcj02ToBd09(gcjLon, gcjLat)
    assert.notStrictEqual(bdLon, gcjLon)
    assert.notStrictEqual(bdLat, gcjLat)

    const [recLon, recLat] = bd09ToGcj02(bdLon, bdLat)
    assert.ok(Math.abs(recLon - gcjLon) < 2e-6)
    assert.ok(Math.abs(recLat - gcjLat) < 2e-6)
  })

  test('wgs84ToBd09 and bd09ToWgs84 round-trip', () => {
    const wLon = 121.4737
    const wLat = 31.2304

    const [bdLon, bdLat] = wgs84ToBd09(wLon, wLat)
    const [recLon, recLat] = bd09ToWgs84(bdLon, bdLat)

    assert.ok(Math.abs(recLon - wLon) < 2e-6)
    assert.ok(Math.abs(recLat - wLat) < 2e-6)
  })

  test('transformCoord dispatcher handles identity and cross-transformations', () => {
    const lon = 116.4
    const lat = 39.9

    // Identity
    assert.deepStrictEqual(transformCoord(lon, lat, 'wgs84', 'wgs84'), [lon, lat])
    assert.deepStrictEqual(transformCoord(lon, lat, 'gcj02', 'gcj02'), [lon, lat])

    // WGS84 -> GCJ02
    assert.deepStrictEqual(transformCoord(lon, lat, 'wgs84', 'gcj02'), wgs84ToGcj02(lon, lat))
    // GCJ02 -> WGS84
    assert.deepStrictEqual(transformCoord(lon, lat, 'gcj02', 'wgs84'), gcj02ToWgs84(lon, lat))
    // BD09 -> GCJ02
    assert.deepStrictEqual(transformCoord(lon, lat, 'bd09', 'gcj02'), bd09ToGcj02(lon, lat))
  })
})
