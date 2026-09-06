<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-pick-banner' })

import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo } from '../types'
import { photoThumbUrl } from '../types'

defineProps<{
  pickingGpsPhoto: Photo | null
  relocatingPhotos: Photo[] | null
  isGcj02Active: boolean
  confirmGpsDialogOpen: boolean
  pendingGpsCoords: { lat: number; lon: number } | null
  pendingGpsAddress: string | null
  pendingGpsGeocoding: boolean
  confirmRelocateDialogOpen: boolean
  relocatingAnchor: { lat: number; lon: number } | null
  pendingRelocateTarget: { lat: number; lon: number } | null
  relocateDistanceStr: string
  relocatingLoading: boolean
}>()

const emit = defineEmits<{
  (e: 'cancel-pick-gps'): void
  (e: 'cancel-relocate-group'): void
  (e: 'request-pending-geocode'): void
  (e: 'confirm-save-gps'): void
  (e: 'confirm-save-relocate'): void
  (e: 'update:confirmGpsDialogOpen', val: boolean): void
  (e: 'update:confirmRelocateDialogOpen', val: boolean): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div>
    <!-- 地图拾取坐标顶栏提示 -->
    <Transition name="fade">
      <div v-if="pickingGpsPhoto" class="yarj-pick-banner">
        <div class="d-flex align-center ga-3 min-w-0">
          <v-icon size="20" color="primary" class="spin">mdi-crosshairs-gps</v-icon>
          <span class="text-body-2 font-weight-medium text-truncate">
            {{ t('yarj.pick.banner', '正在拾取位置：请点击地图选择目标坐标') }} —
            <b>{{ pickingGpsPhoto.path.split('/').pop() }}</b>
          </span>
          <v-chip
            v-if="isGcj02Active"
            size="x-small"
            color="warning"
            variant="flat"
            class="flex-shrink-0"
            :title="
              t(
                'yarj.providers.gcj02Hint',
                '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
              )
            "
          >
            {{ t('yarj.providers.gcj02Badge', 'GCJ-02 火星坐标系') }}
          </v-chip>
        </div>
        <v-btn
          variant="tonal"
          color="error"
          class="ml-4 flex-shrink-0"
          @click="emit('cancel-pick-gps')"
        >
          {{ t('yarj.drawer.cancel', '取消') }}
        </v-btn>
      </div>
    </Transition>

    <!-- 地图批量平移坐标顶栏提示 -->
    <Transition name="fade">
      <div v-if="relocatingPhotos" class="yarj-pick-banner">
        <div class="d-flex align-center ga-3 min-w-0">
          <v-icon size="20" color="primary" class="spin">mdi-map-marker-distance</v-icon>
          <span class="text-body-2 font-weight-medium text-truncate">
            {{
              t(
                'yarj.drawer.relocatingBanner',
                '正在批量平移位置：请点击地图选择新中心（保留各照片间距）'
              )
            }}
            —
            <b>{{ relocatingPhotos.length }} 张照片</b>
          </span>
          <v-chip
            v-if="isGcj02Active"
            size="x-small"
            color="warning"
            variant="flat"
            class="flex-shrink-0"
            :title="
              t(
                'yarj.providers.gcj02Hint',
                '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
              )
            "
          >
            {{ t('yarj.providers.gcj02Badge', 'GCJ-02 火星坐标系') }}
          </v-chip>
        </div>
        <v-btn
          variant="tonal"
          color="error"
          class="ml-4 flex-shrink-0"
          @click="emit('cancel-relocate-group')"
        >
          {{ t('yarj.drawer.cancel', '取消') }}
        </v-btn>
      </div>
    </Transition>

    <!-- 右上角悬浮待定位缩略图（悬浮自动放大） -->
    <Transition name="fade">
      <div v-if="pickingGpsPhoto" class="yarj-pick-floating-preview">
        <div class="preview-inner">
          <v-img
            :src="photoThumbUrl(pickingGpsPhoto.path)"
            :alt="pickingGpsPhoto.path"
            class="preview-img"
            cover
          >
            <template #placeholder>
              <div class="d-flex align-center justify-center fill-height bg-surface-variant-subtle">
                <v-progress-circular indeterminate color="primary" size="20" width="2" />
              </div>
            </template>
          </v-img>
          <div class="preview-badge">
            <v-icon size="14" color="white" class="mr-1">mdi-map-marker</v-icon>
            <span>{{ t('yarj.pick.targetBadge', '待定位') }}</span>
          </div>
          <div class="preview-expanded-info">
            <div class="text-caption font-weight-bold text-truncate">
              {{ pickingGpsPhoto.path.split('/').pop() }}
            </div>
            <div class="text-caption on-surface-variant text-truncate">
              {{ pickingGpsPhoto.camera_model || pickingGpsPhoto.camera_make || 'Photo' }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 确认拾取照片 GPS 定位对话框 -->
    <v-dialog
      :model-value="confirmGpsDialogOpen"
      max-width="460"
      persistent
      @update:model-value="(v) => emit('update:confirmGpsDialogOpen', v)"
    >
      <v-card
        class="pa-5 rounded-2xl"
        style="background: rgba(var(--v-theme-surface), 0.95); backdrop-filter: blur(24px)"
      >
        <div class="d-flex align-center ga-3 mb-4">
          <v-icon size="26" color="primary">mdi-map-marker-check</v-icon>
          <span class="text-h6 font-weight-bold">{{
            t('yarj.pick.confirmTitle', '确认更新照片定位')
          }}</span>
        </div>

        <div
          v-if="pickingGpsPhoto"
          class="d-flex align-center ga-3 pa-3 rounded-xl mb-4"
          style="background: rgba(var(--v-theme-surface-bright), 0.18)"
        >
          <v-img
            :src="photoThumbUrl(pickingGpsPhoto.path)"
            width="60"
            height="60"
            cover
            class="rounded-lg flex-shrink-0"
          >
            <template #placeholder>
              <div class="d-flex align-center justify-center fill-height bg-surface-variant-subtle">
                <v-progress-circular indeterminate color="primary" size="20" width="2" />
              </div>
            </template>
          </v-img>
          <div class="min-w-0 flex-grow-1">
            <div class="text-body-1 font-weight-bold text-truncate">
              {{ pickingGpsPhoto.path.split('/').pop() }}
            </div>
            <div class="text-caption on-surface-variant mt-1">
              {{ pickingGpsPhoto.camera_model || 'Photo' }}
            </div>
          </div>
        </div>

        <v-alert
          v-if="isGcj02Active"
          type="warning"
          variant="tonal"
          density="compact"
          icon="mdi-alert-circle-outline"
          class="mb-4 text-caption"
        >
          {{
            t(
              'yarj.providers.gcj02Hint',
              '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
            )
          }}
        </v-alert>

        <div class="mb-4 text-body-2 d-flex flex-column ga-2">
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.pick.newCoords', '拾取的新经纬度') }}:</span
            >
            <span class="font-weight-bold font-mono text-primary">
              {{ pendingGpsCoords?.lat.toFixed(5) }}°N, {{ pendingGpsCoords?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div
            v-if="pickingGpsPhoto?.gps_lat != null"
            class="d-flex justify-space-between align-center"
          >
            <span class="on-surface-variant">{{ t('yarj.pick.oldCoords', '原经纬度') }}:</span>
            <span class="on-surface-variant font-mono">
              {{ pickingGpsPhoto.gps_lat?.toFixed(5) }}°N,
              {{ pickingGpsPhoto.gps_lon?.toFixed(5) }}°E
            </span>
          </div>
          <div
            v-if="pendingGpsAddress"
            class="d-flex align-start ga-2 mt-2 pa-3 rounded-lg"
            style="
              background: rgba(var(--v-theme-primary), 0.08);
              border: 1px solid rgba(var(--v-theme-primary), 0.18);
            "
          >
            <v-icon size="16" color="primary" class="mt-1 flex-shrink-0">mdi-map-marker</v-icon>
            <span class="text-caption font-weight-medium">{{ pendingGpsAddress }}</span>
          </div>
          <div v-else class="mt-2">
            <v-btn
              variant="tonal"
              color="primary"
              block
              prepend-icon="mdi-map-marker-radius"
              :loading="pendingGpsGeocoding"
              @click="emit('request-pending-geocode')"
            >
              {{ t('yarj.pick.manualGeocode', '解析地名地址 (可选)') }}
            </v-btn>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-3 ga-3 justify-end d-flex border-t">
          <v-btn variant="text" @click="emit('cancel-pick-gps')">
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn color="primary" variant="flat" @click="emit('confirm-save-gps')">
            {{ t('yarj.pick.confirmBtn', '确认更新') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 确认批量平移照片 GPS 定位对话框 -->
    <v-dialog
      :model-value="confirmRelocateDialogOpen"
      max-width="480"
      persistent
      @update:model-value="(v) => emit('update:confirmRelocateDialogOpen', v)"
    >
      <v-card
        class="pa-5 rounded-2xl"
        style="background: rgba(var(--v-theme-surface), 0.95); backdrop-filter: blur(24px)"
      >
        <div class="d-flex align-center ga-3 mb-4">
          <v-icon size="26" color="primary">mdi-map-marker-distance</v-icon>
          <span class="text-h6 font-weight-bold">{{
            t('yarj.drawer.relocateConfirmTitle', '确认批量平移照片 GPS 定位')
          }}</span>
        </div>

        <div
          class="d-flex align-center ga-3 pa-3 rounded-xl mb-4"
          style="background: rgba(var(--v-theme-surface-bright), 0.18)"
        >
          <v-avatar color="primary" variant="tonal" size="44">
            <v-icon size="24">mdi-image-multiple</v-icon>
          </v-avatar>
          <div class="min-w-0 flex-grow-1">
            <div class="text-body-1 font-weight-bold text-truncate">
              {{
                t(
                  'yarj.drawer.relocateCountDesc',
                  `共 ${relocatingPhotos?.length ?? 0} 张照片`
                ).replace('{n}', String(relocatingPhotos?.length ?? 0))
              }}
            </div>
            <div class="text-caption on-surface-variant mt-1">
              {{
                t(
                  'yarj.drawer.relocateKeepOffsetTip',
                  '系统将以新位置为锚点，保留组内各照片相对间距'
                )
              }}
            </div>
          </div>
        </div>

        <v-alert
          v-if="isGcj02Active"
          type="warning"
          variant="tonal"
          density="compact"
          icon="mdi-alert-circle-outline"
          class="mb-4 text-caption"
        >
          {{
            t(
              'yarj.providers.gcj02Hint',
              '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
            )
          }}
        </v-alert>

        <div class="mb-4 text-body-2 d-flex flex-column ga-2">
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateOldCenter', '原位置中心') }}:</span
            >
            <span class="on-surface-variant font-mono">
              {{ relocatingAnchor?.lat.toFixed(5) }}°N, {{ relocatingAnchor?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateNewCenter', '平移后新中心') }}:</span
            >
            <span class="font-weight-bold font-mono text-primary">
              {{ pendingRelocateTarget?.lat.toFixed(5) }}°N,
              {{ pendingRelocateTarget?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div v-if="relocateDistanceStr" class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateDistance', '平移位移距离') }}:</span
            >
            <span class="font-weight-bold font-mono text-success">
              ≈ {{ relocateDistanceStr }}
            </span>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-3 ga-3 justify-end d-flex border-t">
          <v-btn
            variant="text"
            :disabled="relocatingLoading"
            @click="emit('cancel-relocate-group')"
          >
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="relocatingLoading"
            @click="emit('confirm-save-relocate')"
          >
            {{ t('yarj.drawer.confirmRelocate', '确认平移') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.yarj-pick-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-radius: 24px;
  background: rgba(var(--v-theme-surface), 0.9);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1.5px solid rgb(var(--v-theme-primary));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-width: 90%;
}

.yarj-pick-floating-preview {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 35;
  border-radius: 16px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border: 2px solid rgb(var(--v-theme-primary));
  overflow: hidden;
  transition:
    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    width 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    height 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 0.25s ease;
  width: 76px;
  height: 76px;
  cursor: pointer;
}

.yarj-pick-floating-preview:hover {
  width: 240px;
  height: 240px;
  transform: scale(1.03);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}

.preview-inner {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.preview-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  display: flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
  color: #ffffff;
  font-size: 0.7rem;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.preview-expanded-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0) 100%);
  color: #ffffff;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  pointer-events: none;
}

.yarj-pick-floating-preview:hover .preview-badge {
  opacity: 0;
}

.yarj-pick-floating-preview:hover .preview-expanded-info {
  opacity: 1;
  transform: translateY(0);
}
</style>
