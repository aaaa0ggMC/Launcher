/**
 * 系统语音 SDK 的纯函数单测（不碰 window / 语音引擎）。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { pickVoice } from './speech'

const voices = [
  { id: 'en-us-x-net', name: 'English Network', lang: 'en-US', local: false },
  { id: 'en-us-x-local', name: 'English Local', lang: 'en-US', local: true },
  { id: 'zh', name: 'Microsoft Xiaoxiao', lang: 'zh_CN', local: true },
  { id: 'zh-tw', name: 'Tingting', lang: 'zh-TW', local: true }
]

it('pickVoice：按 id / 名称片段优先', () => {
  assert.equal(pickVoice(voices, 'zh-tw', 'en-US')?.id, 'zh-tw')
  assert.equal(pickVoice(voices, 'xiaoxiao', 'en-US')?.id, 'zh')
})

it('pickVoice：按语言选，本地语音优先，语言族兜底', () => {
  assert.equal(pickVoice(voices, '', 'en-US')?.id, 'en-us-x-local')
  assert.equal(pickVoice(voices, 'nope', 'zh-CN')?.id, 'zh')
  assert.equal(pickVoice(voices, undefined, 'zh-HK')?.id, 'zh')
  assert.equal(pickVoice(voices, undefined, 'ja-JP'), null)
})
