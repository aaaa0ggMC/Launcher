import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LoudnessCache, VolBal } from './loudness'
import type { LoudnessInfo } from '../types'

/** Fake measurement table: path → loudness (null = ffprobe unavailable). */
function fakeMeasure(
  table: Record<string, LoudnessInfo | null>
): (path: string) => Promise<LoudnessInfo | null> {
  return async (path: string): Promise<LoudnessInfo | null> => table[path] ?? null
}

interface Spy {
  volumes: number[]
  setVolume: (v: number) => void
}

function spy(): Spy {
  const volumes: number[] = []
  return {
    volumes,
    setVolume: (v: number) => {
      volumes.push(v)
    }
  }
}

const LOUD: LoudnessInfo = { peak_db: 0.2, rms_db: -11, integrated_lufs: -8.6 }
const QUIET: LoudnessInfo = { peak_db: -2.2, rms_db: -18.6, integrated_lufs: -17.3 }
const MID: LoudnessInfo = { peak_db: -0.9, rms_db: -13.9, integrated_lufs: -12.3 }

describe('AIDJ VolBal state machine', () => {
  it('lands the base volume FIRST, then anchors on the first track', async () => {
    const s = spy()
    const vb = new VolBal({ measure: fakeMeasure({ a: LOUD }), setVolume: s.setVolume })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    // 基准音量先落地（不等 ffprobe）：第一首就从 50% 开始，而不是引擎默认 80%
    assert.deepEqual(s.volumes, [0.5])
    assert.equal(vb.anchor, -8.6)
    assert.equal(vb.state().baseVolume, 0.5)
  })

  it('adjusts later tracks relative to the anchor (real-library spread)', async () => {
    const s = spy()
    const vb = new VolBal({
      measure: fakeMeasure({ a: LOUD, b: QUIET, c: MID }),
      setVolume: s.setVolume
    })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    s.volumes.length = 0
    await vb.apply('b') // -17.3 vs -8.6 → 8.7 dB boost → clamped to 1.0
    await vb.apply('c') // -12.3 vs -8.6 → +3.7 dB → ~0.74
    assert.equal(s.volumes.length, 2)
    assert.equal(s.volumes[0], 1.0)
    assert.ok(s.volumes[1] > 0.5 && s.volumes[1] < 1.0, `mid track target ${s.volumes[1]}`)
  })

  it('re-reading the config (same method) does NOT drop the anchor', async () => {
    const s = spy()
    const vb = new VolBal({
      measure: fakeMeasure({ a: LOUD, b: QUIET, c: MID }),
      setVolume: s.setVolume
    })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    // 引擎心跳 / 后端重连会反复 syncPrefs() → configure()：锚点必须活下来
    vb.configure(true, 'lufs')
    vb.configure(true, 'lufs')
    await vb.apply('c')
    assert.equal(vb.anchor, -8.6, 'anchor survived the config re-read')
    assert.equal(s.volumes.at(-1) && s.volumes.at(-1)! > 0.5, true)
  })

  it('a method change re-anchors (measurement key differs)', async () => {
    const s = spy()
    const vb = new VolBal({
      measure: fakeMeasure({ a: LOUD, b: QUIET }),
      setVolume: s.setVolume
    })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    assert.equal(vb.anchor, -8.6)
    vb.configure(true, 'linear') // rms-based anchor
    await vb.apply('a')
    assert.equal(vb.anchor, -11, 'anchor re-measured with the new method')
    assert.deepEqual(s.volumes.at(-1), 0.5)
  })

  it('rebase moves the reference and recomputes the current track', async () => {
    const s = spy()
    const vb = new VolBal({
      measure: fakeMeasure({ a: LOUD, b: MID }),
      setVolume: s.setVolume
    })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    s.volumes.length = 0
    await vb.rebase(0.8)
    assert.equal(vb.state().baseVolume, 0.8)
    // rebase 本身不推音量；由调用方（播放器）对当前曲目重算
    assert.deepEqual(s.volumes, [])
    await vb.apply('a')
    assert.ok(Math.abs(s.volumes.at(-1)! - 0.8) < 1e-6, 'current track now sits at the new base')
  })

  it('a failed measurement keeps the last volume and warns instead of freezing silently', async () => {
    const s = spy()
    const warnings: string[] = []
    const vb = new VolBal({
      measure: fakeMeasure({ a: null }),
      setVolume: s.setVolume,
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg)
      }
    })
    vb.configure(true, 'lufs')
    await vb.apply('a')
    assert.equal(vb.anchor, null)
    assert.deepEqual(s.volumes, [0.5], 'base volume still lands')
    assert.ok(
      warnings.some((w) => w.includes('anchor failed')),
      warnings.join('|')
    )
  })

  it('disabled volbal never touches the volume', async () => {
    const s = spy()
    const vb = new VolBal({ measure: fakeMeasure({ a: LOUD }), setVolume: s.setVolume })
    vb.configure(false, 'lufs')
    await vb.apply('a')
    assert.deepEqual(s.volumes, [])
    assert.equal(vb.state().enabled, false)
  })

  it('curve 1.0 (web) is linear: base * 10^(dB diff / 20)', async () => {
    const s = spy()
    const vb = new VolBal({
      measure: fakeMeasure({ a: LOUD, c: MID }),
      setVolume: s.setVolume
    })
    vb.configure(true, 'lufs', 1.0)
    await vb.apply('a')
    await vb.apply('c')
    const expected = 0.5 * 10 ** ((-8.6 - -12.3) / 20)
    assert.ok(Math.abs(s.volumes.at(-1)! - expected) < 1e-6)
  })

  it('LoudnessCache.setAnchor accepts an injected measure fn', async () => {
    const cache = new LoudnessCache('lufs', 1.0)
    const anchor = await cache.setAnchor('x', 0.5, fakeMeasure({ x: MID }))
    assert.equal(anchor, -12.3)
    assert.equal(cache.anchorVal, -12.3)
  })
})
