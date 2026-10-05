import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { FtGestureIntent, FtGestureMode, FtGesturePointerInput } from './gestures'
import { FtGestures } from './gestures'

// The gesture machine is pure, but stay safe anyway: never touch the real
// ~/.config/LinuxCockpit (AGENTS.md §11.7) — sandbox HOME before anything else.
const home = mkdtempSync(join('/tmp', 'cockpit-ft-gestures-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

type Harness = {
  gestures: FtGestures
  intents: FtGestureIntent[]
  setMode(m: FtGestureMode): void
  setTouchRotate(v: boolean): void
  down(p: Partial<FtGesturePointerInput> & { pointerId: number }): void
  move(p: Partial<FtGesturePointerInput> & { pointerId: number }): void
  up(pointerId: number): void
  lost(pointerId: number): void
}

function harness(opts?: { mode?: FtGestureMode; touchRotate?: boolean }): Harness {
  let mode: FtGestureMode = opts?.mode ?? '2d'
  let touchRotate = opts?.touchRotate ?? false
  const intents: FtGestureIntent[] = []
  const gestures = new FtGestures({
    emit: (i) => intents.push(i),
    mode: () => mode,
    touchRotate: () => touchRotate
  })
  const fill = (
    p: Partial<FtGesturePointerInput> & { pointerId: number }
  ): FtGesturePointerInput => ({
    x: 0,
    y: 0,
    button: 0,
    pointerType: 'touch',
    ...p
  })
  return {
    gestures,
    intents,
    setMode: (m) => (mode = m),
    setTouchRotate: (v) => (touchRotate = v),
    down: (p) => gestures.down(fill(p)),
    move: (p) => gestures.move(fill(p)),
    up: (id) => gestures.up(id),
    lost: (id) => gestures.lostCapture(id)
  }
}

const pans = (h: Harness): { dx: number; dy: number }[] =>
  h.intents.filter((i) => i.kind === 'pan') as { dx: number; dy: number }[]
const orbits = (h: Harness): { dx: number; dy: number }[] =>
  h.intents.filter((i) => i.kind === 'orbit') as { dx: number; dy: number }[]
const zooms = (h: Harness): { factor: number }[] =>
  h.intents.filter((i) => i.kind === 'zoom') as { factor: number }[]
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const near = (v: number, expected: number): boolean => Math.abs(v - expected) < 1e-9
/** Zoom factor of an arbitrary intent (0 when it isn't a zoom). */
const factorOf = (i: FtGestureIntent | undefined): number => (i && i.kind === 'zoom' ? i.factor : 0)

test('single finger pans by the exact pointer delta (2D default)', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 100, y: 100 })
  h.move({ pointerId: 1, x: 130, y: 140 })
  h.move({ pointerId: 1, x: 160, y: 100 })
  assert.equal(pans(h).length, 2)
  assert.deepEqual(pans(h)[0], { kind: 'pan', dx: 30, dy: 40 })
  assert.deepEqual(pans(h)[1], { kind: 'pan', dx: 30, dy: -40 })
  assert.equal(orbits(h).length, 0)
  assert.equal(zooms(h).length, 0)
})

test('touch rotate toggle makes a single finger orbit in 3D, pan in 2D', () => {
  const h = harness({ mode: '3d', touchRotate: true })
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.move({ pointerId: 1, x: 12, y: -5 })
  assert.equal(orbits(h).length, 1)
  assert.deepEqual(orbits(h)[0], { kind: 'orbit', dx: 12, dy: -5 })
  assert.equal(pans(h).length, 0)

  // toggle off → back to panning, even in 3D
  h.setTouchRotate(false)
  h.move({ pointerId: 1, x: 20, y: 0 })
  assert.equal(pans(h).length, 1)
  assert.deepEqual(pans(h)[0], { kind: 'pan', dx: 8, dy: 5 })

  // in 2D the toggle never orbits (scene.orbitBy is a no-op there)
  const h2 = harness({ mode: '2d', touchRotate: true })
  h2.down({ pointerId: 1, x: 0, y: 0 })
  h2.move({ pointerId: 1, x: 9, y: 9 })
  assert.equal(orbits(h2).length, 0)
  assert.equal(pans(h2).length, 1)
})

test('pinch emits the distance ratio with the scene.zoomBy convention', () => {
  const h = harness()
  // two fingers 100px apart on the x axis → baseline pinch distance 100
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 100, y: 0 })
  assert.equal(h.intents.length, 0, 'landing a finger emits nothing')

  // ---- spread apart: 100 → 150 → 200 px. Fingers spreading must zoom IN,
  //      i.e. factor < 1, because scene.zoomBy multiplies the view distance.
  h.move({ pointerId: 1, x: -50, y: 0 }) // distance 150
  h.move({ pointerId: 2, x: 150, y: 0 }) // distance 200
  const spread = zooms(h)
  assert.equal(spread.length, 2)
  assert.ok(spread[0].factor < 1 && spread[1].factor < 1, 'spreading zooms in')
  assert.ok(near(spread[0].factor, 100 / 150), `factor ${spread[0].factor}`)
  assert.ok(near(spread[1].factor, 150 / 200), `factor ${spread[1].factor}`)

  // ---- pinch back: 200 → 175 → 100 px → zoom OUT (factor > 1)
  h.move({ pointerId: 1, x: -25, y: 0 }) // distance 175
  h.move({ pointerId: 2, x: 75, y: 0 }) // distance 100
  const back = zooms(h).slice(2)
  assert.equal(back.length, 2)
  assert.ok(back[0].factor > 1 && back[1].factor > 1, 'pinching together zooms out')
  assert.ok(near(back[0].factor, 200 / 175), `factor ${back[0].factor}`)
  assert.ok(near(back[1].factor, 175 / 100), `factor ${back[1].factor}`)

  // returning to the start distance must cancel out to a neutral zoom
  const product = zooms(h).reduce((a, z) => a * z.factor, 1)
  assert.ok(near(product, 1), `round trip should be neutral, got ${product}`)
})

test('two-finger centroid drag orbits in 3D and pans in 2D', () => {
  const h = harness({ mode: '3d' })
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 100, y: 0 })
  // both fingers move +10/+10 → centroid +10/+10
  h.move({ pointerId: 1, x: 10, y: 10 })
  assert.deepEqual(orbits(h), [{ kind: 'orbit', dx: 5, dy: 5 }])
  assert.equal(pans(h).length, 0)

  const h2 = harness({ mode: '2d' })
  h2.down({ pointerId: 1, x: 0, y: 0 })
  h2.down({ pointerId: 2, x: 100, y: 0 })
  h2.move({ pointerId: 1, x: 10, y: 10 })
  assert.deepEqual(pans(h2), [{ kind: 'pan', dx: 5, dy: 5 }])
  assert.equal(orbits(h2).length, 0)
})

test('1 → 2 pointer transition does not jump (fresh pinch + centroid baseline)', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 100, y: 0 })
  h.move({ pointerId: 1, x: 120, y: 0 })
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 20, dy: 0 }])

  // second finger lands far away: no intent from the landing itself
  h.down({ pointerId: 2, x: 400, y: 0 })
  assert.equal(h.intents.length, 1)

  // first finger's next move: only the real movement shows up — centroid
  // 260 → 265 (dx 5) and pinch distance 280 → 270 (factor 280/270).
  h.move({ pointerId: 1, x: 130, y: 0 })
  const after = h.intents.slice(1)
  assert.equal(after.length, 2, 'centroid pan + pinch zoom, nothing else')
  assert.deepEqual(after[0], { kind: 'pan', dx: 5, dy: 0 })
  assert.ok(near(factorOf(after[1]), 280 / 270), `factor ${factorOf(after[1])}`)
})

test('2 → 1 → 2 transitions keep panning without a jump', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 100, y: 0 })
  h.move({ pointerId: 1, x: 20, y: 0 }) // centroid 50→60, distance 100→80
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 10, dy: 0 }])
  assert.ok(near(zooms(h)[0].factor, 100 / 80))

  // lift one finger: nothing emitted, baseline rebased to the survivor
  h.up(2)
  assert.equal(h.gestures.pointerCount, 1)

  // the surviving finger pans by its own delta only (no stale jump)
  h.move({ pointerId: 1, x: 40, y: 0 })
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 20, dy: 0 })
  assert.equal(zooms(h).length, 1, 'single finger never zooms')

  // a new second finger re-baselines the pinch: the first move afterwards
  // must not produce a giant one-frame zoom
  h.down({ pointerId: 2, x: 200, y: 0 }) // distance 160, centroid 120
  h.move({ pointerId: 1, x: 50, y: 0 }) // distance 150, centroid 125
  const fresh = zooms(h).at(-1)
  assert.ok(fresh && near(fresh.factor, 160 / 150), `factor ${fresh?.factor}`)
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 5, dy: 0 })
})

test('pointercancel and unknown ids are safe no-ops', () => {
  const h = harness()
  h.up(99) // never went down
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.move({ pointerId: 1, x: 10, y: 0 })
  const settled = h.intents.length
  // cancel mid-gesture: state is dropped, further moves are ignored
  h.up(1)
  h.move({ pointerId: 1, x: 90, y: 0 })
  assert.equal(h.gestures.pointerCount, 0)
  assert.equal(h.intents.length, settled)
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 10, dy: 0 })

  // double cancel is harmless
  h.up(1)
  h.lost(1)
  assert.equal(h.intents.length, settled)
})

test('lostpointercapture ends the gesture instead of sticking', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 100, y: 0 })
  h.lost(1)
  assert.equal(h.gestures.pointerCount, 1)
  const settled = h.intents.length
  // the pointer that lost capture no longer drives anything
  h.move({ pointerId: 1, x: 80, y: 0 })
  assert.equal(h.intents.length, settled)
  // the surviving one still pans, by its own delta
  h.move({ pointerId: 2, x: 130, y: 0 })
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 30, dy: 0 })

  // losing both leaves a clean slate
  h.lost(2)
  assert.equal(h.gestures.pointerCount, 0)
  h.down({ pointerId: 3, x: 0, y: 0 })
  h.move({ pointerId: 3, x: 4, y: 4 })
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 4, dy: 4 })
})

test('a third pointer freezes gestures and resumes without a jump', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 100, y: 0 })
  h.down({ pointerId: 3, x: 300, y: 0 })
  assert.ok(h.gestures.isFrozen)
  const settled = h.intents.length
  // moves with three fingers down emit nothing
  h.move({ pointerId: 1, x: 40, y: 40 })
  h.move({ pointerId: 2, x: 140, y: 40 })
  h.move({ pointerId: 3, x: 340, y: 40 })
  assert.equal(h.intents.length, settled)
  // a fourth is tolerated too
  h.down({ pointerId: 4, x: 500, y: 0 })
  h.move({ pointerId: 4, x: 600, y: 0 })
  assert.equal(h.intents.length, settled)

  // lift the extras back down to two → gestures resume from a fresh baseline
  h.up(3)
  h.up(4)
  assert.equal(h.gestures.pointerCount, 2)
  assert.ok(!h.gestures.isFrozen)
  h.move({ pointerId: 1, x: 60, y: 40 })
  const resumed = h.intents.slice(settled)
  assert.equal(resumed.length, 2, 'centroid pan + pinch zoom only')
  // fingers sit at 60 / 140 → centroid 100 (was 90) and distance 80 (was 100)
  assert.deepEqual(resumed[0], { kind: 'pan', dx: 10, dy: 0 })
  assert.ok(near(factorOf(resumed[1]), 100 / 80), `factor ${factorOf(resumed[1])}`)
})

test('mouse drags keep the desktop behaviour (left pan / right orbit)', () => {
  const h = harness({ mode: '3d' })
  h.down({ pointerId: 1, x: 10, y: 10, button: 0, pointerType: 'mouse' })
  h.move({ pointerId: 1, x: 20, y: 25 })
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 10, dy: 15 }])

  // right drag orbits in 3D
  h.up(1)
  h.down({ pointerId: 2, x: 0, y: 0, button: 2, pointerType: 'mouse' })
  h.move({ pointerId: 2, x: -6, y: 8 })
  assert.deepEqual(orbits(h), [{ kind: 'orbit', dx: -6, dy: 8 }])
  assert.equal(pans(h).length, 1)

  // right drag in 2D is ignored (orbit is 3D-only)
  const h2 = harness({ mode: '2d' })
  h2.down({ pointerId: 1, x: 0, y: 0, button: 2, pointerType: 'mouse' })
  h2.move({ pointerId: 1, x: 30, y: 30 })
  assert.equal(h2.intents.length, 0)

  // middle button never starts a drag
  const h3 = harness({ mode: '3d' })
  h3.down({ pointerId: 1, x: 0, y: 0, button: 1, pointerType: 'mouse' })
  h3.move({ pointerId: 1, x: 30, y: 30 })
  assert.equal(h3.gestures.pointerCount, 0)
  assert.equal(h3.intents.length, 0)
})

test('a mouse drag that loses its button mid-move closes cleanly', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0, button: 0, pointerType: 'mouse' })
  h.move({ pointerId: 1, x: 10, y: 0, buttons: 1 })
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 10, dy: 0 }])
  // buttons bitmask drops to 0 → treat as released, do not pan further
  h.move({ pointerId: 1, x: 40, y: 0, buttons: 0 })
  assert.equal(h.gestures.pointerCount, 0)
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 10, dy: 0 }])
})

test('a mouse drag wins over simultaneous touch pointers', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0, button: 0, pointerType: 'mouse' })
  h.down({ pointerId: 2, x: 100, y: 0 }) // touch lands on the same view
  h.move({ pointerId: 2, x: 140, y: 20 })
  assert.equal(pans(h).length, 0, 'touch moves are ignored during a mouse drag')
  h.move({ pointerId: 1, x: 12, y: 4 })
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 12, dy: 4 }])
})

test('extreme pinch ratios are clamped per event', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 10, y: 0 }) // baseline distance 10
  h.move({ pointerId: 1, x: -1000, y: 0 }) // 1010px spread from a 10px baseline
  const zoomIn = zooms(h).at(-1)?.factor ?? 0
  assert.ok(near(zoomIn, 0.2), `extreme zoom-in must clamp to 0.2, got ${zoomIn}`)

  // the other end: a huge distance collapsing onto one point
  const h2 = harness()
  h2.down({ pointerId: 1, x: -1000, y: 0 })
  h2.down({ pointerId: 2, x: 1000, y: 0 }) // baseline distance 2000
  h2.move({ pointerId: 1, x: 999, y: 0 }) // distance 1 → ratio 2000
  const zoomOut = zooms(h2).at(-1)?.factor ?? 0
  assert.ok(near(zoomOut, 5), `extreme zoom-out must clamp to 5, got ${zoomOut}`)
  assert.ok(zoomOut >= 0.2 && zoomOut <= 5, 'both ends stay inside the clamp')
})

test('reset() drops every pointer and baseline', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  h.down({ pointerId: 2, x: 10, y: 0 })
  h.down({ pointerId: 3, x: 20, y: 0 })
  h.gestures.reset()
  assert.equal(h.gestures.pointerCount, 0)
  assert.ok(!h.gestures.isFrozen)
  const settled = h.intents.length
  h.move({ pointerId: 1, x: 100, y: 100 })
  assert.equal(h.intents.length, settled)
  // and works again afterwards
  h.down({ pointerId: 4, x: 0, y: 0 })
  h.move({ pointerId: 4, x: 3, y: 0 })
  assert.deepEqual(pans(h).at(-1), { kind: 'pan', dx: 3, dy: 0 })
})

test('pen input is treated like a finger', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0, pointerType: 'pen' })
  h.move({ pointerId: 1, x: 5, y: 6 })
  assert.deepEqual(pans(h), [{ kind: 'pan', dx: 5, dy: 6 }])
})

test('aggregate pan matches the total pointer travel across a gesture', () => {
  const h = harness()
  h.down({ pointerId: 1, x: 0, y: 0 })
  for (let i = 1; i <= 10; i++) h.move({ pointerId: 1, x: i * 7, y: -i * 3 })
  assert.equal(sum(pans(h).map((p) => p.dx)), 70)
  assert.equal(sum(pans(h).map((p) => p.dy)), -30)
})
