<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'

/**
 * Shared 10-band EQ curve renderer.
 * - `interactive=false`: small readonly preview (list item thumbnail).
 * - `interactive=true`:  drag the control points to reshape the curve; emits
 *   `update` with the new gains array.
 * X axis is logarithmic (31 → 16k), Y axis maps EQ_GAIN_MIN..MAX.
 */
const props = withDefaults(
  defineProps<{
    gains: number[]
    interactive?: boolean
    /** Canvas height in CSS px (width is fluid). */
    height?: number
    /** Max ±dB gain range mapped to the Y axis (default 20). */
    range?: number
  }>(),
  { interactive: false, height: 32, range: 20 }
)

const emit = defineEmits<{ update: [gains: number[]] }>()

const EQ_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const PAD_Y = 4
/** Horizontal padding — the interactive editor draws band labels, so it needs
 *  room at both ends (the leftmost "31" centers inside the pad); thumbnails
 *  keep a tighter margin. */
const PAD_X = 18

const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLDivElement | null>(null)
let cssW = 0
let cssH = 0
let raf = 0
let ro: ResizeObserver | null = null

// -- geometry ----------------------------------------------------------------
function xFor(i: number, w: number): number {
  // Log10 span: 31 ≈ 1.49, 16k ≈ 4.2.
  const logMin = Math.log10(EQ_FREQS[0])
  const logMax = Math.log10(EQ_FREQS[EQ_FREQS.length - 1])
  const t = (Math.log10(EQ_FREQS[i]) - logMin) / (logMax - logMin)
  const pad = props.interactive ? PAD_X : 4
  return pad + t * (w - pad * 2)
}
function yFor(g: number, h: number): number {
  // Interactive editor reserves bottom space for the frequency label row.
  const bottom = props.interactive ? PAD_Y + 14 : PAD_Y
  const t = (g + props.range) / (props.range * 2)
  return h - bottom - t * (h - PAD_Y - bottom)
}

/** Sample the smoothed curve into N points (Catmull-Rom through controls). */
function curvePoints(w: number, h: number, gains: number[]): { x: number; y: number }[] {
  const ctrl = gains.map((g, i) => ({ x: xFor(i, w), y: yFor(g, h) }))
  const out: { x: number; y: number }[] = []
  const steps = 48
  for (let s = 0; s < steps; s++) {
    const t = (s / (steps - 1)) * (ctrl.length - 1)
    const i = Math.floor(t)
    const f = t - i
    const p0 = ctrl[Math.max(0, i - 1)]
    const p1 = ctrl[i]
    const p2 = ctrl[Math.min(ctrl.length - 1, i + 1)]
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)]
    // Catmull-Rom with 0.5 tension.
    const x =
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * f +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f * f +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f * f * f)
    const y =
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * f +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f * f +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f * f * f)
    out.push({ x, y })
  }
  return out
}

// -- drawing -----------------------------------------------------------------
function themeVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v.trim() || fallback
}
function rgba(v: string, a: number): string {
  return `rgba(${v}, ${a})`
}

function draw(): void {
  if (!canvas.value) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(10, cssW)
  const h = Math.max(10, cssH)
  if (canvas.value.width !== Math.round(w * dpr) || canvas.value.height !== Math.round(h * dpr)) {
    canvas.value.width = Math.round(w * dpr)
    canvas.value.height = Math.round(h * dpr)
  }
  const c = canvas.value.getContext('2d')
  if (!c) return
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)

  const primary = themeVar('--v-theme-primary', '79,124,255')
  const onSurface = themeVar('--v-theme-on-surface-variant', '180,180,180')
  const lineW = Math.max(1, Math.min(2, cssH / 24))

  // 0dB midline.
  c.strokeStyle = rgba(onSurface, 0.18)
  c.lineWidth = 1
  const y0 = yFor(0, h)
  const pad = props.interactive ? PAD_X : 4
  c.beginPath()
  c.moveTo(pad, y0)
  c.lineTo(w - pad, y0)
  c.stroke()

  // Frequency ticks — all 10, only on the interactive editor (thumbnails stay clean).
  if (props.interactive) {
    c.fillStyle = rgba(onSurface, 0.55)
    c.font = `${Math.max(8, cssH * 0.11)}px sans-serif`
    c.textAlign = 'center'
    EQ_FREQS.forEach((f, i) => {
      const x = xFor(i, w)
      const label = f >= 1000 ? `${f / 1000}k` : String(f)
      c.fillText(label, x, h - 4)
    })
  }

  // Smoothed curve + control points.
  const pts = curvePoints(w, h, props.gains)
  c.strokeStyle = rgba(primary, 0.9)
  c.lineWidth = lineW
  c.lineJoin = 'round'
  c.beginPath()
  pts.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)))
  c.stroke()

  if (props.interactive || cssW > 80) {
    props.gains.forEach((g, i) => {
      const hovered = i === hoverIdx.value
      c.fillStyle = hovered ? '#ffffff' : rgba(primary, 1)
      c.beginPath()
      c.arc(xFor(i, w), yFor(g, h), hovered ? lineW * 2.6 : lineW * 1.6, 0, Math.PI * 2)
      c.fill()
      if (hovered) {
        c.strokeStyle = rgba(primary, 1)
        c.lineWidth = 1
        c.stroke()
      }
    })
  }
}

// -- resize ------------------------------------------------------------------
function resize(): void {
  const rect = wrap.value?.getBoundingClientRect()
  if (!rect) return
  cssW = rect.width
  // Prefer the wrap's real height (responsive) — fall back to the prop.
  cssH = rect.height > 0 ? rect.height : props.height
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

// -- interaction -------------------------------------------------------------
let dragIdx = -1
const hoverIdx = ref(-1)
const hoverPos = ref({ x: 0, y: 0, visible: false })
function clientPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}
function nearestBand(x: number): number {
  let best = 0
  let bestD = Infinity
  EQ_FREQS.forEach((_, i) => {
    const d = Math.abs(xFor(i, cssW) - x)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
function gainFromY(y: number): number {
  const bottom = props.interactive ? PAD_Y + 14 : PAD_Y
  const t = 1 - (y - PAD_Y) / (cssH - PAD_Y - bottom)
  const g = -props.range + t * (props.range * 2)
  return Math.max(-props.range, Math.min(props.range, Math.round(g * 2) / 2))
}
function onPointerDown(e: PointerEvent): void {
  if (!props.interactive) return
  const p = clientPoint(e)
  dragIdx = nearestBand(p.x)
  hoverIdx.value = dragIdx
  canvas.value?.setPointerCapture(e.pointerId)
  onPointerMove(e)
}
function onPointerMove(e: PointerEvent): void {
  const p = clientPoint(e)
  if (dragIdx < 0) {
    // Hover (no drag): highlight the nearest band + show its current value.
    const i = nearestBand(p.x)
    hoverIdx.value = i
    hoverPos.value = { x: p.x, y: p.y, visible: true }
    return
  }
  const next = [...props.gains]
  next[dragIdx] = gainFromY(p.y)
  hoverIdx.value = dragIdx
  hoverPos.value = { x: p.x, y: p.y, visible: true }
  emit('update', next)
}
function onPointerLeave(): void {
  if (dragIdx >= 0) return
  hoverIdx.value = -1
  hoverPos.value = { ...hoverPos.value, visible: false }
}
function onPointerUp(e: PointerEvent): void {
  if (dragIdx < 0) return
  dragIdx = -1
  try {
    canvas.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* noop */
  }
}

const hoverLabel = computed(() => {
  if (hoverIdx.value < 0) return ''
  const f = EQ_FREQS[hoverIdx.value]
  const label = f >= 1000 ? `${f / 1000}k` : String(f)
  const g = props.gains[hoverIdx.value] ?? 0
  return `${label} Hz · ${g > 0 ? `+${g}` : g} dB`
})
/** Flip the bubble below the point when it would clip above the canvas top. */
const hoverTipPos = computed(() => {
  const p = hoverPos.value
  return p.y < 28
    ? { left: p.x, top: p.y + 10, below: true }
    : { left: p.x, top: p.y - 24, below: false }
})

watch(() => props.gains, resize, { deep: true })
watch(() => props.height, resize)
watch(hoverIdx, () => {
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
})
onMounted(() => {
  resize()
  // The dialog animates in — the initial measure (onMounted) may run while the
  // container is still 0-width/transformed. Observe so we redraw at real size.
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    ro = new ResizeObserver(resize)
    ro.observe(wrap.value)
  }
  // Fallback: the dialog transition finishes well under this.
  setTimeout(resize, 350)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (raf) cancelAnimationFrame(raf)
  raf = 0
})

const style = computed(() => ({ height: `${props.height}px`, width: '100%' }))
</script>

<template>
  <div ref="wrap" class="eq-curve-wrap" :style="style">
    <canvas
      ref="canvas"
      class="eq-curve-canvas"
      :class="{ 'is-draggable': interactive }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
    />
    <div
      v-if="hoverPos.visible && hoverLabel"
      class="eq-hover-tip"
      :class="{ 'eq-hover-tip--below': hoverTipPos.below }"
      :style="{
        left: `${hoverTipPos.left}px`,
        top: `${hoverTipPos.top}px`
      }"
    >
      {{ hoverLabel }}
    </div>
  </div>
</template>

<style scoped>
.eq-curve-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
}
.eq-curve-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.eq-hover-tip {
  position: absolute;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  z-index: 2;
}
.eq-curve-canvas.is-draggable {
  cursor: crosshair;
  touch-action: none;
}
</style>
