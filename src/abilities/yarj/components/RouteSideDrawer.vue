<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-side-drawer' })

import { ref, computed } from 'vue'
import type { Route } from '../types'
import { isRouteIntersectingCircle } from '../route-parser'

const props = defineProps<{
  modelValue: boolean
  routes: Route[]
  activeRouteId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'selectRoute', route: Route): void
  (e: 'openDetail', route: Route): void
  (e: 'toggleActive', routeId: string): void
  (e: 'deleteRoute', route: Route): void
}>()

const searchQuery = ref('')
const selectedActivity = ref<string>('all')

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '00:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

// 过滤后的航线列表（支持关键词与 :gps(lon, lat, km) 空间区域相交）
const filteredRoutes = computed<Route[]>(() => {
  let list = props.routes

  if (selectedActivity.value !== 'all') {
    list = list.filter((r) => r.activityType === selectedActivity.value)
  }

  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return list

  // 解析 :gps(lon, lat, km) 指令
  const gpsMatch = /:gps(?:\(([^)]+)\))?/i.exec(query)
  if (gpsMatch) {
    const args = (gpsMatch[1] || '').trim()
    if (args) {
      const parts = args
        .replace(/km/gi, '')
        .split(/[,;\s]+/)
        .map(parseFloat)
        .filter((n) => !Number.isNaN(n))
      if (parts.length >= 2) {
        const targetLon = parts[0]
        const targetLat = parts[1]
        const radiusKm = parts.length >= 3 ? parts[2] : 5
        list = list.filter((r) => isRouteIntersectingCircle(r, targetLon, targetLat, radiusKm))
      }
    }
  }

  // 移除指令后的文本关键字过滤
  const cleanQuery = query.replace(/:gps(?:\([^)]*\))?/gi, '').trim()
  if (!cleanQuery) return list

  return list.filter((r) => {
    return (
      r.name.toLowerCase().includes(cleanQuery) ||
      (r.desc && r.desc.toLowerCase().includes(cleanQuery)) ||
      (r.activityType && r.activityType.toLowerCase().includes(cleanQuery)) ||
      (r.startTime && r.startTime.includes(cleanQuery))
    )
  })
})

function close(): void {
  emit('update:modelValue', false)
}

function onRouteClick(route: Route): void {
  emit('selectRoute', route)
}
</script>

<template>
  <v-navigation-drawer
    :model-value="modelValue"
    location="right"
    temporary
    width="420"
    class="route-drawer elevation-8"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="d-flex flex-column h-100">
      <!-- 抽屉头部 -->
      <div class="pa-4 pb-2 border-b d-flex align-center justify-space-between">
        <div class="d-flex align-center ga-2">
          <v-icon color="primary" size="24">mdi-routes</v-icon>
          <span class="text-subtitle-1 font-weight-bold">运动轨迹航线</span>
          <v-chip size="x-small" variant="tonal" color="primary">
            {{ filteredRoutes.length }} / {{ routes.length }}
          </v-chip>
        </div>
        <v-btn icon="mdi-close" variant="text" size="small" @click="close" />
      </div>

      <!-- 搜索与空间筛选 -->
      <div class="px-4 py-3 border-b">
        <v-text-field
          v-model="searchQuery"
          placeholder="搜索航线名称或 :gps(经度, 纬度, 距离km)"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          class="mb-2"
        />

        <div class="d-flex align-center justify-space-between ga-1">
          <v-chip-group
            v-model="selectedActivity"
            mandatory
            filter
            variant="tonal"
            density="compact"
          >
            <v-chip value="all">全部</v-chip>
            <v-chip value="cycling">骑行</v-chip>
            <v-chip value="running">跑步</v-chip>
            <v-chip value="walking">健步</v-chip>
            <v-chip value="hiking">徒步</v-chip>
          </v-chip-group>

          <!-- 若有当前聚焦航线，提示重置聚焦 -->
          <v-btn
            v-if="activeRouteId"
            size="x-small"
            variant="text"
            color="warning"
            prepend-icon="mdi-eye-off-outline"
            @click="emit('toggleActive', '')"
          >
            显示全部航线
          </v-btn>
        </div>
      </div>

      <!-- 航线卡片列表 -->
      <div class="flex-grow-1 overflow-y-auto pa-4 d-flex flex-column ga-3">
        <div v-if="filteredRoutes.length === 0" class="text-center py-12 text-disabled">
          <v-icon size="48" class="mb-2 opacity-50">mdi-map-marker-distance</v-icon>
          <div>暂无符合条件的运动航线</div>
          <div class="text-caption mt-1">支持输入 :gps(114.4, 30.5, 5km) 检索穿过该区域的轨迹</div>
        </div>

        <v-card
          v-for="route in filteredRoutes"
          :key="route.id"
          rounded="lg"
          variant="tonal"
          :class="[
            'route-card cursor-pointer',
            { 'route-card-active': activeRouteId === route.id }
          ]"
          @click="onRouteClick(route)"
        >
          <div class="pa-3">
            <div class="d-flex align-center justify-space-between mb-2">
              <div class="d-flex align-center ga-2 min-width-0">
                <v-icon
                  size="20"
                  :color="
                    route.activityType === 'cycling'
                      ? 'primary'
                      : route.activityType === 'running'
                        ? 'secondary'
                        : route.activityType === 'walking'
                          ? 'success'
                          : route.activityType === 'hiking'
                            ? 'warning'
                            : 'info'
                  "
                >
                  {{
                    route.activityType === 'cycling'
                      ? 'mdi-bike'
                      : route.activityType === 'running'
                        ? 'mdi-run'
                        : route.activityType === 'walking'
                          ? 'mdi-walk'
                          : route.activityType === 'hiking'
                            ? 'mdi-hiking'
                            : 'mdi-routes'
                  }}
                </v-icon>
                <span class="text-subtitle-2 font-weight-bold text-truncate">{{ route.name }}</span>
              </div>

              <div class="d-flex align-center ga-1 flex-shrink-0">
                <!-- 独立聚焦开关（降低其他路线存在感，防止光污染） -->
                <v-btn
                  icon
                  size="x-small"
                  variant="text"
                  :color="activeRouteId === route.id ? 'primary' : 'default'"
                  :title="activeRouteId === route.id ? '取消单独高亮' : '高亮此航线并暗化其余航线'"
                  @click.stop="emit('toggleActive', activeRouteId === route.id ? '' : route.id)"
                >
                  <v-icon>{{
                    activeRouteId === route.id ? 'mdi-lightbulb' : 'mdi-lightbulb-outline'
                  }}</v-icon>
                </v-btn>

                <!-- 详情看板 -->
                <v-btn
                  icon="mdi-chart-box-outline"
                  size="x-small"
                  variant="text"
                  title="查看完整运动数据看板"
                  @click.stop="emit('openDetail', route)"
                />
              </div>
            </div>

            <!-- 数据统计条 -->
            <div
              class="d-flex align-center justify-space-between text-caption text-medium-emphasis"
            >
              <div>
                <span class="font-weight-bold text-high-emphasis text-body-2">
                  {{ (route.totalDistanceM / 1000).toFixed(2) }}
                </span>
                km
              </div>
              <div>
                <span class="font-weight-bold text-high-emphasis text-body-2">
                  {{ route.avgSpeedKmh }}
                </span>
                km/h
              </div>
              <div>
                {{ formatDuration(route.durationSec) }}
              </div>
              <div>
                {{ formatDate(route.startTime) }}
              </div>
            </div>

            <!-- 次要指标徽章条（心率、卡路里、步数、设备） -->
            <div
              v-if="route.avgHr || route.calories || route.steps || route.deviceType"
              class="d-flex align-center ga-3 mt-2 pt-2 border-t text-caption text-medium-emphasis flex-wrap"
            >
              <div v-if="route.avgHr" class="d-flex align-center ga-1 text-error">
                <v-icon size="14">mdi-heart-pulse</v-icon>
                <span>{{ route.avgHr }} bpm</span>
              </div>
              <div v-if="route.calories" class="d-flex align-center ga-1 text-warning">
                <v-icon size="14">mdi-fire</v-icon>
                <span>{{ route.calories }} kcal</span>
              </div>
              <div v-if="route.steps" class="d-flex align-center ga-1 text-info">
                <v-icon size="14">mdi-shoe-sneaker</v-icon>
                <span>{{ route.steps.toLocaleString() }} 步</span>
              </div>
              <div
                v-if="route.deviceType"
                class="d-flex align-center ga-1 ml-auto text-medium-emphasis"
              >
                <v-icon size="14">
                  {{
                    route.deviceType === 'smart_watch'
                      ? 'mdi-watch'
                      : route.deviceType === 'indoor'
                        ? 'mdi-home-fitness'
                        : 'mdi-cellphone'
                  }}
                </v-icon>
                <span>{{
                  route.deviceType === 'smart_watch'
                    ? '手表'
                    : route.deviceType === 'indoor'
                      ? '室内'
                      : '手机'
                }}</span>
              </div>
            </div>
          </div>
        </v-card>
      </div>
    </div>
  </v-navigation-drawer>
</template>

<style scoped>
.route-drawer {
  background: rgba(var(--v-theme-surface), 0.96) !important;
  backdrop-filter: blur(16px);
}

.route-card {
  transition: all 0.2s ease;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.route-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.4);
  transform: translateY(-1px);
}

.route-card-active {
  border-color: rgb(var(--v-theme-primary)) !important;
  box-shadow: 0 0 12px rgba(var(--v-theme-primary), 0.3);
  background: rgba(var(--v-theme-primary), 0.08) !important;
}
</style>
