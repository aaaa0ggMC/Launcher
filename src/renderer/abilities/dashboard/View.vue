<script setup lang="ts">
defineOptions({ name: 'cockpit-dashboard' })

import {
  ref,
  shallowRef,
  computed,
  inject,
  onMounted,
  onActivated,
  onBeforeUnmount,
  nextTick
} from 'vue'
import type { Ref } from 'vue'
import { GridStack } from 'gridstack'
import type { GridStackNode, GridItemHTMLElement } from 'gridstack'
import 'gridstack/dist/gridstack.min.css'
import type { SystemStats } from '@shared/types'
import { DASHBOARD_LAYOUT_VERSION } from '@shared/types'
import { fmtBytes, fmtUptime } from '../../composables/format'
import LoadingBar from '../../components/LoadingBar.vue'
import { translate, translateTemplate } from '../../i18n'

const stats = shallowRef<SystemStats | null>(null)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const pm = ref<0 | 1 | null>(null)
const pmBusy = ref(false)
const pmConfirm = ref(false)
const firstLoaded = ref(false)
const loading = ref(false)
const error = ref('')
const gridEl = ref<HTMLElement | null>(null)

let grid: GridStack | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Manual / first load (drives the shared loading bar + skeleton). */
async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [s, p] = await Promise.all([
      window.cockpit.stats(),
      window.cockpit.readPm().catch(() => null)
    ])
    stats.value = s
    pm.value = p as 0 | 1 | null
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

/** Toggle NVIDIA PM via confirm dialog (ported from the old hardware page). */
async function doTogglePm(): Promise<void> {
  pmConfirm.value = false
  pmBusy.value = true
  try {
    const v = await window.cockpit.togglePm()
    if (v !== null) pm.value = v
    else error.value = '切换电源管理失败'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pmBusy.value = false
  }
}

/** Read persisted layout via the CLI-first dashboard.get-layout command. */
async function loadSavedLayout(): Promise<GridStackNode[] | null> {
  try {
    const res = (await window.cockpit.command('dashboard.get-layout')) as {
      layout?: GridStackNode[]
      version?: number | null
    }
    const layout = res?.layout
    if (!Array.isArray(layout) || layout.length === 0) return null
    // Discard layouts saved under a different grid geometry (cellHeight etc.)
    // — they were authored on a coarser grid and would render at the wrong
    // scale. Fall back to the default layout; it gets re-saved on first change.
    if (res?.version !== DASHBOARD_LAYOUT_VERSION) return null
    // Guard against corrupt/legacy layouts pushing cards off-grid.
    const valid = layout.every(
      (n) => typeof n.x === 'number' && typeof n.w === 'number' && n.x >= 0 && n.x + n.w <= 12
    )
    if (!valid) return null
    // Discard saved layout if the card set changed (e.g. a card was added or
    // removed) — otherwise gridstack load() would silently skip new cards.
    const ids = new Set(['host', 'cpu', 'mem', 'gpu', 'pm', 'disk', 'docker'])
    const savedIds = new Set(layout.map((n) => n.id))
    const sameSet = ids.size === savedIds.size && [...ids].every((id) => savedIds.has(id))
    if (!sameSet) return null
    return layout
  } catch {
    return null
  }
}

/** Restore the grid to the default (layoutCards) positions. */
async function applyDefaultLayout(): Promise<void> {
  if (!grid) return
  for (const c of cards.value) {
    const el = gridEl.value?.querySelector(`#${c.id}`)
    if (el) grid.update(el as GridItemHTMLElement, { x: c.x, y: c.y, w: c.w, h: c.h })
  }
  await window.cockpit.command('dashboard.set-layout', { layout: grid.save(false) })
}

async function initGrid(): Promise<void> {
  const el = gridEl.value
  if (!el || grid) return
  const g = GridStack.init(
    {
      column: 12,
      margin: 12,
      // Fine vertical grid: 48px per row (was 96) — drag/resize snaps in half
      // the previous steps, so card heights can be tuned precisely. Default
      // card h values are doubled below to keep the same pixel sizes.
      cellHeight: 48,
      animate: true,
      // float: cards stay exactly where dropped; container height grows to the
      // lowest widget's bottom (never snap-backs, never leaves stale ghosts).
      float: true
    },
    el
  )
  if (!g) return
  grid = g
  const saved = await loadSavedLayout()
  if (saved) g.load(saved)
  g.on('change', () => {
    void window.cockpit.command('dashboard.set-layout', { layout: g.save(false) })
  })
}

function onResize(): void {
  // Reflow all widgets against the current container width.
  grid?.column(12)
}

let unsubReset: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('resize', onResize)
  // Settings → 重置排版: restore the default grid layout live.
  unsubReset = window.cockpit.on('cockpit:dashboard-reset', () => void applyDefaultLayout())
  await refresh()
  // grid init must wait until the container has a real width
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  await initGrid()
  timer = setInterval(poll, 4000)
})

// Re-shown from keep-alive cache: the container was display:none while hidden,
// so reflow the grid now that it has a real width again.
onActivated(async () => {
  if (!firstLoaded.value || !grid) return
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  grid.column(12)
})

onBeforeUnmount(() => {
  unsubReset?.()
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
    { id: 'host', w: 6, h: 8, title: '主机', icon: 'mdi-desktop-tower' },
    { id: 'cpu', w: 6, h: 8, title: '处理器', icon: 'mdi-chip' },
    { id: 'mem', w: 6, h: 8, title: '内存', icon: 'mdi-memory' },
    { id: 'gpu', w: 6, h: 8, title: 'GPU', icon: 'mdi-expansion-card' },
    { id: 'pm', w: 6, h: 6, title: 'NVIDIA 电源管理', icon: 'mdi-power-plug' },
    { id: 'disk', w: 6, h: 8, title: '磁盘', icon: 'mdi-harddisk' },
    { id: 'docker', w: 6, h: 8, title: '容器', icon: 'mdi-docker' }
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
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">{{ translate(uiLang, 'dashboard.heading') }}</div>
        <div v-if="stats" class="text-caption on-surface-variant mt-1">
          {{ stats.hostname }} · {{ stats.platform }} · 已运行 {{ fmtUptime(stats.uptime) }}
        </div>
      </div>
      <v-btn
        variant="tonal"
        prepend-icon="mdi-refresh"
        :loading="loading && firstLoaded"
        @click="refresh"
      >
        {{ translate(uiLang, 'dashboard.refresh') }}
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
        :id="c.id"
        :gs-id="c.id"
        class="grid-stack-item"
        :gs-x="String(c.x)"
        :gs-y="String(c.y)"
        :gs-w="String(c.w)"
        :gs-h="String(c.h)"
      >
        <div class="grid-stack-item-content">
          <v-card class="card-fill" flat variant="tonal" rounded="lg">
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2 pb-1">
              <v-icon size="18" color="primary">{{ c.icon }}</v-icon>
              <span>{{ translate(uiLang, 'dashboard.card.' + c.id, c.title) }}</span>
            </v-card-title>
            <v-card-text class="stat-card-text">
              <!-- Host -->
              <template v-if="c.id === 'host'">
                <div class="text-body-1 font-weight-medium">{{ stats?.hostname }}</div>
                <div class="info-grid mt-2">
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.sys') }}</span>
                    <span class="info-value">{{ stats?.platform }}</span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.arch') }}</span>
                    <span class="info-value">{{ stats?.arch }}</span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.user') }}</span>
                    <span class="info-value">{{ stats?.username ?? '—' }}</span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.desktop') }}</span>
                    <span class="info-value">{{ stats?.de ?? '—' }}</span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">Shell</span>
                    <span class="info-value text-truncate">{{ stats?.shell ?? '—' }}</span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.uptime') }}</span>
                    <span class="info-value">{{ fmtUptime(stats?.uptime ?? 0) }}</span>
                  </div>
                </div>
                <v-divider class="my-2" />
                <div class="d-flex ga-3 flex-wrap">
                  <v-chip size="x-small" variant="tonal" color="primary">
                    <v-icon start size="14">mdi-package-variant</v-icon>
                    pacman {{ stats?.packages?.pacman ?? '—' }}
                  </v-chip>
                  <v-chip size="x-small" variant="tonal" color="secondary">
                    <v-icon start size="14">mdi-package-variant-closed</v-icon>
                    flatpak {{ stats?.packages?.flatpak ?? '—' }}
                  </v-chip>
                </div>
              </template>

              <!-- CPU -->
              <template v-else-if="c.id === 'cpu'">
                <div class="d-flex align-center ga-3 mb-2">
                  <v-progress-circular
                    :model-value="stats?.cpu.usage ?? 0"
                    color="primary"
                    size="56"
                    width="5"
                  >
                    {{ stats?.cpu.usage }}%
                  </v-progress-circular>
                  <div class="flex-grow-1 min-width-0">
                    <div class="text-body-2 font-weight-medium text-truncate">
                      {{ stats?.cpu.model }}
                    </div>
                    <div class="text-caption on-surface-variant mt-1">
                      {{
                        translateTemplate(uiLang, 'dashboard.cores', {
                          n: String(stats?.cpu.cores ?? '')
                        })
                      }}
                      <span v-if="stats?.cpu.freq"> · {{ stats.cpu.freq }} MHz</span>
                    </div>
                  </div>
                </div>
                <v-divider class="my-2" />
                <div class="info-grid">
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.temp') }}</span>
                    <span class="info-value">
                      <v-icon
                        v-if="stats?.cpu.temp"
                        size="13"
                        :color="
                          (stats.cpu.temp ?? 0) > 80
                            ? 'error'
                            : (stats.cpu.temp ?? 0) > 60
                              ? 'warning'
                              : 'success'
                        "
                      >
                        mdi-thermometer
                      </v-icon>
                      {{ stats?.cpu.temp ? stats.cpu.temp + '°C' : '—' }}
                    </span>
                  </div>
                  <div class="info-cell">
                    <span class="info-label">{{ translate(uiLang, 'dashboard.load') }}</span>
                    <span class="info-value font-family-mono">
                      {{
                        stats?.loadAvg ? stats.loadAvg.map((l) => l.toFixed(2)).join(' / ') : '—'
                      }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- Memory -->
              <template v-else-if="c.id === 'mem'">
                <div class="d-flex align-center justify-space-between mb-1">
                  <span class="text-body-2 font-weight-medium">{{
                    translate(uiLang, 'dashboard.mem')
                  }}</span>
                  <span class="text-caption font-family-mono on-surface-variant">
                    {{ stats?.mem.percent }}%
                  </span>
                </div>
                <v-progress-linear
                  :model-value="stats?.mem.percent ?? 0"
                  :color="
                    (stats?.mem.percent ?? 0) > 85
                      ? 'error'
                      : (stats?.mem.percent ?? 0) > 70
                        ? 'warning'
                        : 'primary'
                  "
                  height="10"
                  rounded
                />
                <div class="d-flex justify-space-between mt-1">
                  <span class="text-caption on-surface-variant">
                    {{ translate(uiLang, 'dashboard.used') }} {{ fmtBytes(stats?.mem.used ?? 0) }}
                  </span>
                  <span class="text-caption on-surface-variant">
                    {{ translate(uiLang, 'dashboard.total') }} {{ fmtBytes(stats?.mem.total ?? 0) }}
                  </span>
                </div>
                <v-divider class="my-2" />
                <div class="d-flex align-center justify-space-between mb-1">
                  <span class="text-body-2 font-weight-medium">{{
                    translate(uiLang, 'dashboard.swap')
                  }}</span>
                  <span v-if="stats?.swap" class="text-caption font-family-mono on-surface-variant">
                    {{ stats.swap.percent }}%
                  </span>
                </div>
                <v-progress-linear
                  v-if="stats?.swap"
                  :model-value="stats.swap.percent"
                  :color="stats.swap.percent > 80 ? 'error' : 'secondary'"
                  height="8"
                  rounded
                />
                <div v-if="stats?.swap" class="d-flex justify-space-between mt-1">
                  <span class="text-caption on-surface-variant">
                    {{ translate(uiLang, 'dashboard.used') }} {{ fmtBytes(stats.swap.used) }}
                  </span>
                  <span class="text-caption on-surface-variant">
                    {{ translate(uiLang, 'dashboard.total') }} {{ fmtBytes(stats.swap.total) }}
                  </span>
                </div>
                <div v-else class="text-caption on-surface-variant">
                  {{ translate(uiLang, 'dashboard.noSwap') }}
                </div>
              </template>

              <!-- GPU -->
              <template v-else-if="c.id === 'gpu'">
                <div v-if="gpus.length === 0" class="text-caption on-surface-variant">
                  {{ translate(uiLang, 'dashboard.noGpu') }}
                </div>
                <div v-for="g in gpus" :key="g.name" class="mb-3">
                  <div class="d-flex justify-space-between align-center">
                    <span class="text-body-2 font-weight-medium text-truncate">{{ g.name }}</span>
                    <v-chip
                      size="x-small"
                      :color="Number(g.temp.replace('°C', '')) > 80 ? 'error' : 'success'"
                      variant="tonal"
                    >
                      {{ g.temp }}
                    </v-chip>
                  </div>
                  <div class="text-caption on-surface-variant mt-1">
                    {{ translate(uiLang, 'dashboard.driver') }} {{ g.driver }}
                  </div>
                  <div class="text-caption on-surface-variant mt-1 d-flex ga-3 flex-wrap">
                    <span>{{ translate(uiLang, 'dashboard.vram') }} {{ g.vram }}</span>
                    <span v-if="g.fanSpeed"
                      >{{ translate(uiLang, 'dashboard.fan') }} {{ g.fanSpeed }}</span
                    >
                    <span v-if="g.power">
                      {{ translate(uiLang, 'dashboard.power') }} {{ g.power
                      }}<span v-if="g.powerLimit"> / {{ g.powerLimit }}</span>
                    </span>
                  </div>
                  <div class="mt-1">
                    <div class="d-flex justify-space-between text-caption">
                      <span class="on-surface-variant">{{
                        translate(uiLang, 'dashboard.gpuUtil')
                      }}</span>
                      <span class="font-family-mono">{{ g.usage }}</span>
                    </div>
                    <v-progress-linear
                      :model-value="Number(g.usage.replace('%', '')) || 0"
                      color="primary"
                      height="6"
                      rounded
                      class="mt-1"
                    />
                  </div>
                  <div v-if="g.vramPercent !== undefined" class="mt-1">
                    <div class="d-flex justify-space-between text-caption">
                      <span class="on-surface-variant">显存占用</span>
                      <span class="font-family-mono">{{ g.vramPercent }}%</span>
                    </div>
                    <v-progress-linear
                      :model-value="g.vramPercent"
                      color="secondary"
                      height="6"
                      rounded
                      class="mt-1"
                    />
                  </div>
                </div>
              </template>

              <!-- NVIDIA PM -->
              <template v-else-if="c.id === 'pm'">
                <div class="d-flex align-center justify-space-between">
                  <div class="flex-grow-1 min-width-0 pr-2">
                    <div class="text-body-2 text-truncate">
                      NVreg_PreserveVideoMemoryAllocations
                    </div>
                    <div class="text-caption on-surface-variant mt-1">
                      当前: <code>{{ pm ?? '—' }}</code> · 修改后需重启生效
                    </div>
                  </div>
                  <v-btn
                    :color="pm === 1 ? 'success' : ''"
                    variant="tonal"
                    :loading="pmBusy"
                    @click="pmConfirm = true"
                  >
                    {{ pm === 1 ? '已启用' : '已禁用' }}
                  </v-btn>
                </div>
              </template>

              <!-- Disk -->
              <template v-else-if="c.id === 'disk'">
                <div v-if="disks.length === 0" class="text-caption on-surface-variant">
                  无磁盘信息
                </div>
                <div v-for="d in disks" :key="d.path" class="mb-2">
                  <div class="d-flex justify-space-between text-caption">
                    <span class="font-family-mono">{{ d.path }}</span>
                    <span class="on-surface-variant">{{ d.percent }}%</span>
                  </div>
                  <v-progress-linear
                    :model-value="d.percent"
                    :color="d.percent > 85 ? 'error' : d.percent > 70 ? 'warning' : 'primary'"
                    height="8"
                    rounded
                    class="mt-1"
                  />
                  <div class="d-flex justify-space-between mt-1">
                    <span class="text-caption on-surface-variant">
                      {{ fmtBytes(d.used) }} / {{ fmtBytes(d.total) }}
                    </span>
                    <span class="text-caption on-surface-variant">
                      可用 {{ fmtBytes(d.free) }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- Docker -->
              <template v-else-if="c.id === 'docker'">
                <div v-if="containers.length > 0" class="d-flex ga-2 mb-2">
                  <v-chip size="x-small" variant="tonal" color="success">
                    运行 {{ containers.filter((ct) => ct.state === 'running').length }}
                  </v-chip>
                  <v-chip size="x-small" variant="tonal" color="on-surface-variant">
                    停止 {{ containers.filter((ct) => ct.state !== 'running').length }}
                  </v-chip>
                  <v-chip size="x-small" variant="tonal"> 共 {{ containers.length }} </v-chip>
                </div>
                <div v-if="containers.length === 0" class="text-caption on-surface-variant">
                  Docker 未运行或无容器
                </div>
                <div
                  v-for="ct in containers"
                  :key="ct.id"
                  class="d-flex justify-space-between align-center mb-1"
                >
                  <div class="d-flex align-center ga-2 min-width-0">
                    <v-icon
                      size="16"
                      :color="ct.state === 'running' ? 'success' : 'on-surface-variant'"
                    >
                      {{ ct.state === 'running' ? 'mdi-play-circle' : 'mdi-stop-circle' }}
                    </v-icon>
                    <span class="text-body-2 text-truncate">{{ ct.name }}</span>
                  </div>
                  <v-chip
                    size="x-small"
                    :color="ct.state === 'running' ? 'success' : ''"
                    variant="tonal"
                  >
                    {{ ct.state }}
                  </v-chip>
                </div>
              </template>
            </v-card-text>
          </v-card>
        </div>
      </div>
    </div>

    <v-dialog v-model="pmConfirm" width="440">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1">切换 NVIDIA 电源管理？</v-card-title>
        <v-card-text class="text-body-2">
          将修改 <code>/etc/modprobe.d/nvidia-pm-override.conf</code>（自动备份），
          需要管理员密码，且需重启才能生效。
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="pmConfirm = false">取消</v-btn>
          <v-btn color="primary" @click="doTogglePm">确认</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.stat-card-text {
  padding: 0 16px 16px;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}

.info-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.info-label {
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  margin-bottom: 1px;
}

.info-value {
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface));
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
