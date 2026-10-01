import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { searchLibrary, type LibrarySearchHit } from './library-search'

const NAMES = ['toe - サニーボーイ・ラプソディ', 'Sonny Boy OST - Main Theme', '周杰伦 - 晴天']

function find(query: string, names: string[] = NAMES): LibrarySearchHit[] {
  return searchLibrary(query, names)
}

describe('AIDJ library search', () => {
  it('finds short queries that the old whole-string ratio missed', () => {
    const sonny = find('sonny')
    assert.equal(sonny[0]?.name, 'Sonny Boy OST - Main Theme')
    assert.equal(sonny[0]?.matched, 'substring')
    assert.ok(sonny[0]!.score >= 90 && sonny[0]!.score <= 99)

    const toe = find('toe')
    assert.equal(toe[0]?.name, 'toe - サニーボーイ・ラプソディ')
    assert.equal(toe[0]?.matched, 'substring')

    // 'boy' only matches the ASCII title — サニーボーイ is katakana, so サニーボーイ stays unmatched
    const boy = find('boy')
    assert.equal(boy.length, 1)
    assert.equal(boy[0]?.name, 'Sonny Boy OST - Main Theme')
    assert.equal(boy[0]?.matched, 'substring')
  })

  it('is case- and fullwidth-insensitive', () => {
    assert.equal(find('Ｓｏｎｎｙ')[0]?.name, 'Sonny Boy OST - Main Theme')
    assert.equal(find('ＴＯＥ')[0]?.name, 'toe - サニーボーイ・ラプソディ')
    assert.equal(find('MAIN theme')[0]?.name, 'Sonny Boy OST - Main Theme')
  })

  it('matches multi-word queries out of order at the tokens tier', () => {
    const hits = find('晴天 周杰伦')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.name, '周杰伦 - 晴天')
    assert.equal(hits[0]?.matched, 'tokens')
    assert.ok(hits[0]!.score >= 80 && hits[0]!.score <= 89)
  })

  it('falls back to fuzzy matching for misspellings', () => {
    const hits = find('sony boy')
    assert.equal(hits[0]?.name, 'Sonny Boy OST - Main Theme')
    assert.equal(hits[0]?.matched, 'fuzzy')
    assert.ok(hits[0]!.score >= 70)
    // unrelated library entries stay out
    assert.ok(!hits.some((h) => h.name === '周杰伦 - 晴天'))
  })

  it('does not run fuzzy when a better tier already matched', () => {
    const hits = searchLibrary('sonny', ['Sonny Boy OST - Main Theme', 'Sunny Days'])
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.name, 'Sonny Boy OST - Main Theme')
    assert.equal(hits[0]?.matched, 'substring')
  })

  it('ranks exact above substring and honours limit', () => {
    const names = ['周杰伦 - 晴天', '周杰伦 - 晴天 (Live)']
    const hits = searchLibrary('周杰伦 - 晴天', names)
    assert.equal(hits[0]?.name, '周杰伦 - 晴天')
    assert.equal(hits[0]?.matched, 'exact')
    assert.equal(hits[0]?.score, 100)
    assert.equal(hits[1]?.name, '周杰伦 - 晴天 (Live)')
    assert.equal(hits[1]?.matched, 'substring')

    const many = Array.from({ length: 30 }, (_, i) => `Artist ${i} - Song`)
    assert.equal(searchLibrary('song', many).length, 20)
    assert.equal(searchLibrary('song', many, { limit: 5 }).length, 5)
  })

  it('returns [] for an empty or whitespace query', () => {
    assert.deepEqual(searchLibrary('', NAMES), [])
    assert.deepEqual(searchLibrary('   ', NAMES), [])
    assert.deepEqual(searchLibrary('sonny', []), [])
  })

  it('searches the extra metadata text', () => {
    const meta = new Map<string, { artist?: string; album?: string }>([
      ['Track One', { artist: 'Nirvana', album: 'Nevermind' }],
      ['Track Two', { artist: 'Radiohead' }]
    ])
    const names = [...meta.keys()]
    const extra = (name: string): string => {
      const m = meta.get(name)
      return m ? [m.artist, m.album].filter(Boolean).join(' ') : ''
    }
    const hits = searchLibrary('nevermind', names, { extra })
    assert.equal(hits[0]?.name, 'Track One')
    assert.equal(hits[0]?.matched, 'substring')
    assert.equal(searchLibrary('radiohead', names, { extra })[0]?.name, 'Track Two')
  })
})
