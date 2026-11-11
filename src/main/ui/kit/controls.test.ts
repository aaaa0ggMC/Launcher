import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GRID } from './layout/tokens'
import { fitScale, fitState } from './layout/fit'

/**
 * 控件层契约测试。
 *
 * 同类控件同高是「用户看得见」的那条（截图里 select 比输入框高就是破这条），
 * 而 DOM 测量跑在 node:test 里没有 layout——所以这里钉两件事：
 *   1. 令牌本身自洽（输入档 = 11 单位，且窄屏档也是整数单位）；
 *   2. kit.css 里控件层的声明与令牌一致（防回退，也防再犯 :deep() 那种整条规则被丢弃的错）。
 */

const css = readFileSync(fileURLToPath(new URL('./kit.css', import.meta.url)), 'utf8')

test('控件层契约：根盒子高度 = 输入档令牌，且是网格单位的整数倍', () => {
  assert.equal(GRID.inputHeight % GRID.unit, 0, '输入档必须是单位的整数倍')
  assert.equal(GRID.inputHeight, 44, '输入档 = Vuetify compact 自然高度（实测）')
  assert.match(css, /\.kit-control \{[^}]*min-height: 44px/, '根盒子 min-height 与令牌一致')
})

test('控件层契约：窄屏降档也是整数单位，且不碰 Vuetify 内部高度', () => {
  assert.match(
    css,
    /@media \(max-width: 720px\) \{\s*\.kit-control \{\s*min-height: 36px/,
    '窄屏降到 36px'
  )
  assert.equal(36 % GRID.unit, 0)
  // 不再用 min-height 硬压 field（实测只会得到四不像），也不再给 outlined field 加第二层 border
  assert.doesNotMatch(css, /\.kit-control \.v-field \{[^}]*min-height/, '不压 field 高度')
  assert.doesNotMatch(css, /\.kit-control \.v-field \{[^}]*border:/, '不加第二层 border')
})

test('控件层契约：玻璃表面与内容率变量都在用', () => {
  assert.match(css, /rgba\(var\(--kit-surface\), var\(--kit-glass-alpha\)\)/, '表面吃玻璃变量')
  assert.match(css, /backdrop-filter: blur\(var\(--kit-glass-blur\)\)/, '模糊吃玻璃变量')
  assert.match(css, /calc\(0\.875rem \* var\(--kit-fit-scale, 1\)\)/, '字号吃内容率变量')
  // 全局样式表里不能用 :deep()（scoped 语法，在这里整条规则会被丢弃——踩过）
  assert.doesNotMatch(css, /:deep\(/, 'kit.css 是全局表，不出现 :deep()')
})

test('useFitBox 的降档系数就是 fitScale（overflow 时压回 80%）', () => {
  const content = { width: 120, height: 20 }
  const container = { width: 100, height: 44 }
  assert.equal(fitState(content, container), 'overflow')
  // 120/100 = 1.2 → 压到 80% 需要 ×(0.8/1.2) = 2/3
  assert.equal(fitScale(content, container), 0.8 / 1.2, '超出 20% → 乘 0.8/1.2')
  // roomy 不动
  assert.equal(fitScale({ width: 40, height: 20 }, container), 1)
})
