import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import { isNetworkError, splitNameTokens, DJSession } from './session'
import { SEPARATOR, DEFAULT_AIDJ_CONFIG, type SongMeta } from '../types'

describe('AIDJ DJSession & session utils', () => {
  it('isNetworkError detects network issues and server errors', () => {
    assert.equal(isNetworkError(new Error('fetch failed')), true)
    assert.equal(isNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:8080')), true)
    assert.equal(isNetworkError(new Error('socket hang up')), true)
    assert.equal(isNetworkError(new Error('ETIMEDOUT')), true)
    assert.equal(isNetworkError({ status: 500 }), true)
    assert.equal(isNetworkError({ status: 502 }), true)
    assert.equal(isNetworkError({ status: 503 }), true)
    assert.equal(isNetworkError({ status: 504 }), true)

    // Not a network error
    assert.equal(isNetworkError({ status: 400 }), false)
    assert.equal(isNetworkError({ status: 401 }), false)
    assert.equal(isNetworkError({ status: 404 }), false)
    assert.equal(isNetworkError(new Error('Invalid JSON response')), false)
    assert.equal(isNetworkError(new DOMException('Aborted', 'AbortError')), false)
  })

  it('splitNameTokens breaks text into unique lowercase tokens', () => {
    const tokens = splitNameTokens('周杰伦 - 晴天 (Live 版)')
    assert.ok(tokens.includes('周杰伦'))
    assert.ok(tokens.includes('晴天'))
    assert.ok(tokens.includes('live'))
    assert.ok(tokens.includes('版'))
  })

  it('DJSession tokenSortRatio scores similarity correctly', () => {
    const session = new DJSession({} as OpenAI, new Map(), new Map(), DEFAULT_AIDJ_CONFIG)

    // Identical
    assert.equal(session.tokenSortRatio('周杰伦 晴天', '晴天 周杰伦'), 100)
    // Very similar
    const sim = session.tokenSortRatio('周杰伦 晴天', '周杰伦 晴天啦')
    assert.ok(sim > 70)
    // Completely different
    const diff = session.tokenSortRatio('周杰伦', 'Taylor Swift')
    assert.ok(diff < 30)
  })

  it('DJSession bestMatch and parseRawPlaylist matches tracks from library', () => {
    const metadata = new Map<string, SongMeta>([
      ['周杰伦 - 晴天', { genre: '流行', language: '国语' }],
      ['周杰伦 - 七里香', { genre: '流行', language: '国语' }],
      ['林俊杰 - 江南', { genre: '流行', language: '国语' }]
    ])
    const musicPaths = new Map([
      ['周杰伦 - 晴天', '/music/晴天.mp3'],
      ['周杰伦 - 七里香', '/music/七里香.mp3'],
      ['林俊杰 - 江南', '/music/江南.mp3']
    ])

    const session = new DJSession({} as OpenAI, metadata, musicPaths, DEFAULT_AIDJ_CONFIG)

    // Exact and fuzzy match
    assert.equal(session.bestMatch('周杰伦 - 晴天'), '周杰伦 - 晴天')
    assert.equal(session.bestMatch('周杰伦 晴天'), '周杰伦 - 晴天')
    assert.equal(session.bestMatch('林俊杰 江南'), '林俊杰 - 江南')
    assert.equal(session.bestMatch('不存在的歌曲'), null)

    // parseRawPlaylist with separator
    const rawAiResponse = `为您精选了周杰伦的经典曲目：\n${SEPARATOR}\n周杰伦 - 晴天\n周杰伦 - 七里香`
    const parsed = session.parseRawPlaylist(rawAiResponse, 'AI')
    assert.equal(parsed.intro, '为您精选了周杰伦的经典曲目：')
    assert.equal(parsed.playlist.length, 2)
    assert.equal(parsed.playlist[0]?.name, '周杰伦 - 晴天')
    assert.equal(parsed.playlist[0]?.path, '/music/晴天.mp3')
    assert.equal(parsed.playlist[1]?.name, '周杰伦 - 七里香')
    assert.equal(parsed.playlist[1]?.path, '/music/七里香.mp3')

    // parseRawPlaylist without separator (pure conversation)
    const rawChat = '你好，今天过得怎么样？'
    const chatParsed = session.parseRawPlaylist(rawChat, 'AI')
    assert.equal(chatParsed.intro, '你好，今天过得怎么样？')
    assert.equal(chatParsed.playlist.length, 0)
  })
})
