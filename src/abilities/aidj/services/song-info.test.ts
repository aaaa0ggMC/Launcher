import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseProbe } from './song-info'

describe('AIDJ parseProbe', () => {
  it('reads container tags and the first audio stream', () => {
    const r = parseProbe({
      format: {
        format_name: 'mp3',
        duration: '248.12',
        bit_rate: '320000',
        tags: { title: 'Mother', artist: 'toe', encoder: 'Lavf', ALBUM: 'Our Latest Number' }
      },
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg' },
        { codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }
      ]
    })
    assert.equal(r.duration, 248.12)
    assert.equal(r.bitRate, 320000)
    assert.equal(r.format, 'mp3')
    assert.equal(r.codec, 'mp3')
    assert.equal(r.sampleRate, 44100)
    assert.equal(r.channels, 2)
    // lower-cased, filtered (no encoder) and in display order
    assert.deepEqual(Object.keys(r.tags), ['title', 'artist', 'album'])
    assert.equal(r.tags.album, 'Our Latest Number')
  })

  it('falls back to stream tags (ogg/opus) and handles empty input', () => {
    const r = parseProbe({
      format: { format_name: 'ogg' },
      streams: [{ codec_type: 'audio', duration: '10', tags: { TITLE: 'x', ARTIST: ' y ' } }]
    })
    assert.equal(r.duration, 10)
    assert.deepEqual(r.tags, { title: 'x', artist: 'y' })
    const empty = parseProbe(null)
    assert.equal(empty.duration, null)
    assert.deepEqual(empty.tags, {})
  })
})
