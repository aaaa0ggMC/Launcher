<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-drawer' })

import { ref, computed, inject, watch, nextTick } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, ReverseGeocodeResult } from '../types'
import { isVideoFile, photoThumbUrl } from '../types'
import JsonTreeView from './JsonTreeView.vue'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  coords: [number, number] | null
  pageSize?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'updated'): void
  (e: 'preview', payload: { photo: Photo; index: number }): void
  (e: 'pick-gps', photo: Photo): void
  (e: 'explore', photos: Photo[]): void
  (e: 'relocate-group', photos: Photo[]): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const filterQuery = ref('')
const expandedJsonPaths = ref<Set<string>>(new Set())

function toggleJsonTree(path: string): void {
  if (expandedJsonPaths.value.has(path)) {
    expandedJsonPaths.value.delete(path)
  } else {
    expandedJsonPaths.value.add(path)
  }
}

async function onSaveDrawerJsonTree(p: Photo, updatedObj: unknown): Promise<void> {
  if (!p || !updatedObj || typeof updatedObj !== 'object') return
  const data = updatedObj as Record<string, unknown>
  const patch = (
    data.appendix && typeof data.appendix === 'object' ? data.appendix : data
  ) as Record<string, unknown>
  saving.value = true
  try {
    const res = (await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      patch
    })) as { ok: boolean; photo?: Photo }
    if (res?.ok && res.photo) {
      p.appendix = { ...res.photo.appendix }
      emit('updated')
    }
  } catch (err) {
    console.error('Failed to save appendix JSON in drawer:', err)
  } finally {
    saving.value = false
  }
}

function matchPhoto(p: Photo, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().trim()
  const qTerms = q.split(/\s+/).filter(Boolean)
  if (!qTerms.length) return true

  const filename = (p.path.split('/').pop() || '').toLowerCase()
  const path = p.path.toLowerCase()
  const camera =
    `${p.camera_make || ''} ${p.camera_model || ''} ${p.lens_model || ''}`.toLowerCase()
  const comment = (typeof p.appendix?.comment === 'string' ? p.appendix.comment : '').toLowerCase()
  const address = (
    typeof p.appendix?.formatted_address === 'string' ? p.appendix.formatted_address : ''
  ).toLowerCase()
  const tags = Array.isArray(p.appendix?.tags)
    ? p.appendix.tags.map(String).join(' ').toLowerCase()
    : ''
  const city = (typeof p.appendix?.city === 'string' ? p.appendix.city : '').toLowerCase()
  const country = (typeof p.appendix?.country === 'string' ? p.appendix.country : '').toLowerCase()

  const combined = `${filename} ${path} ${camera} ${comment} ${address} ${tags} ${city} ${country}`
  return qTerms.every((term) => combined.includes(term))
}

const filteredPhotos = computed(() => {
  return props.photos.filter((p) => matchPhoto(p, filterQuery.value))
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

const editingPhotoPath = ref<string | null>(null)
const editingTags = ref<string>('')
const editingComment = ref<string>('')
const editingLat = ref<string>('')
const editingLon = ref<string>('')
const saving = ref(false)
const geocodingPath = ref<string | null>(null)
const reverseGeocodeMap = ref<Record<string, ReverseGeocodeResult>>({})

function startEdit(p: Photo): void {
  editingPhotoPath.value = p.path
  const currentTags = Array.isArray(p.appendix?.tags) ? p.appendix.tags.join(', ') : ''
  editingTags.value = currentTags
  editingComment.value = typeof p.appendix?.comment === 'string' ? p.appendix.comment : ''
  editingLat.value = p.gps_lat != null ? String(p.gps_lat) : ''
  editingLon.value = p.gps_lon != null ? String(p.gps_lon) : ''
}

function cancelEdit(): void {
  editingPhotoPath.value = null
}

async function saveEdit(p: Photo): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const rawTags = editingTags.value
      .split(/[,，、 ]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    const patch: Record<string, unknown> = {
      tags: rawTags,
      comment: editingComment.value.trim()
    }
    const newLat = editingLat.value.trim() ? parseFloat(editingLat.value.trim()) : null
    const newLon = editingLon.value.trim() ? parseFloat(editingLon.value.trim()) : null

    await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      patch,
      lat: Number.isNaN(newLat) ? undefined : newLat,
      lon: Number.isNaN(newLon) ? undefined : newLon
    })

    p.appendix = {
      ...p.appendix,
      tags: rawTags,
      comment: editingComment.value.trim()
    }
    if (!Number.isNaN(newLat)) p.gps_lat = newLat
    if (!Number.isNaN(newLon)) p.gps_lon = newLon

    editingPhotoPath.value = null
    emit('updated')
  } catch (err) {
    console.error('Failed to update photo:', err)
  } finally {
    saving.value = false
  }
}

async function triggerReverseGeocode(p: Photo): Promise<void> {
  if (p.gps_lat == null || p.gps_lon == null || geocodingPath.value) return
  geocodingPath.value = p.path
  try {
    const res = (await window.cockpit.command('yarj.reverse-geocode', {
      lat: p.gps_lat,
      lon: p.gps_lon,
      lang: uiLang.value
    })) as { ok?: boolean; result?: ReverseGeocodeResult } | null

    if (res?.ok && res.result) {
      reverseGeocodeMap.value[p.path] = res.result
      await window.cockpit.command('yarj.update-photo', {
        path: p.path,
        patch: {
          formatted_address: res.result.formattedAddress,
          city: res.result.city,
          country: res.result.country
        }
      })
      p.appendix = {
        ...p.appendix,
        formatted_address: res.result.formattedAddress,
        city: res.result.city,
        country: res.result.country
      }
      emit('updated')
    }
  } catch (err) {
    console.error('Reverse geocode failed:', err)
  } finally {
    geocodingPath.value = null
  }
}

function handlePhotoCardClick(p: Photo, idx: number): void {
  if (isMultiSelectMode.value) {
    toggleSelect(p.path)
  } else {
    emit('preview', { photo: p, index: idx })
  }
}

function getPhotoAddress(p: Photo): string | null {
  if (reverseGeocodeMap.value[p.path]) {
    return reverseGeocodeMap.value[p.path].formattedAddress
  }
  if (typeof p.appendix?.formatted_address === 'string') {
    return p.appendix.formatted_address
  }
  return null
}

function formatCoords(coords: [number, number] | null): string {
  if (!coords) return ''
  const [lon, lat] = coords
  const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`
  const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`
  return `${latStr}, ${lonStr}`
}

function formatDate(iso: string | null): string {
  if (!iso) return t('yarj.popup.unknownTime', '未知时间')
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(uiLang.value === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getPhotoTags(p: Photo): string[] {
  if (Array.isArray(p.appendix?.tags)) {
    return p.appendix.tags.map(String)
  }
  return []
}

function getPhotoComment(p: Photo): string {
  if (typeof p.appendix?.comment === 'string') {
    return p.appendix.comment
  }
  return ''
}

async function openInFolder(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.show-item-in-folder', { path: filePath })
  } catch {
    /* ignore */
  }
}

async function copyPath(filePath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(filePath)
  } catch {
    /* ignore */
  }
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
        <div v-if="photos.length > 0" class="mb-4">
          <v-text-field
            v-model="filterQuery"
            :placeholder="
              t('yarj.drawer.filterPlaceholder', '过滤当前列表照片（文件名、标签、备注…）')
            "
            density="compact"
            variant="outlined"
            hide-details
            clearable
            prepend-inner-icon="mdi-filter-variant"
          />
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
          <v-card
            v-for="(p, idx) in displayedPhotos"
            :key="p.id || idx"
            variant="tonal"
            rounded="xl"
            class="photo-card"
            :class="{ 'is-selected': selectedPaths.has(p.path) }"
          >
            <!-- 缩略图区域（点击打开 Lightbox 放大预览，多选模式下点击切换勾选） -->
            <div
              class="photo-img-wrap"
              :class="{
                'cursor-zoom-in': !isMultiSelectMode,
                'cursor-pointer': isMultiSelectMode
              }"
              :title="
                isMultiSelectMode
                  ? selectedPaths.has(p.path)
                    ? t('yarj.drawer.deselectPhoto', '取消勾选')
                    : t('yarj.drawer.selectPhoto', '勾选此照片')
                  : t('yarj.drawer.previewHint', '点击全屏查看与缩放拖拽')
              "
              @click="handlePhotoCardClick(p, filteredPhotos.indexOf(p))"
            >
              <!-- 快捷勾选框（多选模式或悬浮时显示） -->
              <div
                class="photo-select-checkbox"
                :class="{ 'show-always': isMultiSelectMode || selectedPaths.has(p.path) }"
                :title="
                  selectedPaths.has(p.path)
                    ? t('yarj.drawer.deselectPhoto', '取消勾选')
                    : t('yarj.drawer.selectPhoto', '勾选此照片')
                "
                @click.stop="toggleSelect(p.path)"
              >
                <v-icon size="20" :color="selectedPaths.has(p.path) ? 'primary' : 'white'">
                  {{
                    selectedPaths.has(p.path) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'
                  }}
                </v-icon>
              </div>

              <v-img
                :src="photoThumbUrl(p.path)"
                :alt="getFileName(p.path)"
                class="photo-img"
                cover
                height="200"
              >
                <template #placeholder>
                  <div
                    class="d-flex align-center justify-center fill-height"
                    style="background: rgba(0, 0, 0, 0.25)"
                  >
                    <v-progress-circular indeterminate color="primary" size="28" width="2.5" />
                  </div>
                </template>
                <template #error>
                  <div
                    class="d-flex flex-column align-center justify-center fill-height text-caption on-surface-variant ga-1"
                    style="background: rgba(0, 0, 0, 0.35)"
                  >
                    <v-icon size="26" color="warning">mdi-image-broken-variant</v-icon>
                    <span>{{ t('yarj.drawer.loadFailed', '加载失败') }}</span>
                  </div>
                </template>
              </v-img>
              <div class="photo-img-badge text-caption d-flex align-center ga-1">
                <v-icon v-if="isVideoFile(p.path)" size="14" color="white">mdi-video</v-icon>
                <span>{{
                  p.camera_model || p.camera_make || (isVideoFile(p.path) ? 'Video' : 'Photo')
                }}</span>
              </div>
              <div v-if="!isMultiSelectMode" class="photo-zoom-icon">
                <v-icon size="26" color="white">{{
                  isVideoFile(p.path) ? 'mdi-play-circle-outline' : 'mdi-magnify-plus-outline'
                }}</v-icon>
              </div>
            </div>

            <!-- 照片信息与标签 -->
            <v-card-text class="pa-4 pb-2">
              <div class="d-flex align-center justify-space-between mb-2">
                <div
                  class="text-body-2 font-weight-bold text-truncate flex-grow-1 mr-3 cursor-pointer"
                  :title="p.path"
                  @click="handlePhotoCardClick(p, idx)"
                >
                  {{ getFileName(p.path) }}
                </div>
                <div class="text-caption on-surface-variant flex-shrink-0">
                  {{ formatDate(p.taken_at) }}
                </div>
              </div>

              <!-- 智能逆地理编码解析出的地址展示 -->
              <div
                v-if="getPhotoAddress(p) && editingPhotoPath !== p.path"
                class="photo-addr-box text-caption mb-3"
              >
                <v-icon size="14" color="primary" class="mr-1">mdi-map-marker</v-icon>
                <span>{{ getPhotoAddress(p) }}</span>
              </div>

              <!-- 备注展示 -->
              <div
                v-if="getPhotoComment(p) && editingPhotoPath !== p.path"
                class="photo-comment text-caption mb-3"
              >
                <v-icon size="15" class="mr-1 text-primary">mdi-comment-text-outline</v-icon>
                <span>{{ getPhotoComment(p) }}</span>
              </div>

              <!-- 标签展示 -->
              <div
                v-if="editingPhotoPath !== p.path"
                class="d-flex flex-wrap align-center ga-2 mb-2"
              >
                <v-chip
                  v-for="tag in getPhotoTags(p)"
                  :key="tag"
                  variant="tonal"
                  color="primary"
                  class="photo-chip"
                >
                  {{ tag }}
                </v-chip>
                <v-chip
                  v-if="!getPhotoTags(p).length && !getPhotoComment(p)"
                  variant="outlined"
                  class="on-surface-variant cursor-pointer photo-chip"
                  @click="startEdit(p)"
                >
                  <v-icon size="14" class="mr-1">mdi-plus</v-icon>
                  {{ t('yarj.drawer.addTag', '添加标签/备注') }}
                </v-chip>
              </div>

              <!-- 内联编辑表单（支持编辑标签、备注、GPS 经纬度） -->
              <div
                v-if="editingPhotoPath === p.path"
                class="edit-form mb-2 d-flex flex-column ga-3 pt-1"
              >
                <div class="d-flex ga-3">
                  <v-text-field
                    v-model="editingLat"
                    :label="t('yarj.lightbox.latLabel', '纬度 (Lat)')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-text-field
                    v-model="editingLon"
                    :label="t('yarj.lightbox.lonLabel', '经度 (Lon)')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </div>
                <v-btn
                  variant="outlined"
                  prepend-icon="mdi-crosshairs-gps"
                  class="on-surface-variant"
                  @click="emit('pick-gps', p)"
                >
                  {{ t('yarj.drawer.pickOnMap', '在地图上点击拾取坐标') }}
                </v-btn>
                <v-text-field
                  v-model="editingTags"
                  :label="t('yarj.drawer.tagsLabel', '标签（逗号或空格分隔）')"
                  density="compact"
                  variant="outlined"
                  hide-details
                  autofocus
                  @keydown.enter="saveEdit(p)"
                  @keydown.esc="cancelEdit"
                />
                <v-textarea
                  v-model="editingComment"
                  :label="t('yarj.drawer.commentLabel', '备注 / 旅途记录')"
                  density="compact"
                  variant="outlined"
                  rows="2"
                  hide-details
                  no-resize
                  @keydown.esc="cancelEdit"
                />
                <div class="d-flex align-center justify-end ga-2 pt-2">
                  <v-btn variant="text" @click="cancelEdit">
                    {{ t('yarj.drawer.cancel', '取消') }}
                  </v-btn>
                  <v-btn color="primary" variant="flat" :loading="saving" @click="saveEdit(p)">
                    {{ t('yarj.drawer.save', '保存') }}
                  </v-btn>
                </div>
              </div>

              <!-- 完整元数据 (JSON 树) -->
              <v-expand-transition>
                <div v-if="expandedJsonPaths.has(p.path)" class="mt-3">
                  <JsonTreeView
                    :data="p"
                    root-name="photo"
                    :editable="editingPhotoPath === p.path"
                    @save="(patch) => onSaveDrawerJsonTree(p, patch)"
                  />
                </div>
              </v-expand-transition>
            </v-card-text>

            <!-- 底部操作区（遵循 apps 参考规范：分组、间距与呼吸感） -->
            <v-card-actions class="px-4 pb-3 pt-1 ga-2 d-flex align-center flex-wrap">
              <div class="d-flex align-center ga-1">
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :title="t('yarj.drawer.edit', '编辑坐标、标签与备注')"
                  @click="startEdit(p)"
                >
                  <v-icon size="18">mdi-pencil-outline</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :color="expandedJsonPaths.has(p.path) ? 'primary' : undefined"
                  :title="t('yarj.lightbox.metadataTree', '查看完整数据库元数据 (JSON)')"
                  @click="toggleJsonTree(p.path)"
                >
                  <v-icon size="18">mdi-code-json</v-icon>
                </v-btn>
                <v-btn
                  v-if="p.gps_lat != null && p.gps_lon != null"
                  icon
                  size="small"
                  variant="text"
                  :loading="geocodingPath === p.path"
                  :title="t('yarj.lightbox.reverseGeocode', '解析详细地名地址')"
                  @click="triggerReverseGeocode(p)"
                >
                  <v-icon size="18">mdi-map-marker-radius</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :title="t('yarj.drawer.changeGps', '在地图上点击拾取/更改坐标')"
                  @click="emit('pick-gps', p)"
                >
                  <v-icon size="18">mdi-map-marker-plus-outline</v-icon>
                </v-btn>
                <v-btn
                  v-if="p.gps_lon != null && p.gps_lat != null"
                  icon
                  size="small"
                  variant="text"
                  :title="t('yarj.drawer.locate', '定位到地图中心')"
                  @click="emit('locate', [p.gps_lon as number, p.gps_lat as number])"
                >
                  <v-icon size="18">mdi-crosshairs-gps</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :title="t('yarj.drawer.copyPath', '复制文件路径')"
                  @click="copyPath(p.path)"
                >
                  <v-icon size="18">mdi-content-copy</v-icon>
                </v-btn>
              </div>

              <v-spacer />

              <v-btn
                variant="text"
                prepend-icon="mdi-folder-open-outline"
                @click="openInFolder(p.path)"
              >
                {{ t('yarj.drawer.showInFolder', '在文件夹中显示') }}
              </v-btn>
            </v-card-actions>
          </v-card>
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

.photo-card.is-selected {
  border-color: rgb(var(--v-theme-primary)) !important;
  box-shadow:
    0 0 0 1px rgb(var(--v-theme-primary)),
    0 4px 16px rgba(var(--v-theme-primary), 0.25);
}

.photo-select-checkbox {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 5;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    background-color 0.15s ease;
}

.photo-select-checkbox.show-always,
.photo-img-wrap:hover .photo-select-checkbox {
  opacity: 1;
}

.photo-select-checkbox:hover {
  transform: scale(1.1);
  background: rgba(0, 0, 0, 0.78);
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

.photo-card {
  overflow: hidden;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
}

.photo-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.45);
}

.photo-img-wrap {
  position: relative;
  width: 100%;
  height: 200px;
  background: rgba(0, 0, 0, 0.25);
  overflow: hidden;
}

.cursor-zoom-in {
  cursor: zoom-in;
}

.photo-zoom-icon {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.photo-img-wrap:hover .photo-zoom-icon {
  opacity: 1;
}

.photo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-img-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(8px);
  color: #ffffff;
  font-size: 0.75rem;
}

.photo-addr-box {
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-primary), 0.08);
  border: 1px solid rgba(var(--v-theme-primary), 0.18);
  color: rgb(var(--v-theme-on-surface));
}

.photo-comment {
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.5);
  border-left: 3px solid rgb(var(--v-theme-primary));
  white-space: pre-wrap;
  word-break: break-word;
}

.photo-chip {
  min-height: 24px !important;
  padding-block: 4px !important;
}

.cursor-pointer {
  cursor: pointer;
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
