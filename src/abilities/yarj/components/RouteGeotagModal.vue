<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-geotag-modal' })

import { ref, computed, watch } from 'vue'
import type { Route, GeotagPreviewResult } from '../types'
import { photoThumbUrl } from '../types'

const props = defineProps<{
  modelValue: boolean
  preselectedRoute?: Route | null
  initialRoute?: Route | null
  initialOffset?: number
  routes: Route[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'started'): void
}>()

const selectedRouteId = ref<string>('')
const timeOffsetSeconds = ref<number>(0)
const baseOffsetSeconds = ref<number>(0)
const isLocalTime = ref(false)
const loadingPreview = ref(false)
const previewResult = ref<GeotagPreviewResult | null>(null)
const countGeotagged = ref<number>(0)
const snackbar = ref(false)
const snackbarText = ref('')

const effectiveOffset = computed(() => baseOffsetSeconds.value + timeOffsetSeconds.value)

async function detectBaseOffset(): Promise<void> {
  if (!selectedRouteId.value) {
    baseOffsetSeconds.value = 0
    isLocalTime.value = false
    return
  }
  if (
    props.initialOffset != null &&
    (selectedRouteId.value === props.initialRoute?.id ||
      selectedRouteId.value === props.preselectedRoute?.id)
  ) {
    baseOffsetSeconds.value = props.initialOffset
    isLocalTime.value = props.initialOffset !== 0
    return
  }
  try {
    const res = (await window.cockpit.command('yarj.get-route-photos', {
      routeId: selectedRouteId.value
    })) as {
      ok: boolean
      detectedOffsetSec?: number
      isLocalTime?: boolean
    }
    if (res.ok) {
      baseOffsetSeconds.value = res.detectedOffsetSec ?? 0
      isLocalTime.value = res.isLocalTime ?? false
    }
  } catch {
    baseOffsetSeconds.value = 0
    isLocalTime.value = false
  }
}

watch(
  () => props.modelValue,
  async (val) => {
    if (val) {
      const target = props.initialRoute ?? props.preselectedRoute
      if (target) {
        selectedRouteId.value = target.id
      } else if (props.routes.length > 0 && !selectedRouteId.value) {
        selectedRouteId.value = props.routes[0].id
      }
      await detectBaseOffset()
      await refreshCount()
      await updatePreview()
    }
  }
)

watch(selectedRouteId, async () => {
  if (props.modelValue) {
    await detectBaseOffset()
    await updatePreview()
  }
})

watch(timeOffsetSeconds, () => {
  if (props.modelValue) {
    updatePreview()
  }
})

async function refreshCount(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yarj.count-geotagged', {})) as {
      ok: boolean
      count: number
    }
    countGeotagged.value = res.count ?? 0
  } catch {
    countGeotagged.value = 0
  }
}

async function updatePreview(): Promise<void> {
  if (!selectedRouteId.value) {
    previewResult.value = null
    return
  }

  loadingPreview.value = true
  try {
    const res = (await window.cockpit.command('yarj.preview-geotag', {
      routeId: selectedRouteId.value,
      offset: effectiveOffset.value
    })) as {
      ok: boolean
      preview?: GeotagPreviewResult
    }
    if (res.ok && res.preview) {
      previewResult.value = res.preview
    }
  } catch {
    previewResult.value = null
  } finally {
    loadingPreview.value = false
  }
}

async function startGeotagJob(): Promise<void> {
  try {
    await window.cockpit.btJob('yarj.geotag-routes', {
      routeId: selectedRouteId.value || undefined,
      timeOffsetSeconds: effectiveOffset.value
    })
    emit('update:modelValue', false)
    emit('started')
  } catch (err) {
    snackbarText.value = `启动任务失败: ${String(err)}`
    snackbar.value = true
  }
}

async function clearGeotagJob(): Promise<void> {
  try {
    await window.cockpit.btJob('yarj.clear-route-geotag', {})
    emit('update:modelValue', false)
    emit('started')
  } catch (err) {
    snackbarText.value = `启动重置任务失败: ${String(err)}`
    snackbar.value = true
  }
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="720"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card rounded="xl">
      <!-- 弹窗标题 -->
      <v-card-title class="pa-5 pb-3 d-flex align-center justify-space-between border-b">
        <div class="d-flex align-center ga-3">
          <v-avatar color="primary" size="40" variant="tonal">
            <v-icon size="24">mdi-camera-timer</v-icon>
          </v-avatar>
          <div>
            <div class="text-subtitle-1 font-weight-bold">
              基于运动轨迹贴合照片 (Route Geotagging)
            </div>
            <div class="text-caption text-medium-emphasis">
              将相机/手机照片拍摄时间与运动手表 GPX 航线对齐，高精度赋予或纠正照片真实路网位置
            </div>
          </div>
        </div>
        <v-btn icon="mdi-close" variant="text" size="small" @click="close" />
      </v-card-title>

      <v-card-text class="pa-5 d-flex flex-column ga-4">
        <!-- 1. 选择航线 -->
        <v-card rounded="lg" variant="tonal" class="pa-4 card-fill">
          <div class="text-caption font-weight-medium text-medium-emphasis mb-2">
            选择目标运动轨迹
          </div>
          <v-select
            v-model="selectedRouteId"
            :items="routes"
            item-title="name"
            item-value="id"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="请选择一条运动轨迹"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps">
                <template #prepend>
                  <v-icon size="20" color="primary">
                    {{ item.raw.activityType === 'cycling' ? 'mdi-bike' : 'mdi-run' }}
                  </v-icon>
                </template>
                <template #append>
                  <span class="text-caption text-medium-emphasis">
                    {{ (item.raw.totalDistanceM / 1000).toFixed(1) }}km ·
                    {{ item.raw.startTime?.slice(0, 10) }}
                  </span>
                </template>
              </v-list-item>
            </template>
          </v-select>
        </v-card>

        <!-- 2. 相机时钟偏差补偿微调滑块 -->
        <v-card rounded="lg" variant="tonal" class="pa-4 card-fill">
          <div class="d-flex align-center justify-space-between mb-2">
            <div class="text-caption font-weight-medium text-medium-emphasis">
              相机时钟微调校准 (Camera Clock Fine-tuning)
            </div>
            <div class="text-subtitle-2 font-weight-bold text-primary">
              {{ timeOffsetSeconds >= 0 ? `+${timeOffsetSeconds} 秒` : `${timeOffsetSeconds} 秒` }}
              <span
                v-if="baseOffsetSeconds !== 0"
                class="text-caption text-medium-emphasis font-weight-regular ml-1"
              >
                (生效总补偿: {{ effectiveOffset >= 0 ? `+${effectiveOffset}` : effectiveOffset }}s)
              </span>
            </div>
          </div>

          <div v-if="baseOffsetSeconds !== 0" class="mb-3">
            <v-chip
              size="small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-clock-check-outline"
            >
              已自动识别运动记录时区偏移: {{ baseOffsetSeconds >= 0 ? '+' : ''
              }}{{ Math.round(baseOffsetSeconds / 3600) }} 小时 ({{ baseOffsetSeconds }}s)
            </v-chip>
          </div>

          <div class="text-caption text-medium-emphasis mb-3">
            若相机时间慢于 GPS 卫星标准时间，请向右拖动增加秒数；反之向左拖动。支持 ±120
            秒实时微调预览。
          </div>

          <v-slider
            v-model="timeOffsetSeconds"
            :min="-120"
            :max="120"
            :step="1"
            thumb-label="always"
            color="primary"
            density="compact"
            hide-details
          >
            <template #thumb-label="{ modelValue: val }"> {{ val }}s </template>
          </v-slider>

          <div class="d-flex justify-space-between text-caption text-disabled mt-1">
            <span>-120 秒</span>
            <span class="cursor-pointer text-primary" @click="timeOffsetSeconds = 0"
              >归零 (0s)</span
            >
            <span>+120 秒</span>
          </div>
        </v-card>

        <!-- 3. 实时匹配预览结果 -->
        <v-card rounded="lg" variant="tonal" class="pa-4 card-fill">
          <div class="d-flex align-center justify-space-between mb-3">
            <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
              <v-icon size="20" color="primary">mdi-eye-outline</v-icon>
              <span>实时对齐预览</span>
            </div>

            <div v-if="previewResult" class="text-caption">
              成功贴合 <strong class="text-primary">{{ previewResult.matchedCount }}</strong> 张照片
              <span v-if="previewResult.unmatchedCount > 0" class="text-medium-emphasis">
                (其余 {{ previewResult.unmatchedCount }} 张不在该时段)
              </span>
            </div>
          </div>

          <div v-if="loadingPreview" class="text-center py-6 text-disabled">
            <v-progress-circular indeterminate size="24" class="mr-2" />
            正在检索照片拍摄时间并插值匹配...
          </div>

          <div
            v-else-if="previewResult && previewResult.matchedItems.length > 0"
            class="d-flex flex-column ga-2 max-preview-list"
          >
            <div
              v-for="item in previewResult.matchedItems.slice(0, 5)"
              :key="item.photo.path"
              class="preview-card pa-2 px-3 rounded-lg d-flex align-center justify-space-between ga-3"
            >
              <div class="d-flex align-center ga-3 min-width-0">
                <img
                  :src="photoThumbUrl(item.photo.path)"
                  class="preview-img rounded"
                  loading="lazy"
                />
                <div class="min-width-0">
                  <div class="text-caption font-weight-medium text-truncate">
                    {{ item.photo.path.split('/').pop() }}
                  </div>
                  <div class="text-caption text-medium-emphasis">
                    拍摄于 {{ item.photo.taken_at?.slice(11, 19) }}
                  </div>
                </div>
              </div>

              <div class="text-right flex-shrink-0 text-caption">
                <div class="text-primary font-weight-bold">
                  {{ item.matchedGps.lat.toFixed(5) }}, {{ item.matchedGps.lon.toFixed(5) }}
                </div>
                <div v-if="item.diffDistM != null" class="text-medium-emphasis">
                  原定位偏差: {{ item.diffDistM }}m
                </div>
                <div v-else class="text-success">全新定位补全</div>
              </div>
            </div>

            <div
              v-if="previewResult.matchedItems.length > 5"
              class="text-center text-caption text-medium-emphasis pt-1"
            >
              及其他 {{ previewResult.matchedItems.length - 5 }} 张照片...
            </div>
          </div>

          <div v-else class="text-center py-6 text-disabled">
            该运动轨迹的时间段内暂未找到拍摄的照片
          </div>
        </v-card>
      </v-card-text>

      <!-- 底部动作栏 -->
      <v-card-actions class="pa-4 px-5 border-t d-flex justify-space-between align-center">
        <div>
          <v-btn
            v-if="countGeotagged > 0"
            color="error"
            variant="tonal"
            prepend-icon="mdi-restore"
            @click="clearGeotagJob"
          >
            重置已贴合记录 ({{ countGeotagged }})
          </v-btn>
        </div>

        <div class="d-flex ga-2">
          <v-btn variant="tonal" @click="close">取消</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-check-bold"
            :disabled="!previewResult || previewResult.matchedCount === 0"
            @click="startGeotagJob"
          >
            启动后台贴合并保存
          </v-btn>
        </div>
      </v-card-actions>
    </v-card>

    <v-snackbar v-model="snackbar" timeout="2500">
      {{ snackbarText }}
    </v-snackbar>
  </v-dialog>
</template>

<style scoped>
.preview-card {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.preview-img {
  width: 44px;
  height: 44px;
  object-fit: cover;
  flex-shrink: 0;
}

.max-preview-list {
  max-height: 240px;
  overflow-y: auto;
}
</style>
