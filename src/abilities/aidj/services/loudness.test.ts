import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LoudnessCache } from './loudness'

describe('AIDJ LoudnessCache', () => {
  it('returns null volume when anchor is not set', () => {
    const cache = new LoudnessCache('lufs', 3.0)
    assert.equal(cache.computeVolume(-14), null)
  })

  it('returns baseVolume when song loudness equals anchor loudness', () => {
    const cache = new LoudnessCache('lufs', 3.0)
    cache.setAnchorValue(-14, 0.6)
    const vol = cache.computeVolume(-14)
    assert.ok(vol !== null)
    assert.ok(Math.abs(vol - 0.6) < 1e-4)
  })

  it('boosts volume for quieter songs and lowers volume for louder songs', () => {
    const cache = new LoudnessCache('lufs', 3.0)
    cache.setAnchorValue(-14, 0.5)

    // Quieter song (-20 LUFS) should result in higher volume than base
    const quieterVol = cache.computeVolume(-20)
    assert.ok(quieterVol !== null)
    assert.ok(quieterVol > 0.5)

    // Louder song (-8 LUFS) should result in lower volume than base
    const louderVol = cache.computeVolume(-8)
    assert.ok(louderVol !== null)
    assert.ok(louderVol < 0.5)
  })

  it('clamps volume to [0.05, 1.0]', () => {
    const cache = new LoudnessCache('lufs', 3.0)
    cache.setAnchorValue(-14, 0.5)

    // Extremely quiet song should clamp to 1.0
    const maxClamped = cache.computeVolume(-60)
    assert.equal(maxClamped, 1.0)

    // Extremely loud song should clamp to 0.05
    const minClamped = cache.computeVolume(100)
    assert.equal(minClamped, 0.05)
  })

  it('loudnessKey selects integrated_lufs for lufs and rms_db for other methods', () => {
    const info = { peak_db: 0, rms_db: -16, integrated_lufs: -14 }

    const lufsCache = new LoudnessCache('lufs')
    assert.equal(lufsCache.loudnessKey(info), -14)

    const linearCache = new LoudnessCache('linear')
    assert.equal(linearCache.loudnessKey(info), -16)

    assert.equal(lufsCache.loudnessKey(null), null)
  })

  it('setBaseVol updates base volume', () => {
    const cache = new LoudnessCache()
    cache.setAnchorValue(-14, 0.5)
    cache.setBaseVol(0.8)
    assert.equal(cache.baseVolume, 0.8)
    const vol = cache.computeVolume(-14)
    assert.ok(vol !== null)
    assert.ok(Math.abs(vol - 0.8) < 1e-4)
  })
})
