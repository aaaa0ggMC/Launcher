import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DrawerSwipe } from './drawer-swipe'

function gesture(dx: number, dy: number, duration = 400): { close: boolean; dragged: boolean } {
  const swipe = new DrawerSwipe()
  swipe.down(1, 120, 300, 264, 0)
  swipe.move(1, 120 + dx, 300 + dy)
  return swipe.end(1, duration)
}

test('dismisses a left swipe from the middle of the sidebar', () => {
  assert.deepEqual(gesture(-80, 4), { close: true, dragged: true })
})
test('accepts a quick short flick but snaps back after a slow short drag', () => {
  assert.equal(gesture(-30, 2, 50).close, true)
  assert.deepEqual(gesture(-30, 2, 400), { close: false, dragged: true })
})
test('preserves vertical scrolling, taps and rightward motion', () => {
  assert.deepEqual(gesture(-4, 100), { close: false, dragged: false })
  assert.deepEqual(gesture(-3, 2), { close: false, dragged: false })
  assert.deepEqual(gesture(100, 2), { close: false, dragged: false })
})
test('a gesture that starts vertically cannot later dismiss the sidebar', () => {
  const swipe = new DrawerSwipe()
  swipe.down(1, 180, 300, 264, 0)
  swipe.move(1, 181, 320)
  swipe.move(1, 20, 324)
  assert.equal(swipe.end(1, 500).close, false)
})
test('two fingers cancel dismissal until both are lifted', () => {
  const swipe = new DrawerSwipe()
  swipe.down(1, 180, 300, 264, 0)
  swipe.move(1, 100, 300)
  swipe.down(2, 120, 300, 264, 100)
  assert.equal(swipe.move(1, 0, 300), null)
  assert.equal(swipe.end(2, 200).close, false)
  assert.equal(swipe.end(1, 250).close, false)
  swipe.down(3, 180, 300, 264, 300)
  swipe.move(3, 80, 300)
  assert.equal(swipe.end(3, 500).close, true)
})
test('pointer cancellation and mode reset never dismiss', () => {
  const swipe = new DrawerSwipe()
  swipe.down(1, 180, 300, 264, 0)
  swipe.move(1, 0, 300)
  assert.deepEqual(swipe.end(1, 100, true), { close: false, dragged: true })
  swipe.down(2, 180, 300, 264, 200)
  swipe.reset()
  assert.equal(swipe.end(2, 300).close, false)
})
test('bounds displacement and allows returning to the starting point', () => {
  const swipe = new DrawerSwipe()
  swipe.down(1, 180, 300, 264, 0)
  assert.equal(swipe.move(1, -500, 300)?.offset, -264)
  assert.equal(swipe.move(1, 200, 300)?.offset, 0)
  assert.equal(swipe.end(1, 500).close, false)
})
