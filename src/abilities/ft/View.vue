<script setup lang="ts">
defineOptions({ name: 'cockpit-ft' })

import {
  inject,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  provide,
  reactive,
  ref,
  watch
} from 'vue'
import type { Ref } from 'vue'
import { FtEngine } from './engine'
import { FtScene } from './scene'
import type { FtUiState, FtVector } from './types'
import { translate } from '@ui/i18n'
import InfoPanel from './panels/InfoPanel.vue'
import ControlsPanel from './panels/ControlsPanel.vue'
import VectorsPanel from './panels/VectorsPanel.vue'
import SamplesPanel from './panels/SamplesPanel.vue'
import type { FtPresetMeta } from './panels/SamplesPanel.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// ---------------------------------------------------------------------------
// Reactive UI state — panels mutate this; watchers push it into engine/scene.
// ---------------------------------------------------------------------------
const state = reactive<FtUiState>({
  running: true,
  mode: '2d',
  follow: false,
  neon: false,
  show: { coords: true, circles: false, vectors: true, track: true, final: true },
  runSpeed: 1,
  verticesLimit: 4096,
  fps: 0,
  maxFps: 0,
  time: 0,
  vectorCount: 0,
  trackCount: 0,
  tip: { x: 0, y: 0, z: 0 },
  zoom: 1,
  currentPreset: '',
  vectors: []
})

const collapsed = ref(false)
const openSections = ref<string[]>(['info', 'controls'])
const presets = ref<FtPresetMeta[]>([])
const presetLoading = ref(false)

provide('ft:state', state)
provide('ft:presets', presets)
provide('ft:presetLoading', presetLoading)
provide('ft:loadPreset', loadPreset)
provide('ft:applyVectors', applyVectors)

const hostRef = ref<HTMLElement | null>(null)
let engine: FtEngine | null = null
let scene: FtScene | null = null
let raf = 0
let last = 0
let fpsCount = 0
let fpsStart = 0
let statsLast = 0
let dragButton = -1
let lastX = 0
let lastY = 0
let currentChain: ReturnType<FtEngine['computeChain']> | null = null
let ro: ResizeObserver | null = null

// ---------------------------------------------------------------------------
// Preset loading (CLI-first: goes through the main-process command registry)
// ---------------------------------------------------------------------------
/**
 * Replace the vector set and redraw from scratch: reset sim time, clear the
 * track, recompute the chain and reframe the camera. Shared by preset loading
 * and the vectors editor (update / load-file).
 */
function applyVectors(
  vectors: FtVectorLike[],
  opts?: { runSpeed?: number; verticesLimit?: number }
): void {
  if (!engine || !scene) return
  const limit = opts?.verticesLimit ?? state.verticesLimit
  engine.setVectors(vectors)
  if (opts?.runSpeed !== undefined) engine.runSpeed = opts.runSpeed
  engine.verticesLimit = limit
  engine.running = state.running
  scene.setVectors(vectors, limit)

  state.vectors = vectors as FtVector[]
  state.vectorCount = vectors.length
  state.verticesLimit = limit
  if (opts?.runSpeed !== undefined) state.runSpeed = opts.runSpeed
  state.currentPreset = ''
  state.time = 0
  state.trackCount = 0
  state.tip = { x: 0, y: 0, z: 0 }

  engine.clearTrack()
  currentChain = engine.computeChain()
  scene.update(currentChain)
  scene.updateTrack(engine.track, 0)
  scene.resetView()
}

async function loadPreset(name: string): Promise<void> {
  if (!engine || !scene) return
  presetLoading.value = true
  try {
    const res = (await window.cockpit.command('ft.load', { name })) as {
      vectors?: FtVectorLike[]
      runSpeed?: number
      verticesLimit?: number
    } | null
    if (!res || !Array.isArray(res.vectors)) return
    applyVectors(res.vectors, { runSpeed: res.runSpeed, verticesLimit: res.verticesLimit })
    state.currentPreset = name
  } finally {
    presetLoading.value = false
  }
}

interface FtVectorLike {
  x: number
  y: number
  z?: number
  orot?: number
  secperRound: number
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function tick(now: number): void {
  if (!engine || !scene) {
    raf = requestAnimationFrame(tick)
    return
  }
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  const chain = engine.step(dt)
  if (chain) {
    currentChain = chain
    scene.update(chain)
    scene.updateTrack(engine.track, engine.time)
  }
  scene.render()

  fpsCount++
  if (now - fpsStart >= 1000) {
    state.fps = Math.round((fpsCount * 1000) / (now - fpsStart))
    if (state.fps > state.maxFps) state.maxFps = state.fps
    fpsCount = 0
    fpsStart = now
  }
  if (now - statsLast >= 250) {
    statsLast = now
    state.time = engine.time
    state.trackCount = engine.track.length
    if (currentChain) state.tip = { ...currentChain.tip }
    state.zoom = scene.getZoom()
  }
  raf = requestAnimationFrame(tick)
}

function startLoop(): void {
  if (raf) return
  last = performance.now()
  fpsStart = last
  statsLast = last
  raf = requestAnimationFrame(tick)
}

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

// ---------------------------------------------------------------------------
// Actions (also keyboard-triggered)
// ---------------------------------------------------------------------------
function repaint(): void {
  if (!engine || !scene) return
  engine.time = 0
  engine.clearTrack()
  state.time = 0
  state.trackCount = 0
  currentChain = engine.computeChain()
  scene.update(currentChain)
  scene.updateTrack(engine.track, 0)
}

function resetView(): void {
  scene?.resetView()
}

function toggleMode(): void {
  state.mode = state.mode === '3d' ? '2d' : '3d'
}

// ---------------------------------------------------------------------------
// Pointer / wheel interactions on the main view
//  - left drag  → pan along the camera's view plane (world-space screen plane)
//  - right drag → rotate the view direction (orbit) — 3D only
// ---------------------------------------------------------------------------
function onWheel(e: WheelEvent): void {
  const factor = Math.pow(1.1, e.deltaY / 100)
  scene?.zoomBy(factor)
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 2) return
  dragButton = e.button
  lastX = e.clientX
  lastY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (dragButton < 0) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  if (!scene) return
  if (dragButton === 2) {
    scene.orbitBy(dx, dy)
  } else {
    scene.panBy(dx, dy)
  }
}

function onPointerUp(): void {
  dragButton = -1
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  const host = hostRef.value
  if (!host) return
  engine = new FtEngine()
  scene = new FtScene(host)

  // sync initial state into the scene
  scene.setOptions({
    showCoords: state.show.coords,
    showCircles: state.show.circles,
    showVectors: state.show.vectors,
    showTrack: state.show.track,
    showFinal: state.show.final,
    neon: state.neon
  })
  scene.setMode(state.mode)
  scene.setFollow(state.follow)

  ro = new ResizeObserver(() => scene?.resize())
  ro.observe(host)

  try {
    const meta = (await window.cockpit.command('ft.presets')) as FtPresetMeta[] | null
    if (Array.isArray(meta)) presets.value = meta
  } catch {
    // presets stay empty
  }
  await loadPreset('circle')
})

onActivated(() => {
  startLoop()
  scene?.resize()
})

onDeactivated(() => {
  stopLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  ro?.disconnect()
  scene?.dispose()
  scene = null
  engine = null
})

// ---------------------------------------------------------------------------
// State → engine/scene sync
// ---------------------------------------------------------------------------
watch(
  () => state.running,
  (v) => engine && (engine.running = v)
)
watch(
  () => state.runSpeed,
  (v) => engine && (engine.runSpeed = v)
)
watch(
  () => state.verticesLimit,
  (v) => {
    if (!engine || !scene) return
    engine.verticesLimit = v
    scene.setVerticesLimit(v)
  }
)
watch(
  () => state.mode,
  (m) => scene?.setMode(m)
)
watch(
  () => state.follow,
  (f) => scene?.setFollow(f)
)
watch(
  () => state.neon,
  (n) => scene?.setOptions({ neon: n })
)
watch(
  () => state.show,
  (s) =>
    scene?.setOptions({
      showCoords: s.coords,
      showCircles: s.circles,
      showVectors: s.vectors,
      showTrack: s.track,
      showFinal: s.final
    }),
  { deep: true }
)
</script>

<template>
  <div class="ft-root" :class="{ 'ft-root--collapsed': collapsed }">
    <div
      ref="hostRef"
      class="ft-host"
      @wheel.prevent="onWheel"
      @pointerdown.prevent="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @contextmenu.prevent
    />

    <!-- top-left floating toolbar -->
    <div class="ft-toolbar">
      <v-btn
        icon
        variant="tonal"
        :color="state.running ? 'success' : 'warning'"
        :title="state.running ? t('ft.ctrl.pause') : t('ft.ctrl.play')"
        @click="state.running = !state.running"
      >
        <v-icon>{{ state.running ? 'mdi-pause' : 'mdi-play' }}</v-icon>
      </v-btn>
      <v-btn icon variant="tonal" :title="t('ft.ctrl.repaint')" @click="repaint">
        <v-icon>mdi-eraser</v-icon>
      </v-btn>
      <v-btn icon variant="tonal" :title="t('ft.ctrl.resetView')" @click="resetView">
        <v-icon>mdi-crosshairs-gps</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="tonal"
        :color="state.follow ? 'primary' : ''"
        :title="t('ft.ctrl.follow')"
        @click="state.follow = !state.follow"
      >
        <v-icon>mdi-target</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="tonal"
        :color="state.mode === '3d' ? 'primary' : ''"
        :title="t('ft.ctrl.mode3d')"
        @click="toggleMode"
      >
        <v-icon>{{ state.mode === '3d' ? 'mdi-cube' : 'mdi-square-rounded' }}</v-icon>
      </v-btn>
    </div>

    <!-- right floating panel: collapses without affecting the main view -->
    <aside class="ft-panel" :class="{ 'ft-panel--collapsed': collapsed }">
      <div class="ft-panel__head">
        <span v-if="!collapsed" class="text-subtitle-2">{{ t('ft.panelTitle') }}</span>
        <v-btn
          :icon="collapsed ? 'mdi-chevron-left' : 'mdi-chevron-right'"
          size="small"
          variant="tonal"
          :title="collapsed ? t('ft.panelExpand') : t('ft.panelCollapse')"
          @click="collapsed = !collapsed"
        />
      </div>

      <div v-if="!collapsed" class="ft-panel__body">
        <v-expansion-panels v-model="openSections" multiple flat class="ft-panels">
          <v-expansion-panel value="info">
            <v-expansion-panel-title>
              <v-icon size="18" color="primary" class="mr-2">mdi-information-outline</v-icon>
              {{ t('ft.section.info') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <InfoPanel />
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel value="controls">
            <v-expansion-panel-title>
              <v-icon size="18" color="primary" class="mr-2">mdi-tune-variant</v-icon>
              {{ t('ft.section.controls') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <ControlsPanel @repaint="repaint" @reset-view="resetView" />
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel value="vectors">
            <v-expansion-panel-title>
              <v-icon size="18" color="primary" class="mr-2">mdi-vector-polyline</v-icon>
              {{ t('ft.section.vectors') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <VectorsPanel />
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel value="samples">
            <v-expansion-panel-title>
              <v-icon size="18" color="primary" class="mr-2">mdi-shape-outline</v-icon>
              {{ t('ft.section.samples') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <SamplesPanel />
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ft-root {
  position: relative;
  height: 100%;
  min-height: 320px;
  width: 100%;
  overflow: hidden;
}

.ft-host {
  /* Reserves the docked panel on the right, so the scene canvas is exactly the
     visible area and the origin stays dead-center — never covered by the UI. */
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  right: 336px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.ft-root--collapsed .ft-host {
  right: 72px;
}

.ft-host:active {
  cursor: grabbing;
}

/* top-left toolbar — matches the app's floating glass chrome */
.ft-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 6px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(var(--v-theme-surface-variant), 0.42);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}

/* right panel — docked beside the view (not floating), so the scene canvas
 * never gets covered and the origin stays centered in the visible area */
.ft-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: 312px;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(var(--v-theme-surface-variant), 0.42);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  z-index: 5;
}

.ft-panel--collapsed {
  width: 48px;
  height: 48px;
  bottom: auto;
}

.ft-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  flex-shrink: 0;
}

.ft-panel--collapsed .ft-panel__head {
  justify-content: center;
  padding: 8px;
}

.ft-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 10px 12px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ft-panel__body::-webkit-scrollbar {
  display: none;
}

.ft-panel__body :deep(.v-expansion-panels) {
  background: transparent;
}

.ft-panel__body :deep(.v-expansion-panel) {
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
}

.ft-panel__body :deep(.v-expansion-panel-title) {
  font-size: 0.85rem;
  font-weight: 500;
  min-height: 44px;
  color: rgb(var(--v-theme-on-surface));
}

.ft-panel__body :deep(.v-expansion-panel-text__wrapper) {
  padding-top: 4px;
}
</style>
