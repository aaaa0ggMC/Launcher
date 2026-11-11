import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BREAKPOINTS, GRID, grid, narrowQuery } from './tokens'

test('网格令牌：一切尺寸都是 4px 基础单位的整数倍', () => {
  assert.equal(GRID.unit, 4)
  assert.equal(grid(1), 4)
  assert.equal(grid(2), 8)
  assert.equal(grid(3), 12)
  assert.equal(grid(10), 40, '触控热区 = 10 单位')
  assert.equal(GRID.gutter % GRID.unit, 0, '栏距是单位的整数倍')
  assert.equal(GRID.radius % GRID.unit, 0, '圆角是单位的整数倍')
  assert.equal(GRID.touch % GRID.unit, 0, '触控热区是单位的整数倍')
  assert.equal(GRID.controlHeight % GRID.unit, 0, '文字按钮高度是单位的整数倍')
  assert.equal(GRID.iconHeight % GRID.unit, 0, '图标按钮高度是单位的整数倍')
})

test('断点令牌：kit 唯一一套（sm 600 / md 960 / narrow 720 兼容值）', () => {
  assert.deepEqual({ ...BREAKPOINTS }, { sm: 600, md: 960, narrow: 720 })
  assert.equal(narrowQuery(BREAKPOINTS.narrow), '(max-width: 720px)')
  assert.equal(narrowQuery(BREAKPOINTS.sm), '(max-width: 600px)')
})
