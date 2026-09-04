<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-lightbox' })

import { ref, computed, watch, onBeforeUnmount, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, ReverseGeocodeResult } from '../types'
import { isVideoFile, photoThumbUrl } from '../types'
import JsonTreeView from './JsonTreeView.vue'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  initialIndex: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'pick-gps', photo: Photo): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const currentIndex = ref(props.initialIndex ?? 0)
const showInfo = ref(true)
const isEditing = ref(false)
const saving = ref(false)
const geocoding = ref(false)
const geocodeResult = ref<ReverseGeocodeResult | null>(null)
const showJsonMetadata = ref(false)

// 变换状态：缩放、拖拽平移、旋转
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const rotate = ref(0)

const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
let pointerDownPos = { x: 0, y: 0 }

// 内联编辑表单
const editTags = ref('')
const editComment = ref('')
const editLat = ref('')
const editLon = ref('')

const currentPhoto = computed<Photo | null>(() => {
  if (!props.photos.length) return null
  const idx = Math.max(0, Math.min(currentIndex.value, props.photos.length - 1))
  return props.photos[idx] ?? null
})

watch(
  () => props.initialIndex,
  (idx) => {
    if (idx >= 0 && idx < props.photos.length) {
      currentIndex.value = idx
      resetTransform()
      loadCurrentPhotoData()
    }
  }
)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      currentIndex.value = Math.max(0, Math.min(props.initialIndex, props.photos.length - 1))
      resetTransform()
      loadCurrentPhotoData()
      window.addEventListener('keydown', onKeyDown)
    } else {
      window.removeEventListener('keydown', onKeyDown)
    }
  }
)

watch(currentIndex, () => {
  resetTransform()
  loadCurrentPhotoData()
})

function loadCurrentPhotoData(): void {
  mediaLoading.value = true
  videoPlayError.value = false
  isEditing.value = false
  geocodeResult.value = null
  const p = currentPhoto.value
  if (!p) return
  editTags.value = Array.isArray(p.appendix?.tags) ? p.appendix.tags.join(', ') : ''
  editComment.value = typeof p.appendix?.comment === 'string' ? p.appendix.comment : ''
  editLat.value = p.gps_lat != null ? String(p.gps_lat) : ''
  editLon.value = p.gps_lon != null ? String(p.gps_lon) : ''

  if (typeof p.appendix?.formatted_address === 'string') {
    geocodeResult.value = {
      formattedAddress: p.appendix.formatted_address,
      city: typeof p.appendix.city === 'string' ? p.appendix.city : undefined,
      country: typeof p.appendix.country === 'string' ? p.appendix.country : undefined,
      provider: 'cache'
    }
  }
}

function resetTransform(): void {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
  rotate.value = 0
}

function zoomIn(): void {
  scale.value = Math.min(10, +(scale.value * 1.25).toFixed(2))
}

function zoomOut(): void {
  scale.value = Math.max(0.1, +(scale.value / 1.25).toFixed(2))
}

const mediaLoading = ref(true)
const videoPlayError = ref(false)

function onVideoError(e: Event): void {
  mediaLoading.value = false
  videoPlayError.value = true
  const v = e.target as HTMLVideoElement
  console.warn('Video playback error:', v.error?.code, v.error?.message, v.src)
}

function onMediaLoaded(): void {
  mediaLoading.value = false
  videoPlayError.value = false
}

async function openExternalVideo(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.open-path', { path: filePath })
  } catch {
    /* ignore */
  }
}

function rotateClockwise(): void {
  rotate.value = (rotate.value + 90) % 360
}

function rotateCounterClockwise(): void {
  rotate.value = (rotate.value - 90 + 360) % 360
}

function prevPhoto(): void {
  if (currentIndex.value > 0) {
    currentIndex.value--
  } else {
    currentIndex.value = props.photos.length - 1
  }
}

function nextPhoto(): void {
  if (currentIndex.value < props.photos.length - 1) {
    currentIndex.value++
  } else {
    currentIndex.value = 0
  }
}

function onWheel(e: WheelEvent): void {
  if (isVideoFile(props.photos[currentIndex.value]?.path) && !e.ctrlKey) return
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 0.85
  const newScale = Math.max(0.1, Math.min(10, +(scale.value * factor).toFixed(2)))
  scale.value = newScale
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  if (
    target.closest('.lightbox-bottom-nav') ||
    target.closest('.v-btn') ||
    target.closest('.lightbox-info-drawer') ||
    target.closest('.lightbox-topbar') ||
    target.closest('video') ||
    target.closest('.video-error-fallback')
  ) {
    return
  }
  isDragging.value = true
  pointerDownPos = { x: e.clientX, y: e.clientY }
  dragStartX.value = e.clientX - translateX.value
  dragStartY.value = e.clientY - translateY.value
  const currentTarget = e.currentTarget as HTMLElement
  try {
    currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!isDragging.value) return
  translateX.value = e.clientX - dragStartX.value
  translateY.value = e.clientY - dragStartY.value
}

function handleLocateCurrentPhoto(): void {
  if (currentPhoto.value?.gps_lon != null && currentPhoto.value?.gps_lat != null) {
    emit('locate', [currentPhoto.value.gps_lon, currentPhoto.value.gps_lat])
  }
}

function onPointerUp(e: PointerEvent): void {
  isDragging.value = false
  const target = e.currentTarget as HTMLElement
  try {
    target.releasePointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
}

function onDoubleClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (
    target.closest('.lightbox-bottom-nav') ||
    target.closest('.v-btn') ||
    target.closest('video') ||
    target.closest('.video-error-fallback')
  ) {
    return
  }
  if (scale.value > 1.2) {
    resetTransform()
  } else {
    scale.value = 2.5
  }
}

function onStageClick(e: MouseEvent): void {
  const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y)
  if (dist > 6) return // 拖拽平移中不触发背景退出
  const target = e.target as HTMLElement
  if (target.classList.contains('lightbox-stage')) {
    emit('close')
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
    if (e.key === 'Escape') isEditing.value = false
    return
  }

  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === 'ArrowLeft') {
    prevPhoto()
  } else if (e.key === 'ArrowRight') {
    nextPhoto()
  } else if (e.key === '+' || e.key === '=') {
    zoomIn()
  } else if (e.key === '-' || e.key === '_') {
    zoomOut()
  } else if (e.key === '0') {
    resetTransform()
  } else if (e.key === 'r' || e.key === 'R') {
    if (e.shiftKey) {
      rotateCounterClockwise()
    } else {
      rotateClockwise()
    }
  } else if (e.key === 'l' || e.key === 'L') {
    rotateCounterClockwise()
  } else if (e.key === 'i' || e.key === 'I') {
    showInfo.value = !showInfo.value
  }
}

async function requestReverseGeocode(): Promise<void> {
  const p = currentPhoto.value
  if (!p || p.gps_lat == null || p.gps_lon == null || geocoding.value) return
  geocoding.value = true
  try {
    const res = (await window.cockpit.command('yarj.reverse-geocode', {
      lat: p.gps_lat,
      lon: p.gps_lon,
      lang: uiLang.value
    })) as { ok?: boolean; result?: ReverseGeocodeResult } | null

    if (res?.ok && res.result) {
      geocodeResult.value = res.result
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
    geocoding.value = false
  }
}

function addAddressToTags(): void {
  const p = currentPhoto.value
  const addr = geocodeResult.value
  if (!p || !addr) return
  const current = Array.isArray(p.appendix?.tags) ? [...p.appendix.tags] : []
  const candidates = [addr.city, addr.country].filter(Boolean) as string[]
  let changed = false
  for (const c of candidates) {
    if (!current.includes(c)) {
      current.push(c)
      changed = true
    }
  }
  if (changed) {
    editTags.value = current.join(', ')
    void saveLightboxEdit()
  }
}

async function saveLightboxEdit(): Promise<void> {
  const p = currentPhoto.value
  if (!p || saving.value) return
  saving.value = true
  try {
    const rawTags = editTags.value
      .split(/[,，、 ]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    const patch: Record<string, unknown> = {
      tags: rawTags,
      comment: editComment.value.trim()
    }
    const newLat = editLat.value.trim() ? parseFloat(editLat.value.trim()) : null
    const newLon = editLon.value.trim() ? parseFloat(editLon.value.trim()) : null

    await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      patch,
      lat: Number.isNaN(newLat) ? undefined : newLat,
      lon: Number.isNaN(newLon) ? undefined : newLon
    })

    p.appendix = {
      ...p.appendix,
      tags: rawTags,
      comment: editComment.value.trim()
    }
    if (!Number.isNaN(newLat)) p.gps_lat = newLat
    if (!Number.isNaN(newLon)) p.gps_lon = newLon

    isEditing.value = false
    emit('updated')
  } catch (err) {
    console.error('Failed to save edit:', err)
  } finally {
    saving.value = false
  }
}

async function onSaveJsonTree(updatedObj: unknown): Promise<void> {
  const p = currentPhoto.value
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
    console.error('Failed to save appendix JSON:', err)
  } finally {
    saving.value = false
  }
}

async function openInFolder(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.show-item-in-folder', { path: filePath })
  } catch {
    /* ignore */
  }
}

function formatCoords(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return t('yarj.lightbox.noGps', '无 GPS 定位')
  const latStr = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`
  const lonStr = `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`
  return `${latStr}, ${lonStr}`
}

function formatDate(iso: string | null): string {
  if (!iso) return t('yarj.popup.unknownTime', '未知时间')
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(uiLang.value === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

function formatExposure(s?: string | null): string {
  if (!s) return '—'
  return s.includes('/') ? `${s}s` : `${s}s`
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <Transition name="fade">
    <div v-if="open && currentPhoto" class="yarj-lightbox-overlay" @click.self="emit('close')">
      <!-- 顶部快捷控制条 -->
      <div class="lightbox-topbar d-flex align-center justify-space-between px-5 py-3">
        <div class="d-flex align-center ga-3 min-w-0 flex-grow-1 mr-4">
          <v-btn
            variant="tonal"
            prepend-icon="mdi-arrow-left"
            :title="t('yarj.lightbox.back', '返回地图 (Esc)')"
            @click="emit('close')"
          >
            {{ t('yarj.lightbox.back', '返回地图') }}
          </v-btn>
          <v-chip variant="tonal" color="primary" class="photo-top-chip">
            {{ currentIndex + 1 }} / {{ photos.length }}
          </v-chip>
          <span class="text-body-2 font-weight-bold text-truncate" :title="currentPhoto.path">
            {{ currentPhoto.path.split('/').pop() }}
          </span>
        </div>

        <div class="d-flex align-center ga-2">
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.zoomIn', '放大 (+)')"
            @click="zoomIn"
          >
            <v-icon size="20">mdi-magnify-plus-outline</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.zoomOut', '缩小 (-)')"
            @click="zoomOut"
          >
            <v-icon size="20">mdi-magnify-minus-outline</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.reset', '复位 (0)')"
            @click="resetTransform"
          >
            <v-icon size="20">mdi-fit-to-screen-outline</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.rotateLeft', '逆时针旋转 (Shift+R)')"
            @click="rotateCounterClockwise"
          >
            <v-icon size="20">mdi-rotate-left</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.rotate', '顺时针旋转 (R)')"
            @click="rotateClockwise"
          >
            <v-icon size="20">mdi-rotate-right</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :color="showInfo ? 'primary' : 'default'"
            :title="t('yarj.lightbox.toggleInfo', '详细信息 (I)')"
            @click="showInfo = !showInfo"
          >
            <v-icon size="20">mdi-information-outline</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            :title="t('yarj.lightbox.showInFolder', '在文件夹中打开')"
            @click="openInFolder(currentPhoto.path)"
          >
            <v-icon size="20">mdi-folder-open-outline</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            color="error"
            :title="t('yarj.drawer.close', '关闭 (Esc)')"
            @click="emit('close')"
          >
            <v-icon size="22">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>

      <!-- 中间主内容区：图像/视频舞台与右侧信息侧栏并排 -->
      <div class="lightbox-content d-flex flex-grow-1 min-h-0 position-relative">
        <div
          class="lightbox-stage"
          :class="{ 'is-dragging': isDragging }"
          @click="onStageClick"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @dblclick="onDoubleClick"
        >
          <!-- 媒体加载中旋转指示器（在加载完成前转圈，加载后淡入显示） -->
          <div v-if="mediaLoading && !videoPlayError" class="lightbox-media-spinner">
            <v-progress-circular indeterminate color="primary" size="56" width="3.5" />
          </div>

          <!-- 视频播放器与特殊格式外置播放器降级卡片 -->
          <div v-if="isVideoFile(currentPhoto.path)" class="lightbox-video-container">
            <video
              v-show="!videoPlayError"
              :key="currentPhoto.path"
              :src="`cockpit-icon://${encodeURIComponent(currentPhoto.path)}`"
              :poster="photoThumbUrl(currentPhoto.path)"
              controls
              autoplay
              crossorigin="anonymous"
              playsinline
              class="lightbox-video"
              :style="{
                transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotate}deg)`,
                opacity: mediaLoading ? 0 : 1
              }"
              @error="onVideoError"
              @loadeddata="onMediaLoaded"
              @canplay="onMediaLoaded"
              @pointerdown.stop
              @pointerup.stop
              @pointermove.stop
              @mousedown.stop
              @mouseup.stop
              @click.stop
              @dblclick.stop
            />
            <div v-if="videoPlayError" class="video-error-fallback pa-6 text-center rounded-2xl">
              <v-icon size="48" color="warning" class="mb-3">mdi-alert-circle-outline</v-icon>
              <div class="text-h6 font-weight-bold mb-1">
                {{ t('yarj.lightbox.videoDecodeFailed', '内嵌播放器无法直接播放此视频') }}
              </div>
              <div class="text-body-2 on-surface-variant mb-5">
                {{
                  t(
                    'yarj.lightbox.videoExternalTip',
                    '可能为特殊编码或专有格式（如 HEVC/H.265 10-bit），可一键调用系统播放器流畅播放'
                  )
                }}
              </div>
              <div class="d-flex ga-3 justify-center">
                <v-btn
                  variant="flat"
                  color="primary"
                  prepend-icon="mdi-play-circle"
                  @click="openExternalVideo(currentPhoto.path)"
                >
                  {{ t('yarj.lightbox.openExternalPlayer', '在系统播放器中打开') }}
                </v-btn>
                <v-btn
                  variant="tonal"
                  prepend-icon="mdi-folder-open-outline"
                  @click="openInFolder(currentPhoto.path)"
                >
                  {{ t('yarj.lightbox.showInFolder', '在文件夹中打开') }}
                </v-btn>
              </div>
            </div>
          </div>
          <img
            v-else
            :src="`cockpit-icon://${encodeURIComponent(currentPhoto.path)}`"
            :alt="currentPhoto.path"
            class="lightbox-img"
            :style="{
              transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotate}deg)`,
              opacity: mediaLoading ? 0 : 1
            }"
            draggable="false"
            @load="onMediaLoaded"
            @error="mediaLoading = false"
          />

          <!-- 画面下方悬浮居中切换控制条（上一张 / 计数 / 下一张） -->
          <div v-if="photos.length > 1" class="lightbox-bottom-nav">
            <v-btn
              variant="tonal"
              icon="mdi-chevron-left"
              size="small"
              class="bottom-nav-btn"
              :title="t('yarj.lightbox.prev', '上一张 (←)')"
              @pointerdown.stop
              @pointerup.stop
              @dblclick.stop
              @click.stop="prevPhoto"
            />
            <div class="bottom-nav-counter px-3 font-mono text-caption font-weight-bold">
              {{ currentIndex + 1 }} / {{ photos.length }}
            </div>
            <v-btn
              variant="tonal"
              icon="mdi-chevron-right"
              size="small"
              class="bottom-nav-btn"
              :title="t('yarj.lightbox.next', '下一张 (→)')"
              @pointerdown.stop
              @pointerup.stop
              @dblclick.stop
              @click.stop="nextPhoto"
            />
          </div>
        </div>

        <!-- 右侧 EXIF 与智能地址信息侧栏 -->
        <Transition name="drawer-slide">
          <div v-if="showInfo" class="lightbox-info-drawer">
            <div class="drawer-header d-flex align-center justify-space-between px-4 py-3">
              <span class="text-subtitle-1 font-weight-bold">{{
                t('yarj.lightbox.details', '照片详细信息')
              }}</span>
              <v-btn
                v-if="!isEditing"
                variant="tonal"
                color="primary"
                prepend-icon="mdi-pencil"
                @click="isEditing = true"
              >
                {{ t('yarj.lightbox.editGpsTags', '编辑坐标/备注') }}
              </v-btn>
            </div>

            <v-divider />

            <div class="drawer-scroll px-4 py-4 d-flex flex-column ga-4">
              <!-- 媒体类型 -->
              <div class="info-group">
                <div class="text-caption font-weight-bold on-surface-variant mb-1">
                  {{ t('yarj.lightbox.mediaType', '媒体类型') }}
                </div>
                <div class="d-flex align-center ga-2 text-body-2 font-weight-medium">
                  <v-icon
                    size="18"
                    :color="isVideoFile(currentPhoto.path) ? 'primary' : 'secondary'"
                  >
                    {{ isVideoFile(currentPhoto.path) ? 'mdi-video' : 'mdi-image' }}
                  </v-icon>
                  <span>{{
                    isVideoFile(currentPhoto.path)
                      ? t('yarj.lightbox.video', '视频短片')
                      : t('yarj.lightbox.image', '照片图片')
                  }}</span>
                  <span
                    v-if="currentPhoto.width && currentPhoto.height"
                    class="text-caption on-surface-variant ml-1 font-mono"
                  >
                    · {{ currentPhoto.width }} × {{ currentPhoto.height }}
                  </span>
                </div>
              </div>

              <!-- 拍摄设备与基本信息 -->
              <div class="info-group">
                <div class="text-caption font-weight-bold on-surface-variant mb-1">
                  {{ t('yarj.lightbox.cameraInfo', '拍摄设备') }}
                </div>
                <div class="text-body-1 font-weight-medium">
                  {{
                    [currentPhoto.camera_make, currentPhoto.camera_model]
                      .filter(Boolean)
                      .join(' ') || '—'
                  }}
                </div>
                <div v-if="currentPhoto.lens_model" class="text-caption on-surface-variant mt-1">
                  {{ currentPhoto.lens_model }}
                </div>
              </div>

              <!-- 拍摄参数 -->
              <div class="info-group">
                <div class="text-caption font-weight-bold on-surface-variant mb-2">
                  {{ t('yarj.lightbox.params', '拍摄参数') }}
                </div>
                <div class="d-flex flex-wrap ga-2 text-caption">
                  <v-chip variant="tonal" class="param-chip">
                    {{ formatDate(currentPhoto.taken_at) }}
                  </v-chip>
                  <v-chip v-if="currentPhoto.exposure_time" variant="tonal" class="param-chip">
                    {{ formatExposure(currentPhoto.exposure_time) }}
                  </v-chip>
                  <v-chip v-if="currentPhoto.f_number" variant="tonal" class="param-chip">
                    f/{{ currentPhoto.f_number }}
                  </v-chip>
                  <v-chip v-if="currentPhoto.iso" variant="tonal" class="param-chip">
                    ISO {{ currentPhoto.iso }}
                  </v-chip>
                  <v-chip v-if="currentPhoto.focal_length" variant="tonal" class="param-chip">
                    {{ currentPhoto.focal_length }}mm
                  </v-chip>
                </div>
              </div>

              <!-- 地理位置 & 智能逆地理编码 -->
              <div class="info-group">
                <div class="d-flex align-center justify-space-between mb-2">
                  <span class="text-caption font-weight-bold on-surface-variant">
                    {{ t('yarj.lightbox.gpsLocation', '地理位置') }}
                  </span>
                  <v-btn
                    v-if="currentPhoto.gps_lat != null && currentPhoto.gps_lon != null"
                    variant="text"
                    color="primary"
                    prepend-icon="mdi-map-marker-radius"
                    :loading="geocoding"
                    @click="requestReverseGeocode"
                  >
                    {{ t('yarj.lightbox.reverseGeocode', '解析详细地址') }}
                  </v-btn>
                </div>

                <div class="text-body-1 font-weight-medium mb-1">
                  {{ formatCoords(currentPhoto.gps_lat, currentPhoto.gps_lon) }}
                  <span
                    v-if="currentPhoto.gps_alt != null"
                    class="text-caption on-surface-variant ml-1"
                  >
                    (海拔 {{ Math.round(currentPhoto.gps_alt) }}m)
                  </span>
                </div>

                <!-- 智能解析出的中文/英文地名地址 -->
                <div
                  v-if="geocodeResult?.formattedAddress"
                  class="address-box pa-3 rounded-lg mb-2"
                >
                  <div class="d-flex align-start ga-2">
                    <v-icon size="18" color="primary" class="mt-1 flex-shrink-0"
                      >mdi-map-marker</v-icon
                    >
                    <div class="flex-grow-1 min-w-0">
                      <div class="text-body-2 font-weight-medium">
                        {{ geocodeResult.formattedAddress }}
                      </div>
                      <div
                        v-if="geocodeResult.city || geocodeResult.country"
                        class="text-caption on-surface-variant mt-1"
                      >
                        {{
                          [geocodeResult.country, geocodeResult.city].filter(Boolean).join(' · ')
                        }}
                      </div>
                    </div>
                  </div>
                  <div class="d-flex justify-end mt-2">
                    <v-btn
                      variant="text"
                      color="primary"
                      prepend-icon="mdi-tag-plus"
                      @click="addAddressToTags"
                    >
                      {{ t('yarj.lightbox.applyAddressToTags', '加为地名标签') }}
                    </v-btn>
                  </div>
                </div>

                <div class="d-flex flex-column ga-2 mt-2">
                  <v-btn
                    v-if="currentPhoto.gps_lon != null && currentPhoto.gps_lat != null"
                    variant="outlined"
                    block
                    prepend-icon="mdi-crosshairs-gps"
                    @click="handleLocateCurrentPhoto"
                  >
                    {{ t('yarj.drawer.locate', '定位到地图中心') }}
                  </v-btn>
                  <v-btn
                    variant="outlined"
                    block
                    prepend-icon="mdi-map-marker-plus-outline"
                    @click="emit('pick-gps', currentPhoto)"
                  >
                    {{ t('yarj.drawer.changeGps', '在地图上点击拾取/更改坐标') }}
                  </v-btn>
                </div>
              </div>

              <!-- 标签与备注编辑区域 -->
              <div class="info-group">
                <div class="text-caption font-weight-bold on-surface-variant mb-2">
                  {{ t('yarj.lightbox.tagsAndNotes', '标签与备注') }}
                </div>

                <!-- 查看态 -->
                <div v-if="!isEditing">
                  <div v-if="currentPhoto.appendix?.comment" class="photo-comment text-body-2 mb-3">
                    <v-icon size="16" class="mr-1 text-primary">mdi-comment-text-outline</v-icon>
                    <span>{{ currentPhoto.appendix.comment }}</span>
                  </div>

                  <div class="d-flex flex-wrap align-center ga-2">
                    <v-chip
                      v-for="tag in Array.isArray(currentPhoto.appendix?.tags)
                        ? currentPhoto.appendix.tags
                        : []"
                      :key="String(tag)"
                      variant="tonal"
                      color="primary"
                      class="param-chip"
                    >
                      {{ tag }}
                    </v-chip>
                    <span
                      v-if="
                        !Array.isArray(currentPhoto.appendix?.tags) ||
                        !currentPhoto.appendix.tags.length
                      "
                      class="text-caption on-surface-variant"
                    >
                      {{ t('yarj.popup.noTags', '暂无标签') }}
                    </span>
                  </div>
                </div>

                <!-- 编辑态 -->
                <div v-else class="d-flex flex-column ga-3">
                  <v-text-field
                    v-model="editLat"
                    :label="t('yarj.lightbox.latLabel', '纬度 (Latitude, 如 35.6895)')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-text-field
                    v-model="editLon"
                    :label="t('yarj.lightbox.lonLabel', '经度 (Longitude, 如 139.6917)')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-text-field
                    v-model="editTags"
                    :label="t('yarj.drawer.tagsLabel', '标签（逗号或空格分隔）')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-textarea
                    v-model="editComment"
                    :label="t('yarj.drawer.commentLabel', '备注 / 旅途记录')"
                    density="compact"
                    variant="outlined"
                    rows="2"
                    hide-details
                    no-resize
                  />
                  <div class="d-flex align-center justify-end ga-2 pt-2">
                    <v-btn variant="text" @click="isEditing = false">
                      {{ t('yarj.drawer.cancel', '取消') }}
                    </v-btn>
                    <v-btn
                      color="primary"
                      variant="flat"
                      :loading="saving"
                      @click="saveLightboxEdit"
                    >
                      {{ t('yarj.drawer.save', '保存修改') }}
                    </v-btn>
                  </div>
                </div>
              </div>

              <!-- 完整元数据 (JSON 树) -->
              <div class="info-group">
                <div
                  class="d-flex align-center justify-space-between cursor-pointer py-1"
                  @click="showJsonMetadata = !showJsonMetadata"
                >
                  <div class="d-flex align-center ga-2">
                    <v-icon size="18" color="primary">mdi-code-json</v-icon>
                    <span class="text-caption font-weight-bold on-surface-variant">
                      {{ t('yarj.lightbox.metadataTree', '完整数据库元数据 (JSON)') }}
                    </span>
                  </div>
                  <v-btn
                    size="small"
                    variant="text"
                    :icon="showJsonMetadata ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                  />
                </div>

                <v-expand-transition>
                  <div v-if="showJsonMetadata" class="pt-2">
                    <JsonTreeView
                      :data="currentPhoto"
                      root-name="photo"
                      :editable="isEditing"
                      @save="onSaveJsonTree"
                    />
                  </div>
                </v-expand-transition>
              </div>

              <!-- 外部应用打开与定位操作 -->
              <div class="info-group d-flex flex-column ga-2 mt-2">
                <v-btn
                  v-if="isVideoFile(currentPhoto.path)"
                  variant="outlined"
                  color="primary"
                  block
                  prepend-icon="mdi-play-circle"
                  @click="openExternalVideo(currentPhoto.path)"
                >
                  {{ t('yarj.lightbox.openExternalPlayer', '在系统播放器中打开') }}
                </v-btn>
                <v-btn
                  variant="outlined"
                  block
                  prepend-icon="mdi-folder-open-outline"
                  @click="openInFolder(currentPhoto.path)"
                >
                  {{ t('yarj.lightbox.showInFolder', '在文件夹中打开') }}
                </v-btn>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.yarj-lightbox-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.92);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  overflow: hidden;
  user-select: none;
}

.lightbox-topbar {
  flex-shrink: 0;
  background: rgba(var(--v-theme-surface), 0.6);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
  z-index: 10;
}

.photo-top-chip {
  min-height: 24px !important;
  padding-block: 4px !important;
}

.lightbox-content {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  position: relative;
}

.lightbox-stage {
  flex: 1;
  min-width: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  touch-action: none;
  padding: 24px 48px 84px 48px;
}

.lightbox-stage.is-dragging {
  cursor: grabbing;
}

.lightbox-img {
  max-width: calc(100% - 96px);
  max-height: calc(100% - 110px);
  object-fit: contain;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  border-radius: 12px;
  transform-origin: center center;
  transition: transform 0.05s linear;
  pointer-events: none;
}

.lightbox-video-container {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: calc(100% - 96px);
  max-height: calc(100% - 110px);
  z-index: 10;
}

.lightbox-video {
  max-width: 100%;
  max-height: 100%;
  outline: none;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  z-index: 10;
  pointer-events: auto;
  touch-action: auto;
  transform-origin: center center;
  transition: transform 0.05s linear;
}

.lightbox-media-spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 12;
  pointer-events: none;
}

.video-error-fallback {
  background: rgba(var(--v-theme-surface), 0.88);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(var(--v-theme-warning), 0.3);
  max-width: 440px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  z-index: 15;
}

.lightbox-bottom-nav {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.3);
  border-radius: 28px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  z-index: 30;
}

.bottom-nav-btn {
  border-radius: 50%;
  color: rgb(var(--v-theme-on-surface));
}

.bottom-nav-counter {
  color: rgb(var(--v-theme-on-surface));
  user-select: none;
  letter-spacing: 0.5px;
}

.lightbox-info-drawer {
  flex-shrink: 0;
  width: 420px;
  height: 100%;
  background: rgba(var(--v-theme-surface), 0.92);
  backdrop-filter: blur(28px) saturate(1.2);
  -webkit-backdrop-filter: blur(28px) saturate(1.2);
  border-left: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
  z-index: 20;
}

.drawer-header {
  flex-shrink: 0;
}

.drawer-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.drawer-scroll::-webkit-scrollbar {
  width: 6px;
}

.drawer-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.4);
  border-radius: 3px;
}

.param-chip {
  min-height: 24px !important;
  padding-block: 4px !important;
}

.address-box {
  background: rgba(var(--v-theme-primary), 0.08);
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.photo-comment {
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.5);
  border-left: 3px solid rgb(var(--v-theme-primary));
  white-space: pre-wrap;
  word-break: break-word;
}

/* 过渡动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition:
    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    margin-right 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.2s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(420px);
  margin-right: -420px;
  opacity: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
