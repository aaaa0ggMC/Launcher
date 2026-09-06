<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-card-item' })

import { ref, computed, watch, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, ReverseGeocodeResult, GuessedGps } from '../types'
import { isVideoFile, photoThumbUrl } from '../types'
import JsonTreeView from './JsonTreeView.vue'

const props = defineProps<{
  photo: Photo
  index: number
  isSelected: boolean
  isMultiSelectMode: boolean
  guessedGps?: GuessedGps | null
  cachedAddress?: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle-select', path: string): void
  (e: 'preview', payload: { photo: Photo; index: number }): void
  (e: 'locate', coords: [number, number]): void
  (e: 'pick-gps', photo: Photo): void
  (e: 'solidify-gps', payload: { photo: Photo; guess: GuessedGps }): void
  (e: 'updated'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const isEditing = ref(false)
const editingTags = ref('')
const editingComment = ref('')
const editingLat = ref('')
const editingLon = ref('')
const saving = ref(false)
const geocoding = ref(false)
const solidifying = ref(false)
const isJsonExpanded = ref(false)

const photoAddress = ref<string | null>(
  props.cachedAddress ||
    (typeof props.photo.appendix?.formatted_address === 'string'
      ? props.photo.appendix.formatted_address
      : null)
)

watch(
  () => props.cachedAddress,
  (addr) => {
    if (addr) photoAddress.value = addr
  }
)

watch(
  () => props.photo,
  (p) => {
    if (typeof p.appendix?.formatted_address === 'string') {
      photoAddress.value = p.appendix.formatted_address
    }
  }
)

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
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

const photoTags = computed<string[]>(() => {
  if (Array.isArray(props.photo.appendix?.tags)) {
    return props.photo.appendix.tags.map(String)
  }
  return []
})

const photoComment = computed<string>(() => {
  if (typeof props.photo.appendix?.comment === 'string') {
    return props.photo.appendix.comment
  }
  return ''
})

function startEdit(): void {
  isEditing.value = true
  editingTags.value = photoTags.value.join(', ')
  editingComment.value = photoComment.value
  editingLat.value = props.photo.gps_lat != null ? String(props.photo.gps_lat) : ''
  editingLon.value = props.photo.gps_lon != null ? String(props.photo.gps_lon) : ''
}

function cancelEdit(): void {
  isEditing.value = false
}

async function saveEdit(): Promise<void> {
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
      path: props.photo.path,
      patch,
      lat: Number.isNaN(newLat) ? undefined : newLat,
      lon: Number.isNaN(newLon) ? undefined : newLon
    })

    const p = props.photo
    p.appendix = {
      ...p.appendix,
      tags: rawTags,
      comment: editingComment.value.trim()
    }
    if (!Number.isNaN(newLat)) p.gps_lat = newLat
    if (!Number.isNaN(newLon)) p.gps_lon = newLon

    isEditing.value = false
    emit('updated')
  } catch (err) {
    console.error('Failed to update photo:', err)
  } finally {
    saving.value = false
  }
}

async function triggerReverseGeocode(): Promise<void> {
  if (props.photo.gps_lat == null || props.photo.gps_lon == null || geocoding.value) return
  geocoding.value = true
  try {
    const res = (await window.cockpit.command('yarj.reverse-geocode', {
      lat: props.photo.gps_lat,
      lon: props.photo.gps_lon,
      lang: uiLang.value
    })) as { ok?: boolean; result?: ReverseGeocodeResult } | null

    if (res?.ok && res.result) {
      photoAddress.value = res.result.formattedAddress
      await window.cockpit.command('yarj.update-photo', {
        path: props.photo.path,
        patch: {
          formatted_address: res.result.formattedAddress,
          city: res.result.city,
          country: res.result.country
        }
      })
      const p = props.photo
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
    geocoding.value = false
  }
}

async function solidifyGps(): Promise<void> {
  const guess = props.guessedGps
  if (!guess || solidifying.value) return
  solidifying.value = true
  try {
    const res = (await window.cockpit.command('yarj.update-photo', {
      path: props.photo.path,
      lat: guess.lat,
      lon: guess.lon,
      patch: { gps_source: 'solidified_guess' }
    })) as { ok: boolean; photo?: Photo }
    if (res?.ok) {
      const p = props.photo
      p.gps_lat = guess.lat
      p.gps_lon = guess.lon
      p.appendix = {
        ...p.appendix,
        gps_source: 'solidified_guess'
      }
      emit('solidify-gps', { photo: p, guess })
      emit('updated')
    }
  } catch (err) {
    console.error('Failed to solidify photo GPS:', err)
  } finally {
    solidifying.value = false
  }
}

async function onSaveJsonTree(updatedObj: unknown): Promise<void> {
  if (!updatedObj || typeof updatedObj !== 'object') return
  const data = updatedObj as Record<string, unknown>
  const patch = (
    data.appendix && typeof data.appendix === 'object' ? data.appendix : data
  ) as Record<string, unknown>
  saving.value = true
  try {
    const res = (await window.cockpit.command('yarj.update-photo', {
      path: props.photo.path,
      patch
    })) as { ok: boolean; photo?: Photo }
    if (res?.ok && res.photo) {
      const p = props.photo
      p.appendix = { ...res.photo.appendix }
      emit('updated')
    }
  } catch (err) {
    console.error('Failed to save appendix JSON:', err)
  } finally {
    saving.value = false
  }
}

async function openInFolder(): Promise<void> {
  try {
    await window.cockpit.command('yarj.show-item-in-folder', { path: props.photo.path })
  } catch {
    /* ignore */
  }
}

async function copyPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.photo.path)
  } catch {
    /* ignore */
  }
}

function handleCardClick(): void {
  if (props.isMultiSelectMode) {
    emit('toggle-select', props.photo.path)
  } else {
    emit('preview', { photo: props.photo, index: props.index })
  }
}
</script>

<template>
  <v-card variant="tonal" rounded="xl" class="photo-card" :class="{ 'is-selected': isSelected }">
    <!-- 缩略图区域 -->
    <div
      class="photo-img-wrap"
      :class="{
        'cursor-zoom-in': !isMultiSelectMode,
        'cursor-pointer': isMultiSelectMode
      }"
      :title="
        isMultiSelectMode
          ? isSelected
            ? t('yarj.drawer.deselectPhoto', '取消勾选')
            : t('yarj.drawer.selectPhoto', '勾选此照片')
          : t('yarj.drawer.previewHint', '点击全屏查看与缩放拖拽')
      "
      @click="handleCardClick"
    >
      <!-- 快捷勾选框 -->
      <div
        class="photo-select-checkbox"
        :class="{ 'show-always': isMultiSelectMode || isSelected }"
        :title="
          isSelected
            ? t('yarj.drawer.deselectPhoto', '取消勾选')
            : t('yarj.drawer.selectPhoto', '勾选此照片')
        "
        @click.stop="emit('toggle-select', photo.path)"
      >
        <v-icon size="20" :color="isSelected ? 'primary' : 'white'">
          {{ isSelected ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}
        </v-icon>
      </div>

      <v-img
        :src="photoThumbUrl(photo.path)"
        :alt="getFileName(photo.path)"
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
        <v-icon v-if="isVideoFile(photo.path)" size="14" color="white">mdi-video</v-icon>
        <span>{{
          photo.camera_model || photo.camera_make || (isVideoFile(photo.path) ? 'Video' : 'Photo')
        }}</span>
      </div>
      <div v-if="!isMultiSelectMode" class="photo-zoom-icon">
        <v-icon size="26" color="white">{{
          isVideoFile(photo.path) ? 'mdi-play-circle-outline' : 'mdi-magnify-plus-outline'
        }}</v-icon>
      </div>
    </div>

    <!-- 照片信息与标签 -->
    <v-card-text class="pa-4 pb-2">
      <div class="d-flex align-center justify-space-between mb-2">
        <div
          class="text-body-2 font-weight-bold text-truncate flex-grow-1 mr-3 cursor-pointer"
          :title="photo.path"
          @click="handleCardClick"
        >
          {{ getFileName(photo.path) }}
        </div>
        <div class="text-caption on-surface-variant flex-shrink-0">
          {{ formatDate(photo.taken_at) }}
        </div>
      </div>

      <!-- 智能逆地理编码解析出的地址展示 -->
      <div v-if="photoAddress && !isEditing" class="photo-addr-box text-caption mb-3">
        <v-icon size="14" color="primary" class="mr-1">mdi-map-marker</v-icon>
        <span>{{ photoAddress }}</span>
      </div>

      <!-- 智能时空速度纠正结果展示 -->
      <div
        v-if="photo.gps_corrected && !isEditing"
        class="photo-corrected-box text-caption mb-3 pa-2 rounded-lg"
      >
        <div class="d-flex align-center justify-space-between mb-1">
          <div class="d-flex align-center ga-1 text-secondary font-weight-bold">
            <v-icon size="16" color="secondary">mdi-auto-fix</v-icon>
            <span>{{ t('yarj.correct.badge', 'GPS 已纠正') }}</span>
          </div>
          <v-chip
            v-if="photo.gps_corrected.drift_distance_km"
            size="x-small"
            color="secondary"
            variant="tonal"
          >
            偏移 {{ photo.gps_corrected.drift_distance_km }} km
          </v-chip>
        </div>
        <div class="text-caption on-surface-variant mb-1 line-height-tight">
          {{ photo.gps_corrected.reason }}
        </div>
        <div class="d-flex align-center justify-space-between ga-2 mt-1">
          <div class="font-mono text-caption text-truncate on-surface-variant">
            {{ photo.gps_corrected.lat.toFixed(4) }}°, {{ photo.gps_corrected.lon.toFixed(4) }}°
          </div>
          <v-btn
            icon
            size="small"
            variant="text"
            color="secondary"
            :title="t('yarj.drawer.locate', '定位到地图中心')"
            @click.stop="emit('locate', [photo.gps_corrected.lon, photo.gps_corrected.lat])"
          >
            <v-icon size="18">mdi-crosshairs-gps</v-icon>
          </v-btn>
        </div>
      </div>

      <!-- 大致 GPS 猜测提示 -->
      <div
        v-if="guessedGps && !photo.gps_corrected && !isEditing"
        class="photo-guess-box text-caption mb-3 pa-2 rounded-lg"
      >
        <div class="d-flex align-center justify-space-between mb-1">
          <div class="d-flex align-center ga-1 text-warning font-weight-bold">
            <v-icon size="16" color="warning">mdi-map-marker-question-outline</v-icon>
            <span>{{ t('yarj.guess.badge', '大致 GPS 猜测') }}</span>
          </div>
          <v-chip size="x-small" color="warning" variant="tonal">
            {{ (guessedGps.distanceM / 1000).toFixed(1) }} km
          </v-chip>
        </div>
        <div class="d-flex align-center justify-space-between ga-2 mt-2">
          <div class="font-mono text-caption text-truncate on-surface-variant">
            {{ guessedGps.lat.toFixed(4) }}, {{ guessedGps.lon.toFixed(4) }}
          </div>
          <div class="d-flex align-center ga-1 flex-shrink-0">
            <v-btn
              variant="tonal"
              color="warning"
              prepend-icon="mdi-check-decagram"
              :loading="solidifying"
              @click.stop="solidifyGps"
            >
              {{ t('yarj.guess.solidify', '固化此位置') }}
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.drawer.locate', '定位到地图中心')"
              @click.stop="emit('locate', [guessedGps.lon, guessedGps.lat])"
            >
              <v-icon size="18">mdi-crosshairs-gps</v-icon>
            </v-btn>
          </div>
        </div>
      </div>

      <!-- 备注展示 -->
      <div v-if="photoComment && !isEditing" class="photo-comment text-caption mb-3">
        <v-icon size="15" class="mr-1 text-primary">mdi-comment-text-outline</v-icon>
        <span>{{ photoComment }}</span>
      </div>

      <!-- 标签展示 -->
      <div v-if="!isEditing" class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-chip
          v-for="tag in photoTags"
          :key="tag"
          variant="tonal"
          color="primary"
          class="photo-chip"
        >
          {{ tag }}
        </v-chip>
        <v-chip
          v-if="!photoTags.length && !photoComment"
          variant="outlined"
          class="on-surface-variant cursor-pointer photo-chip"
          @click="startEdit"
        >
          <v-icon size="14" class="mr-1">mdi-plus</v-icon>
          {{ t('yarj.drawer.addTag', '添加标签/备注') }}
        </v-chip>
      </div>

      <!-- 内联编辑表单（支持编辑标签、备注、GPS 经纬度） -->
      <div v-if="isEditing" class="edit-form mb-2 d-flex flex-column ga-3 pt-1">
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
          @click="emit('pick-gps', photo)"
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
          @keydown.enter="saveEdit"
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
          <v-btn color="primary" variant="flat" :loading="saving" @click="saveEdit">
            {{ t('yarj.drawer.save', '保存') }}
          </v-btn>
        </div>
      </div>

      <!-- 完整元数据 (JSON 树) -->
      <v-expand-transition>
        <div v-if="isJsonExpanded" class="mt-3">
          <JsonTreeView
            :data="photo"
            root-name="photo"
            :editable="isEditing"
            @save="onSaveJsonTree"
          />
        </div>
      </v-expand-transition>
    </v-card-text>

    <!-- 底部操作区 -->
    <v-card-actions class="px-4 pb-3 pt-1 ga-2 d-flex align-center flex-wrap">
      <div class="d-flex align-center ga-1">
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('yarj.drawer.edit', '编辑坐标、标签与备注')"
          @click="startEdit"
        >
          <v-icon size="18">mdi-pencil-outline</v-icon>
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :color="isJsonExpanded ? 'primary' : undefined"
          :title="t('yarj.lightbox.metadataTree', '查看完整数据库元数据 (JSON)')"
          @click="isJsonExpanded = !isJsonExpanded"
        >
          <v-icon size="18">mdi-code-json</v-icon>
        </v-btn>
        <v-btn
          v-if="photo.gps_lat != null && photo.gps_lon != null"
          icon
          size="small"
          variant="text"
          :loading="geocoding"
          :title="t('yarj.lightbox.reverseGeocode', '解析详细地名地址')"
          @click="triggerReverseGeocode"
        >
          <v-icon size="18">mdi-map-marker-radius</v-icon>
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('yarj.drawer.changeGps', '在地图上点击拾取/更改坐标')"
          @click="emit('pick-gps', photo)"
        >
          <v-icon size="18">mdi-map-marker-plus-outline</v-icon>
        </v-btn>
        <v-btn
          v-if="(photo.gps_lon != null && photo.gps_lat != null) || guessedGps"
          icon
          size="small"
          variant="text"
          :title="t('yarj.drawer.locate', '定位到地图中心')"
          @click="
            emit(
              'locate',
              photo.gps_lon != null && photo.gps_lat != null
                ? [photo.gps_lon as number, photo.gps_lat as number]
                : [guessedGps!.lon, guessedGps!.lat]
            )
          "
        >
          <v-icon size="18">mdi-crosshairs-gps</v-icon>
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('yarj.drawer.copyPath', '复制文件路径')"
          @click="copyPath"
        >
          <v-icon size="18">mdi-content-copy</v-icon>
        </v-btn>
      </div>

      <v-spacer />

      <v-btn variant="text" prepend-icon="mdi-folder-open-outline" @click="openInFolder">
        {{ t('yarj.drawer.showInFolder', '在文件夹中显示') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
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

.photo-card.is-selected {
  border-color: rgb(var(--v-theme-primary)) !important;
  box-shadow:
    0 0 0 1px rgb(var(--v-theme-primary)),
    0 4px 16px rgba(var(--v-theme-primary), 0.25);
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

.cursor-pointer {
  cursor: pointer;
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

.photo-addr-box {
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-primary), 0.08);
  border: 1px solid rgba(var(--v-theme-primary), 0.18);
  color: rgb(var(--v-theme-on-surface));
}

.photo-corrected-box {
  background: rgba(var(--v-theme-secondary), 0.08);
  border: 1px solid rgba(var(--v-theme-secondary), 0.3);
}

.line-height-tight {
  line-height: 1.4;
}

.photo-guess-box {
  background: rgba(var(--v-theme-warning), 0.08);
  border: 1px solid rgba(var(--v-theme-warning), 0.3);
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
</style>
