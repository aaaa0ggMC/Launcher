<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-drawer' })

import { ref, computed, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, ReverseGeocodeResult } from '../types'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  coords: [number, number] | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'updated'): void
  (e: 'preview', payload: { photo: Photo; index: number }): void
  (e: 'pick-gps', photo: Photo): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const filterQuery = ref('')

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
    await window.cockpit.command('system.show-item-in-folder', { path: filePath })
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

      <v-divider />

      <!-- 照片列表卡片流（过滤搜索框嵌入此文档流最顶部，随内容滚动，不占固定视口高度） -->
      <div class="drawer-body px-4 py-4">
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
            v-for="(p, idx) in filteredPhotos"
            :key="p.id || idx"
            variant="tonal"
            rounded="xl"
            class="photo-card"
          >
            <!-- 缩略图区域（点击打开 Lightbox 放大预览） -->
            <div
              class="photo-img-wrap cursor-zoom-in"
              :title="t('yarj.drawer.previewHint', '点击全屏查看与缩放拖拽')"
              @click="emit('preview', { photo: p, index: idx })"
            >
              <img
                :src="`cockpit-icon://${encodeURIComponent(p.path)}`"
                :alt="getFileName(p.path)"
                class="photo-img"
                loading="lazy"
              />
              <div class="photo-img-badge text-caption">
                {{ p.camera_model || p.camera_make || 'Photo' }}
              </div>
              <div class="photo-zoom-icon">
                <v-icon size="26" color="white">mdi-magnify-plus-outline</v-icon>
              </div>
            </div>

            <!-- 照片信息与标签 -->
            <v-card-text class="pa-4 pb-2">
              <div class="d-flex align-center justify-space-between mb-2">
                <div
                  class="text-body-2 font-weight-bold text-truncate flex-grow-1 mr-3 cursor-pointer"
                  :title="p.path"
                  @click="emit('preview', { photo: p, index: idx })"
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
