import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  centerSpread,
  contains,
  edgeSpread,
  horizontalGap,
  isAlignmentDefect,
  isCollision,
  isSizeDefect,
  isStaggered,
  overlapArea,
  sizeSpread,
  type Box
} from './row-audit'

/**
 * 第 3 类（对齐）/ 第 4 类（同类尺寸）判定契约。
 * 典型事故：胶囊因文字折行一行高 48 一行高 24（尺寸类）；图标用 mt-1 冒充对齐
 * （对齐类，换字号即错位）。
 */

const b = (top: number, bottom: number, left = 0, right = 10): Box => ({ top, bottom, left, right })

test('中线散布 = max-min（px）', () => {
  // 两个不同高度但居中对齐的元素：中线相同 → 散布 0
  assert.equal(centerSpread([b(0, 24), b(0, 48)]), 12) // 中线 12 vs 24
  assert.equal(centerSpread([b(6, 30), b(6, 30)]), 0)
})

test('边缘散布（左/右/顶/底同口径）', () => {
  const boxes = [
    { top: 0, bottom: 24, left: 0, right: 10 },
    { top: 0, bottom: 24, left: 4, right: 14 }
  ]
  assert.equal(edgeSpread(boxes, 'left'), 4)
  assert.equal(edgeSpread(boxes, 'right'), 4)
  assert.equal(edgeSpread(boxes, 'top'), 0)
})

test('第 3 类：center 行中线偏差 >1px 判缺陷；start/end 比顶/底', () => {
  // mt-1 魔数对齐：同排图标抬高 4px（start 行），顶缘差 4px
  assert.equal(isAlignmentDefect([b(0, 24), b(4, 28)], 'start'), true)
  // 真正居中：不同高度中线一致（12 == 12）
  assert.equal(isAlignmentDefect([b(0, 24), b(-6, 30)], 'center'), false)
  // 中线差 2px（>1px）→ 缺陷
  assert.equal(isAlignmentDefect([b(0, 24), b(8, 32)], 'center'), true)
  // end 行底缘不齐
  assert.equal(isAlignmentDefect([b(0, 24), b(0, 22)], 'end'), true)
  // 1px 容差内不算
  assert.equal(isAlignmentDefect([b(0, 24), b(0, 25)], 'end'), false)
})

test('单元素行 / 空行不算缺陷', () => {
  assert.equal(isAlignmentDefect([], 'center'), false)
  assert.equal(isAlignmentDefect([b(0, 24)], 'center'), false)
})

test('第 4 类：同 kind 高度不一致判缺陷（胶囊折行事故口径）', () => {
  // 一行两个胶囊：一个折行 48 高、一个 24 高（用户抓的事故）
  assert.equal(sizeSpread([b(0, 24), b(0, 48)], 'height'), 24)
  assert.equal(isSizeDefect([b(0, 24), b(0, 48)]), true)
  // 同高不同宽：高度契约不比宽 → 不算
  assert.equal(isSizeDefect([b(0, 24, 0, 60), b(0, 24, 0, 80)]), false)
})

test('第 4 类：等宽数值类比宽度（kit-num「读数不跳」）', () => {
  const narrow = b(0, 24, 0, 29)
  const wide = b(0, 24, 0, 37)
  assert.equal(isSizeDefect([narrow, wide], ['height', 'width']), true)
  assert.equal(sizeSpread([narrow, wide], 'width'), 8)
  // 单个 / 两个以下不算
  assert.equal(isSizeDefect([narrow], ['height', 'width']), false)
})

// ── 第 5 类（碰撞 / 高低错落）───────────────────────────────────────────────

test('碰撞：非父子矩形相交 >1px² 判缺陷；贴边与包含不算', () => {
  const a = b(0, 24, 0, 40)
  const hit = b(10, 20, 30, 50) // 相交 10×10
  assert.equal(overlapArea(a, hit), 100)
  assert.equal(isCollision(a, hit), true)
  // 贴边（右缘相接）不算
  assert.equal(isCollision(a, b(0, 24, 40, 80)), false)
  // 父子包含不算（覆盖层/内层）
  assert.equal(isCollision(a, b(2, 22, 2, 38)), false)
})

test('高低错落：顶缘散布 > 行高一半判缺陷（折行断层口径）', () => {
  // 同排一个 24 高一个 48 高：顶缘差 12 = 行高(24)/2 → 不超
  assert.equal(isStaggered([b(0, 24), b(0, 48)]), false)
  // 折到第二行：top 差 30 > 行高(24)/2 → 断层
  assert.equal(isStaggered([b(0, 24), b(30, 54)]), true)
  // 单元素 / 空
  assert.equal(isStaggered([b(0, 24)]), false)
})

test('水平间距：负值=重叠、0=贴着', () => {
  assert.equal(horizontalGap(b(0, 10, 0, 40), b(0, 10, 30, 60)), -10)
  assert.equal(horizontalGap(b(0, 10, 0, 40), b(0, 10, 40, 60)), 0)
  assert.equal(horizontalGap(b(0, 10, 0, 40), b(0, 10, 46, 60)), 6)
})
