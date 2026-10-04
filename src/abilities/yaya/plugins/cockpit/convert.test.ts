import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ToolOutput } from '../../../../main/process/agent/tools'
import { convertToolOutput, toolParameters } from './convert'

const redacted = {
  redacted: ['student.id'],
  expired: [],
  requestable: ['student.id'],
  hint: 'x'
} satisfies NonNullable<ToolOutput['privacy']>

describe('convertToolOutput (json)', () => {
  it('stringifies the value as the model text and keeps it as display', () => {
    const value = { ok: true, page: 'aidj', nested: [1, 2] }
    const out = convertToolOutput({ kind: 'json', value })
    assert.equal(out.isError, undefined)
    assert.deepEqual(out.content, [{ type: 'text', text: JSON.stringify(value, null, 2) }])
    assert.deepEqual(out.display, value)
  })

  it('serializes null instead of "undefined" and clips long output', () => {
    assert.deepEqual(convertToolOutput({ kind: 'json', value: undefined }).content, [
      { type: 'text', text: 'null' }
    ])
    const value = 'x'.repeat(40_000)
    const raw = JSON.stringify(value, null, 2)
    const text = (convertToolOutput({ kind: 'json', value }).content[0] as { text: string }).text
    assert.equal(text, `${raw.slice(0, 32_000)}\n…[truncated ${raw.length - 32_000} chars]`)
    assert.ok(text.length < 33_000)
  })

  it('appends the redacted scope list to the text', () => {
    const out = convertToolOutput(
      { kind: 'json', value: { name: '«redacted:student.id»' }, privacy: redacted },
      { redactedPrefix: 'REDACTED: ' }
    )
    assert.equal(
      (out.content[0] as { text: string }).text,
      `${JSON.stringify({ name: '«redacted:student.id»' }, null, 2)}\nREDACTED: student.id`
    )
    // privacy 是「说明」，不进 display
    assert.deepEqual(out.display, { name: '«redacted:student.id»' })
  })
})

describe('convertToolOutput (images)', () => {
  it('single image: meta as text (dropped when empty) + one image part', () => {
    const withMeta = convertToolOutput({
      kind: 'image',
      data: 'BASE64',
      mimeType: 'image/png',
      meta: { scale: 2 }
    })
    assert.deepEqual(withMeta.content, [
      { type: 'text', text: JSON.stringify({ scale: 2 }, null, 2) },
      { type: 'image', mimeType: 'image/png', data: 'BASE64' }
    ])
    assert.deepEqual(withMeta.display, { scale: 2 })

    const noMeta = convertToolOutput({ kind: 'image', data: 'B', mimeType: 'image/jpeg', meta: {} })
    assert.deepEqual(noMeta.content, [{ type: 'image', mimeType: 'image/jpeg', data: 'B' }])
    assert.equal(noMeta.display, undefined)
  })

  it('multiple images: every label is listed, then every image follows', () => {
    const out = convertToolOutput({
      kind: 'images',
      images: [
        { data: 'A', mimeType: 'image/png', label: 'frame t=0ms' },
        { data: 'B', mimeType: 'image/png', label: '' }
      ],
      meta: { frames: [] }
    })
    assert.deepEqual(out.content, [
      { type: 'text', text: '1. frame t=0ms\n2. image' },
      { type: 'image', mimeType: 'image/png', data: 'A' },
      { type: 'image', mimeType: 'image/png', data: 'B' }
    ])
    assert.deepEqual(out.display, { frames: [] })
  })

  it('image-only results get their own privacy note (appended at the end)', () => {
    const out = convertToolOutput(
      { kind: 'image', data: 'A', mimeType: 'image/png', meta: {}, privacy: redacted },
      { redactedPrefix: 'REDACTED: ' }
    )
    assert.deepEqual(out.content, [
      { type: 'image', mimeType: 'image/png', data: 'A' },
      { type: 'text', text: 'REDACTED: student.id' }
    ])
  })
})

describe('toolParameters', () => {
  it('maps a zod raw shape to a JSON Schema object', () => {
    const schema = toolParameters('probe', {
      ref: z.string().describe('e.g. "e12"'),
      count: z.number().optional()
    })
    assert.equal(schema.type, 'object')
    assert.deepEqual(Object.keys(schema.properties as object), ['ref', 'count'])
    assert.equal((schema as { $schema?: unknown }).$schema, undefined)
  })

  it('caches by tool name: byte-identical schema across calls', () => {
    const shape = {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional()
    }
    const a = toolParameters('command_run', shape)
    const b = toolParameters('command_run', shape)
    assert.equal(JSON.stringify(a), JSON.stringify(b))
    // 缓存是深拷贝返回的，调用方改不动缓存
    ;(a.properties as Record<string, unknown>).name = 'mutated'
    assert.deepEqual(
      toolParameters('command_run', shape).properties as object,
      b.properties as object
    )
  })
})
