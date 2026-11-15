import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { GRID } from '../layout/tokens'

/**
 * KitChip 契约（SPEC「行内三律」第三条：同类元素同尺寸）。
 * 出事的那一行：demo 手写 .kit-demo-chip（display:inline-block + padding + radius），
 * 没有 nowrap、没有高度兜底——行内一紧文字折行、胶囊变高，一行里一个两行高一个一行高
 * （用户：「你这一行内胶囊大小不一致」）。契约盯两件事：高度不随内容变 + 文字不折行。
 */

const chip = readFileSync(fileURLToPath(new URL('./KitChip.vue', import.meta.url)), 'utf8')
const style = chip.slice(chip.indexOf('<style scoped>'))

test('高度走密度阶令牌，不随内容变', () => {
  // inline 档 = 6 单位（24px 布局），input 档 = 8 单位（32px 布局）
  assert.match(style, /height: var\(--kit-chip-height\)/, '高度由变量给，变量来自令牌')
  assert.match(chip, /GRID\.unit \* 6/, 'inline 档 24px = 6 网格单位')
  assert.match(chip, /GRID\.unit \* 8/, 'input 档 32px = 8 网格单位')
  assert.equal(GRID.unit * 6, 24)
  assert.equal(GRID.unit * 8, 32)
  // 不许出现 min-height / height:auto 这类会让它随内容长的写法
  assert.doesNotMatch(style, /min-height/, 'min-height 会让它随内容长')
})

test('文字不折行：ellipsis 归 KitTruncated 管，不在这再写一遍', () => {
  // 截断与揭示都收编到 KitTruncated（SPEC「信息降级链」）：积木不再各自写 ellipsis
  const truncated = readFileSync(
    fileURLToPath(new URL('./KitTruncated.vue', import.meta.url)),
    'utf8'
  )
  assert.match(truncated, /white-space: nowrap/)
  assert.match(truncated, /text-overflow: ellipsis/)
  assert.match(truncated, /overflow: hidden/)
  // KitChip 自己不再重复实现（重复就是两份会漂的实现）
  assert.doesNotMatch(style, /text-overflow: ellipsis/, 'ellipsis 归原语，积木不重复写')
})

test('内边距 / 圆角 / 字号从令牌算，表面吃玻璃变量', () => {
  assert.match(style, /padding: 0 8px/, '左右 2 单位（8px）')
  assert.match(style, /border-radius: 999px/, '胶囊形')
  assert.match(style, /font-size: 0\.75rem/, '字号阶的说明档')
})

test('priority 交给行的引擎：demo 里两个胶囊都是 tertiary', () => {
  const demo = readFileSync(
    fileURLToPath(
      new URL('../../../../abilities/settings/items/ui-kit/KitSmartRowDemo.vue', import.meta.url)
    ),
    'utf8'
  )
  assert.doesNotMatch(demo, /kit-demo-chip/, '手写胶囊样式已删')
  const chipUses = [...demo.matchAll(/<KitChip/g)]
  assert.ok(chipUses.length >= 2, '那一行的两个胶囊都用 KitChip')
  // 它们挂在 priority=tertiary 的 KitRowItem 下，行装不下时会被自动收进行尾「更多」
  assert.match(demo, /priority="tertiary"[^>]*>\s*<KitChip/)
})

test('回归：.kit-chip 必须可缩（min-width:0），否则截断永不发生、揭示也就永不生效', () => {
  // 实测踩坑：flex 项的 min-width 默认 auto = min-content = 全文宽，胶囊因此缩不到
  // 文字宽度以下 → .kit-truncated 的 scrollWidth 永远等于 clientWidth → truncated
  // 永远是 false → 没 title、点按没反应（用户：「悬浮还是点击都啥都没有」）。
  assert.match(style, /\.kit-chip \{[^}]*min-width: 0/, '没有 min-width:0 就缩不下去')
  assert.match(
    style,
    /max-width: 100%/,
    'max-width 让胶囊不超过容器，配合 min-width:0 才会真的截断'
  )
})
