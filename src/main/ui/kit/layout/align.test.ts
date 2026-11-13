import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ALIGN, isAlignOverride, type KitAlign } from './align'

/**
 * 行内对齐契约（SPEC「行内对齐」）。
 * 用户原话「行内对齐是默认方案 + 可以覆盖设置哦」+「有没有行内对齐方案，为啥对齐这么混乱」
 * ——这条契约盯两件事：默认 center 落在机制上（一条规则治所有 affix），
 * 以及「治 Vuetify 内部元素的补丁数量不增长」（防再回到逐个打地鼠）。
 */

const css = readFileSync(fileURLToPath(new URL('../kit.css', import.meta.url)), 'utf8')

test('行内对齐默认 center：field 根节点一条规则治所有 affix', () => {
  assert.match(
    css,
    /\.kit-control \.v-field \{[^}]*align-items: var\(--kit-field-align, center\)/,
    'field 根节点定对齐（grid 四个区域共享中线），可用 --kit-field-align 覆盖'
  )
  // 行 / 元素的变量链：元素没传跟行，行没传回落 center
  assert.match(css, /\.kit-smart-row__line \{\s*align-items: var\(--kit-row-align, center\)/)
  assert.match(
    css,
    /\.kit-row-item \{\s*align-self: var\(--kit-item-align, var\(--kit-row-align, center\)\)/
  )
})

test('覆盖是显式少数：只有 align prop 能改，且默认值就是 center', () => {
  assert.equal(DEFAULT_ALIGN, 'center')
  const values: KitAlign[] = ['center', 'start', 'end', 'baseline', 'stretch']
  assert.deepEqual(values.slice().sort(), ['baseline', 'center', 'end', 'start', 'stretch'])
  // 默认 / 跟行 → 不算覆盖；显式传非 center → 算覆盖（自检会标出来）
  assert.equal(isAlignOverride(undefined), false)
  assert.equal(isAlignOverride('center'), false)
  assert.equal(isAlignOverride('start'), true)
  // 和行传的一致 → 不算覆盖（自检只标「偏离行默认模式」的）
  assert.equal(isAlignOverride('start', 'start'), false)
  assert.equal(isAlignOverride(undefined, 'start'), false, '没传 = 跟行，不算覆盖')
})

test('防回归：治 Vuetify 内部元素的补丁不增长（一条规则治一类的，不要三条治三个）', () => {
  // kit.css 里直接命中 Vuetify 内部类（.v-field__* / .v-input__*）的规则数
  // 只数「治 affix / 输入内部」这类最容易长补丁的选择器；尺寸/间距/圆角类不算
  const affixPatches = [
    ...css.matchAll(
      /\.kit-[a-zA-Z-]*\s+\.v-field__(?:append-inner|prepend-inner|clearable|field)[^{]*\{/g
    )
  ].map((m) => m[0].replace('{', '').trim())
  const allowed = [
    '.kit-control--num .v-field__append-inner' // 间距：Vuetify 给 affix 加的 padding-inline-start
  ]
  const unexpected = affixPatches.filter((sel) => !allowed.some((a) => sel.includes(a)))
  assert.deepEqual(
    unexpected,
    [],
    `出现新的 affix 补丁，先想清楚能不能用 .kit-control .v-field 的根规则替代：\n${unexpected.join('\n')}`
  )
})

test('自检有对齐视图：中线偏差标色 + 覆盖标色都在 kit.css 里', () => {
  assert.match(css, /\.kit-debug-on \.kit-debug-align \{/)
  assert.match(css, /\.kit-debug-on \.kit-debug-align--bad \{/)
  assert.match(css, /\.kit-debug-on \.kit-debug-align--override \{/)
})
