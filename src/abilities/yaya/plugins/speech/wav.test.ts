/**
 * 渲染端 WAV 编码（纯函数部分）的单测。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { encodeWav16 } from './wav'

it('encodeWav16：16 位单声道，样本夹到 -1..1', () => {
  const buf = Buffer.from(encodeWav16(new Float32Array([0, 1, -1, 2]), 16000))
  assert.equal(buf.toString('latin1', 8, 12), 'WAVE')
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt32LE(40), 8)
  assert.deepEqual(
    [buf.readInt16LE(44), buf.readInt16LE(46), buf.readInt16LE(48), buf.readInt16LE(50)],
    [0, 32767, -32768, 32767]
  )
})
