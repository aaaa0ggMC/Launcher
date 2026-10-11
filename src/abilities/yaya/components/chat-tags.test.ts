import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findBlockTags,
  findChatTags,
  maskCodeRegions,
  parseTagBody,
  splitBubbles,
  stripBlockTags,
  trimPartialTag,
  type InlineTagRule
} from './chat-tags'

const RULES: InlineTagRule[] = [{ prefix: '<||', kind: 'split' }]
const ids = (text: string): string[] => splitBubbles(text, RULES).bubbles.map((b) => b.id)
const texts = (text: string): string[] => splitBubbles(text, RULES).bubbles.map((b) => b.text)

test('没有标记：单气泡、原文不变、hadTags=false', () => {
  const r = splitBubbles('你好，世界', RULES)
  assert.equal(r.hadTags, false)
  assert.equal(r.bubbles.length, 1)
  assert.equal(r.bubbles[0].text, '你好，世界')
  assert.equal(r.plain, '你好，世界')
})

test('分隔与缺省 id：按位置 b1/b2/b3', () => {
  assert.deepEqual(ids('A<||>B<||>C'), ['b1', 'b2', 'b3'])
  assert.deepEqual(texts('A<||>B<||>C'), ['A', 'B', 'C'])
})

test('标记命名它前面的那一段', () => {
  assert.deepEqual(ids('A<||s1>B<||s2>C'), ['s1', 's2', 'b3'])
})

test('末尾标记命名末段，不产生空气泡', () => {
  const r = splitBubbles('A<||s1>B<||s2>', RULES)
  assert.deepEqual(
    r.bubbles.map((b) => [b.id, b.text]),
    [
      ['s1', 'A'],
      ['s2', 'B']
    ]
  )
})

test('开头标记给第一段命名，不产生空气泡', () => {
  const r = splitBubbles('<||s1>A', RULES)
  assert.equal(r.bubbles.length, 1)
  assert.deepEqual([r.bubbles[0].id, r.bubbles[0].text], ['s1', 'A'])
})

test('延迟：秒 / ms / 纯数字 / 上限', () => {
  const d = (t: string): number => splitBubbles(t, RULES).bubbles[1].delay
  assert.equal(d('A<||1.2s>B'), 1200)
  assert.equal(d('A<||300ms>B'), 300)
  assert.equal(d('A<||2>B'), 2000)
  assert.equal(d('A<||99s>B'), 10_000)
  assert.equal(d('A<||>B'), 0)
})

test('撤回标记不切分，只按 id 标记气泡', () => {
  const r = splitBubbles('A<||s1>B<||-s1>', RULES)
  assert.equal(r.bubbles.length, 2)
  assert.equal(r.bubbles[0].retracted, true)
  assert.equal(r.bubbles[1].retracted, false)
  assert.deepEqual(r.marks, ['-s1'])
})

test('撤回写在命名之前也认（按 id 全局匹配）', () => {
  const r = splitBubbles('<||-s1>A<||s1>B', RULES)
  assert.equal(r.bubbles.length, 2)
  assert.equal(r.bubbles[0].retracted, true)
})

test('围栏代码块里的标记不解析', () => {
  const text = '说明：\n```\nA<||>B\n```\n完'
  const r = splitBubbles(text, RULES)
  assert.equal(r.hadTags, false)
  assert.equal(r.bubbles.length, 1)
  assert.equal(r.bubbles[0].text, text)
})

test('行内代码里的标记不解析', () => {
  const r = splitBubbles('用 `<||>` 分隔', RULES)
  assert.equal(r.hadTags, false)
})

test('流式未闭合的标记不当标记', () => {
  const r = splitBubbles('你好<||', RULES)
  assert.equal(r.hadTags, false)
  assert.equal(r.bubbles[0].text, '你好<||')
})

test('plain 剥掉全部标记', () => {
  assert.equal(splitBubbles('A<||s1>B<||1.2s>C', RULES).plain, 'ABC')
})

test('maskCodeRegions 长度不变、围栏内被遮蔽', () => {
  const text = 'x\n```\ny<||>\n```\nz `a<||>` b'
  const masked = maskCodeRegions(text)
  assert.equal(masked.length, text.length)
  assert.equal(findChatTags(masked, RULES).length, 0)
})

test('block 类型的前缀不参与自闭合标记解析', () => {
  const rules: InlineTagRule[] = [{ prefix: '<g||', kind: 'block' }]
  assert.equal(findChatTags('<g||board>x</g||>', rules).length, 0)
})

test('标记体解析：id= 写法与 wait 关键字', () => {
  assert.deepEqual(parseTagBody('wait id=s2'), { id: 's2', retract: [] })
  assert.deepEqual(parseTagBody('-s9'), { retract: ['s9'] })
  assert.deepEqual(parseTagBody('name=s3 500ms'), { id: 's3', delay: 500, retract: [] })
})

test('未知标记原样保留（不当标记、不去掉）', () => {
  const r = splitBubbles('a <br/> b', RULES)
  assert.equal(r.hadTags, false)
  assert.equal(r.bubbles[0].text, 'a <br/> b')
})

test('流式尾部的半截标记先藏起来，闭合后不藏', () => {
  assert.equal(trimPartialTag('你好<||s', RULES), '你好')
  assert.equal(trimPartialTag('你好<', RULES), '你好')
  assert.equal(trimPartialTag('你好<||s1/>', RULES), '你好<||s1/>')
  // 正文里的普通 < 不受影响
  assert.equal(trimPartialTag('a < b', RULES), 'a < b')
  assert.equal(trimPartialTag('标签<br>后面', RULES), '标签<br>后面')
  assert.equal(trimPartialTag('你好', RULES), '你好')
})

const BLOCK: InlineTagRule[] = [{ prefix: '<g|', kind: 'block' }]

test('块级标记：name / payload 解析', () => {
  const hits = findBlockTags('旁白<g|ttt|X.O.X...|turn=O>结尾', BLOCK)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'ttt')
  assert.equal(hits[0].payload, 'X.O.X...|turn=O')
  assert.equal(hits[0].raw, '<g|ttt|X.O.X...|turn=O>')
  // 没有 payload 时 name = 全部
  assert.deepEqual(
    findBlockTags('<g|ttt>', BLOCK).map((h) => [h.name, h.payload]),
    [['ttt', '']]
  )
})

test('块级标记：代码区跳过、未闭合不当标记、strip 只留旁白', () => {
  assert.equal(findBlockTags('```\n<g|ttt|x>\n```', BLOCK).length, 0)
  assert.equal(findBlockTags('行内 `<g|ttt|x>` 也不算', BLOCK).length, 0)
  assert.equal(findBlockTags('还没写完<g|ttt', BLOCK).length, 0)
  assert.equal(stripBlockTags('旁白一<g|ttt|X..>旁白二', BLOCK), '旁白一旁白二')
  // split 规则不认块级前缀（命名空间互不越界）
  assert.equal(findChatTags('a<g|ttt|x>b', RULES).length, 0)
  assert.equal(findBlockTags('a<||>b', BLOCK).length, 0)
})
