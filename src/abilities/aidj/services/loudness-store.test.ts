import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LoudnessStore } from './loudness-store'
import type { LoudnessInfo } from '../types'

const INFO: LoudnessInfo = { peak_db: -1, rms_db: -14, integrated_lufs: -12 }

function setup(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aidj-loud-'))
  const a = join(dir, 'a.mp3')
  const b = join(dir, 'b.mp3')
  writeFileSync(a, 'aaa')
  writeFileSync(b, 'bbbb')
  return { dir, a, b }
}

describe('AIDJ LoudnessStore', () => {
  it('measures one file at a time and shares concurrent requests', async () => {
    const { dir, a, b } = setup()
    let running = 0
    let peak = 0
    const calls: string[] = []
    const store = new LoudnessStore(join(dir, 'cache.json'), async (p) => {
      calls.push(p)
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return INFO
    })
    const r = await Promise.all([store.get(a), store.get(a), store.get(b)])
    assert.deepEqual(r, [INFO, INFO, INFO])
    assert.equal(peak, 1)
    assert.deepEqual(calls.sort(), [a, b])
  })

  it('persists results and re-measures a changed file', async () => {
    const { dir, a } = setup()
    const file = join(dir, 'cache.json')
    let calls = 0
    const measure = async (): Promise<LoudnessInfo> => {
      calls++
      return INFO
    }
    const s1 = new LoudnessStore(file, measure)
    await s1.get(a)
    await new Promise((r) => setTimeout(r, 2100)) // debounced save
    assert.ok(existsSync(file))
    const s2 = new LoudnessStore(file, measure)
    assert.deepEqual(await s2.cached(a), INFO)
    await s2.get(a)
    assert.equal(calls, 1)
    writeFileSync(a, 'changed content')
    assert.equal(await s2.cached(a), null)
    await s2.get(a)
    assert.equal(calls, 2)
  })
})
