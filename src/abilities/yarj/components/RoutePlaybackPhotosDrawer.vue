<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-playback-photos-drawer' })

import type { Photo } from '../types'
import { photoThumbUrl } from '../types'
import { haversineDistM } from '../explored-area'

const props = defineProps<{
  open: boolean
  photos: Photo[]
  totalPhotosCount: number
  currentTimeMs: number | null
  currentHeadCoord: [number, number] | null
  timeWindowSec: number
  detectedOffsetSec: number
  isLocalTime: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update:timeWindowSec', val: number): void
  (e: 'selectPhoto', payload: { photo: Photo; index: number; allPhotos: Photo[] }): void
  (e: 'locatePhoto', photo: Photo): void
}>()

const windowPresets = [
  { label: '±1 分钟', value: 60 },
  { label: '±3 分钟', value: 180 },
  { label: '±5 分钟', value: 300 },
  { label: '全部随行', value: -1 }
]

function formatPhotoTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    if (props.isLocalTime) {
      const utcMs = new Date(iso).getTime()
      const local = new Date(utcMs + 8 * 3600 * 1000)
      const h = String(local.getUTCHours()).padStart(2, '0')
      const m = String(local.getUTCMinutes()).padStart(2, '0')
      const s = String(local.getUTCSeconds()).padStart(2, '0')
      return `${h}:${m}:${s}`
    }
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso.slice(11, 19)
  }
}

function getRelativeTimeStr(p: Photo): string {
  if (!props.currentTimeMs || !p.taken_at) return ''
  const pTimeMs = new Date(p.taken_at).getTime() + props.detectedOffsetSec * 1000
  const diffSec = Math.round((pTimeMs - props.currentTimeMs) / 1000)
  if (Math.abs(diffSec) <= 2) return '当前时刻'
  if (diffSec > 0) return `+${diffSec} 秒`
  return `${diffSec} 秒`
}

function getDistanceStr(p: Photo): string | null {
  if (!props.currentHeadCoord || p.gps_lon == null || p.gps_lat == null) return null
  const distM = haversineDistM(
    props.currentHeadCoord[0],
    props.currentHeadCoord[1],
    p.gps_lon,
    p.gps_lat
  )
  if (distM < 1000) {
    return `${Math.round(distM)} m`
  }
  return `${(distM / 1000).toFixed(1)} km`
}

function handlePhotoClick(p: Photo, idx: number): void {
  emit('selectPhoto', { photo: p, index: idx, allPhotos: props.photos })
}
</script>

<template>
  <Transition name="drawer-slide">
    <aside v-if="open" class="route-playback-drawer">
      <!-- 头部：标题、窗口调节与关闭 -->
      <div class="drawer-header pa-4 border-b d-flex flex-column ga-3">
        <div class="d-flex align-center justify-space-between">
          <div class="d-flex align-center ga-2">
            <v-icon color="primary" size="22">mdi-camera-timer</v-icon>
            <span class="text-subtitle-1 font-weight-bold">周围时刻照片</span>
            <v-chip size="small" color="primary" variant="flat" class="font-weight-medium">
              {{ photos.length }} 张
            </v-chip>
          </div>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            class="text-medium-emphasis"
            @click="emit('close')"
          />
        </div>

        <!-- 关联时间颗粒度筛选 Presets -->
        <div class="d-flex align-center justify-space-between ga-2">
          <div class="text-caption text-medium-emphasis">时间视窗：</div>
          <div class="d-flex ga-1 flex-wrap">
            <v-chip
              v-for="preset in windowPresets"
              :key="preset.value"
              size="small"
              :variant="timeWindowSec === preset.value ? 'flat' : 'tonal'"
              :color="timeWindowSec === preset.value ? 'primary' : undefined"
              class="cursor-pointer"
              @click="emit('update:timeWindowSec', preset.value)"
            >
              {{ preset.label }}
              <template v-if="preset.value === -1"> ({{ totalPhotosCount }}) </template>
            </v-chip>
          </div>
        </div>
      </div>

      <!-- 照片滚动列表 -->
      <div class="drawer-body pa-3">
        <div v-if="photos.length > 0" class="photos-list d-flex flex-column ga-3">
          <div
            v-for="(p, idx) in photos"
            :key="p.path"
            class="photo-moment-card pa-2 rounded-xl d-flex ga-3 align-center cursor-pointer"
            @click="handlePhotoClick(p, idx)"
          >
            <!-- 照片缩略图 -->
            <div class="thumb-wrap flex-shrink-0 rounded-lg overflow-hidden">
              <img :src="photoThumbUrl(p.path)" class="thumb-img" loading="lazy" />
            </div>

            <!-- 照片元信息 -->
            <div class="photo-meta min-w-0 flex-grow-1 d-flex flex-column ga-1">
              <div class="d-flex align-center justify-space-between">
                <span class="text-subtitle-2 font-weight-medium font-mono text-truncate">
                  {{ formatPhotoTime(p.taken_at) }}
                </span>
                <v-chip
                  size="x-small"
                  :color="
                    getRelativeTimeStr(p) === '当前时刻'
                      ? 'primary'
                      : getRelativeTimeStr(p).startsWith('+')
                        ? 'secondary'
                        : 'default'
                  "
                  variant="flat"
                  class="font-weight-medium"
                >
                  {{ getRelativeTimeStr(p) }}
                </v-chip>
              </div>

              <div
                class="d-flex align-center justify-space-between text-caption text-medium-emphasis"
              >
                <span class="text-truncate" :title="p.camera_model || '拍摄设备'">
                  {{ p.camera_model || '实拍照片' }}
                </span>
                <span v-if="getDistanceStr(p)" class="font-mono flex-shrink-0">
                  <v-icon size="12" class="mr-1">mdi-map-marker-distance</v-icon>
                  {{ getDistanceStr(p) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态提示 -->
        <div
          v-else
          class="empty-state d-flex flex-column align-center justify-center text-center py-10 px-4"
        >
          <v-icon size="48" color="medium-emphasis" class="mb-3 opacity-60">
            mdi-camera-off-outline
          </v-icon>
          <div class="text-subtitle-2 font-weight-medium mb-1">当前时刻附近暂无实拍照片</div>
          <div class="text-caption text-medium-emphasis mb-4">
            {{
              timeWindowSec === -1
                ? '本次航线时间段内未匹配到照片'
                : `随行程播放推进，周围时刻的照片将自动浮现`
            }}
          </div>
          <v-btn
            v-if="timeWindowSec !== -1 && totalPhotosCount > 0"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-image-multiple"
            @click="emit('update:timeWindowSec', -1)"
          >
            查看全部 {{ totalPhotosCount }} 张随行照片
          </v-btn>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.route-playback-drawer {
  position: absolute;
  top: 72px;
  right: 20px;
  bottom: 120px;
  width: 360px;
  z-index: 25;
  background: rgba(var(--v-theme-surface), 0.9);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
  border-radius: 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.photo-moment-card {
  background: rgba(var(--v-theme-surface-bright), 0.08);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.photo-moment-card:hover {
  background: rgba(var(--v-theme-surface-bright), 0.16);
  border-color: rgba(var(--v-theme-primary), 0.4);
  transform: translateY(-1px);
}

.thumb-wrap {
  width: 64px;
  height: 64px;
  background: rgba(0, 0, 0, 0.2);
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 抽屉进出动效 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(400px);
  opacity: 0;
}
</style>
