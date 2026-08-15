<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'

defineOptions({ name: 'cockpit-aidj-listening-stats' })

const emit = defineEmits<{ (e: 'close'): void }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) as Record<
      string,
      string
    >,
    fallback
  )

type Gran = 'day' | 'month' | 'year'

interface HeatCell {
  label: string
  minutes: number
  /** 该格子理论最大分钟数（coverage = minutes / max） */
  max: number
}

interface Period {
  key: string
  start: number
  end: number
  label: string
  total: number
  cells: HeatCell[]
}

const DAY = 86_400_000
/** 行高兜底估算（cells 换行后高度不固定，实际行高由 ref 实测） */
const ROW_FALLBACK = 70
/** 已加载周期数上限（滑动窗口：超出即卸载远端） */
const MAX_LOADED = 96
/** 每次滚动加载的批量（一次 range 多读一点，用户查看是时间线性的） */
const BATCH = { day: 31, month: 12, year: 6 } as const

/** 粒度记忆（localStorage，下次打开恢复） */
const GRAN_KEY = 'cockpit-aidj-stats-gran'

const gran = ref<Gran>('day')
const periods = ref<Period[]>([]) // 升序：最旧在上、最新在下
const loading = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
const hover = ref<{ x: number; y: number; period: string; cell: HeatCell } | null>(null)
const jumpInput = ref('')
const anchorLabel = ref('')
/** 每周期实测行高（cells 自动换行后高度随容器宽度变化） */
const rowHeights = new Map<string, number>()

/** v-for 函数 ref：挂载/更新时记录该周期行高。 */
function onRowRef(el: unknown, key: string): void {
  if (el instanceof HTMLElement) rowHeights.set(key, el.offsetHeight)
}

function rowHeight(key: string): number {
  return rowHeights.get(key) ?? ROW_FALLBACK
}

/** 前 idx 个周期累计高度（滚动定位 / 补偿用）。 */
function heightBefore(idx: number): number {
  let h = 0
  for (let i = 0; i < idx && i < periods.value.length; i++) h += rowHeight(periods.value[i].key)
  return h
}

/** 删除一批周期的行高记录（prune 卸载时清理）。 */
function dropRowHeights(ps: Period[]): void {
  for (const p of ps) rowHeights.delete(p.key)
}

// ---------------------------------------------------------------------------
// 本地时区的周期数学（CSV 行是 UTC 小时起点，展示按本地日/月/年聚合）
// ---------------------------------------------------------------------------
const dayStartOf = (ts: number): number => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const monthStartOf = (ts: number): number => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}
const yearStartOf = (ts: number): number => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), 0, 1).getTime()
}
const daysInMonth = (ts: number): number => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}
const nextStart = (g: Gran, start: number, count: number): number => {
  const d = new Date(start)
  if (g === 'day') return start + count * DAY
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth() + count, 1).getTime()
  return new Date(d.getFullYear() + count, 0, 1).getTime()
}
const prevStart = (g: Gran, start: number, count: number): number => {
  const d = new Date(start)
  if (g === 'day') return start - count * DAY
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth() - count, 1).getTime()
  return new Date(d.getFullYear() - count, 0, 1).getTime()
}
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface GranCfg {
  label: (start: number) => string
  cellCount: (start: number) => number
  cellLabel: (start: number, i: number) => string
  cellMax: (start: number, i: number) => number
}

const granCfgs: Record<Gran, GranCfg> = {
  day: {
    label: (s) => {
      const d = new Date(s)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')} 周${WEEKDAYS[d.getDay()]}`
    },
    cellCount: () => 24,
    cellLabel: (_, i) => `${i}`,
    cellMax: () => 60
  },
  month: {
    label: (s) => {
      const d = new Date(s)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    },
    cellCount: (s) => daysInMonth(s),
    cellLabel: (_, i) => `${i + 1}`,
    cellMax: () => 1440
  },
  year: {
    label: (s) => `${new Date(s).getFullYear()}`,
    cellCount: () => 12,
    cellLabel: (_, i) => `${i + 1}月`,
    cellMax: (s, i) => {
      const d = new Date(s)
      return new Date(d.getFullYear(), i + 1, 0).getDate() * 1440
    }
  }
}

// ---------------------------------------------------------------------------
// 数据加载：range 一次拉一段（多读一点），按本地周期聚合
// ---------------------------------------------------------------------------
async function fetchRows(startMs: number, endMs: number): Promise<Map<number, number>> {
  const r = (await window.cockpit.command('aidj.time-range', {
    start: Math.floor(startMs),
    end: Math.floor(endMs)
  })) as { ok?: boolean; rows?: { timestamp: number; duration: number }[] } | null
  const map = new Map<number, number>()
  for (const row of r?.rows ?? []) {
    map.set(row.timestamp, row.duration)
  }
  return map
}

function buildPeriods(
  g: Gran,
  fromStart: number,
  untilExclusive: number,
  rows: Map<number, number>
): Period[] {
  const cfg = granCfgs[g]
  const specs: { start: number; end: number }[] = []
  let s = fromStart
  while (s < untilExclusive) {
    specs.push({ start: s, end: nextStart(g, s, 1) })
    s = nextStart(g, s, 1)
  }
  const idxByStart = new Map<number, number>()
  specs.forEach((p, i) => idxByStart.set(p.start, i))
  const mins: number[][] = specs.map((p) => new Array<number>(cfg.cellCount(p.start)).fill(0))
  for (const [hourTs, minutes] of rows) {
    const d = new Date(hourTs)
    let pStart: number
    let cellIdx: number
    if (g === 'day') {
      pStart = dayStartOf(hourTs)
      cellIdx = d.getHours()
    } else if (g === 'month') {
      pStart = monthStartOf(hourTs)
      cellIdx = d.getDate() - 1
    } else {
      pStart = yearStartOf(hourTs)
      cellIdx = d.getMonth()
    }
    const pi = idxByStart.get(pStart)
    if (pi == null) continue
    if (cellIdx >= 0 && cellIdx < mins[pi].length) mins[pi][cellIdx] += minutes
  }
  return specs.map((p, i) => {
    const total = mins[i].reduce((a, b) => a + b, 0)
    return {
      key: `${g}:${p.start}`,
      start: p.start,
      end: p.end,
      label: cfg.label(p.start),
      total,
      cells: mins[i].map((minutes, j) => ({
        label: cfg.cellLabel(p.start, j),
        minutes,
        max: cfg.cellMax(p.start, j)
      }))
    }
  })
}

/** 以 anchor 月份为"时间起点"重新加载窗口（向上多预读一个批量）。
 *  periods 升序（旧在上、新在下）——打开时定位到 anchor 月，向上滑无限看历史，
 *  向下滑到"现在"为止，是时间线式的无限卷轴。 */
async function reload(anchor?: number): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const g = gran.value
    const nowMs = Date.now()
    const anchorMonth = monthStartOf(anchor ?? nowMs)
    let from: number
    let until: number
    if (g === 'day') {
      from = anchorMonth
      until = nextStart(g, from, daysInMonth(from))
    } else if (g === 'month') {
      from = anchorMonth
      until = nextStart(g, from, 1)
    } else {
      from = yearStartOf(anchorMonth)
      until = nextStart(g, from, 1)
    }
    const olderFrom = prevStart(g, from, BATCH[g])
    const rows = await fetchRows(olderFrom - DAY, until + DAY)
    const newestCap =
      g === 'day' ? dayStartOf(nowMs) : g === 'month' ? monthStartOf(nowMs) : yearStartOf(nowMs)
    const built = buildPeriods(g, olderFrom, until, rows).filter((p) => p.start <= newestCap)
    periods.value = built // 升序：最旧在顶部
    await nextTick()
    const el = scrollEl.value
    if (el) {
      // 定位到"目标时间所在周期"在视口顶部：无参 = 现在（回到当前 → 今天），
      // 跳转 = 目标月（日粒度 → 该月 1 日，月/年粒度 → 该月/年）
      const targetTs = anchor ?? nowMs
      const targetStart =
        g === 'day'
          ? dayStartOf(targetTs)
          : g === 'month'
            ? monthStartOf(targetTs)
            : yearStartOf(targetTs)
      const idx = periods.value.findIndex((p) => p.start >= targetStart)
      el.scrollTop = idx <= 0 ? 0 : heightBefore(idx)
      updateAnchor()
    }
  } finally {
    loading.value = false
  }
}

/** 向上滑：加载更早的历史（prepend 到顶部，保持视口位置）。 */
async function loadOlder(): Promise<void> {
  if (loading.value) return
  const g = gran.value
  const first = periods.value[0]
  if (!first) return
  loading.value = true
  const el = scrollEl.value
  const prevH = el ? el.scrollHeight : 0
  try {
    const from = prevStart(g, first.start, BATCH[g])
    const rows = await fetchRows(from - DAY, first.start + DAY)
    const built = buildPeriods(g, from, first.start, rows)
    if (!built.length) return
    periods.value = [...built, ...periods.value]
    await nextTick()
    if (el) el.scrollTop += el.scrollHeight - prevH // 顶部插入后保持视口位置
    prune()
  } finally {
    loading.value = false
  }
}

/** 向下滑：加载更新的数据（append 到底部，直到"现在"）。 */
async function loadNewer(): Promise<void> {
  if (loading.value) return
  const g = gran.value
  const last = periods.value[periods.value.length - 1]
  if (!last) return
  const nowMs = Date.now()
  const newestCap =
    g === 'day' ? dayStartOf(nowMs) : g === 'month' ? monthStartOf(nowMs) : yearStartOf(nowMs)
  if (last.start >= newestCap) return
  loading.value = true
  try {
    const from = last.end
    const until = nextStart(g, from, BATCH[g])
    const rows = await fetchRows(from - DAY, until + DAY)
    const built = buildPeriods(g, from, until, rows).filter((p) => p.start <= newestCap)
    if (!built.length) return
    periods.value = [...periods.value, ...built]
    prune()
  } finally {
    loading.value = false
  }
}

/** 滑动窗口卸载：超出上限时裁掉离视口远的一端（按实测行高补偿滚动位置）。 */
function prune(): void {
  const el = scrollEl.value
  if (periods.value.length <= MAX_LOADED) return
  const excess = periods.value.length - MAX_LOADED
  if (!el) {
    dropRowHeights(periods.value.slice(MAX_LOADED))
    periods.value.length = MAX_LOADED
    return
  }
  if (el.scrollTop + el.clientHeight / 2 > el.scrollHeight / 2) {
    // 视口靠下（接近最新）→ 裁掉顶部（最旧），按被裁行实际高度补偿 scrollTop
    const removed = periods.value.slice(0, excess)
    const removedH = removed.reduce((s, p) => s + rowHeight(p.key), 0)
    dropRowHeights(removed)
    periods.value.splice(0, excess)
    el.scrollTop = Math.max(0, el.scrollTop - removedH)
  } else {
    // 视口靠上（在看历史）→ 裁掉底部（最新），无需补偿
    dropRowHeights(periods.value.slice(MAX_LOADED))
    periods.value.length = MAX_LOADED
  }
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  const { scrollTop, scrollHeight, clientHeight } = el
  // 升序时间线：向上滑 = 更早（无限），向下滑 = 更新（到 now 为止）
  if (scrollTop < 240) void loadOlder()
  else if (scrollTop + clientHeight > scrollHeight - 240) void loadNewer()
  updateAnchor()
}

/** 滚动时自动更新时间起点（顶部可见周期，按实测行高定位）。 */
function updateAnchor(): void {
  const el = scrollEl.value
  if (!el || !periods.value.length) return
  const top = el.scrollTop
  let acc = 0
  let idx = 0
  for (let i = 0; i < periods.value.length; i++) {
    const h = rowHeight(periods.value[i].key)
    if (acc + h > top) {
      idx = i
      break
    }
    acc += h
    idx = i + 1
  }
  idx = Math.min(idx, periods.value.length - 1)
  anchorLabel.value = periods.value[idx].label
}

function onCellMove(e: MouseEvent, period: Period, cell: HeatCell): void {
  hover.value = { x: e.clientX + 12, y: e.clientY + 12, period: period.label, cell }
}

function coveragePct(cell: HeatCell): number {
  if (cell.max <= 0) return 0
  return Math.min(100, Math.round((cell.minutes / cell.max) * 100))
}

/** 读取 --v-theme-* CSS 变量为 [r,g,b]（Vuetify 变量是逗号分隔三元组）。 */
function themeRgb(name: string): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const parts = v.split(',').map((s) => Number(s.trim()))
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0], parts[1], parts[2]]
  }
  return [103, 80, 164] // 兜底（MD3 默认紫）
}

/** 格子着色：secondary → primary 双色插值（低覆盖偏灰蓝、高覆盖过渡到主题青），
 *  透明度随 coverage 加深——跟随当前主题（--v-theme-*），非硬编码。 */
function cellBg(cell: HeatCell): string {
  if (cell.minutes <= 0) return 'rgba(128,128,128,0.07)'
  const cov = cell.max > 0 ? Math.min(1, cell.minutes / cell.max) : 0
  const [sr, sg, sb] = themeRgb('--v-theme-secondary')
  const [pr, pg, pb] = themeRgb('--v-theme-primary')
  const r = Math.round(sr + (pr - sr) * cov)
  const g = Math.round(sg + (pg - sg) * cov)
  const b = Math.round(sb + (pb - sb) * cov)
  const a = 0.15 + cov * 0.8
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

function fmt(mins: number): string {
  if (mins <= 0) return '0m'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d}d ${rh}h` : `${d}d`
}

const windowTotal = computed(() => periods.value.reduce((s, p) => s + p.total, 0))

/** 已加载到"现在"（数组末尾最新周期 >= 当前周期起点）→ 底部提示。 */
const atLatest = computed(() => {
  if (!periods.value.length) return false
  const g = gran.value
  const nowMs = Date.now()
  const cap =
    g === 'day' ? dayStartOf(nowMs) : g === 'month' ? monthStartOf(nowMs) : yearStartOf(nowMs)
  return periods.value[periods.value.length - 1].start >= cap
})

function jump(): void {
  const m = /^(\d{4})-(\d{1,2})$/.exec(jumpInput.value.trim())
  if (!m) return
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  if (mo < 0 || mo > 11) return
  void reload(new Date(y, mo, 1).getTime())
}

function onGranChange(): void {
  localStorage.setItem(GRAN_KEY, gran.value)
  void reload()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') jump()
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  // 记忆用户上次选的粒度（localStorage）
  const saved = localStorage.getItem(GRAN_KEY)
  if (saved === 'day' || saved === 'month' || saved === 'year') gran.value = saved
  void reload()
})
onBeforeUnmount(() => {
  hover.value = null
})
</script>

<template>
  <div class="stats-shell d-flex flex-column">
    <!-- 顶栏：返回 + 粒度 + 时间起点 + 快速跳转（窄屏 flex-wrap 换行不挤压） -->
    <div class="stats-topbar d-flex align-center ga-3">
      <v-btn
        icon
        variant="text"
        size="small"
        :title="t('aidj.stats.close', '关闭')"
        @click="emit('close')"
      >
        <v-icon size="20">mdi-arrow-left</v-icon>
      </v-btn>

      <span class="text-subtitle-1 font-weight-medium">{{
        t('aidj.stats.title', '听歌时长统计')
      }}</span>

      <v-select
        v-model="gran"
        :items="[
          { title: t('aidj.stats.gran_day', '日（每天 24h 分布）'), value: 'day' },
          { title: t('aidj.stats.gran_month', '月（天分布）'), value: 'month' },
          { title: t('aidj.stats.gran_year', '年（月分布）'), value: 'year' }
        ]"
        density="compact"
        variant="outlined"
        hide-details
        class="stats-gran"
        @update:model-value="onGranChange"
      />

      <div class="d-flex align-center ga-2">
        <span class="text-caption text-medium-emphasis">{{
          t('aidj.stats.anchor', '时间起点')
        }}</span>
        <span class="text-caption font-weight-medium tabular-nums">{{ anchorLabel || '…' }}</span>
      </div>

      <v-spacer />

      <div class="d-flex align-center ga-2 flex-wrap">
        <v-text-field
          v-model="jumpInput"
          density="compact"
          variant="outlined"
          hide-details
          :placeholder="t('aidj.stats.jump_placeholder', 'YYYY-MM')"
          class="stats-jump"
          @keydown="onKeydown"
        />
        <v-btn variant="tonal" @click="jump">{{ t('aidj.stats.jump', '跳转') }}</v-btn>
        <v-btn variant="text" @click="reload()">{{ t('aidj.stats.today', '回到当前') }}</v-btn>
      </div>
    </div>

    <!-- 热度图：竖向无限滚动，滑动窗口懒加载 & 卸载 -->
    <div ref="scrollEl" class="stats-scroll" @scroll.passive="onScroll">
      <div class="stats-window-total text-caption px-4 py-2">
        {{
          tt('aidj.stats.window_total', { n: fmt(windowTotal) }, '窗口内共听 ' + fmt(windowTotal))
        }}
      </div>

      <div
        v-for="p in periods"
        :key="p.key"
        :ref="(el) => onRowRef(el, p.key)"
        class="period-row px-4"
      >
        <div class="period-head d-flex align-center">
          <span class="period-label text-body-2 font-weight-medium">{{ p.label }}</span>
          <span class="period-total text-caption text-medium-emphasis">{{
            tt('aidj.stats.total', { n: fmt(p.total) }, '共 ' + fmt(p.total))
          }}</span>
        </div>
        <div class="cells-row">
          <div
            v-for="(cell, i) in p.cells"
            :key="i"
            class="heat-cell"
            :title="`${p.label} ${cell.label} · ${fmt(cell.minutes)} · ${coveragePct(cell)}%`"
            :style="{ background: cellBg(cell) }"
            @mousemove="onCellMove($event, p, cell)"
            @mouseleave="hover = null"
          >
            <span class="cell-label">{{ cell.label }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading" class="stats-loading text-caption text-medium-emphasis pa-3">
        {{ t('aidj.stats.loading', '加载中…') }}
      </div>
      <div v-else-if="!periods.length" class="stats-empty text-caption text-medium-emphasis pa-6">
        {{ t('aidj.stats.empty', '暂无数据') }}
      </div>
      <div v-else-if="atLatest" class="stats-end-hint text-caption text-medium-emphasis pa-3">
        {{ t('aidj.stats.at_latest', '已到当前') }}
      </div>
    </div>

    <!-- 悬停提示 -->
    <Teleport to="body">
      <div
        v-if="hover"
        class="stats-tooltip"
        :style="{ left: hover.x + 'px', top: hover.y + 'px' }"
      >
        <div class="stats-tooltip-head">{{ hover.period }} · {{ hover.cell.label }}</div>
        <div class="stats-tooltip-row">
          {{ t('aidj.stats.duration', '时长') }}: {{ fmt(hover.cell.minutes) }}
        </div>
        <div class="stats-tooltip-row">
          {{ t('aidj.stats.coverage', '覆盖') }}: {{ coveragePct(hover.cell) }}%
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.stats-shell {
  position: absolute;
  inset: 0;
  background: var(--v-theme-surface);
  color: var(--v-theme-on-surface);
  z-index: 40;
}
.stats-topbar {
  flex-shrink: 0;
  min-height: 56px;
  padding: 8px 16px;
  flex-wrap: wrap;
  row-gap: 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.18);
}
.stats-gran {
  flex-shrink: 1;
  min-width: 130px;
  max-width: 220px;
}
.stats-jump {
  flex-shrink: 1;
  min-width: 96px;
  max-width: 150px;
}
.stats-scroll {
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
}
.period-row {
  /* 高度不固定：cells 自动换行后随容器宽度变化，滚动定位用 ref 实测 */
  display: flex;
  flex-direction: column;
  padding-top: 6px;
  padding-bottom: 6px;
  gap: 4px;
}
.period-head {
  min-height: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.cells-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18px, 26px));
  gap: 3px;
  justify-content: center;
}
.heat-cell {
  aspect-ratio: 1 / 1;
  min-height: 18px;
  border-radius: 3px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(128, 128, 128, 0.12);
  transition: outline 0.1s;
}
.heat-cell:hover {
  outline: 1.5px solid rgba(var(--v-theme-primary), 0.9);
  outline-offset: 1px;
}
.cell-label {
  font-size: 9px;
  line-height: 1;
  padding-bottom: 2px;
  color: rgba(128, 128, 128, 0.85);
  user-select: none;
}
.period-total {
  margin-left: auto;
  flex-shrink: 0;
}
.stats-tooltip {
  position: fixed;
  z-index: 3000;
  pointer-events: none;
  background: var(--v-theme-surface-variant);
  color: var(--v-theme-on-surface-variant);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  max-width: 240px;
}
.stats-tooltip-head {
  font-weight: 600;
  margin-bottom: 2px;
}
.stats-loading,
.stats-empty,
.stats-end-hint {
  text-align: center;
}
</style>
