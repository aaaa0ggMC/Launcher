<script setup lang="ts">
/**
 * KitWidthStage —— 画廊的「宽度模拟器」：不改窗口大小就能看智能排版的退化过程。
 *
 * 三种用法叠加：预设按钮（1280 / 720 / 390）、滑块微调、右边缘拖拽手柄。
 * 手柄是 `role="separator"` + 键盘可操作（左右方向键 ±8px），纯图标按钮都有 aria-label。
 *
 * 被模拟的内容渲染在一个固定宽度的盒子里，盒子才是 KitSmartRow 量的「容器宽度」——
 * 所以拖动手柄时，盒内的智能行会实时重规划（一行 → 隐藏次要元素 → 换行）。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { KitCaption, KitSlider } from '@ui/kit'

const props = withDefaults(
  defineProps<{
    /** 初始宽度（px） */
    initial?: number
    /** 最小宽度 */
    min?: number
    /** 最大宽度 */
    max?: number
    /** 盒子高度（px）；内容更高时内部滚 */
    height?: number
    /** 盒子里的说明（渲染在内容上方） */
    caption?: string
  }>(),
  { initial: 720, min: 240, max: 1280, height: 0, caption: '' }
)

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const PRESETS = [1280, 720, 390]

const width = ref(Math.min(Math.max(props.initial, props.min), props.max))
const trackEl = ref<HTMLElement | null>(null)
const dragging = ref(false)

/** 轨道可用宽度：盒子再宽也不能超出轨道 */
const maxWidth = computed(() => {
  const track = trackEl.value?.clientWidth ?? props.max
  return Math.min(props.max, track)
})

function clampWidth(w: number): number {
  return Math.round(Math.min(Math.max(w, props.min), maxWidth.value))
}

function setWidth(w: number): void {
  width.value = clampWidth(w)
}

const activePreset = computed(() => PRESETS.find((p) => p === width.value) ?? null)

function applyPreset(p: number | null): void {
  if (p !== null) setWidth(p)
}

function onSliderInput(v: number | string): void {
  setWidth(Number(v))
}

/* ── 拖拽手柄 ─────────────────────────────────────────────────────────────── */

function onHandleDown(e: PointerEvent): void {
  const handle = e.currentTarget as HTMLElement | null
  if (!handle?.setPointerCapture) return
  dragging.value = true
  handle.setPointerCapture(e.pointerId)
}

function onHandleMove(e: PointerEvent): void {
  if (!dragging.value || !trackEl.value) return
  const rect = trackEl.value.getBoundingClientRect()
  setWidth(e.clientX - rect.left)
}

function onHandleUp(e: PointerEvent): void {
  dragging.value = false
  const handle = e.currentTarget as HTMLElement | null
  handle?.releasePointerCapture?.(e.pointerId)
}

function onHandleKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 40 : 8
  if (e.key === 'ArrowLeft') setWidth(width.value - step)
  else if (e.key === 'ArrowRight') setWidth(width.value + step)
  else if (e.key === 'Home') setWidth(props.min)
  else if (e.key === 'End') setWidth(props.max)
  else return
  e.preventDefault()
}

const handleLabel = computed(() => t('kit.gallery.dragWidth', '拖动改变宽度（左右方向键也可）'))
const boxStyle = computed(() => ({
  width: `${width.value}px`,
  ...(props.height ? { height: `${props.height}px` } : {})
}))
</script>

<template>
  <div class="kit-stage">
    <div class="kit-stage__bar">
      <v-btn-toggle
        :model-value="activePreset"
        density="compact"
        variant="outlined"
        divided
        @update:model-value="applyPreset"
      >
        <v-btn v-for="p in PRESETS" :key="p" :value="p" size="small">{{ p }}</v-btn>
      </v-btn-toggle>
      <KitSlider
        class="kit-stage__slider"
        :model-value="width"
        :min="min"
        :max="maxWidth"
        :step="8"
        :aria-label="t('kit.gallery.width', '容器宽度')"
        @update:model-value="onSliderInput"
      />
      <span class="kit-stage__num kit-num">{{ width }}px</span>
    </div>

    <div ref="trackEl" class="kit-stage__track">
      <div class="kit-stage__box" :style="boxStyle">
        <KitCaption v-if="caption" class="kit-stage__caption">{{ caption }}</KitCaption>
        <slot />
      </div>
      <div
        class="kit-stage__handle"
        :class="{ 'kit-stage__handle--drag': dragging }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="handleLabel"
        :title="handleLabel"
        @pointerdown="onHandleDown"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
        @keydown="onHandleKey"
      />
    </div>
  </div>
</template>

<style scoped>
.kit-stage {
  min-width: 0;
}

.kit-stage__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}

.kit-stage__slider {
  flex: 1 1 120px;
  min-width: 100px;
}

.kit-stage__num {
  min-width: 52px;
  text-align: right;
  font-size: 0.8125rem;
}

/* 轨道：盒子在这里面被限制宽度，超出的部分露出网格底（示意「可用宽度」） */
.kit-stage__track {
  position: relative;
  min-width: 0;
  padding: 12px;
  border-radius: 8px;
  background: repeating-linear-gradient(
    45deg,
    rgba(var(--v-theme-on-surface), 0.04) 0 8px,
    transparent 8px 16px
  );
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.16);
}

.kit-stage__box {
  max-width: 100%;
  min-width: 0;
  padding: 12px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  overflow: hidden;
}

.kit-stage__caption {
  padding-bottom: 8px;
}

.kit-stage__handle {
  position: absolute;
  top: 12px;
  bottom: 12px;
  width: 14px;
  margin-left: 12px;
  border-radius: 4px;
  cursor: col-resize;
  touch-action: none;
  background: rgba(var(--v-theme-primary), 0.18);
  border: 1px solid rgba(var(--v-theme-primary), 0.35);
}

.kit-stage__handle:hover,
.kit-stage__handle--drag {
  background: rgba(var(--v-theme-primary), 0.32);
}

.kit-stage__handle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}
</style>
