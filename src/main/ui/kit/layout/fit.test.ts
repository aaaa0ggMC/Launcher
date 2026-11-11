import assert from 'node:assert/strict'
import { test } from 'node:test'
import { circleDiameter, fitRatio, fitScale, fitState, type BoxSize } from './fit'

const box = (w: number, h: number): BoxSize => ({ width: w, height: h })

test('80% 规则：占比 ≤80% 是 roomy，≤100% 是 tight，超出是 overflow', () => {
  assert.equal(fitState(box(80, 40), box(100, 100)), 'roomy')
  assert.equal(fitState(box(80, 80), box(100, 100)), 'roomy', '正好 80% 仍算 roomy')
  assert.equal(fitState(box(90, 40), box(100, 100)), 'tight')
  assert.equal(fitState(box(100, 40), box(100, 100)), 'tight', '正好 100% 仍算 tight')
  assert.equal(fitState(box(101, 40), box(100, 100)), 'overflow')
  assert.equal(fitState(box(10, 200), box(100, 100)), 'overflow', '取更大的那条边')
  // 空容器不当溢出
  assert.equal(fitState(box(50, 50), box(0, 0)), 'roomy')
})

test('fitRatio：取宽高比较大的那条边', () => {
  assert.equal(fitRatio(box(50, 200), box(100, 100)), 2)
  assert.equal(fitRatio(box(200, 50), box(100, 100)), 2)
})

test('fitScale：overflow 时给出压回 80% 的系数，否则 1', () => {
  assert.equal(fitScale(box(50, 50), box(100, 100)), 1, '没超不用动')
  assert.equal(fitScale(box(80, 80), box(100, 100)), 1, '正好 80% 不用动')
  assert.equal(fitScale(box(100, 50), box(100, 100)), 0.8, '100% → 压到 80%')
  // 降档有 0.5 下限：再夸张也只压一半，剩下的交给调用方按 fit 状态做更激进的退化
  assert.equal(fitScale(box(200, 50), box(100, 100)), 0.5)
  assert.equal(fitScale(box(400, 50), box(100, 100)), 0.5)
})

test('圆形 stat 直径：文本 × 1.25（文字占 80%），夹在 min/max 之间', () => {
  // 40×40 的文字 → 直径 50（40/0.8）
  assert.equal(circleDiameter(box(40, 40), 30, 120), 50)
  // 长文本 → 上限
  assert.equal(circleDiameter(box(400, 40), 30, 120), 120)
  // 短文本 → 下限
  assert.equal(circleDiameter(box(8, 8), 44, 120), 44)
  // 取宽高较大的那条边
  assert.equal(circleDiameter(box(20, 80), 30, 120), 100)
})
