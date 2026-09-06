<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-drawer' })

import { ref, computed, inject, watch, nextTick } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, GuessedGps } from '../types'
import { filterPhotosWithQuery } from '../search-parser'
import SearchHelpDialog from './SearchHelpDialog.vue'
import PhotoCardItem from './PhotoCardItem.vue'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  coords: [number, number] | null
  pageSize?: number
  guessedGpsMap?: Map<string, GuessedGps>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'updated'): void
  (e: 'preview', payload: { photo: Photo; index: number }): void
  (e: 'pick-gps', photo: Photo): void
  (e: 'explore', photos: Photo[]): void
  (e: 'relocate-group', photos: Photo[]): void
  (e: 'solidify-gps', payload: { photo: Photo; guess: GuessedGps }): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const filterQuery = ref('')
const searchHelpOpen = ref(false)

const filteredPhotos = computed(() => {
  return filterPhotosWithQuery(props.photos, filterQuery.value)
})

// ---------------------------------------------------------------------------
// 滑动加载窗口（Sliding Window）— 避免数千张照片同时挂载 DOM 导致卡死
// ---------------------------------------------------------------------------
const getPageSize = computed(() => props.pageSize || 30)
const visibleLimit = ref(getPageSize.value)
const drawerBodyRef = ref<HTMLElement | null>(null)

const displayedPhotos = computed(() => {
  return filteredPhotos.value.slice(0, visibleLimit.value)
})

const hasMore = computed(() => {
  return visibleLimit.value < filteredPhotos.value.length
})

function loadMore(): void {
  if (visibleLimit.value < filteredPhotos.value.length) {
    visibleLimit.value = Math.min(
      filteredPhotos.value.length,
      visibleLimit.value + getPageSize.value
    )
  }
}

function handleScroll(e: Event): void {
  const target = e.target as HTMLElement
  if (!target) return
  if (target.scrollHeight - target.scrollTop - target.clientHeight < 600) {
    loadMore()
  }
}

watch(
  () => [props.photos, filterQuery.value, props.open, props.pageSize],
  () => {
    visibleLimit.value = getPageSize.value
    nextTick(() => {
      if (drawerBodyRef.value) {
        drawerBodyRef.value.scrollTop = 0
      }
    })
  }
)

// ---------------------------------------------------------------------------
// 多选模式与批量平移
// ---------------------------------------------------------------------------
const isMultiSelectMode = ref(false)
const selectedPaths = ref<Set<string>>(new Set())

const selectedPhotos = computed<Photo[]>(() => {
  return props.photos.filter((p) => selectedPaths.value.has(p.path))
})

const selectedCount = computed<number>(() => selectedPaths.value.size)

const isAllSelected = computed<boolean>(() => {
  if (!filteredPhotos.value.length) return false
  return filteredPhotos.value.every((p) => selectedPaths.value.has(p.path))
})

function toggleSelect(path: string): void {
  const next = new Set(selectedPaths.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  selectedPaths.value = next
}

function toggleSelectAll(): void {
  if (isAllSelected.value) {
    const next = new Set(selectedPaths.value)
    for (const p of filteredPhotos.value) {
      next.delete(p.path)
    }
    selectedPaths.value = next
  } else {
    const next = new Set(selectedPaths.value)
    for (const p of filteredPhotos.value) {
      next.add(p.path)
    }
    selectedPaths.value = next
  }
}

function triggerRelocate(): void {
  if (selectedCount.value > 0) {
    emit('relocate-group', selectedPhotos.value)
  } else {
    emit('relocate-group', filteredPhotos.value.length ? filteredPhotos.value : props.photos)
  }
}

function getGuessedGps(p: Photo): GuessedGps | null {
  if (p.gps_lat != null && p.gps_lon != null) return null
  return props.guessedGpsMap?.get(p.path) ?? null
}

function formatCoords(coords: [number, number] | null): string {
  if (!coords) return ''
  const [lon, lat] = coords
  const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`
  const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`
  return `${latStr}, ${lonStr}`
}
</script>

<template>
  <Transition name="drawer-slide">
    <div v-if="open" class="yarj-photo-drawer">
      <!-- 抽屉顶部栏 -->
      <div class="drawer-header d-flex align-center justify-space-between px-4 py-3">
        <div class="d-flex align-center ga-3 min-w-0 flex-grow-1 mr-2">
          <v-icon size="22" color="primary">mdi-image-multiple</v-icon>
          <div class="min-w-0 flex-grow-1">
            <div class="text-subtitle-1 font-weight-bold text-truncate">
              {{ t('yarj.drawer.title', '位置照片') }} ({{
                filterQuery ? `${filteredPhotos.length}/${photos.length}` : photos.length
              }})
            </div>
            <div v-if="coords" class="text-caption on-surface-variant text-truncate">
              {{ formatCoords(coords) }}
            </div>
          </div>
        </div>

        <div class="d-flex align-center ga-1 flex-shrink-0">
          <v-btn
            v-if="photos.length > 0"
            icon
            size="small"
            variant="text"
            color="primary"
            class="mr-1"
            :title="
              selectedCount > 0
                ? t(
                    'yarj.drawer.relocateSelectedHint',
                    `平移所选 ${selectedCount} 张照片位置`
                  ).replace('{n}', String(selectedCount))
                : t(
                    'yarj.drawer.relocateGroupHint',
                    '整体平移这组照片的 GPS 定位（保留各照片相对间距）'
                  )
            "
            @click="triggerRelocate"
          >
            <v-badge v-if="selectedCount > 0" :content="selectedCount" color="primary" floating>
              <v-icon size="20">mdi-map-marker-distance</v-icon>
            </v-badge>
            <v-icon v-else size="20">mdi-map-marker-distance</v-icon>
          </v-btn>
          <v-btn
            v-if="photos.length > 0"
            variant="tonal"
            color="primary"
            class="mr-1"
            prepend-icon="mdi-compass-outline"
            :title="t('yarj.drawer.exploreHint', '以当前照片开启旅途探索回放')"
            @click="emit('explore', filteredPhotos.length ? filteredPhotos : photos)"
          >
            {{ t('yarj.exploration.title', '我的探索') }}
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            class="close-btn"
            :title="t('yarj.drawer.close', '关闭')"
            @click="emit('close')"
          >
            <v-icon size="20">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>

      <v-divider />

      <!-- 照片列表卡片流（过滤搜索框嵌入此文档流最顶部，随内容滚动，不占固定视口高度） -->
      <div ref="drawerBodyRef" class="drawer-body px-4 py-4" @scroll.passive="handleScroll">
        <div v-if="photos.length > 0" class="mb-4 d-flex align-center ga-2">
          <v-text-field
            v-model="filterQuery"
            :placeholder="
              t('yarj.drawer.filterPlaceholder', '过滤当前列表照片（文件名、标签、:guess_gps…）')
            "
            density="compact"
            variant="outlined"
            hide-details
            clearable
            prepend-inner-icon="mdi-filter-variant"
          />
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.search.helpBtn', '高级搜索语法指南 (SEARCH.md)')"
            @click="searchHelpOpen = true"
          >
            <v-icon size="18">mdi-help-circle-outline</v-icon>
          </v-btn>
        </div>

        <div v-if="!photos.length" class="text-caption on-surface-variant text-center py-10">
          {{ t('yarj.drawer.empty', '暂无照片') }}
        </div>
        <div
          v-else-if="!filteredPhotos.length"
          class="text-caption on-surface-variant text-center py-10"
        >
          {{ t('yarj.drawer.noFilterResults', '当前列表无匹配照片') }}
        </div>

        <div class="d-flex flex-column ga-4">
          <PhotoCardItem
            v-for="p in displayedPhotos"
            :key="p.id || p.path"
            :photo="p"
            :index="filteredPhotos.indexOf(p)"
            :is-selected="selectedPaths.has(p.path)"
            :is-multi-select-mode="isMultiSelectMode"
            :guessed-gps="getGuessedGps(p)"
            @toggle-select="toggleSelect"
            @preview="(payload) => emit('preview', payload)"
            @locate="(c) => emit('locate', c)"
            @pick-gps="(photo) => emit('pick-gps', photo)"
            @solidify-gps="(payload) => emit('solidify-gps', payload)"
            @updated="() => emit('updated')"
          />
        </div>

        <!-- 滑动加载更多提示与操作 -->
        <div v-if="hasMore" class="d-flex flex-column align-center py-4 ga-2">
          <v-btn
            variant="tonal"
            color="primary"
            density="comfortable"
            prepend-icon="mdi-arrow-down"
            @click="loadMore"
          >
            {{
              t('yarj.drawer.loadMore', '加载更多照片 ({current}/{total})')
                .replace('{current}', String(displayedPhotos.length))
                .replace('{total}', String(filteredPhotos.length))
            }}
          </v-btn>
        </div>
      </div>

      <!-- 抽屉底部多选控制底栏 -->
      <v-divider />
      <div class="drawer-footer px-4 py-2 d-flex align-center justify-space-between">
        <!-- 多选开关与选中计数 -->
        <div class="d-flex align-center ga-2">
          <v-switch
            v-model="isMultiSelectMode"
            color="primary"
            density="compact"
            hide-details
            :label="t('yarj.drawer.multiSelect', '多选')"
          />
          <span v-if="isMultiSelectMode" class="text-caption on-surface-variant font-mono">
            ({{ selectedCount }}/{{ filteredPhotos.length }})
          </span>
        </div>

        <!-- 多选模式下的操作按钮 -->
        <div v-if="isMultiSelectMode" class="d-flex align-center ga-2">
          <v-btn
            variant="text"
            size="small"
            :disabled="!filteredPhotos.length"
            @click="toggleSelectAll"
          >
            {{
              isAllSelected
                ? t('yarj.drawer.deselectAll', '全不选')
                : t('yarj.drawer.selectAll', '全选')
            }}
          </v-btn>
          <v-btn
            variant="flat"
            color="primary"
            prepend-icon="mdi-map-marker-distance"
            :disabled="selectedCount === 0"
            @click="triggerRelocate"
          >
            {{ t('yarj.drawer.relocateSelectedBtn', '平移所选') }}
          </v-btn>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 高级搜索语法帮助对话框 -->
  <SearchHelpDialog v-model="searchHelpOpen" />
</template>

<style scoped>
.yarj-photo-drawer {
  position: absolute;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: 420px;
  max-width: calc(100vw - 32px);
  z-index: 25;
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.9);
  backdrop-filter: blur(24px) saturate(1.2);
  -webkit-backdrop-filter: blur(24px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 18px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  user-select: none;
}

.drawer-header {
  flex-shrink: 0;
  background: rgba(var(--v-theme-surface), 0.4);
}

.drawer-footer {
  flex-shrink: 0;
  background: rgba(var(--v-theme-surface), 0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  min-height: 52px;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.drawer-body::-webkit-scrollbar {
  width: 6px;
}

.drawer-body::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.4);
  border-radius: 3px;
}

/* 过渡动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition:
    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.2s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(440px);
  opacity: 0;
}
</style>
