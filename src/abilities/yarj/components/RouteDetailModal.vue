<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-detail-modal' })

import { ref, computed, watch } from 'vue'
import type { Route, Photo } from '../types'
import { photoThumbUrl } from '../types'

const props = defineProps<{
  modelValue: boolean
  route: Route | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'focusRoute', route: Route): void
  (e: 'playRoute', route: Route): void
  (e: 'startGeotag', route: Route, detectedOffsetSec?: number): void
  (e: 'viewPhoto', photo: Photo, allPhotos?: Photo[]): void
}>()

const activeTab = ref<'overview' | 'splits' | 'photos'>('overview')
const routePhotos = ref<Photo[]>([])
const loadingPhotos = ref(false)
const detectedOffsetSec = ref(0)
const isLocalTime = ref(false)

async function loadRoutePhotos(): Promise<void> {
  if (!props.route?.id) {
    routePhotos.value = []
    return
  }
  loadingPhotos.value = true
  try {
    const res = (await window.cockpit.command('yarj.get-route-photos', {
      routeId: props.route.id
    })) as {
      ok: boolean
      photos?: Photo[]
      detectedOffsetSec?: number
      isLocalTime?: boolean
    }
    if (res.ok && res.photos) {
      routePhotos.value = res.photos
      detectedOffsetSec.value = res.detectedOffsetSec ?? 0
      isLocalTime.value = res.isLocalTime ?? false
    } else {
      routePhotos.value = []
    }
  } catch {
    routePhotos.value = []
  } finally {
    loadingPhotos.value = false
  }
}

watch(
  () => [props.modelValue, props.route?.id],
  ([open, id]) => {
    if (open && id) {
      loadRoutePhotos()
    }
  },
  { immediate: true }
)

// 格式化时间
function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '00:00:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '未知时间'
  try {
    if (isLocalTime.value && iso.length >= 16) {
      const d = iso.slice(0, 10).replace(/-/g, '/')
      const time = iso.slice(11, 16)
      return `${d} ${time}`
    }
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function formatPhotoTime(iso: string | null): string {
  if (!iso) return ''
  try {
    if (isLocalTime.value && iso.length >= 16) {
      const utcMs = new Date(iso).getTime()
      const local = new Date(utcMs + 8 * 3600 * 1000)
      const h = String(local.getUTCHours()).padStart(2, '0')
      const m = String(local.getUTCMinutes()).padStart(2, '0')
      return `${h}:${m}`
    }
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso.slice(11, 16)
  }
}

const hasExtraStats = computed(() => {
  return !!(
    (props.route?.avgHr && props.route.avgHr > 0) ||
    (props.route?.elevationGainM && props.route.elevationGainM > 0)
  )
})

const maxSplitSpeed = computed(() => {
  if (!props.route?.splits?.length) return 30
  let max = 15
  for (const s of props.route.splits) {
    if (s.avgSpeedKmh > max) max = s.avgSpeedKmh
  }
  return Math.ceil(max * 1.15)
})

function close(): void {
  emit('update:modelValue', false)
}

function handlePlay(): void {
  if (props.route) {
    emit('playRoute', props.route)
    close()
  }
}

function handleFocus(): void {
  if (props.route) {
    emit('focusRoute', props.route)
    close()
  }
}

function handleGeotag(): void {
  if (props.route) {
    emit('startGeotag', props.route, detectedOffsetSec.value)
    close()
  }
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="840"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card v-if="route" rounded="xl" class="route-modal-card">
      <!-- 头部：标题与活动状态 -->
      <v-card-title
        class="pa-5 pb-3 d-flex align-center justify-space-between flex-wrap ga-2 border-b"
      >
        <div class="d-flex align-center ga-3">
          <v-avatar color="primary" size="44" variant="tonal">
            <v-icon size="26">
              {{
                route.activityType === 'cycling'
                  ? 'mdi-bike'
                  : route.activityType === 'running'
                    ? 'mdi-run'
                    : 'mdi-routes'
              }}
            </v-icon>
          </v-avatar>
          <div>
            <div class="text-h6 font-weight-bold d-flex align-center ga-2">
              <span>{{ route.name }}</span>
              <v-chip size="small" variant="flat" color="primary">
                {{
                  route.activityType === 'cycling'
                    ? '户外骑行'
                    : route.activityType === 'running'
                      ? '户外跑步'
                      : '运动轨迹'
                }}
              </v-chip>
            </div>
            <div class="text-caption text-medium-emphasis">
              {{ formatDate(route.startTime) }} · {{ route.pointCount }} 个定位点
            </div>
          </div>
        </div>

        <div class="d-flex align-center ga-2 flex-wrap">
          <v-btn color="primary" variant="flat" prepend-icon="mdi-motion-play" @click="handlePlay">
            播放行程
          </v-btn>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-crosshairs-gps"
            @click="handleFocus"
          >
            地图聚焦
          </v-btn>
          <v-btn
            color="secondary"
            variant="tonal"
            prepend-icon="mdi-camera-timer"
            @click="handleGeotag"
          >
            轨迹贴合照片
          </v-btn>
          <v-btn icon="mdi-close" variant="text" size="small" @click="close" />
        </div>
      </v-card-title>

      <!-- 选项卡切换 -->
      <v-tabs v-model="activeTab" density="compact" color="primary" class="px-5 border-b">
        <v-tab value="overview">总览指标</v-tab>
        <v-tab value="splits">分公里配速 ({{ route.splits?.length || 0 }})</v-tab>
        <v-tab value="photos">随行实拍照片 ({{ routePhotos.length }})</v-tab>
      </v-tabs>

      <!-- 内容区 -->
      <v-card-text class="pa-5">
        <!-- 1. 总览指标卡片 -->
        <div v-if="activeTab === 'overview'" class="d-flex flex-column ga-4">
          <!-- 核心高光大卡片（对标 Mi Fitness 运动详情大看板） -->
          <v-card rounded="lg" variant="tonal" class="pa-5 card-fill metric-hero-card">
            <div class="d-flex justify-space-between align-baseline mb-4 flex-wrap ga-2">
              <div>
                <div class="text-caption text-uppercase tracking-wider text-medium-emphasis mb-1">
                  总运动里程 (Distance)
                </div>
                <div class="hero-distance text-primary font-weight-black">
                  {{ (route.totalDistanceM / 1000).toFixed(2) }}
                  <span class="text-h6 font-weight-bold">公里</span>
                </div>
              </div>

              <div v-if="route.calories && route.calories > 0" class="text-right">
                <div class="text-caption text-uppercase tracking-wider text-medium-emphasis mb-1">
                  消耗能量 (Est. Calories)
                </div>
                <div class="text-h4 font-weight-bold text-warning">
                  {{ route.calories }}
                  <span class="text-subtitle-1 font-weight-medium">千卡</span>
                </div>
              </div>
            </div>

            <v-divider class="my-3 opacity-20" />

            <!-- 核心看板 (无心率/爬升时自适应 4 列网格) -->
            <v-row dense>
              <v-col cols="6" :sm="hasExtraStats ? 4 : 3">
                <div class="metric-item">
                  <div class="metric-label">总耗时</div>
                  <div class="metric-val">{{ formatDuration(route.durationSec) }}</div>
                </div>
              </v-col>
              <v-col cols="6" :sm="hasExtraStats ? 4 : 3">
                <div class="metric-item">
                  <div class="metric-label">移动耗时</div>
                  <div class="metric-val">{{ formatDuration(route.movingDurationSec) }}</div>
                </div>
              </v-col>
              <v-col cols="6" :sm="hasExtraStats ? 4 : 3">
                <div class="metric-item">
                  <div class="metric-label">平均时速</div>
                  <div class="metric-val">
                    {{ route.avgSpeedKmh }} <span class="unit">km/h</span>
                  </div>
                </div>
              </v-col>
              <v-col cols="6" :sm="hasExtraStats ? 4 : 3">
                <div class="metric-item">
                  <div class="metric-label">最高时速</div>
                  <div class="metric-val text-primary">
                    {{ route.maxSpeedKmh }} <span class="unit">km/h</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.avgHr && route.avgHr > 0" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">平均心率</div>
                  <div class="metric-val">{{ route.avgHr }} <span class="unit">bpm</span></div>
                </div>
              </v-col>
              <v-col v-if="route.elevationGainM && route.elevationGainM > 0" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">累计爬升</div>
                  <div class="metric-val">
                    {{ route.elevationGainM }} <span class="unit">m</span>
                  </div>
                </div>
              </v-col>
            </v-row>
          </v-card>

          <!-- 传感器状态卡片 (仅当有传感器数据时展示，无数据彻底隐藏) -->
          <div v-if="route.avgHr || route.minEle != null" class="d-flex ga-3 flex-wrap">
            <v-card
              v-if="route.avgHr"
              rounded="lg"
              variant="outlined"
              class="flex-grow-1 pa-3 d-flex align-center ga-3"
            >
              <v-icon color="error">mdi-heart-pulse</v-icon>
              <div class="text-caption">
                <div class="font-weight-medium">心率传感器状态</div>
                <div class="text-medium-emphasis">
                  实时记录心率流 (峰值 {{ route.maxHr ?? route.avgHr }} bpm)
                </div>
              </div>
            </v-card>

            <v-card
              v-if="route.minEle != null"
              rounded="lg"
              variant="outlined"
              class="flex-grow-1 pa-3 d-flex align-center ga-3"
            >
              <v-icon color="info">mdi-altimeter</v-icon>
              <div class="text-caption">
                <div class="font-weight-medium">海拔高度剖面</div>
                <div class="text-medium-emphasis">
                  海拔区间: {{ route.minEle }}m ~ {{ route.maxEle }}m
                  <span v-if="route.elevationGainM && route.elevationGainM > 0">
                    (爬升 {{ route.elevationGainM }}m)
                  </span>
                </div>
              </div>
            </v-card>
          </div>

          <!-- 随行实拍照片快速条带预览 -->
          <v-card rounded="lg" variant="tonal" class="pa-4 card-fill">
            <div class="d-flex align-center justify-space-between mb-3">
              <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
                <v-icon size="20" color="primary">mdi-camera-outline</v-icon>
                <span>运动随行拍摄照片 ({{ routePhotos.length }})</span>
              </div>
              <v-btn
                v-if="routePhotos.length > 0"
                variant="text"
                size="small"
                @click="activeTab = 'photos'"
              >
                查看全部
              </v-btn>
            </div>

            <div v-if="routePhotos.length > 0" class="d-flex ga-2 overflow-x-auto pb-2">
              <div
                v-for="p in routePhotos.slice(0, 10)"
                :key="p.path"
                class="photo-thumb-wrap cursor-pointer"
                @click="emit('viewPhoto', p, routePhotos)"
              >
                <img :src="photoThumbUrl(p.path)" class="photo-thumb" loading="lazy" />
                <div class="photo-time-badge">{{ formatPhotoTime(p.taken_at) }}</div>
              </div>
            </div>
            <div v-else class="text-caption text-medium-emphasis text-center py-2">
              该时间段内暂无拍摄照片，可在「足迹构建」中导入并贴合更多相册照片
            </div>
          </v-card>
        </div>

        <!-- 2. 分公里配速与柱状图 (Splits) -->
        <div v-else-if="activeTab === 'splits'" class="d-flex flex-column ga-3">
          <div class="text-caption text-medium-emphasis mb-2">
            每公里阶段耗时与均速表现（条形宽度与速度正相关）：
          </div>

          <div v-if="route.splits && route.splits.length > 0" class="d-flex flex-column ga-2">
            <div
              v-for="split in route.splits"
              :key="split.km"
              class="split-row pa-2 px-3 rounded-lg d-flex align-center justify-space-between ga-3"
            >
              <div class="split-km font-weight-bold">第 {{ split.km }} km</div>

              <!-- 动态速度进度条 -->
              <div class="split-bar-wrap flex-grow-1 min-width-0">
                <div
                  class="split-bar"
                  :style="{ width: `${Math.min(100, (split.avgSpeedKmh / maxSplitSpeed) * 100)}%` }"
                />
              </div>

              <div class="split-speed text-right font-weight-bold text-primary">
                {{ split.avgSpeedKmh }}
                <span class="text-caption font-weight-regular unit">km/h</span>
              </div>
              <div class="split-time text-right text-medium-emphasis text-caption">
                {{ formatDuration(split.durationSec) }}
              </div>
            </div>
          </div>
          <div v-else class="text-center py-6 text-disabled">暂无分公里数据</div>
        </div>

        <!-- 3. 随行照片完整列表 -->
        <div v-else-if="activeTab === 'photos'">
          <div v-if="routePhotos.length > 0" class="photos-grid">
            <div
              v-for="p in routePhotos"
              :key="p.path"
              class="photo-card rounded-lg overflow-hidden cursor-pointer"
              @click="emit('viewPhoto', p, routePhotos)"
            >
              <img :src="photoThumbUrl(p.path)" class="grid-img" loading="lazy" />
              <div class="photo-info pa-2 d-flex justify-space-between align-center">
                <span class="text-caption">{{ formatPhotoTime(p.taken_at) }}</span>
                <v-icon v-if="p.gps_track" size="14" color="primary">mdi-check-decagram</v-icon>
              </div>
            </div>
          </div>
          <div v-else class="text-center py-8 text-disabled">当前航线时间段内未发现匹配照片</div>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.route-modal-card {
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.hero-distance {
  font-size: 3rem;
  line-height: 1;
}

.metric-hero-card {
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.metric-item {
  padding: 8px 4px;
}

.metric-label {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.65);
  margin-bottom: 2px;
}

.metric-val {
  font-size: 1.15rem;
  font-weight: 700;
}

.unit {
  font-size: 0.75rem;
  opacity: 0.75;
}

.photo-thumb-wrap {
  position: relative;
  width: 90px;
  height: 90px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}

.photo-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.2s ease;
}

.photo-thumb-wrap:hover .photo-thumb {
  transform: scale(1.08);
}

.photo-time-badge {
  position: absolute;
  bottom: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
}

.split-row {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.split-km {
  width: 80px;
  font-size: 0.85rem;
}

.split-bar-wrap {
  height: 12px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 6px;
  overflow: hidden;
}

.split-bar {
  height: 100%;
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.6),
    rgba(var(--v-theme-primary), 1)
  );
  border-radius: 6px;
  transition: width 0.3s ease;
}

.split-speed {
  width: 90px;
  font-size: 0.95rem;
}

.split-time {
  width: 80px;
}

.photos-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}

.photo-card {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
}

.grid-img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
}
</style>
