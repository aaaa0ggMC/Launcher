import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  yrcToInlineLrc,
  localYrcToInlineLrc,
  localYrcToLrc,
  resolveLyricForTrack,
  resolveLyricForTrackPath
} from './lyrics'

describe('AIDJ lyrics service', () => {
  it('yrcToInlineLrc converts JSON-lines YRC to inline-timestamp LRC', () => {
    const yrc = JSON.stringify({
      t: 12500,
      c: [
        { t: 12500, c: '你' },
        { t: 12800, c: '好' }
      ]
    })
    const inline = yrcToInlineLrc(yrc)
    assert.ok(inline.startsWith('[00:12.50]'))
    assert.ok(inline.includes('[00:12.50]你'))
    assert.ok(inline.includes('[00:12.80]好'))
  })

  it('yrcToInlineLrc handles invalid or empty input gracefully', () => {
    assert.equal(yrcToInlineLrc(''), '')
    assert.equal(yrcToInlineLrc('invalid json'), '')
    assert.equal(yrcToInlineLrc('{"t": 100}'), '') // missing c
  })

  it('localYrcToInlineLrc converts bracket/parenthesis format to inline LRC', () => {
    const local = '[1000,5000](1000,200,0)Hello (1200,300,0)World'
    const res = localYrcToInlineLrc(local)
    assert.ok(res.startsWith('[00:01.00]'))
    assert.ok(res.includes('[00:01.00]Hello '))
    assert.ok(res.includes('[00:01.20]World'))
  })

  it('localYrcToLrc converts bracket/parenthesis format to plain LRC', () => {
    const local = '[1000,5000](1000,200,0)Hello (1200,300,0)World'
    const res = localYrcToLrc(local)
    assert.equal(res, '[00:01.00]Hello World')
  })

  it('resolveLyricForTrack resolves exact match, punctuation, and substring', () => {
    const map = new Map<string, string>([
      ['七里香', '[00:01.00]秋刀鱼的滋味'],
      ['晴天', '[00:02.00]故事的小黄花'],
      ['周杰伦 - 千里之外 (伴奏)', '[00:03.00]我送你离开千里之外']
    ])

    // Exact match
    assert.equal(resolveLyricForTrack('七里香', map), '[00:01.00]秋刀鱼的滋味')

    // Artist - Title split: resolves '晴天' from '周杰伦 - 晴天'
    assert.equal(resolveLyricForTrack('周杰伦 - 晴天', map), '[00:02.00]故事的小黄花')

    // Substring match for >= 3 chars: '千里之外' matches '周杰伦 - 千里之外 (伴奏)'
    assert.equal(resolveLyricForTrack('千里之外', map), '[00:03.00]我送你离开千里之外')

    // Unknown track returns null
    assert.equal(resolveLyricForTrack('未知曲目', map), null)
  })

  it('resolveLyricForTrackPath resolves by file path and falls back to track name', () => {
    const map = new Map<string, string>([
      ['稻香', '[00:05.00]对这个世界如果你有太多的抱怨'],
      ['青花瓷', '[00:06.00]素胚勾勒出青花']
    ])

    // Path basename match
    const byPath = resolveLyricForTrackPath('/music/稻香.mp3', '', map)
    assert.equal(byPath, '[00:05.00]对这个世界如果你有太多的抱怨')

    // Path title-only match (stripping artist - prefix)
    const byTitle = resolveLyricForTrackPath('/music/周杰伦 - 青花瓷.flac', '', map)
    assert.equal(byTitle, '[00:06.00]素胚勾勒出青花')

    // Fallback to track name when path not in map
    const fallback = resolveLyricForTrackPath('/music/unknown.mp3', '稻香', map)
    assert.equal(fallback, '[00:05.00]对这个世界如果你有太多的抱怨')

    // Disabled fuzzy returns null when path doesn't match
    const noFuzzy = resolveLyricForTrackPath('/music/unknown.mp3', '稻香', map, { fuzzy: false })
    assert.equal(noFuzzy, null)

    // Video files and Bilibili downloads with no subtitle exact match return null
    const videoNoLyric = resolveLyricForTrackPath(
      '/music/Bilibili/BV123/UP主 - 稻香.mp4',
      '稻香',
      map
    )
    assert.equal(videoNoLyric, null)

    const mapWithVideoLrc = new Map<string, string>([
      ['UP主 - 稻香', '[00:01.00]专属于该视频的字幕']
    ])
    const videoWithLyric = resolveLyricForTrackPath(
      '/music/Bilibili/BV123/UP主 - 稻香.mp4',
      'UP主 - 稻香',
      mapWithVideoLrc
    )
    assert.equal(videoWithLyric, '[00:01.00]专属于该视频的字幕')
  })
})
