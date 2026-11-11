import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anchorPosition, rootZoom, type AnchorGeometry } from './useAnchor'

const base: AnchorGeometry = {
  viewport: { width: 400, height: 800 },
  trigger: { left: 300, right: 330, top: 300, bottom: 320 },
  floating: { width: 200, height: 120 },
  placement: 'bottom-end',
  margin: 8
}

test('锚定定位：右缘对齐触发块、贴在下方', () => {
  const p = anchorPosition(base)
  assert.equal(p.left, 130) // 330 - 200
  assert.equal(p.top, 324) // 320 + 4
  assert.equal(p.placement, 'bottom-end')
})

test('锚定定位：下方放不下就翻到上方', () => {
  const p = anchorPosition({ ...base, trigger: { ...base.trigger, top: 700, bottom: 720 } })
  assert.equal(p.placement, 'top-end')
  assert.equal(p.top, 700 - 120 - 4)
})

test('锚定定位：横向夹回视口，绝不出屏（不出屏就不会被右缘切掉）', () => {
  // 触发块贴右缘、浮层比可用空间宽 → 夹到 margin
  const p = anchorPosition({
    ...base,
    viewport: { width: 320, height: 800 },
    floating: { width: 300, height: 120 }
  })
  assert.ok(p.left >= 8, '不出左缘')
  assert.ok(p.left + 300 <= 320 - 8 + 0.001, '不出右缘')
})

test('锚定定位：start 方位左缘对齐触发块（放得下时不夹）', () => {
  const p = anchorPosition({
    ...base,
    placement: 'bottom-start',
    floating: { width: 80, height: 120 }
  })
  assert.equal(p.left, 300)
  assert.equal(p.top, 324)
})

test('锚定定位：start 方位放不下时同样夹回视口', () => {
  const p = anchorPosition({ ...base, placement: 'bottom-start' })
  assert.equal(p.left, 192, '330+200 出屏 → 夹到 400-200-8')
})

test('锚定定位：上下都放不下时选空间大的一侧，仍夹在视口内', () => {
  const p = anchorPosition({
    ...base,
    viewport: { width: 400, height: 300 },
    trigger: { left: 300, right: 330, top: 140, bottom: 160 },
    floating: { width: 200, height: 250 }
  })
  assert.ok(p.top >= 8, '不出上缘')
  assert.ok(p.top + 250 <= 300 - 8 + 0.001, '不出下缘')
})

test('rootZoom：无 DOM 环境下回落 1（不抛）', () => {
  assert.equal(rootZoom(), 1)
})
