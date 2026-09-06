import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLrc, parseLrcTimeTag, msToLrcTime, extractPlainLyrics } from './lrcParser'

test('msToLrcTime formats milliseconds into 2-digit minute timestamps', () => {
  assert.equal(msToLrcTime(0), '00:00.00')
  assert.equal(msToLrcTime(12340), '00:12.34')
  assert.equal(msToLrcTime(65430), '01:05.43')
  assert.equal(msToLrcTime(600000), '10:00.00')
})

test('parseLrcTimeTag extracts milliseconds accurately', () => {
  const match1 = '[01:23.45]'.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/)
  assert.ok(match1)
  assert.equal(parseLrcTimeTag(match1), 1 * 60000 + 23 * 1000 + 450)

  const match2 = '[00:05.100]'.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/)
  assert.ok(match2)
  assert.equal(parseLrcTimeTag(match2), 5 * 1000 + 100)
})

test('parseLrc handles standard single-line LRC', () => {
  const lrc = `
[00:01.00]First line
[00:05.50]Second line
[00:10.00]Third line
`
  const lines = parseLrc(lrc)
  assert.equal(lines.length, 3)
  assert.equal(lines[0].time, 1000)
  assert.equal(lines[0].text, 'First line')
  assert.equal(lines[1].time, 5500)
  assert.equal(lines[1].text, 'Second line')
  assert.equal(lines[2].time, 10000)
  assert.equal(lines[2].text, 'Third line')
})

test('parseLrc handles per-word karaoke timestamps', () => {
  const lrc = '[00:10.00]Hello [00:10.50]World [00:11.20]Again'
  const lines = parseLrc(lrc)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].time, 10000)
  assert.equal(lines[0].text, 'Hello World Again')
  assert.equal(lines[0].chunks.length, 3)
  assert.equal(lines[0].chunks[0].text, 'Hello ')
  assert.equal(lines[0].chunks[0].time, 10000)
  assert.equal(lines[0].chunks[1].text, 'World ')
  assert.equal(lines[0].chunks[1].time, 10500)
  assert.equal(lines[0].chunks[2].text, 'Again')
  assert.equal(lines[0].chunks[2].time, 11200)
})

test('parseLrc expands multiple leading timestamps for repeating chorus', () => {
  const lrc = '[00:05.00][00:20.00]Chorus line'
  const lines = parseLrc(lrc)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].time, 5000)
  assert.equal(lines[0].text, 'Chorus line')
  assert.equal(lines[1].time, 20000)
  assert.equal(lines[1].text, 'Chorus line')
})

test('parseLrc applies offset tag', () => {
  const lrc = `
[offset:500]
[00:02.00]Offset line
`
  const lines = parseLrc(lrc)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].time, 2500)
  assert.equal(lines[0].text, 'Offset line')
})

test('parseLrc handles empty instrumental lines and invalid content', () => {
  const lrc = `
[00:01.00]
[00:03.00]Singing
Not a lyric line
`
  const lines = parseLrc(lrc)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].time, 1000)
  assert.equal(lines[0].text, '')
  assert.equal(lines[1].time, 3000)
  assert.equal(lines[1].text, 'Singing')

  assert.deepEqual(parseLrc(''), [])
})

test('extractPlainLyrics strips tags and preserves lines', () => {
  const lrc = `
[offset:200]
[00:01.00]Line 1
[00:02.00]Line 2
`
  const plain = extractPlainLyrics(lrc)
  assert.equal(plain, 'Line 1\nLine 2')
  assert.equal(extractPlainLyrics(''), '')
})
