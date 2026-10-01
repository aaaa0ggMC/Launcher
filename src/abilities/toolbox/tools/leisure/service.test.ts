import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPomodoroPlan, execute } from './service'
import type { PomodoroPlan } from './service'

function planOf(data: unknown): PomodoroPlan {
  return data as PomodoroPlan
}

test('pomodoro 缺省参数回落到默认计划', async () => {
  const res = await execute('pomodoro', {})
  assert.equal(res.ok, true)
  const plan = planOf(res.data)
  assert.equal(plan.focusMinutes, 25)
  assert.equal(plan.breakMinutes, 5)
  assert.equal(plan.cycles, 4)
  assert.equal(plan.cycleMinutes, 30)
  assert.equal(plan.totalFocusMinutes, 100)
  assert.equal(plan.totalBreakMinutes, 20)
  assert.equal(plan.totalMinutes, 120)
  assert.match(res.text ?? '', /25 分钟/)
  assert.ok(res.note)
})

test('pomodoro 接受数字与字符串（CLI 场景）', async () => {
  const res = await execute('pomodoro', { focusMinutes: 50, breakMinutes: '10', cycles: '2' })
  assert.equal(res.ok, true)
  const plan = planOf(res.data)
  assert.equal(plan.totalMinutes, 120)
  assert.equal(plan.segments.length, 4)
})

test('pomodoro 空值与 null 视为缺省', async () => {
  for (const raw of ['', '   ', null, undefined]) {
    const res = await execute('pomodoro', { focusMinutes: raw, breakMinutes: raw, cycles: raw })
    assert.equal(res.ok, true)
    const plan = planOf(res.data)
    assert.equal(plan.focusMinutes, 25)
    assert.equal(plan.breakMinutes, 5)
    assert.equal(plan.cycles, 4)
  }
})

test('pomodoro 拒绝越界/非数字/非整数输入', async () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ focusMinutes: 0 }, '专注分钟'],
    [{ focusMinutes: -5 }, '专注分钟'],
    [{ focusMinutes: 181 }, '专注分钟'],
    [{ focusMinutes: 25.5 }, '专注分钟'],
    [{ breakMinutes: 0 }, '休息分钟'],
    [{ breakMinutes: 61 }, '休息分钟'],
    [{ breakMinutes: 1.5 }, '休息分钟'],
    [{ cycles: 0 }, '循环轮次'],
    [{ cycles: 13 }, '循环轮次'],
    [{ cycles: 1.5 }, '循环轮次']
  ]
  for (const [args, label] of bad) {
    const res = await execute('pomodoro', args)
    assert.equal(res.ok, false, JSON.stringify(args))
    assert.ok(res.error?.startsWith(label), res.error)
  }
})

test('pomodoro 错误信息不回显用户原始输入', async () => {
  const bad: Array<Record<string, unknown>> = [
    { focusMinutes: 'abc' },
    { breakMinutes: 'x' },
    { cycles: 'two' }
  ]
  for (const args of bad) {
    const res = await execute('pomodoro', args)
    assert.equal(res.ok, false)
    const value = String(Object.values(args)[0])
    assert.ok(!res.error?.includes(value), res.error)
  }
})

test('pomodoro 轮次在 1–12 内均通过', async () => {
  for (const cycles of [1, 6, 12]) {
    const res = await execute('pomodoro', { cycles })
    assert.equal(res.ok, true)
    assert.equal(planOf(res.data).cycles, cycles)
  }
})

test('pomodoro 未知工具 id 返回错误', async () => {
  const res = await execute('not-a-tool', {})
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /not-a-tool/)
})

test('buildPomodoroPlan 是确定性的纯函数，阶段顺序固定交替', () => {
  const plan = buildPomodoroPlan(25, 5, 3)
  assert.deepEqual(plan, buildPomodoroPlan(25, 5, 3))
  assert.deepEqual(
    plan.segments.map((s) => s.kind),
    ['focus', 'break', 'focus', 'break', 'focus', 'break']
  )
  assert.deepEqual(
    plan.segments.map((s) => s.labelZh),
    ['第 1 轮专注', '第 1 轮休息', '第 2 轮专注', '第 2 轮休息', '第 3 轮专注', '第 3 轮休息']
  )
  assert.deepEqual(
    plan.segments.map((s) => s.labelEn),
    ['Focus 1', 'Break 1', 'Focus 2', 'Break 2', 'Focus 3', 'Break 3']
  )
  assert.equal(buildPomodoroPlan(1, 1, 1).totalMinutes, 2)
})
