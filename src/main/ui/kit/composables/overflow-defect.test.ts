import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clippedByAncestor,
  isOverflowDefect,
  selfOverflows,
  type OverflowProbe
} from './overflow-defect'

/**
 * 第 2 类「溢出/被裁」判定契约（五类审计口径）。
 * 核心区分：**裁了但有揭示去处 = 合法（档 1）；裁了没去处 = 缺陷（本类）**。
 */

const base: OverflowProbe = {
  scrollWidth: 100,
  clientWidth: 100,
  right: 100,
  clipRight: null,
  revealed: false
}

test('自裁（sw>cw）且无揭示 → 缺陷', () => {
  assert.equal(selfOverflows({ ...base, scrollWidth: 140, clientWidth: 120 }), true)
  assert.equal(isOverflowDefect({ ...base, scrollWidth: 140, clientWidth: 120 }), true)
})

test('祖裁（右缘超 padding 右缘）且无揭示 → 缺陷', () => {
  assert.equal(clippedByAncestor({ ...base, right: 158, clipRight: 150 }), true)
  assert.equal(isOverflowDefect({ ...base, right: 158, clipRight: 150 }), true)
})

test('合法裁剪放行：真截断 + 揭示不算缺陷（档 1 工作状态）', () => {
  const legal: OverflowProbe = { ...base, scrollWidth: 140, clientWidth: 120, revealed: true }
  assert.equal(isOverflowDefect(legal), false)
  assert.equal(isOverflowDefect({ ...base, right: 158, clipRight: 150, revealed: true }), false)
})

test('没裁没溢出 → 不是缺陷（不管有没有揭示）', () => {
  assert.equal(isOverflowDefect(base), false)
  assert.equal(isOverflowDefect({ ...base, revealed: true }), false)
  // 隐藏项（cw=0）不算：teleport 进「更多」浮层的项在行里 display:none
  assert.equal(
    isOverflowDefect({ ...base, scrollWidth: 0, clientWidth: 0, right: 0, clipRight: 0 }),
    false
  )
})

test('贴边不算：右缘正好等于 padding 右缘 / sw-cw 差 1px', () => {
  assert.equal(isOverflowDefect({ ...base, right: 150, clipRight: 150 }), false)
  assert.equal(isOverflowDefect({ ...base, scrollWidth: 101, clientWidth: 100 }), false)
})

test('两个方向同时成立也算一类缺陷（不重复计）', () => {
  const both: OverflowProbe = {
    ...base,
    scrollWidth: 140,
    clientWidth: 120,
    right: 158,
    clipRight: 150
  }
  assert.equal(selfOverflows(both), true)
  assert.equal(clippedByAncestor(both), true)
  assert.equal(isOverflowDefect(both), true)
})
