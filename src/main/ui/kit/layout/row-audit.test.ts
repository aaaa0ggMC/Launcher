import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  centerSpread,
  edgeSpread,
  isAlignmentDefect,
  isSizeDefect,
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
