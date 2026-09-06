<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-lightbox' })

import { ref, computed, watch, onBeforeUnmount, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, GuessedGps } from '../types'
import { isVideoFile, photoThumbUrl } from '../types'
import PhotoLightboxInfoPanel from './PhotoLightboxInfoPanel.vue'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  initialIndex: number
  guessedGpsMap?: Map<string, GuessedGps>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'pick-gps', photo: Photo): void
  (e: 'solidify-gps', payload: { photo: Photo; guess: GuessedGps }): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const currentIndex = ref(props.initialIndex ?? 0)
const showInfo = ref(true)

// 变换状态：缩放、拖拽平移、旋转
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const rotate = ref(0)

const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
let pointerDownPos = { x: 0, y: 0 }

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

async function openInFolder(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.show-item-in-folder', { path: filePath })
  } catch {
    /* ignore */
  }
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
          <PhotoLightboxInfoPanel
            v-if="showInfo && currentPhoto"
            :photo="currentPhoto"
            :guessed-gps-map="props.guessedGpsMap"
            @locate="(c) => emit('locate', c)"
            @pick-gps="(p) => emit('pick-gps', p)"
            @solidify-gps="(payload) => emit('solidify-gps', payload)"
            @updated="() => emit('updated')"
          />
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
