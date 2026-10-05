<script setup lang="ts">
/**
 * 全屏看图对话框（图类插件的公共组件）：宽屏大对话框、窄屏全屏。
 * 缩放 = 滚轮 / 双指捏合（pointer events，不依赖 hover）；拖动 = 平移。
 * 高度用 var(--app-vh)（手机上 100vh 比可见区域高，见 viewport.ts）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    src: string
    alt?: string
  }>(),
  { alt: '' }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

// ---- 缩放 / 平移 ----
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

function clampScale(s: number): number {
  return Math.min(8, Math.max(0.2, s))
}

function zoomBy(factor: number): void {
  scale.value = clampScale(scale.value * factor)
}

function resetView(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/** 活动指针（pointerdown 到 pointerup 之间）；两个 = 捏合 */
const pointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0

function twoPointerDist(): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
}

function onPointerDown(e: PointerEvent): void {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  // 捕获指针：拖到舞台外面也继续收到 move（松手前不会丢）
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
  if (pointers.size === 2) pinchDist = twoPointerDist()
}

function onPointerMove(e: PointerEvent): void {
  const prev = pointers.get(e.pointerId)
  if (!prev) return
  const dx = e.clientX - prev.x
  const dy = e.clientY - prev.y
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 1) {
    tx.value += dx
    ty.value += dy
  } else if (pointers.size === 2) {
    const d = twoPointerDist()
    if (pinchDist > 0 && d > 0) scale.value = clampScale(scale.value * (d / pinchDist))
    pinchDist = d
  }
}

function onPointerUp(e: PointerEvent): void {
  const target = e.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId)
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinchDist = 0
}

/** wheel 手动挂 passive:false，preventDefault 才生效（不会缩成整页缩放） */
const stage = ref<HTMLElement>()
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
}

onMounted(() => {
  stage.value?.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
  stage.value?.removeEventListener('wheel', onWheel)
  pointers.clear()
})

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`
}))

watch(open, (v) => {
  if (v) resetView()
})
watch(
  () => props.src,
  () => resetView()
)

// ---- 窄屏（手机）全屏；与全站断点一致，用 matchMedia 而非 useDisplay ----
const narrow = ref(false)
let narrowMql: MediaQueryList | null = null
function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}
onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  narrow.value = narrowMql.matches
  narrowMql.addEventListener('change', onNarrowChange)
})
onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', onNarrowChange)
  narrowMql = null
})
</script>

<template>
  <v-dialog
    v-model="open"
    :fullscreen="narrow"
    max-width="1200"
    content-class="diagram-zoom"
    scrim="rgba(0, 0, 0, 0.9)"
  >
    <v-card class="diagram-zoom-card" flat>
      <div class="diagram-zoom-bar">
        <span class="text-caption text-medium-emphasis">{{ Math.round(scale * 100) }}%</span>
        <v-spacer />
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.diagram.zoom_in', '放大')"
          :aria-label="t('yaya.diagram.zoom_in', '放大')"
          @click="zoomBy(1.2)"
        >
          <v-icon icon="mdi-magnify-plus-outline" size="20" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.diagram.zoom_out', '缩小')"
          :aria-label="t('yaya.diagram.zoom_out', '缩小')"
          @click="zoomBy(1 / 1.2)"
        >
          <v-icon icon="mdi-magnify-minus-outline" size="20" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.diagram.zoom_reset', '重置视图')"
          :aria-label="t('yaya.diagram.zoom_reset', '重置视图')"
          @click="resetView"
        >
          <v-icon icon="mdi-refresh" size="20" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.diagram.zoom_close', '关闭')"
          :aria-label="t('yaya.diagram.zoom_close', '关闭')"
          @click="open = false"
        >
          <v-icon icon="mdi-close" size="20" />
        </v-btn>
      </div>

      <div
        ref="stage"
        class="diagram-zoom-stage"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="resetView"
      >
        <img
          v-if="src"
          :src="src"
          :alt="alt"
          class="diagram-zoom-img"
          :style="imgStyle"
          draggable="false"
        />
      </div>

      <div class="diagram-zoom-hint text-caption text-medium-emphasis">
        {{ t('yaya.diagram.zoom_hint', '滚轮 / 双指缩放，拖动平移') }}
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.diagram-zoom-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}
.diagram-zoom-bar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 8px 8px 8px 14px;
}
.diagram-zoom-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  /* 触屏：手势自己处理，别让浏览器抢走做原生平移 / 捏合 */
  touch-action: none;
  cursor: grab;
}
.diagram-zoom-stage:active {
  cursor: grabbing;
}
.diagram-zoom-img {
  max-width: 100%;
  max-height: 100%;
  will-change: transform;
  user-select: none;
}
.diagram-zoom-hint {
  flex: 0 0 auto;
  padding: 6px 14px 12px;
  text-align: center;
}
</style>

<!-- v-dialog 内容 teleport 到 <body>，高度必须在 scoped 之外写；
      尺寸用 --app-vh（手机上 100vh 比可见区域高，对话框会顶出屏幕） -->
<style>
.v-dialog > .diagram-zoom {
  height: calc(var(--app-vh) - 32px);
  max-height: calc(var(--app-vh) - 32px);
  display: flex;
}
</style>
