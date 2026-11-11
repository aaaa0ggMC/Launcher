import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import type { EffectScope } from 'vue'
import { BREAKPOINTS, narrowQuery, useContainerWidth, useNarrow } from './useAdaptive'

/* ── DOM 桩：测试跑在 node:test 里（项目统一 runner，不是 vitest），
      没有 window / ResizeObserver，按被测 API 的面目最小桩一下 ───────────────── */

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets: unknown[] = []
  disconnected = false
  constructor(private cb: (entries: unknown[], obs: unknown) => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: unknown): void {
    this.targets.push(el)
  }
  unobserve(el: unknown): void {
    this.targets = this.targets.filter((t) => t !== el)
  }
  disconnect(): void {
    this.disconnected = true
    this.targets = []
  }
  emit(el: unknown, width: number): void {
    this.cb([{ target: el, contentRect: { width } }], this)
  }
}

interface FakeMql {
  matches: boolean
  media: string
  listeners: Array<(e: { matches: boolean }) => void>
}

let mqlMatches = false
let mqlListeners: FakeMql[] = []

function installWindow(): void {
  mqlMatches = false
  mqlListeners = []
  ;(globalThis as Record<string, unknown>).window = {
    matchMedia: (query: string): MediaQueryList => {
      const mql: FakeMql = { matches: mqlMatches, media: query, listeners: [] }
      mqlListeners.push(mql)
      return {
        get matches() {
          return mql.matches
        },
        media: query,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
          mql.listeners.push(cb),
        removeEventListener: () => undefined
      } as unknown as MediaQueryList
    }
  }
  ;(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver
}

function fakeEl(clientWidth: number): HTMLElement {
  return { clientWidth } as unknown as HTMLElement
}

/** 在一个 effectScope 里跑 composable，返回 scope 和它的返回值 */
function withScope<T>(fn: () => T): { scope: EffectScope; value: T } {
  const scope = effectScope()
  const value = scope.run(fn) as T
  return { scope, value }
}

/* ── useContainerWidth ─────────────────────────────────────────────────────── */

test('useContainerWidth：首帧立即读到容器宽度（少一帧「未测量」形态）', async () => {
  installWindow()
  const { scope, value } = withScope(() => useContainerWidth())
  value.target.value = fakeEl(320)
  await nextTick()
  assert.equal(value.width.value, 320)
  scope.stop()
})

test('useContainerWidth 滞回：宽度变化 <8px 不更新（防缩放窗口反复横跳）', async () => {
  installWindow()
  FakeResizeObserver.instances.length = 0
  const el = fakeEl(300)
  const { scope, value } = withScope(() => useContainerWidth())
  value.target.value = el
  await nextTick()
  const ro = FakeResizeObserver.instances.at(-1)!
  // ±7px：滞回阈值内，不更新
  ro.emit(el, 293)
  assert.equal(value.width.value, 300, '缩小 7px 不应触发更新')
  ro.emit(el, 307)
  assert.equal(value.width.value, 300, '放大 7px 不应触发更新')
  // 超过 8px：更新
  ro.emit(el, 309)
  assert.equal(value.width.value, 309)
  ro.emit(el, 250)
  assert.equal(value.width.value, 250)
  scope.stop()
})

test('useContainerWidth：换元素重新观察，离开作用域断开监听', async () => {
  installWindow()
  FakeResizeObserver.instances.length = 0
  const a = fakeEl(100)
  const b = fakeEl(500)
  const { scope, value } = withScope(() => useContainerWidth())
  value.target.value = a
  await nextTick()
  const roA = FakeResizeObserver.instances.at(-1)!
  assert.deepEqual(roA.targets, [a])
  value.target.value = b
  await nextTick()
  const roB = FakeResizeObserver.instances.at(-1)!
  assert.notEqual(roB, roA, '换元素应重建 observer')
  assert.equal(roA.disconnected, true, '旧 observer 应断开')
  assert.deepEqual(roB.targets, [b])
  assert.equal(value.width.value, 500)
  scope.stop()
  assert.equal(roB.disconnected, true, '作用域结束应断开')
})

/* ── useNarrow ─────────────────────────────────────────────────────────────── */

test('useNarrow：按断点建 media query 并跟随变化', async () => {
  installWindow()
  const { scope, value } = withScope(() => useNarrow())
  await nextTick()
  assert.equal(value.value, false, '初始不窄')
  assert.equal(mqlListeners.at(-1)?.media, '(max-width: 720px)', '缺省用全站兼容断点 720')
  // 媒体状态变化 → 窄屏判定跟着变
  mqlMatches = true
  mqlListeners.at(-1)?.listeners.forEach((cb) => cb({ matches: true }))
  assert.equal(value.value, true)
  mqlMatches = false
  mqlListeners.at(-1)?.listeners.forEach((cb) => cb({ matches: false }))
  assert.equal(value.value, false)
  scope.stop()
})

test('useNarrow：断点可传 Ref，换断点重建监听', async () => {
  installWindow()
  const bp = ref<number>(BREAKPOINTS.sm)
  const { scope, value } = withScope(() => useNarrow(bp))
  await nextTick()
  assert.equal(mqlListeners.at(-1)?.media, '(max-width: 600px)')
  bp.value = BREAKPOINTS.md
  await nextTick()
  assert.equal(mqlListeners.at(-1)?.media, '(max-width: 960px)')
  assert.equal(value.value, false)
  scope.stop()
})

test('断点令牌：kit 唯一一套（sm 600 / md 960 / narrow 720 兼容值）', () => {
  assert.deepEqual({ ...BREAKPOINTS }, { sm: 600, md: 960, narrow: 720 })
  assert.equal(narrowQuery(BREAKPOINTS.narrow), '(max-width: 720px)')
  assert.equal(narrowQuery(BREAKPOINTS.sm), '(max-width: 600px)')
})
