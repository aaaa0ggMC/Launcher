import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAbilityMarkdown } from './ability-describe-render'
import type { AbilityDescription } from './ability-describe'

const base: AbilityDescription = {
  id: 'aidj',
  platforms: [],
  provides: ['mpris'],
  dependencies: ['background-tasks'],
  disabled: false,
  commands: [
    {
      name: 'aidj.chat',
      description: '与 AI DJ 对话',
      usage: 'aidj.chat --msg "来点安静的"',
      available: true,
      ui: ['aidj 聊天框'],
      related: ['job:aidj.chat']
    },
    {
      name: 'aidj.next',
      description: '下一曲 | 需要播放器',
      available: false,
      unavailableReason: '需要 MPRIS/DBus 播放模式'
    },
    {
      name: 'aidj.login',
      description: '登录',
      available: true,
      privacy: { agent: 'deny' }
    }
  ],
  jobs: ['aidj.chat'],
  help: [
    { lang: 'zh-cn', path: 'main.md' },
    { lang: 'zh-cn', path: '歌词/歌词页.md' },
    { lang: 'en-us', path: 'main.md' }
  ],
  helpHint: 'help.read --ability aidj --path main.md [--lang zh|en-US]'
}

test('markdown contains metadata, commands, jobs and help', () => {
  const md = renderAbilityMarkdown(base)
  assert.match(md, /^# aidj\n/m)
  assert.match(md, /- 平台: 全平台/)
  assert.match(md, /- 提供能力: mpris/)
  assert.match(md, /- 依赖能力: background-tasks/)
  assert.match(md, /- 运行时状态: 已启用/)
  assert.match(md, /## 命令 \(3\)/)
  assert.match(md, /### 入口 \/ 相关 \/ 隐私/)
  assert.match(md, /`aidj\.next` \| 下一曲 \\\| 需要播放器/)
  assert.match(md, /不可用: 需要 MPRIS\/DBus 播放模式/)
  assert.match(md, /## 后台作业 \(1\)/)
  assert.match(md, /background\.job --name aidj\.chat --args <json>/)
  assert.match(md, /## 帮助文档 \(3\)/)
})

test('empty ability renders placeholders', () => {
  const md = renderAbilityMarkdown({
    ...base,
    commands: [],
    jobs: [],
    help: [],
    helpHint: undefined
  })
  assert.match(md, /## 命令 \(0\)\n\n\(无\)/)
  assert.match(md, /## 后台作业 \(0\)\n\n\(无\)/)
  assert.match(md, /## 帮助文档 \(0\)\n\n\(无\)/)
  assert.ok(!md.includes('help.read'))
})

test('disabled ability is marked', () => {
  assert.match(renderAbilityMarkdown({ ...base, disabled: true }), /- 运行时状态: 已禁用/)
})
