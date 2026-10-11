import test from 'node:test'
import assert from 'node:assert/strict'
import { EMOTE_PATTERN, emoteInstruction, emoteSrcUrl, emoteView, findEmote } from './emotes'
import type { ReactionSet } from './plugin-ui'

const SETS: ReactionSet[] = [
  {
    id: 'default',
    items: [
      { key: '👍', shortcode: 'thumbsup', label: '赞' },
      { key: '❤️', shortcode: 'heart', label: '喜欢' }
    ]
  },
  {
    id: 'pack-demo',
    items: [
      { key: 'cat-lap', src: 'file/abs/pack/cat.png', label: '趴着的猫' },
      { key: 'party', icon: 'mdi-party-popper', label: '派对' },
      { key: 'boss', icon: 'gi:boss', label: 'Boss' }
    ]
  },
  { id: 'no-inline', inline: false, items: [{ key: 'secret-emote', src: 'https://x/y.png' }] }
]

test('短码与 key 都能命中；inline:false 的组不参与', () => {
  assert.equal(findEmote('thumbsup', SETS)?.key, '👍')
  assert.equal(findEmote('👍', SETS)?.key, '👍')
  assert.equal(findEmote('cat-lap', SETS)?.src, 'file/abs/pack/cat.png')
  assert.equal(findEmote('secret-emote', SETS), null)
  assert.equal(findEmote('not-in-pack', SETS), null)
})

test('未命中的普通冒号文本不处理', () => {
  const sets = SETS
  assert.equal(
    emoteView('30', sets, (p) => p),
    null
  )
  assert.equal(
    emoteView('https', sets, (p) => p),
    null
  )
  assert.equal(
    emoteView('smile', sets, (p) => p),
    null
  )
})

test('图片表情 → img 视图（file/ 走 toUrl，危险协议被拒）', () => {
  const v = emoteView('cat-lap', SETS, (p) => `cockpit-icon://${encodeURIComponent(p)}`)
  assert.ok(v?.img)
  assert.equal(v?.img, `cockpit-icon://${encodeURIComponent('/abs/pack/cat.png')}`)
  assert.equal(v?.tone, 'bare')
  assert.equal(v?.text, 'cat-lap')
  assert.equal(
    emoteView('cat-lap', SETS, () => 'javascript:alert(1)'),
    null
  )
})

test('图标：mdi 内联可见，gi: 保留短码原文', () => {
  assert.equal(emoteView('party', SETS, (p) => p)?.icon, 'mdi-party-popper')
  assert.equal(
    emoteView('boss', SETS, (p) => p),
    null
  )
})

test('纯 emoji → 文本视图', () => {
  const v = emoteView('thumbsup', SETS, (p) => p)
  assert.equal(v?.text, '👍')
  assert.equal(v?.img, undefined)
  assert.equal(v?.tone, 'bare')
})

test('短码正则：全局、能逐个 exec、不含空白与冒号', () => {
  const re = new RegExp(EMOTE_PATTERN.source, 'g')
  const m = [...':thumbsup: 和 :heart:'.matchAll(re)].map((x) => x[1])
  assert.deepEqual(m, ['thumbsup', 'heart'])
  // 空白不匹配
  assert.equal(':a b:'.replace(re, 'x'), ':a b:')
  // 正则会匹配到 :30:，但 emoteView 对未知短码返回 null → 原文保留（UI 层因此不受影响）
  assert.match('12:30:45', re)
  assert.equal(
    emoteView('30', SETS, (p) => p),
    null
  )
})

test('emoteSrcUrl：file/ 前缀转换，其余原样', () => {
  assert.equal(
    emoteSrcUrl('file/a/b.png', (p) => `u:${p}`),
    'u:/a/b.png'
  )
  assert.equal(
    emoteSrcUrl('data:image/png;base64,AA', (p) => `u:${p}`),
    'data:image/png;base64,AA'
  )
})

test('emoteInstruction：固定英文、列出短码、无表情返回空', () => {
  const text = emoteInstruction(SETS)
  assert.ok(text.includes('thumbsup'))
  assert.ok(text.includes('cat-lap'))
  assert.ok(!text.includes('secret-emote'))
  assert.ok(emoteInstruction([]) === '')
  // 稳定：两次输出一致（提示词缓存）
  assert.equal(text, emoteInstruction(SETS))
})
