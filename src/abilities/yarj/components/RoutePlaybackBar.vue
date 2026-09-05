<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-playback-bar' })

import { ref } from 'vue'
import type { Route, RouteSplit } from '../types'

defineProps<{
  route: Route
  isPlaying: boolean
  progress: number
  currentTimeStr: string
  elapsedDurationStr: string
  totalDurationStr: string
  currentDistKmStr: string
  totalDistKmStr: string
  currentSpeedKmh: number | null
  currentEleM: number | null
  currentHr: number | null
  speed: number
  followCamera: boolean
  photosDrawerOpen: boolean
  currentPhotosCount: number
  splits?: RouteSplit[]
}>()

const emit = defineEmits<{
  (e: 'togglePlay'): void
  (e: 'update:progress', val: number): void
  (e: 'update:speed', val: number): void
  (e: 'update:followCamera', val: boolean): void
  (e: 'reCenter'): void
  (e: 'togglePhotosDrawer'): void
  (e: 'jumpTime', deltaSec: number): void
  (e: 'jumpToSplit', split: RouteSplit): void
  (e: 'close'): void
}>()

const speedOptions = [1, 5, 15, 30, 60]

const splitsMenuOpen = ref(false)

function onSliderChange(v: number): void {
  emit('update:progress', v / 100)
}

function onSelectSplit(s: RouteSplit): void {
  emit('jumpToSplit', s)
  splitsMenuOpen.value = false
}
</script>

<template>
  <div class="yarj-route-playback-bar" :class="{ 'has-drawer-open': photosDrawerOpen }">
    <div class="playback-card d-flex flex-column ga-3">
      <!-- 1. 顶部行：航线标题、实时运动指标与右侧动作 -->
      <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
        <div class="d-flex align-center ga-2 min-w-0 flex-grow-1">
          <v-avatar color="primary" size="32" variant="tonal" class="flex-shrink-0">
            <v-icon size="18">
              {{
                route.activityType === 'cycling'
                  ? 'mdi-bike'
                  : route.activityType === 'running'
                    ? 'mdi-run'
                    : 'mdi-motion-play'
              }}
            </v-icon>
          </v-avatar>

          <span class="text-subtitle-1 font-weight-bold text-truncate">{{ route.name }}</span>

          <!-- 实时速度 -->
          <v-chip
            v-if="currentSpeedKmh != null && currentSpeedKmh > 0"
            size="small"
            color="primary"
            variant="tonal"
            class="font-mono font-weight-medium"
          >
            <v-icon start size="14">mdi-speedometer</v-icon>
            {{ currentSpeedKmh.toFixed(1) }} km/h
          </v-chip>

          <!-- 实时海拔 -->
          <v-chip
            v-if="currentEleM != null"
            size="small"
            variant="tonal"
            class="font-mono font-weight-medium"
          >
            <v-icon start size="14">mdi-elevation-rise</v-icon>
            {{ currentEleM.toFixed(0) }} m
          </v-chip>

          <!-- 实时心率 -->
          <v-chip
            v-if="currentHr != null && currentHr > 0"
            size="small"
            color="error"
            variant="tonal"
            class="font-mono font-weight-medium"
          >
            <v-icon start size="14">mdi-heart-pulse</v-icon>
            {{ currentHr }} bpm
          </v-chip>
        </div>

        <!-- 右侧动作组 -->
        <div class="d-flex align-center ga-2 flex-shrink-0">
          <!-- 周围时刻图片侧栏切换开关 -->
          <v-btn
            :color="photosDrawerOpen ? 'primary' : undefined"
            :variant="photosDrawerOpen ? 'flat' : 'tonal'"
            prepend-icon="mdi-camera-timer"
            class="font-weight-medium px-3"
            @click="emit('togglePhotosDrawer')"
          >
            周围时刻照片
            <v-badge
              v-if="currentPhotosCount > 0"
              inline
              color="primary"
              :content="currentPhotosCount"
              class="ml-1"
            />
          </v-btn>

          <!-- 视角锁定与跟随 -->
          <v-btn
            :variant="followCamera ? 'flat' : 'tonal'"
            :color="followCamera ? 'primary' : undefined"
            size="small"
            icon
            :title="followCamera ? '镜头跟随中（点击立即居中）' : '自由视角（点击恢复居中跟随）'"
            @click="emit('reCenter')"
          >
            <v-icon size="18">{{ followCamera ? 'mdi-crosshairs-gps' : 'mdi-pan' }}</v-icon>
          </v-btn>

          <!-- 退出播放模式 -->
          <v-btn
            variant="text"
            icon="mdi-close"
            size="small"
            title="退出行程播放"
            @click="emit('close')"
          />
        </div>
      </div>

      <!-- 2. 中部行：全幅时间轴与进度拖动条 -->
      <div class="timeline-row d-flex flex-column ga-1">
        <div class="d-flex align-center justify-space-between text-caption font-mono">
          <span class="text-primary font-weight-bold">
            {{ currentTimeStr || '起点' }}
            <span class="text-medium-emphasis ml-1">({{ elapsedDurationStr }})</span>
          </span>
          <span class="text-medium-emphasis">
            {{ currentDistKmStr }} / {{ totalDistKmStr }}
            <span class="ml-1">· 总长 {{ totalDurationStr }}</span>
          </span>
        </div>

        <div class="slider-wrap">
          <v-slider
            :model-value="progress * 100"
            :min="0"
            :max="100"
            :step="0.05"
            color="primary"
            track-color="surface-variant"
            hide-details
            density="compact"
            @update:model-value="onSliderChange"
          />
        </div>
      </div>

      <!-- 3. 底部行：线性动画播放控制 + 时间颗粒度快捷跳转 -->
      <div class="d-flex align-center justify-space-between ga-2 flex-wrap">
        <!-- 左侧：播放/暂停与微调跳转 -->
        <div class="d-flex align-center ga-2">
          <v-btn
            color="primary"
            variant="flat"
            icon
            size="default"
            class="elevation-2"
            @click="emit('togglePlay')"
          >
            <v-icon size="24">{{ isPlaying ? 'mdi-pause' : 'mdi-play' }}</v-icon>
          </v-btn>

          <!-- 时间颗粒度跳转按钮组 -->
          <div class="d-flex align-center ga-1 ml-1">
            <v-btn
              variant="tonal"
              size="small"
              class="px-2 font-mono"
              title="后退 5 分钟"
              @click="emit('jumpTime', -300)"
            >
              -5m
            </v-btn>
            <v-btn
              variant="tonal"
              size="small"
              class="px-2 font-mono"
              title="后退 1 分钟"
              @click="emit('jumpTime', -60)"
            >
              -1m
            </v-btn>
            <v-btn
              variant="tonal"
              size="small"
              class="px-2 font-mono"
              title="前进 1 分钟"
              @click="emit('jumpTime', 60)"
            >
              +1m
            </v-btn>
            <v-btn
              variant="tonal"
              size="small"
              class="px-2 font-mono"
              title="前进 5 分钟"
              @click="emit('jumpTime', 300)"
            >
              +5m
            </v-btn>
          </div>

          <!-- 分公里阶段跳转 (Splits Jump) -->
          <v-menu
            v-if="splits && splits.length > 0"
            v-model="splitsMenuOpen"
            location="top start"
            offset="8"
          >
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                variant="tonal"
                size="small"
                prepend-icon="mdi-map-marker-path"
                class="ml-1"
              >
                分公里里程
              </v-btn>
            </template>
            <v-card
              class="pa-2 rounded-xl elevation-6"
              min-width="200"
              max-height="260"
              style="
                background: rgba(var(--v-theme-surface), 0.95);
                backdrop-filter: blur(20px);
                overflow-y: auto;
              "
            >
              <div class="text-caption text-medium-emphasis px-2 py-1 font-weight-bold">
                跳转至指定公里里程碑：
              </div>
              <v-list density="compact" nav class="pa-0">
                <v-list-item v-for="s in splits" :key="s.km" rounded="lg" @click="onSelectSplit(s)">
                  <template #prepend>
                    <v-icon size="16" color="primary">mdi-flag-checkered</v-icon>
                  </template>
                  <v-list-item-title class="font-weight-medium">
                    第 {{ s.km }} 公里
                  </v-list-item-title>
                  <template #append>
                    <span class="text-caption font-mono text-medium-emphasis">
                      {{ s.avgSpeedKmh }} km/h
                    </span>
                  </template>
                </v-list-item>
              </v-list>
            </v-card>
          </v-menu>
        </div>

        <!-- 右侧：倍速切换选择器 -->
        <div class="d-flex align-center ga-1">
          <span class="text-caption text-medium-emphasis mr-1">播放速率：</span>
          <v-chip
            v-for="s in speedOptions"
            :key="s"
            size="small"
            :variant="speed === s ? 'flat' : 'tonal'"
            :color="speed === s ? 'primary' : undefined"
            class="font-mono cursor-pointer"
            @click="emit('update:speed', s)"
          >
            {{ s }}x
          </v-chip>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.yarj-route-playback-bar {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 48px);
  max-width: 860px;
  z-index: 20;
  pointer-events: none;
  transition:
    left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.yarj-route-playback-bar.has-drawer-open {
  left: 24px;
  transform: none;
  width: calc(100% - 380px - 48px);
  max-width: calc(100% - 380px - 48px);
}

.playback-card {
  pointer-events: auto;
  background: rgba(var(--v-theme-surface), 0.88);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  border-radius: 18px;
  padding: 16px 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
}

.slider-wrap {
  margin-top: -4px;
  margin-bottom: -6px;
}
</style>
