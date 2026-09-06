<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-detail-modal' })

import { ref, computed, watch } from 'vue'
import type { Route, Photo } from '../types'
import { photoThumbUrl } from '../types'

const props = defineProps<{
  modelValue: boolean
  route: Route | null
  explorationActive?: boolean
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

function formatPace(sec?: number): string {
  if (!sec || sec <= 0) return '-'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}'${String(s).padStart(2, '0')}"`
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

const hasHrZones = computed(() => {
  const z = props.route?.hrZones
  if (!z) return false
  return (
    (z.warmUpDurationSec || 0) +
      (z.fatBurningDurationSec || 0) +
      (z.aerobicDurationSec || 0) +
      (z.anaerobicDurationSec || 0) +
      (z.extremeDurationSec || 0) >
    0
  )
})

const totalHrZoneSec = computed(() => {
  const z = props.route?.hrZones
  if (!z) return 0
  return (
    (z.warmUpDurationSec || 0) +
    (z.fatBurningDurationSec || 0) +
    (z.aerobicDurationSec || 0) +
    (z.anaerobicDurationSec || 0) +
    (z.extremeDurationSec || 0)
  )
})

function getZonePercent(sec?: number | null): number {
  if (!sec || totalHrZoneSec.value <= 0) return 0
  return Math.round((sec / totalHrZoneSec.value) * 100)
}

function getTrainingEffectText(te?: number): string {
  if (te == null || te <= 0) return ''
  if (te < 1.0) return '轻微恢复'
  if (te < 2.0) return '基础维持'
  if (te < 3.0) return '提升心肺'
  if (te < 4.0) return '显著提升'
  return '极限突破'
}

const hasRunningMetrics = computed(() => {
  const r = props.route
  if (!r) return false
  return !!(
    (r.avgCadence && r.avgCadence > 0) ||
    (r.steps && r.steps > 0) ||
    (r.avgStrideCm && r.avgStrideCm > 0) ||
    (r.avgPaceSec && r.avgPaceSec > 0)
  )
})

const hasTrainingMetrics = computed(() => {
  const r = props.route
  if (!r) return false
  return !!(
    r.trainLoad != null ||
    r.trainEffect != null ||
    r.recoverTimeHours != null ||
    r.vo2Max != null
  )
})

const deviceDisplay = computed(() => {
  const r = props.route
  if (!r) return null
  if (r.deviceType === 'smart_watch') {
    return { icon: 'mdi-watch', label: '智能手环 / 手表' }
  }
  if (r.deviceType === 'phone') {
    return { icon: 'mdi-cellphone', label: '智能手机' }
  }
  if (r.deviceType === 'indoor') {
    return { icon: 'mdi-home-fitness', label: '室内健身记录' }
  }
  if (r.deviceId) {
    return { icon: 'mdi-devices', label: `设备 ${r.deviceId}` }
  }
  return null
})

function close(): void {
  emit('update:modelValue', false)
}

function handlePlay(): void {
  if (props.explorationActive) return
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
    max-width="920"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card v-if="route" rounded="xl" class="route-modal-card">
      <!-- 头部：标题与活动状态 -->
      <v-card-title
        class="pa-5 pb-3 d-flex align-center justify-space-between flex-wrap ga-2 border-b flex-shrink-0 route-modal-title"
      >
        <div class="d-flex align-center ga-3">
          <v-avatar color="primary" size="44" variant="tonal">
            <v-icon size="26">
              {{
                route.activityType === 'cycling'
                  ? 'mdi-bike'
                  : route.activityType === 'running'
                    ? 'mdi-run'
                    : route.activityType === 'walking'
                      ? 'mdi-walk'
                      : route.activityType === 'hiking'
                        ? 'mdi-hiking'
                        : route.activityType === 'indoor'
                          ? 'mdi-home-fitness'
                          : 'mdi-routes'
              }}
            </v-icon>
          </v-avatar>
          <div>
            <div class="text-h6 font-weight-bold d-flex align-center flex-wrap ga-2">
              <span>{{ route.name }}</span>
              <v-chip variant="flat" color="primary" class="activity-chip">
                {{
                  route.activityType === 'cycling'
                    ? '户外骑行'
                    : route.activityType === 'running'
                      ? '户外跑步'
                      : route.activityType === 'walking'
                        ? '健步走'
                        : route.activityType === 'hiking'
                          ? '徒步登山'
                          : route.activityType === 'indoor'
                            ? '室内运动'
                            : '运动轨迹'
                }}
              </v-chip>
              <v-chip
                v-if="deviceDisplay"
                variant="tonal"
                color="info"
                class="device-chip"
                :prepend-icon="deviceDisplay.icon"
              >
                {{ deviceDisplay.label }}
              </v-chip>
            </div>
            <div class="text-caption text-medium-emphasis mt-1">
              {{ formatDate(route.startTime) }}
              <span v-if="route.endTime"> ~ {{ formatDate(route.endTime).split(' ')[1] }}</span>
              <span v-if="route.pointCount > 0" class="ml-2">({{ route.pointCount }} 点)</span>
            </div>
          </div>
        </div>

        <div class="d-flex align-center ga-2 flex-wrap">
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-motion-play"
            :disabled="explorationActive || route.pointCount <= 1"
            :title="
              explorationActive
                ? '我的探索漫游进行中，请先退出探索再播放'
                : route.pointCount <= 1
                  ? '该运动无连续航线轨迹，无法播放'
                  : '播放此次行程'
            "
            @click="handlePlay"
          >
            播放行程
          </v-btn>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-crosshairs-gps"
            :disabled="!route.bounds || (route.bounds[0] === 0 && route.bounds[1] === 0)"
            :title="
              !route.bounds || (route.bounds[0] === 0 && route.bounds[1] === 0)
                ? '该运动无地理坐标'
                : '在地图上查看位置'
            "
            @click="handleFocus"
          >
            地图聚焦
          </v-btn>
          <v-btn
            color="secondary"
            variant="tonal"
            prepend-icon="mdi-camera-timer"
            :disabled="route.pointCount <= 1"
            :title="route.pointCount <= 1 ? '无连续轨迹可贴合照片' : '轨迹贴合照片'"
            @click="handleGeotag"
          >
            轨迹贴合照片
          </v-btn>
          <v-btn icon="mdi-close" variant="text" size="small" @click="close" />
        </div>
      </v-card-title>

      <!-- 选项卡切换 -->
      <v-tabs
        v-model="activeTab"
        color="primary"
        class="px-5 border-b flex-shrink-0 route-modal-tabs"
      >
        <v-tab value="overview">总览指标</v-tab>
        <v-tab value="splits">分公里配速 ({{ route.splits?.length || 0 }})</v-tab>
        <v-tab value="photos">随行实拍照片 ({{ routePhotos.length }})</v-tab>
      </v-tabs>

      <!-- 内容区 -->
      <v-card-text class="pa-5 flex-grow-1 overflow-y-auto route-modal-body">
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

          <!-- 运动动力学表现（跑步/健步走步频、步幅、步数、配速） -->
          <v-card v-if="hasRunningMetrics" rounded="lg" variant="tonal" class="pa-4 card-fill">
            <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2 mb-3">
              <v-icon size="20" color="primary">mdi-shoe-sneaker</v-icon>
              <span>运动动力学表现 (Dynamics)</span>
            </div>
            <v-row dense>
              <v-col v-if="route.avgPaceSec" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">平均配速</div>
                  <div class="metric-val">
                    {{ formatPace(route.avgPaceSec) }} <span class="unit">/km</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.minPaceSec" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">最佳配速</div>
                  <div class="metric-val text-primary">
                    {{ formatPace(route.minPaceSec) }} <span class="unit">/km</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.steps" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">总步数</div>
                  <div class="metric-val">
                    {{ route.steps.toLocaleString() }} <span class="unit">步</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.avgCadence" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">平均步频</div>
                  <div class="metric-val">{{ route.avgCadence }} <span class="unit">spm</span></div>
                </div>
              </v-col>
              <v-col v-if="route.maxCadence" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">最高步频</div>
                  <div class="metric-val text-secondary">
                    {{ route.maxCadence }} <span class="unit">spm</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.avgStrideCm" cols="6" sm="4">
                <div class="metric-item">
                  <div class="metric-label">平均步幅</div>
                  <div class="metric-val">{{ route.avgStrideCm }} <span class="unit">cm</span></div>
                </div>
              </v-col>
            </v-row>
          </v-card>

          <!-- 心率区间分布 (Heart Rate Zones) -->
          <v-card
            v-if="hasHrZones"
            rounded="lg"
            variant="tonal"
            class="pa-4 card-fill hr-zones-card"
          >
            <div class="d-flex align-center justify-space-between mb-3 flex-wrap ga-2">
              <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
                <v-icon size="20" color="error">mdi-heart-pulse</v-icon>
                <span>心率区间分布 (Heart Rate Zones)</span>
              </div>
              <div class="text-caption text-medium-emphasis">
                总记录时长: {{ formatDuration(totalHrZoneSec) }}
                <span v-if="route.minHr && route.maxHr" class="ml-2">
                  ({{ route.minHr }} ~ {{ route.maxHr }} bpm)
                </span>
              </div>
            </div>

            <!-- 五段式心率堆叠比例条 -->
            <div class="hr-zones-stacked-bar mb-4">
              <div
                v-if="route.hrZones?.warmUpDurationSec"
                class="zone-bar-segment zone-warmup"
                :style="{ width: `${getZonePercent(route.hrZones.warmUpDurationSec)}%` }"
                :title="`热身放松: ${formatDuration(route.hrZones.warmUpDurationSec)} (${getZonePercent(route.hrZones.warmUpDurationSec)}%)`"
              />
              <div
                v-if="route.hrZones?.fatBurningDurationSec"
                class="zone-bar-segment zone-fatburn"
                :style="{ width: `${getZonePercent(route.hrZones.fatBurningDurationSec)}%` }"
                :title="`脂肪消耗: ${formatDuration(route.hrZones.fatBurningDurationSec)} (${getZonePercent(route.hrZones.fatBurningDurationSec)}%)`"
              />
              <div
                v-if="route.hrZones?.aerobicDurationSec"
                class="zone-bar-segment zone-aerobic"
                :style="{ width: `${getZonePercent(route.hrZones.aerobicDurationSec)}%` }"
                :title="`心肺耐力: ${formatDuration(route.hrZones.aerobicDurationSec)} (${getZonePercent(route.hrZones.aerobicDurationSec)}%)`"
              />
              <div
                v-if="route.hrZones?.anaerobicDurationSec"
                class="zone-bar-segment zone-anaerobic"
                :style="{ width: `${getZonePercent(route.hrZones.anaerobicDurationSec)}%` }"
                :title="`无氧耐力: ${formatDuration(route.hrZones.anaerobicDurationSec)} (${getZonePercent(route.hrZones.anaerobicDurationSec)}%)`"
              />
              <div
                v-if="route.hrZones?.extremeDurationSec"
                class="zone-bar-segment zone-extreme"
                :style="{ width: `${getZonePercent(route.hrZones.extremeDurationSec)}%` }"
                :title="`极限爆发: ${formatDuration(route.hrZones.extremeDurationSec)} (${getZonePercent(route.hrZones.extremeDurationSec)}%)`"
              />
            </div>

            <!-- 五区间明细网格 -->
            <div class="d-flex flex-column ga-2">
              <div
                v-for="zone in [
                  {
                    key: 'extreme',
                    name: '极限爆发 (Anaerobic Capacity)',
                    sec: route.hrZones?.extremeDurationSec,
                    color: '#f44336'
                  },
                  {
                    key: 'anaerobic',
                    name: '无氧耐力 (Threshold)',
                    sec: route.hrZones?.anaerobicDurationSec,
                    color: '#ff9800'
                  },
                  {
                    key: 'aerobic',
                    name: '心肺耐力 (Aerobic)',
                    sec: route.hrZones?.aerobicDurationSec,
                    color: '#2196f3'
                  },
                  {
                    key: 'fatburn',
                    name: '脂肪消耗 (Fat Burn)',
                    sec: route.hrZones?.fatBurningDurationSec,
                    color: '#00bcd4'
                  },
                  {
                    key: 'warmup',
                    name: '热身放松 (Warm Up)',
                    sec: route.hrZones?.warmUpDurationSec,
                    color: '#4caf50'
                  }
                ]"
                :key="zone.key"
                class="zone-detail-row d-flex align-center justify-space-between pa-2 px-3 rounded-lg"
              >
                <div class="d-flex align-center ga-2">
                  <span class="zone-dot" :style="{ backgroundColor: zone.color }" />
                  <span class="text-caption font-weight-medium">{{ zone.name }}</span>
                </div>
                <div class="d-flex align-center ga-3">
                  <span class="text-caption text-medium-emphasis">{{
                    formatDuration(zone.sec || 0)
                  }}</span>
                  <span
                    class="text-caption font-weight-bold"
                    :style="{ color: zone.color, width: '45px', textAlign: 'right' }"
                  >
                    {{ getZonePercent(zone.sec) }}%
                  </span>
                </div>
              </div>
            </div>
          </v-card>

          <!-- 训练负荷与体能恢复 (Training Status) -->
          <v-card v-if="hasTrainingMetrics" rounded="lg" variant="tonal" class="pa-4 card-fill">
            <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2 mb-3">
              <v-icon size="20" color="success">mdi-lightning-bolt</v-icon>
              <span>训练负荷与体能恢复 (Training Status)</span>
            </div>
            <v-row dense>
              <v-col v-if="route.trainEffect != null" cols="6" sm="3">
                <div class="metric-item">
                  <div class="metric-label">训练效果 (TE)</div>
                  <div class="metric-val text-success">
                    {{ route.trainEffect }}
                    <span class="unit ml-1">{{ getTrainingEffectText(route.trainEffect) }}</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.recoverTimeHours != null" cols="6" sm="3">
                <div class="metric-item">
                  <div class="metric-label">建议恢复时间</div>
                  <div class="metric-val text-info">
                    {{ route.recoverTimeHours }} <span class="unit">小时</span>
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.trainLoad != null" cols="6" sm="3">
                <div class="metric-item">
                  <div class="metric-label">运动负荷 (Load)</div>
                  <div class="metric-val text-warning">
                    {{ route.trainLoad }}
                  </div>
                </div>
              </v-col>
              <v-col v-if="route.vo2Max != null" cols="6" sm="3">
                <div class="metric-item">
                  <div class="metric-label">最大摄氧量 (VO2Max)</div>
                  <div class="metric-val text-primary">
                    {{ route.vo2Max }} <span class="unit">ml/kg/min</span>
                  </div>
                </div>
              </v-col>
            </v-row>
          </v-card>

          <!-- 传感器状态与打卡地点卡片 (仅当有数据时展示，无数据彻底隐藏) -->
          <div
            v-if="
              route.avgHr ||
              route.minEle != null ||
              (route.pointCount === 1 &&
                route.bounds &&
                (route.bounds[0] !== 0 || route.bounds[1] !== 0))
            "
            class="d-flex ga-3 flex-wrap"
          >
            <v-card
              v-if="
                route.pointCount === 1 &&
                route.bounds &&
                (route.bounds[0] !== 0 || route.bounds[1] !== 0)
              "
              rounded="lg"
              variant="outlined"
              class="flex-grow-1 pa-3 d-flex align-center ga-3"
            >
              <v-icon color="primary">mdi-map-marker-radius</v-icon>
              <div class="text-caption">
                <div class="font-weight-medium">运动打卡地点</div>
                <div class="text-medium-emphasis">
                  定位点: {{ route.bounds[1].toFixed(4) }}°N, {{ route.bounds[0].toFixed(4) }}°E
                  (地图已标记为打卡圆点)
                </div>
              </div>
            </v-card>

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
                  实时记录心率流 (均值 {{ route.avgHr }} bpm, 峰值
                  {{ route.maxHr ?? route.avgHr }} bpm)
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
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.route-modal-title {
  flex-shrink: 0 !important;
}

.route-modal-tabs,
.route-modal-card :deep(.v-tabs) {
  flex-shrink: 0 !important;
  min-height: 48px !important;
  height: 48px !important;
}

.route-modal-body {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
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

.activity-chip,
.device-chip {
  padding-block: 4px;
  min-height: 26px;
}

.hr-zones-stacked-bar {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  background: rgba(var(--v-theme-on-surface), 0.08);
}

.zone-bar-segment {
  height: 100%;
  transition: width 0.3s ease;
}

.zone-warmup {
  background-color: #4caf50;
}
.zone-fatburn {
  background-color: #00bcd4;
}
.zone-aerobic {
  background-color: #2196f3;
}
.zone-anaerobic {
  background-color: #ff9800;
}
.zone-extreme {
  background-color: #f44336;
}

.zone-detail-row {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.zone-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
</style>
