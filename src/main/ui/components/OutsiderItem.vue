<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import {
  OUTSIDER_CTX,
  closeOutsider,
  type OutsiderAnchor,
  type OutsiderContext,
  type OutsiderEntry
} from '../outsider'

/**
 * 单个悬浮窗：定位（停靠角 + 偏移）、拖动（超过阈值才算拖，按钮照常点击）、位置记忆、
 * 窗口缩放时收回可见区域、不抢焦点。
 */
const props = defineProps<{ entry: OutsiderEntry; data: Record<string, unknown> }>()

const POS_KEY = 'cockpit-outsider-pos'
const MARGIN = 8
const DRAG_THRESHOLD = 5

interface Pos {
  anchor: OutsiderAnchor
  x: number
  y: number
}

const attrs = computed(() => props.entry.attrs)
const canDrag = computed(
  () => attrs.value.draggable !== false && !attrs.value.pinned && !attrs.value.modal
)

function loadSaved(): Pos | null {
  if (attrs.value.persist === false || !canDrag.value) return null
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, Pos>
    const p = all[props.entry.id]
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && p.anchor) return p
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
const el = ref<HTMLElement | null>(null)

const style = computed(() => {
  if (attrs.value.modal) return {}
  if (dragAt.value) return { left: `${dragAt.value.left}px`, top: `${dragAt.value.top}px` }
  const p = pos.value
  const s: Record<string, string> = {}
  s[p.anchor.startsWith('top') ? 'top' : 'bottom'] = `${p.y}px`
  s[p.anchor.endsWith('left') ? 'left' : 'right'] = `${p.x}px`
  return s
})

/** 把偏移夹到可见区域内（窗口变小 / 悬浮窗变大时） */
function clamp(): void {
  const box = el.value?.getBoundingClientRect()
  if (!box || attrs.value.modal) return
  const maxX = Math.max(MARGIN, window.innerWidth - box.width - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - box.height - MARGIN)
  const p = pos.value
  const x = Math.min(Math.max(p.x, MARGIN), maxX)
  const y = Math.min(Math.max(p.y, MARGIN), maxY)
  if (x !== p.x || y !== p.y) pos.value = { ...p, x, y }
}

// -- 拖动 ----------------------------------------------------------------------

let press: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null

/** 这些元素上按下不开始拖动（文本输入 / 显式声明）；按钮可以拖，拖动后吞掉那次 click */
const NO_DRAG = 'input, textarea, select, [contenteditable="true"], [data-outsider-nodrag]'

function onPointerDown(e: PointerEvent): void {
  if (!canDrag.value || e.button !== 0) return
  if ((e.target as Element).closest(NO_DRAG)) return
  const box = el.value!.getBoundingClientRect()
  press = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: box.left, oy: box.top }
}

function onPointerMove(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  const dx = e.clientX - press.sx
  const dy = e.clientY - press.sy
  if (!dragAt.value) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    el.value!.setPointerCapture(e.pointerId)
  }
  const box = el.value!.getBoundingClientRect()
  dragAt.value = {
    left: Math.min(Math.max(press.ox + dx, MARGIN), window.innerWidth - box.width - MARGIN),
    top: Math.min(Math.max(press.oy + dy, MARGIN), window.innerHeight - box.height - MARGIN)
  }
}

function onPointerUp(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  press = null
  const at = dragAt.value
  if (!at) return
  dragAt.value = null
  swallowNextClick()
  // 落点换算成离最近的角的偏移：窗口缩放后仍贴着同一个角
  const box = el.value!.getBoundingClientRect()
  const cx = at.left + box.width / 2
  const cy = at.top + box.height / 2
  const left = cx < window.innerWidth / 2
  const top = cy < window.innerHeight / 2
  const next: Pos = {
    anchor: `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}` as OutsiderAnchor,
    x: Math.round(left ? at.left : window.innerWidth - at.left - box.width),
    y: Math.round(top ? at.top : window.innerHeight - at.top - box.height)
  }
  pos.value = next
  save(next)
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
    :class="{ 'outsider--drag': canDrag, 'outsider--dragging': !!dragAt }"
    :style="style"
    :data-outsider-id="entry.id"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @mousedown="onMouseDown"
  >
    <component :is="entry.component" v-bind="data" />
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
