/**
 * StoryTeller 纯逻辑的单测（不调模型、不碰磁盘）。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  bibleBrief,
  bibleFromArchitect,
  direct,
  emptyBible,
  extractJson,
  mergeChronicle
} from './bible'

it('extractJson：代码块、前后废话、尾逗号', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] })
  assert.deepEqual(extractJson('here {"x": "y"} done'), { x: 'y' })
  assert.equal(extractJson('no json'), null)
  assert.equal(extractJson('[1,2]'), null)
})

it('bibleFromArchitect：清洗字段、丢掉没名字的角色、线索编号', () => {
  const b = bibleFromArchitect({
    title: '雾港',
    genre: '悬疑',
    characters: [{ name: '林雾', role: '侦探', traits: '冷静' }, { role: 'nobody' }],
    threads: ['谁杀了船长', '失踪的灯塔看守'],
    world: ['港口终年起雾']
  })
  assert.equal(b.title, '雾港')
  assert.deepEqual(
    b.characters.map((c) => c.name),
    ['林雾']
  )
  assert.equal(b.threads.length, 2)
  assert.ok(b.threads.every((t) => t.status === 'open' && t.id))
  assert.notEqual(b.threads[0].id, b.threads[1].id)
})

it('mergeChronicle：按名字合并角色、解决 / 新增线索、摘要进时间线，不改原对象', () => {
  const b = bibleFromArchitect({
    characters: [{ name: '林雾', status: '健康' }],
    threads: ['谁杀了船长']
  })
  const id = b.threads[0].id
  const next = mergeChronicle(b, {
    summary: '林雾在码头发现了血迹',
    location: '码头',
    characters: [
      { name: '林雾', status: '左臂受伤' },
      { name: '老周', role: '渔夫' }
    ],
    threads_resolved: [id],
    threads_add: ['血迹是谁的'],
    world_add: ['码头晚上不点灯']
  })
  assert.equal(b.characters[0].status, '健康')
  assert.equal(next.characters[0].status, '左臂受伤')
  assert.equal(next.characters[1].name, '老周')
  assert.equal(next.threads.find((t) => t.id === id)?.status, 'resolved')
  assert.ok(next.threads.some((t) => t.text === '血迹是谁的' && t.status === 'open'))
  assert.deepEqual(next.timeline, ['林雾在码头发现了血迹'])
  assert.equal(next.location, '码头')
  assert.deepEqual(mergeChronicle(next, null), next)
})

it('direct：张力沿弧线先升后降、分章、同种子同结果、轮流推进线索', () => {
  const b = bibleFromArchitect({ threads: ['A', 'B'] })
  const tensions: number[] = []
  for (let turn = 0; turn < 8; turn++) tensions.push(direct({ ...b, turn }, 8, 1).tension)
  const peakAt = tensions.indexOf(Math.max(...tensions))
  assert.ok(peakAt >= 5 && peakAt <= 7, `peak at ${peakAt}: ${tensions}`)
  assert.ok(tensions[0] < tensions[peakAt] && tensions[7] < tensions[peakAt])
  const n9 = direct({ ...b, turn: 8 }, 8, 1)
  assert.equal(n9.chapter, 2)
  assert.ok(n9.newChapter)
  assert.ok(!direct({ ...b, turn: 0 }, 8, 1).newChapter)
  assert.deepEqual(direct(b, 8, 42), direct(b, 8, 42))
  for (let s = 0; s < 50; s++) {
    const r = direct(b, 8, s).roll
    assert.ok(r >= 1 && r <= 20)
  }
  assert.equal(direct({ ...b, turn: 0 }, 8, 1).focusThread?.text, 'A')
  assert.equal(direct({ ...b, turn: 1 }, 8, 1).focusThread?.text, 'B')
  assert.equal(direct(emptyBible(), 8, 1).focusThread, null)
})

it('bibleBrief：秘密只在要求时给出', () => {
  const b = bibleFromArchitect({ characters: [{ name: 'A', secret: 'is the killer' }] })
  assert.ok(!bibleBrief(b).includes('killer'))
  assert.ok(bibleBrief(b, { secrets: true }).includes('killer'))
})
