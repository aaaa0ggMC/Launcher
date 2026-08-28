<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-sidebar' })

import { ref, inject, onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import { resolveSidebarAbilities } from '@ui/ability-registry'

const config = inject<Ref<Record<string, unknown>>>('cockpit:config', ref({}))
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

export interface AbilityItem {
  id: string
  name: string
  icon: string | null
  category: string
}

const sort = ref<'alpha' | 'frequency' | 'recent' | 'custom'>('alpha')
const clearing = ref(false)
const customList = ref<AbilityItem[]>([])
const dragIdx = ref(-1)
const gridEl = ref<HTMLElement | null>(null)

function loadLoadedAbilities(): AbilityItem[] {
  const report = resolveSidebarAbilities(window.cockpit.platform)
  return report.loaded.map((m) => ({
    id: m.id,
    name: translate(uiLang.value, `ability.${m.id}.name`, m.name),
    icon: m.icon,
    category: translate(uiLang.value, `ability.${m.id}.category`, m.category)
  }))
}

function mergeOrder(savedOrder: string[], all: AbilityItem[]): AbilityItem[] {
  const map = new Map<string, AbilityItem>()
  for (const item of all) {
    map.set(item.id, item)
  }
  const result: AbilityItem[] = []
  const seen = new Set<string>()

  // 1. 保留已有顺序中仍存在的 ability
  for (const id of savedOrder) {
    const item = map.get(id)
    if (item && !seen.has(id)) {
      result.push(item)
      seen.add(id)
    }
  }

  // 2. 新加入的 ability（不在 savedOrder 中）按默认字母序置底
  const remaining = all.filter((item) => !seen.has(item.id))
  remaining.sort((a, b) => {
    const c = a.category.localeCompare(b.category, uiLang.value)
    return c !== 0 ? c : a.name.localeCompare(b.name, uiLang.value)
  })
  for (const item of remaining) {
    result.push(item)
  }

  return result
}

async function loadData(): Promise<void> {
  const cfg = await window.cockpit.getConfig()
  const s = (cfg?.sidebar as { sort?: string } | undefined)?.sort
  sort.value = s === 'frequency' || s === 'recent' || s === 'custom' ? s : 'alpha'

  const res = (await window.cockpit.command('sidebar.order.get').catch(() => null)) as {
    ok?: boolean
    order?: string[]
  } | null
  const savedOrder = Array.isArray(res?.order) ? res.order : []
  const all = loadLoadedAbilities()
  customList.value = mergeOrder(savedOrder, all)
}

onMounted(() => {
  void loadData()
})

async function setSort(v: string | null): Promise<void> {
  const mode = v === 'frequency' || v === 'recent' || v === 'custom' ? v : 'alpha'
  sort.value = mode
  await window.cockpit.setConfig({
    sidebar: {
      ...(config.value.sidebar as Record<string, unknown> | undefined),
      sort: mode
    }
  })
  if (mode === 'custom' && customList.value.length > 0) {
    void saveCustomOrder(customList.value)
  }
}

async function saveCustomOrder(list: AbilityItem[]): Promise<void> {
  const order = list.map((item) => item.id)
  await window.cockpit
    .command('sidebar.order.set', { order: JSON.stringify(order) })
    .catch(() => {})
}

function moveItem(from: number, to: number): void {
  if (to < 0 || to >= customList.value.length || from === to) return
  const copy = [...customList.value]
  const [moved] = copy.splice(from, 1)
  copy.splice(to, 0, moved)
  customList.value = copy
  void saveCustomOrder(copy)
}

function resetToAlpha(): void {
  const copy = [...customList.value]
  copy.sort((a, b) => {
    const c = a.category.localeCompare(b.category, uiLang.value)
    return c !== 0 ? c : a.name.localeCompare(b.name, uiLang.value)
  })
  customList.value = copy
  void saveCustomOrder(copy)
}

// ---------------------------------------------------------------------------
// Drag & Drop (AIDJ song swap style)
// ---------------------------------------------------------------------------
function onDragStart(e: DragEvent, idx: number): void {
  dragIdx.value = idx
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
  }
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
}

function performDrop(targetIdx: number): void {
  const from = dragIdx.value
  if (from < 0 || from === targetIdx) {
    dragIdx.value = -1
    return
  }
  const copy = [...customList.value]
  const [moved] = copy.splice(from, 1)
  copy.splice(targetIdx, 0, moved)
  customList.value = copy
  dragIdx.value = -1
  void saveCustomOrder(copy)
}

function onDrop(e: DragEvent, idx: number): void {
  e.preventDefault()
  e.stopPropagation()
  performDrop(idx)
}

function onGridDrop(e: DragEvent): void {
  if (dragIdx.value < 0) return
  e.preventDefault()
  const cells = Array.from(gridEl.value?.children ?? []).filter((c): c is HTMLElement =>
    c.classList.contains('ability-card')
  )
  let target = cells.length
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i].getBoundingClientRect()
    if (e.clientY < r.top + r.height / 2) {
      target = i
      break
    }
  }
  performDrop(target)
}

function cleanupDrag(): void {
  dragIdx.value = -1
}

async function clearRecords(): Promise<void> {
  clearing.value = true
  try {
    await window.cockpit.command('stats.clear')
  } finally {
    clearing.value = false
  }
}

onBeforeUnmount(() => {
  cleanupDrag()
})

/** Deep export: current sidebar sort rule. */
defineExpose({
  toMarkdown: (): string => {
    const label =
      sort.value === 'frequency'
        ? translate(uiLang.value, 'sidebar.frequency')
        : sort.value === 'recent'
          ? translate(uiLang.value, 'sidebar.recent')
          : sort.value === 'custom'
            ? translate(uiLang.value, 'sidebar.custom')
            : translate(uiLang.value, 'sidebar.alpha')
    let res = `${translate(uiLang.value, 'sidebar.title')}: ${label}`
    if (sort.value === 'custom' && customList.value.length) {
      res += '\n' + customList.value.map((a, i) => `  ${i + 1}. ${a.name} (${a.id})`).join('\n')
    }
    return res
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'sidebar.title') }}</v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{ translate(uiLang, 'sidebar.caption') }}
      </div>
      <v-radio-group
        v-model="sort"
        color="primary"
        density="compact"
        hide-details
        class="mb-3"
        @update:model-value="setSort"
      >
        <v-radio :label="translate(uiLang, 'sidebar.alpha')" value="alpha" />
        <v-radio :label="translate(uiLang, 'sidebar.frequency')" value="frequency" />
        <v-radio :label="translate(uiLang, 'sidebar.recent')" value="recent" />
        <v-radio :label="translate(uiLang, 'sidebar.custom')" value="custom" />
      </v-radio-group>

      <!-- Custom reorder card grid (AIDJ song-swap style) -->
      <v-expand-transition>
        <div v-if="sort === 'custom'" class="custom-sort-section mb-4">
          <div class="d-flex align-center justify-space-between mb-2 flex-wrap ga-2">
            <div class="text-caption text-medium-emphasis">
              <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
              {{ translate(uiLang, 'sidebar.customHint') }}
            </div>
            <v-btn
              variant="text"
              prepend-icon="mdi-sort-alphabetical-ascending"
              @click="resetToAlpha"
            >
              {{ translate(uiLang, 'sidebar.resetOrder') }}
            </v-btn>
          </div>

          <TransitionGroup
            ref="gridEl"
            tag="div"
            name="ability"
            class="ability-grid"
            @dragover.prevent="onDragOver"
            @drop.prevent="onGridDrop"
          >
            <div
              v-for="(item, idx) in customList"
              :key="item.id"
              draggable="true"
              class="ability-card d-flex align-center ga-2 px-3 py-2"
              :class="{ 'drag-over': dragIdx === idx }"
              @dragstart="onDragStart($event, idx)"
              @dragover.prevent
              @drop="onDrop($event, idx)"
              @dragend="cleanupDrag"
            >
              <span class="ability-index text-caption text-medium-emphasis flex-shrink-0">
                {{ idx + 1 }}
              </span>

              <AbilityIcon :icon="item.icon" :size="24" class="flex-shrink-0" />

              <div class="d-flex flex-column flex-grow-1 min-w-0">
                <span class="text-body-2 font-weight-medium text-truncate" :title="item.name">
                  {{ item.name }}
                </span>
                <span class="text-caption text-medium-emphasis text-truncate">
                  {{ item.category }}
                </span>
              </div>

              <div class="d-flex align-center ga-1 flex-shrink-0 action-buttons">
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="idx === 0"
                  @click.stop="moveItem(idx, idx - 1)"
                >
                  <v-icon size="16">mdi-chevron-up</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="idx === customList.length - 1"
                  @click.stop="moveItem(idx, idx + 1)"
                >
                  <v-icon size="16">mdi-chevron-down</v-icon>
                </v-btn>
              </div>

              <v-icon size="16" class="drag-handle text-medium-emphasis flex-shrink-0">
                mdi-drag
              </v-icon>
            </div>
          </TransitionGroup>
        </div>
      </v-expand-transition>

      <v-divider class="my-3" />

      <div class="text-caption text-medium-emphasis mb-2">
        {{ translate(uiLang, 'sidebar.statsHint') }}
      </div>
      <v-btn
        variant="text"
        color="error"
        prepend-icon="mdi-delete-outline"
        :disabled="clearing"
        :loading="clearing"
        @click="clearRecords"
      >
        {{ translate(uiLang, 'sidebar.clear') }}
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.custom-sort-section {
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.15);
  border-radius: 10px;
  padding: 12px;
}

.ability-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  width: 100%;
}

.ability-card {
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.18);
  background: rgba(var(--v-theme-surface-variant), 0.22);
  cursor: grab;
  user-select: none;
  transition:
    background 0.15s,
    border-color 0.15s;
  min-width: 0;
  overflow: hidden;
}

.ability-card:active {
  cursor: grabbing;
}

.ability-card:hover {
  background: rgba(var(--v-theme-surface-variant), 0.45);
  border-color: rgba(var(--v-theme-primary), 0.3);
}

.ability-card.drag-over {
  background: rgba(var(--v-theme-primary), 0.15);
  border-color: rgba(var(--v-theme-primary), 0.6);
}

.ability-index {
  min-width: 2.2ch;
  text-align: right;
}

.drag-handle {
  cursor: grab;
}

.ability-move {
  transition: transform 0.25s ease;
}

.ability-enter-active {
  transition: all 0.25s ease-out;
}

.ability-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.ability-leave-active {
  transition: all 0.2s ease-in;
  position: absolute;
}

.ability-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
