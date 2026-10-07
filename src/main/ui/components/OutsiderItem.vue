<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import {
  DOCK_PEEK,
  OUTSIDER_CTX,
  closeOutsider,
  dockSideFor,
  dockSlot,
  type OutsiderAnchor,
  type OutsiderContext,
  type OutsiderDock,
  type OutsiderEntry
} from '../outsider'

/**
 * 单个悬浮窗：定位（停靠角 + 偏移）、拖动（超过阈值才算拖，按钮照常点击）、位置记忆、
 * 窗口缩放时收回可见区域、不抢焦点。
 *
 * 贴边：拖出屏幕边（或指针贴着屏幕边）松手 → 收到那条边外面、只露 `DOCK_PEEK` 宽的一条；
 * 点露出的那条弹回来，也可以直接把它拖出来。同一条边上贴着几个时沿边错开，不叠在一起。
 */
const props = defineProps<{ entry: OutsiderEntry; data: Record<string, unknown> }>()

const POS_KEY = 'cockpit-outsider-pos'
const MARGIN = 8
const DRAG_THRESHOLD = 5

interface Pos {
  anchor: OutsiderAnchor
  x: number
  y: number
  /** 贴边收起中（x / y 里垂直于这条边的那个是弹回来后的位置） */
  dock?: OutsiderDock
}

const DOCKS: OutsiderDock[] = ['left', 'right', 'top', 'bottom']

/**
 * 网页版的页面缩放是根元素 CSS zoom：getBoundingClientRect / clientX / innerWidth 是缩放后的像素，
 * 而 left / top 写的是缩放前的 CSS px。下面的几何计算统一换算成 CSS px。
 */
function zoom(): number {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1
}
function rectOf(node: Element | null | undefined): DOMRect | undefined {
  if (!node) return undefined
  const r = node.getBoundingClientRect()
  const z = zoom()
  return z === 1 ? r : new DOMRect(r.left / z, r.top / z, r.width / z, r.height / z)
}
function viewW(): number {
  return window.innerWidth / zoom()
}
function viewH(): number {
  return window.innerHeight / zoom()
}

const attrs = computed(() => props.entry.attrs)
const canDrag = computed(
  () => attrs.value.draggable !== false && !attrs.value.pinned && !attrs.value.modal
)
const canDock = computed(() => canDrag.value && attrs.value.dockable !== false)

function loadSaved(): Pos | null {
  if (attrs.value.persist === false || !canDrag.value) return null
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, Pos>
    const p = all[props.entry.id]
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && p.anchor) {
      if (p.dock && (!canDock.value || !DOCKS.includes(p.dock))) delete p.dock
      return p
    }
  } catch {
    /* 损坏的记录当作没有 */
  }
  return null
}

function save(p: Pos): void {
  if (attrs.value.persist === false) return
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, Pos>
    all[props.entry.id] = p
    localStorage.setItem(POS_KEY, JSON.stringify(all))
  } catch {
    /* 存不了就只在本次会话有效 */
  }
}

const pos = ref<Pos>(
  loadSaved() ?? {
    anchor: attrs.value.anchor ?? 'bottom-right',
    x: attrs.value.offset?.x ?? 16,
    y: attrs.value.offset?.y ?? 16
  }
)
/** 拖动中的绝对位置（left / top） */
const dragAt = ref<{ left: number; top: number } | null>(null)
/** 拖动中：现在松手会贴到哪条边（给个预览） */
const willDock = ref<OutsiderDock | null>(null)
const el = ref<HTMLElement | null>(null)

const dock = computed(() => (dragAt.value ? undefined : pos.value.dock))

const style = computed(() => {
  if (attrs.value.modal) return {}
  if (dragAt.value) return { left: `${dragAt.value.left}px`, top: `${dragAt.value.top}px` }
  const p = pos.value
  const s: Record<string, string> = { '--outsider-peek': `${DOCK_PEEK}px` }
  const v = p.anchor.startsWith('top') ? 'top' : 'bottom'
  const h = p.anchor.endsWith('left') ? 'left' : 'right'
  // 贴边：贴着那条边（0），由 CSS transform 推到屏幕外只露一条；沿边方向照常用偏移
  if (p.dock === 'left' || p.dock === 'right') {
    s[p.dock] = '0px'
    s[v] = `${p.y}px`
  } else if (p.dock === 'top' || p.dock === 'bottom') {
    s[p.dock] = '0px'
    s[h] = `${p.x}px`
  } else {
    s[v] = `${p.y}px`
    s[h] = `${p.x}px`
  }
  return s
})

/** 把偏移夹到可见区域内（窗口变小 / 悬浮窗变大时）；贴边的只夹沿边方向 */
function clamp(): void {
  const box = rectOf(el.value)
  if (!box || attrs.value.modal) return
  const maxX = Math.max(MARGIN, viewW() - box.width - MARGIN)
  const maxY = Math.max(MARGIN, viewH() - box.height - MARGIN)
  const p = pos.value
  const x = Math.min(Math.max(p.x, MARGIN), maxX)
  const y = Math.min(Math.max(p.y, MARGIN), maxY)
  if (x !== p.x || y !== p.y) pos.value = { ...p, x, y }
}

/** 位置变了（松手吸附 / 贴边 / 弹回）时从旧位置滑过去，而不是瞬移 */
async function glideFrom(from: DOMRect | undefined): Promise<void> {
  await nextTick()
  const node = el.value
  if (!from || !node || typeof node.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const to = rectOf(node)!
  const dx = from.left - to.left
  const dy = from.top - to.top
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
    duration: 220,
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    composite: 'add'
  })
}

/** 同一条边上别的贴边悬浮窗（沿边方向的区间），用来错开 */
function dockedNeighbours(side: OutsiderDock): { start: number; size: number }[] {
  const vertical = side === 'left' || side === 'right'
  const out: { start: number; size: number }[] = []
  for (const n of document.querySelectorAll<HTMLElement>(`[data-outsider-dock="${side}"]`)) {
    if (n === el.value) continue
    const r = rectOf(n)!
    out.push(vertical ? { start: r.top, size: r.height } : { start: r.left, size: r.width })
  }
  return out
}

/** 贴到 `side`：`at` 是松手时的 left / top */
function dockTo(side: OutsiderDock, at: { left: number; top: number }, box: DOMRect): Pos {
  const W = viewW()
  const H = viewH()
  if (side === 'left' || side === 'right') {
    const top = dockSlot(at.top, box.height, dockedNeighbours(side), MARGIN, H - MARGIN)
    const upper = top + box.height / 2 < H / 2
    return {
      anchor: `${upper ? 'top' : 'bottom'}-${side}` as OutsiderAnchor,
      x: MARGIN,
      y: Math.round(upper ? top : H - top - box.height),
      dock: side
    }
  }
  const left = dockSlot(at.left, box.width, dockedNeighbours(side), MARGIN, W - MARGIN)
  const lefty = left + box.width / 2 < W / 2
  return {
    anchor: `${side}-${lefty ? 'left' : 'right'}` as OutsiderAnchor,
    x: Math.round(lefty ? left : W - left - box.width),
    y: MARGIN,
    dock: side
  }
}

/** 点露出的那条：弹回屏幕里（贴着那条边、留 MARGIN） */
function undock(): void {
  const p = pos.value
  if (!p.dock) return
  const from = rectOf(el.value)
  const next: Pos = { anchor: p.anchor, x: p.x, y: p.y }
  if (p.dock === 'left' || p.dock === 'right') next.x = MARGIN
  else next.y = MARGIN
  pos.value = next
  save(next)
  void glideFrom(from).then(clamp)
}

// -- 拖动 ----------------------------------------------------------------------

let press: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null

/** 这些元素上按下不开始拖动（文本输入 / 显式声明）；按钮可以拖，拖动后吞掉那次 click */
const NO_DRAG = 'input, textarea, select, [contenteditable="true"], [data-outsider-nodrag]'

function onPointerDown(e: PointerEvent): void {
  if (!canDrag.value || e.button !== 0) return
  if ((e.target as Element).closest(NO_DRAG)) return
  const box = rectOf(el.value)!
  press = {
    id: e.pointerId,
    sx: e.clientX / zoom(),
    sy: e.clientY / zoom(),
    ox: box.left,
    oy: box.top
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  const dx = e.clientX / zoom() - press.sx
  const dy = e.clientY / zoom() - press.sy
  if (!dragAt.value) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    el.value!.setPointerCapture(e.pointerId)
  }
  const box = rectOf(el.value)!
  const W = viewW()
  const H = viewH()
  // 能贴边的可以拖出屏幕（至少留一条在里面），否则夹在可见区域内
  const minL = canDock.value ? DOCK_PEEK - box.width : MARGIN
  const maxL = canDock.value ? W - DOCK_PEEK : W - box.width - MARGIN
  const minT = canDock.value ? DOCK_PEEK - box.height : MARGIN
  const maxT = canDock.value ? H - DOCK_PEEK : H - box.height - MARGIN
  const at = {
    left: Math.min(Math.max(press.ox + dx, minL), maxL),
    top: Math.min(Math.max(press.oy + dy, minT), maxT)
  }
  dragAt.value = at
  willDock.value = canDock.value
    ? dockSideFor(
        { ...at, width: box.width, height: box.height },
        { x: e.clientX / zoom(), y: e.clientY / zoom() },
        { width: W, height: H }
      )
    : null
}

function onPointerUp(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  press = null
  const at = dragAt.value
  const side = willDock.value
  willDock.value = null
  if (!at) return
  swallowNextClick()
  const box = rectOf(el.value)!
  let next: Pos
  if (side) next = dockTo(side, at, box)
  else {
    // 落点换算成离最近的角的偏移：窗口缩放后仍贴着同一个角；拖出去一截的收回来
    const W = viewW()
    const H = viewH()
    const l = Math.min(Math.max(at.left, MARGIN), Math.max(MARGIN, W - box.width - MARGIN))
    const t = Math.min(Math.max(at.top, MARGIN), Math.max(MARGIN, H - box.height - MARGIN))
    const left = l + box.width / 2 < W / 2
    const top = t + box.height / 2 < H / 2
    next = {
      anchor: `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}` as OutsiderAnchor,
      x: Math.round(left ? l : W - l - box.width),
      y: Math.round(top ? t : H - t - box.height)
    }
  }
  dragAt.value = null
  pos.value = next
  save(next)
  void glideFrom(box)
}

/** 拖动结束时浏览器还会补发一次 click（从按钮上开始拖时会误触按钮）：吞掉它 */
function swallowNextClick(): void {
  const node = el.value
  if (!node) return
  const stop = (ev: Event): void => {
    ev.stopPropagation()
    ev.preventDefault()
  }
  node.addEventListener('click', stop, { capture: true, once: true })
  setTimeout(() => node.removeEventListener('click', stop, { capture: true }), 0)
}

/**
 * 不抢焦点：点悬浮窗的按钮不把焦点从页面挪走——否则 AI 之后发的回车 / 空格
 * 会按在悬浮窗的按钮上（如「继续」）。输入框例外。
 */
function onMouseDown(e: MouseEvent): void {
  const t = e.target as Element
  // 输入框、以及声明了不可拖动的区域（可选中文字的详情等）照常
  if (t.closest('input, textarea, select, [contenteditable="true"], [data-outsider-nodrag]')) return
  e.preventDefault()
}

let ro: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('resize', clamp)
  if (el.value) {
    ro = new ResizeObserver(() => clamp())
    ro.observe(el.value)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', clamp)
  ro?.disconnect()
})

const ctx: OutsiderContext = { id: props.entry.id, close: () => closeOutsider(props.entry.id) }
provide(OUTSIDER_CTX, ctx)
</script>

<template>
  <div v-if="entry.attrs.modal" class="outsider-scrim">
    <div ref="el" class="outsider outsider--modal" @mousedown="onMouseDown">
      <component :is="entry.component" v-bind="data" />
    </div>
  </div>
  <div
    v-else
    ref="el"
    class="outsider"
    :class="{
      'outsider--drag': canDrag,
      'outsider--dragging': !!dragAt,
      'outsider--will-dock': !!willDock,
      [`outsider--dock-${dock}`]: !!dock
    }"
    :style="style"
    :data-outsider-id="entry.id"
    :data-outsider-dock="dock"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @mousedown="onMouseDown"
  >
    <component :is="entry.component" v-bind="data" />
    <!-- 贴边时盖住整个悬浮窗：露出来的那条点了弹回来，不会误按到里面的按钮 -->
    <button
      v-if="dock"
      type="button"
      class="outsider-dock-handle"
      :class="`is-${dock}`"
      :title="entry.label"
      :aria-label="entry.label"
      @click="undock"
    >
      <span class="outsider-dock-grip" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.outsider {
  position: absolute;
  pointer-events: auto;
  max-width: calc(100% - 16px);
}
.outsider--drag {
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.outsider--dragging {
  cursor: grabbing;
}
.outsider--will-dock {
  opacity: 0.65;
}
/* 贴边：推到屏幕外，只露 --outsider-peek 宽的一条 */
.outsider--dock-left {
  transform: translateX(calc(-100% + var(--outsider-peek)));
}
.outsider--dock-right {
  transform: translateX(calc(100% - var(--outsider-peek)));
}
.outsider--dock-top {
  transform: translateY(calc(-100% + var(--outsider-peek)));
}
.outsider--dock-bottom {
  transform: translateY(calc(100% - var(--outsider-peek)));
}
.outsider-dock-handle {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  touch-action: none;
}
/* 把手只画在露出来的那一条上 */
.outsider-dock-handle::before {
  content: '';
  position: absolute;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface), 0.72);
  backdrop-filter: blur(6px);
  box-shadow: 0 0 0 1px rgba(var(--v-theme-on-surface), 0.12);
}
.outsider-dock-handle.is-left::before {
  inset: 0 0 0 auto;
  width: var(--outsider-peek);
}
.outsider-dock-handle.is-right::before {
  inset: 0 auto 0 0;
  width: var(--outsider-peek);
}
.outsider-dock-handle.is-top::before {
  inset: auto 0 0 0;
  height: var(--outsider-peek);
}
.outsider-dock-handle.is-bottom::before {
  inset: 0 0 auto 0;
  height: var(--outsider-peek);
}
.outsider-dock-grip {
  position: absolute;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.45);
}
.is-left > .outsider-dock-grip,
.is-right > .outsider-dock-grip {
  width: 4px;
  height: min(32px, 60%);
}
.is-left > .outsider-dock-grip {
  right: calc(var(--outsider-peek) / 2 - 2px);
}
.is-right > .outsider-dock-grip {
  left: calc(var(--outsider-peek) / 2 - 2px);
}
.is-top > .outsider-dock-grip,
.is-bottom > .outsider-dock-grip {
  height: 4px;
  width: min(32px, 60%);
}
.is-top > .outsider-dock-grip {
  bottom: calc(var(--outsider-peek) / 2 - 2px);
}
.is-bottom > .outsider-dock-grip {
  top: calc(var(--outsider-peek) / 2 - 2px);
}
.outsider-dock-handle:hover::before,
.outsider-dock-handle:focus-visible::before {
  background: rgba(var(--v-theme-surface), 0.92);
}
.outsider-scrim {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}
.outsider--modal {
  position: relative;
  max-height: 100%;
  overflow: auto;
}
</style>
