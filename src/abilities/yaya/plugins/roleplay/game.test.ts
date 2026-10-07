/**
 * Roleplay 插件的纯逻辑：命令解析、阶段判断、设定覆盖、记忆合并、导出。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  decide,
  effectiveSetup,
  emptyState,
  exportText,
  gmSystem,
  mergeChronicle,
  normalizeState,
  parseCommand,
  stateFromSetup,
  type ExportLabels
} from './game'

it('parseCommand: 命令头不区分大小写，c 后面必须是空白或结尾', () => {
  assert.deepEqual(parseCommand('c'), { kind: 'continue', text: '' })
  assert.deepEqual(parseCommand('C 走进酒馆'), { kind: 'continue', text: '走进酒馆' })
  assert.deepEqual(parseCommand('  /c\n去北方'), { kind: 'continue', text: '去北方' })
  assert.deepEqual(parseCommand('R 酒馆老板的样子'), { kind: 'expand', text: '酒馆老板的样子' })
  assert.deepEqual(parseCommand('PROMPT'), { kind: 'export' })
  assert.deepEqual(parseCommand('help'), { kind: 'help' })
  assert.deepEqual(parseCommand('cat is cute'), { kind: 'text', text: 'cat is cute' })
  assert.deepEqual(parseCommand('rain falls'), { kind: 'text', text: 'rain falls' })
  assert.deepEqual(parseCommand('promptly'), { kind: 'text', text: 'promptly' })
})

it('decide: 按阶段解释没有命令头的文字', () => {
  assert.deepEqual(decide({ kind: 'text', text: '一个雨夜' }, null), {
    kind: 'opening',
    intro: '一个雨夜'
  })
  // 开场前的 c / r 也当 intro
  assert.equal(decide({ kind: 'continue', text: 'x' }, null).kind, 'opening')
  const opening = emptyState()
  assert.deepEqual(decide({ kind: 'text', text: '主角改成女生' }, opening), {
    kind: 'revise',
    feedback: '主角改成女生'
  })
  assert.equal(decide({ kind: 'continue', text: '' }, opening).kind, 'continue')
  const playing = { ...emptyState(), phase: 'playing' as const }
  assert.deepEqual(decide({ kind: 'text', text: '拔剑' }, playing), {
    kind: 'continue',
    guidance: '拔剑'
  })
  assert.equal(decide({ kind: 'export' }, null).kind, 'export')
})

it('设定：配置默认值 ← 模型定的主角 / 题材 ← 用户明说的覆盖', () => {
  const cfg = { pov: 'second', detail: 8, mode: 'free' }
  const s = stateFromSetup(
    {
      title: '雨夜',
      protagonist: '[[main]] 是落魄剑客',
      genre: '武侠',
      world: ['江湖'],
      characters: [
        { name: '[[main]]', note: '不该出现' },
        { name: '老板', note: '酒馆老板' }
      ],
      overrides: { detail: 12, mode: 'I', pov: null, pace: 'bogus' }
    },
    null,
    cfg
  )
  assert.equal(s.title, '雨夜')
  assert.deepEqual(s.characters, [{ name: '老板', note: '酒馆老板' }])
  const eff = effectiveSetup(cfg, s)
  assert.equal(eff.pov, 'second')
  assert.equal(eff.detail, 12)
  assert.equal(eff.mode, 'interactive')
  assert.equal(eff.pace, 'slow')
  assert.equal(eff.genre, '武侠')
  // 配置写死的主角优先于模型
  const fixed = stateFromSetup({ protagonist: '别的' }, null, { protagonist: '少女魔法师' })
  assert.equal(fixed.protagonist, '少女魔法师')
})

it('返工：没给的字段沿用上一版', () => {
  const prev = stateFromSetup({ title: 'A', world: ['w1'], overrides: { detail: 3 } }, null, {})
  const next = stateFromSetup({ genre: '科幻' }, prev, {})
  assert.equal(next.title, 'A')
  assert.deepEqual(next.world, ['w1'])
  assert.equal(next.overrides.detail, 3)
  assert.equal(next.genre, '科幻')
})

it('记忆合并与归一化', () => {
  const s = mergeChronicle(emptyState(), {
    summary: '[[main]] 进了酒馆',
    world_add: ['酒馆叫醉仙楼', '酒馆叫醉仙楼'],
    characters: [{ name: '老板', note: '胖' }]
  })
  const s2 = mergeChronicle(s, { characters: [{ name: '老板', note: '其实是刺客' }] })
  assert.deepEqual(s2.world, ['酒馆叫醉仙楼'])
  assert.equal(s2.characters[0].note, '其实是刺客')
  assert.deepEqual(s2.summary, ['[[main]] 进了酒馆'])
  assert.equal(normalizeState(null), null)
  assert.equal(normalizeState({ phase: 'weird', turn: -3 })!.phase, 'opening')
  assert.equal(normalizeState({ phase: 'weird', turn: -3 })!.turn, 0)
})

it('GM 提示词：additions 只在有内容时出现；导出含设定与剧情', () => {
  const setup = effectiveSetup({}, null)
  assert.ok(!gmSystem(setup, '').includes('Additional instructions'))
  assert.ok(gmSystem(setup, '多用对话').includes('多用对话'))
  assert.ok(gmSystem(setup, '').includes('Play mode: Free'))

  const L: ExportLabels = {
    heading: 'H',
    settings: 'S',
    protagonist: 'P',
    pov: 'V',
    genre: 'G',
    style: 'St',
    detail: 'D',
    pace: 'Pa',
    mode: 'M',
    world: 'W',
    characters: 'C',
    story: 'So',
    povText: { third: '3', second: '2', first: '1' },
    paceText: { slow: 'sl', medium: 'me', fast: 'fa' },
    modeText: { free: 'F', interactive: 'I' },
    hint: 'hint',
    colon: ': '
  }
  const st = mergeChronicle(stateFromSetup({ title: 'T', world: ['w'] }, null, {}), {
    summary: 's1'
  })
  const text = exportText(st, effectiveSetup({}, st), L)
  assert.match(text, /^# H: T/)
  assert.match(text, /- D: 8\/16/)
  assert.match(text, /## W\n- w/)
  assert.match(text, /## So\n1\. s1/)
})
