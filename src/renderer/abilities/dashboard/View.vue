<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { GridStack } from 'gridstack'
import type { GridStackNode } from 'gridstack'
import 'gridstack/dist/gridstack.min.css'
import type { SystemStats } from '@shared/types'
import { fmtBytes, fmtUptime } from '../../composables/format'
import LoadingBar from '../../components/LoadingBar.vue'

const stats = shallowRef<SystemStats | null>(null)
const firstLoaded = ref(false)
const loading = ref(false)
const error = ref('')
const gridEl = ref<HTMLElement | null>(null)

let grid: GridStack | null = null
let timer: ReturnType<typeof setInterval> | null = null

const LAYOUT_KEY = 'cockpit-dashboard-layout'

/** Manual / first load (drives the shared loading bar + skeleton). */
async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    stats.value = await window.cockpit.stats()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    firstLoaded.value = true
  }
}

/** Silent background poll — no loading bar flicker. */
async function poll(): Promise<void> {
  try {
    stats.value = await window.cockpit.stats()
  } catch {
    // keep last snapshot
  }
}

function loadSavedLayout(): GridStackNode[] | null {
  const raw = localStorage.getItem(LAYOUT_KEY)
  if (!raw) return null
  try {
    const layout = JSON.parse(raw) as GridStackNode[]
    if (!Array.isArray(layout)) return null
    // Guard against corrupt/legacy layouts pushing cards off-grid.
    const valid = layout.every(
      (n) =>
        typeof n.x === 'number' &&
        typeof n.w === 'number' &&
        n.x >= 0 &&
        n.x + n.w <= 12
    )
    return valid ? layout : null
  } catch {
    return null
  }
}

function initGrid(): void {
  const el = gridEl.value
  if (!el || grid) return
  const g = GridStack.init(
    {
      column: 12,
      margin: 12,
      cellHeight: 96,
      animate: true,
      float: true
    },
    el
  )
  if (!g) return
  grid = g
  const saved = loadSavedLayout()
  if (saved) g.load(saved)
  g.on('change', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(g.save(false)))
  })
}

function onResize(): void {
  // Reflow all widgets against the current container width.
  grid?.column(12)
  grid?.compact()
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
  await refresh()
  // grid init must wait until the container has a real width
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  initGrid()
  timer = setInterval(poll, 4000)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (timer) clearInterval(timer)
})

interface GridCard {
  id: string
  title: string
  icon: string
  w: number
  h: number
  x: number
  y: number
}

/** Greedy first-fit on a 12-column grid → two cards per row by default. */
function layoutCards(
  cards: { id: string; title: string; icon: string; w: number; h: number }[]
): GridCard[] {
  const colY = new Array(12).fill(0)
  return cards.map((c) => {
    let bestX = 0
    let bestY = Infinity
    for (let x = 0; x <= 12 - c.w; x++) {
      let y = 0
      for (let cx = x; cx < x + c.w; cx++) y = Math.max(y, colY[cx])
      if (y < bestY) {
        bestY = y
        bestX = x
      }
    }
    for (let cx = bestX; cx < bestX + c.w; cx++) colY[cx] = bestY + c.h
    return { ...c, x: bestX, y: bestY }
  })
}

const cards = computed<GridCard[]>(() => {
  const defs = [
    { id: 'host', w: 6, h: 3, title: '主机', icon: 'mdi-desktop-tower' },
    { id: 'cpu', w: 6, h: 3, title: '处理器', icon: 'mdi-chip' },
    { id: 'mem', w: 6, h: 3, title: '内存', icon: 'mdi-memory' },
    { id: 'gpu', w: 6, h: 3, title: 'GPU', icon: 'mdi-video-card' },
    { id: 'disk', w: 6, h: 3, title: '磁盘', icon: 'mdi-harddisk' },
    { id: 'docker', w: 6, h: 3, title: '容器', icon: 'mdi-docker' }
  ]
  return layoutCards(defs)
})

const gpus = computed(() => stats.value?.gpu ?? [])
const disks = computed(() => stats.value?.disk ?? [])
const containers = computed(() => stats.value?.docker ?? [])

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-2">
      <div>
        <div class="text-h6 font-weight-medium">系统总览</div>
        <div v-if="stats" class="text-caption on-surface-variant">
          {{ stats.hostname }} · {{ stats.platform }} · 已运行 {{ fmtUptime(stats.uptime) }}
        </div>
      </div>
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-refresh"
        :loading="loading && firstLoaded"
        @click="refresh"
      >
        刷新
      </v-btn>
    </div>

    <LoadingBar
      :loading="loading"
      :skeleton="!firstLoaded"
      :error="error"
      skeleton-type="list-item-two-line,article"
    />

    <div v-if="firstLoaded" ref="gridEl" class="grid-stack">
      <div
        v-for="c in cards"
        :key="c.id"
        class="grid-stack-item"
        :gs-x="String(c.x)"
        :gs-y="String(c.y)"
        :gs-w="String(c.w)"
        :gs-h="String(c.h)"
      >
        <div class="grid-stack-item-content">
          <v-card class="fill-height" flat variant="tonal" rounded="lg">
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
              <v-icon size="20" color="primary">{{ c.icon }}</v-icon>
              <span>{{ c.title }}</span>
            </v-card-title>
            <v-card-text>
              <template v-if="c.id === 'host'">
                <div class="text-body-1">{{ stats?.hostname }}</div>
                <div class="text-caption on-surface-variant">{{ stats?.platform }}</div>
              </template>

              <template v-else-if="c.id === 'cpu'">
                <div class="d-flex align-center ga-2">
                  <v-progress-circular
                    :model-value="stats?.cpu.usage ?? 0"
                    color="primary"
                    size="52"
                    width="5"
                  >
                    {{ stats?.cpu.usage }}%
                  </v-progress-circular>
                  <div>
                    <div class="text-caption on-surface-variant">{{ stats?.cpu.model }}</div>
                    <div class="text-caption on-surface-variant">{{ stats?.cpu.cores }} 核</div>
                  </div>
                </div>
              </template>

              <template v-else-if="c.id === 'mem'">
                <div class="mb-2 d-flex justify-space-between">
                  <span class="text-caption on-surface-variant">已用 {{ fmtBytes(stats?.mem.used ?? 0) }}</span>
                  <span class="text-caption on-surface-variant">共 {{ fmtBytes(stats?.mem.total ?? 0) }}</span>
                </div>
                <v-progress-linear
                  :model-value="stats?.mem.percent ?? 0"
                  :color="(stats?.mem.percent ?? 0) > 85 ? 'error' : 'primary'"
                  height="10"
                  rounded
                />
                <div class="mt-1 text-caption on-surface-variant">{{ stats?.mem.percent }}%</div>
              </template>

              <template v-else-if="c.id === 'gpu'">
                <div v-if="gpus.length === 0" class="text-caption on-surface-variant">未检测到 GPU</div>
                <div v-for="g in gpus" :key="g.name" class="mb-2">
                  <div class="d-flex justify-space-between align-center">
                    <span class="text-body-2">{{ g.name }}</span>
                    <v-chip size="x-small" color="success" variant="tonal">{{ g.temp }}</v-chip>
                  </div>
                  <div class="text-caption on-surface-variant">驱动 {{ g.driver }} · 显存 {{ g.vram }}</div>
                  <v-progress-linear
                    :model-value="Number(g.usage.replace('%', '')) || 0"
                    color="primary"
                    height="6"
                    rounded
                    class="mt-1"
                  />
                </div>
              </template>

              <template v-else-if="c.id === 'disk'">
                <div v-if="disks.length === 0" class="text-caption on-surface-variant">无磁盘信息</div>
                <div v-for="d in disks" :key="d.path" class="mb-2">
                  <div class="d-flex justify-space-between text-caption">
                    <span>{{ d.path }}</span>
                    <span class="on-surface-variant">{{ fmtBytes(d.used) }} / {{ fmtBytes(d.total) }} · {{ d.percent }}%</span>
                  </div>
                  <v-progress-linear
                    :model-value="d.percent"
                    :color="d.percent > 85 ? 'error' : d.percent > 70 ? 'warning' : 'primary'"
                    height="8"
                    rounded
                  />
                </div>
              </template>

              <template v-else-if="c.id === 'docker'">
                <div v-if="containers.length === 0" class="text-caption on-surface-variant">Docker 未运行或无容器</div>
                <div v-for="ct in containers" :key="ct.id" class="d-flex justify-space-between align-center mb-1">
                  <div class="d-flex align-center ga-2">
                    <v-icon size="16" :color="ct.state === 'running' ? 'success' : 'on-surface-variant'">
                      {{ ct.state === 'running' ? 'mdi-play-circle' : 'mdi-stop-circle' }}
                    </v-icon>
                    <span class="text-body-2">{{ ct.name }}</span>
                  </div>
                  <v-chip size="x-small" :color="ct.state === 'running' ? 'success' : ''" variant="tonal">
                    {{ ct.state }}
                  </v-chip>
                </div>
              </template>
            </v-card-text>
          </v-card>
        </div>
      </div>
    </div>
  </div>
</template>
