/**
 * speech 插件纯文本工具的单测（不碰磁盘 / 网络）。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { speechText, splitSpeech } from './text'

it('speechText：去掉代码块、链接地址、强调与列表符号', () => {
  const md = [
    '# 标题',
    '',
    '这是 **重点**，见 [文档](https://example.com/a)。',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    '- 第一项',
    '1. 第二项',
    '> 引用 `code`',
    '![图](a.png)'
  ].join('\n')
  assert.equal(speechText(md), '标题。\n这是 重点，见 文档。\n第一项。\n第二项。\n引用 code.')
})

it('speechText：表格变成逗号停顿，分隔行去掉', () => {
  const md = '| 名称 | 值 |\n| --- | --- |\n| a | 1 |'
  assert.equal(speechText(md), '名称，值。\na，1.')
})

it('splitSpeech：按句切、第一段短、单句太长硬切', () => {
  const text = '第一句话。第二句话！第三句话？' + '很长'.repeat(100) + '。最后'
  const parts = splitSpeech(text, 60, 6)
  assert.equal(parts[0], '第一句话。')
  assert.ok(parts.every((p) => p.length <= 60))
  assert.equal(parts.join(''), text)
})

it('splitSpeech：英文句子按空格拼接', () => {
  assert.deepEqual(splitSpeech('Hello there. How are you? Fine.', 100, 100), [
    'Hello there. How are you? Fine.'
  ])
})

it('splitSpeech：换行分句、空文本', () => {
  assert.deepEqual(splitSpeech('', 100), [])
  assert.deepEqual(splitSpeech('甲\n乙', 1, 1), ['甲', '乙'])
})
