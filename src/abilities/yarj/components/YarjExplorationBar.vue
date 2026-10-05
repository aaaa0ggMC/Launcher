<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-exploration-bar' })

import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, JourneyData, JourneyStage, JourneyLeg, ExploredGranularity } from '../types'
import { GRANULARITY_PRESETS } from '../types'
import { useYarjCompact } from '../composables/useYarjCompact'

const GRANULARITY_LIST: ExploredGranularity[] = ['fine', 'standard', 'trip', 'coarse', 'massive']

const props = defineProps<{
  explorationActive: boolean
  journeyData: JourneyData | null
  currentStageIndex: number
  currentStage: JourneyStage | null
  currentLeg: JourneyLeg | null
  drawerOpen: boolean
  isTimeShuttling: boolean
  isPlaying: boolean
  displayDatePart: string
  displayTimePart: string
  explorationGranularity: ExploredGranularity
  customStageCount: number | null
  currentGranularityIndex: number
  journeyFocusRange: number
  explorationPhotos: Photo[]
}>()

const emit = defineEmits<{
  (e: 'exit'): void
  (e: 'jump-stage', stageIndex: number): void
  (e: 'cycle-granularity', delta: -1 | 1): void
  (e: 'set-granularity', g: ExploredGranularity): void
  (e: 'set-custom-stage-count', count: number): void
  (e: 'reset-granularity'): void
  (e: 'set-focus-range', range: number): void
  (e: 'open-photo-drawer', photos: Photo[], center: [number, number]): void
  (e: 'prev-stage'): void
  (e: 'next-stage'): void
  (e: 'toggle-play'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const compact = useYarjCompact()

const jumpMenuOpen = ref(false)
const jumpStageInput = ref('')
const targetCountMenuOpen = ref(false)
const customTargetCountInput = ref('')
const focusRangeMenuOpen = ref(false)

function handleJumpStage(): void {
  const num = parseInt(jumpStageInput.value.trim(), 10)
  if (
    !Number.isNaN(num) &&
    props.journeyData &&
    num >= 1 &&
    num <= props.journeyData.stages.length
  ) {
    jumpToStageNum(num)
  }
}

function jumpToStageNum(num: number): void {
  if (!props.journeyData) return
  const targetIdx = Math.max(0, Math.min(num - 1, props.journeyData.stages.length - 1))
  emit('jump-stage', targetIdx)
  jumpMenuOpen.value = false
  jumpStageInput.value = ''
}

function applyCustomTargetCount(): void {
  const count = parseInt(customTargetCountInput.value.trim(), 10)
  if (!Number.isNaN(count) && count >= 2) {
    emit('set-custom-stage-count', count)
    targetCountMenuOpen.value = false
    customTargetCountInput.value = ''
  }
}

function setTargetCount(count: number): void {
  emit('set-custom-stage-count', count)
  targetCountMenuOpen.value = false
}

function resetToGranularity(): void {
  emit('reset-granularity')
  targetCountMenuOpen.value = false
}
</script>

<template>
  <div>
    <!-- 探索模式顶部「时空穿梭 / 当前时间」醒目 HUD 胶囊栏 -->
    <Transition name="fade">
      <div
        v-if="explorationActive && journeyData?.stages.length"
        class="yarj-journey-time-badge"
        :class="{ 'has-drawer-open': drawerOpen, 'is-compact': compact }"
      >
        <div class="time-badge-inner">
          <v-icon
            size="24"
            color="primary"
            class="time-shuttle-icon mr-1"
            :class="{ 'is-shuttling': isTimeShuttling || isPlaying }"
          >
            {{ isPlaying ? 'mdi-timelapse' : 'mdi-clock-time-four-outline' }}
          </v-icon>
          <div class="d-flex align-center ga-2 font-mono time-display">
            <span class="time-date-text">{{ displayDatePart }}</span>
            <span class="time-clock-text">{{ displayTimePart }}</span>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 「我的探索」沉浸式浮动控制面板 -->
    <Transition name="fade">
      <div
        v-if="explorationActive && journeyData?.stages.length"
        class="yarj-exploration-bar"
        :class="{ 'has-drawer-open': drawerOpen, 'is-compact': compact }"
      >
        <div class="exploration-card">
          <!-- 第一行：阶段信息、时空跃迁与退出按钮 -->
          <div class="d-flex align-center flex-wrap ga-3 mb-3 explore-head">
            <div class="d-flex align-center ga-2 min-w-0 flex-grow-1 explore-stage">
              <!-- 支持点击键入站点编号快速精准跳转 -->
              <v-menu
                v-model="jumpMenuOpen"
                :close-on-content-click="false"
                location="bottom start"
              >
                <template #activator="{ props: jumpProps }">
                  <v-chip
                    v-bind="jumpProps"
                    color="primary"
                    variant="flat"
                    class="font-weight-bold px-3 cursor-pointer flex-shrink-0"
                    :title="
                      t('yarj.exploration.jumpHint', '输入站点编号直接跳转 (1 ~ {total})').replace(
                        '{total}',
                        String(journeyData.stages.length)
                      )
                    "
                  >
                    {{
                      compact
                        ? `${currentStageIndex + 1} / ${journeyData.stages.length}`
                        : t('yarj.exploration.stageCount', '第 {curr} / {total} 站')
                            .replace('{curr}', String(currentStageIndex + 1))
                            .replace('{total}', String(journeyData.stages.length))
                    }}
                    <v-icon end size="14" class="ml-1 opacity-80">mdi-menu-swap</v-icon>
                  </v-chip>
                </template>
                <v-card
                  class="pa-4 rounded-xl elevation-6"
                  min-width="300"
                  style="
                    background: rgba(var(--v-theme-surface), 0.95);
                    backdrop-filter: blur(24px);
                  "
                >
                  <div class="text-subtitle-2 font-weight-bold mb-1">
                    {{
                      t('yarj.exploration.jumpTitle', '跳转至指定站点 (1 ~ {total})').replace(
                        '{total}',
                        String(journeyData.stages.length)
                      )
                    }}
                  </div>
                  <div class="text-caption on-surface-variant mb-3">
                    {{
                      t(
                        'yarj.exploration.jumpDesc',
                        '直接键入目标站点编号，一键快速飞往并穿梭到该时间点。'
                      )
                    }}
                  </div>
                  <div class="d-flex align-center ga-2 mb-3">
                    <v-text-field
                      v-model="jumpStageInput"
                      type="number"
                      :min="1"
                      :max="journeyData.stages.length"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :placeholder="String(currentStageIndex + 1)"
                      @keyup.enter="handleJumpStage"
                    />
                    <v-btn color="primary" variant="flat" @click="handleJumpStage">
                      {{ t('yarj.exploration.jumpBtn', '前往') }}
                    </v-btn>
                  </div>
                  <!-- 快捷节点跳转 -->
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(1)"
                    >
                      {{ t('yarj.exploration.firstStage', '首站 (1)') }}
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 4"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.25))"
                    >
                      25%
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 2"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.5))"
                    >
                      50%
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 4"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.75))"
                    >
                      75%
                    </v-chip>
                    <v-chip
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(journeyData.stages.length)"
                    >
                      {{
                        t('yarj.exploration.lastStage', '末站 ({total})').replace(
                          '{total}',
                          String(journeyData.stages.length)
                        )
                      }}
                    </v-chip>
                  </div>
                </v-card>
              </v-menu>

              <div class="min-w-0 flex-grow-1">
                <div class="text-subtitle-2 font-weight-bold text-truncate">
                  {{ currentStage?.title || '旅途节点' }}
                </div>
                <div
                  v-if="currentStage?.formattedTimeRange"
                  class="text-caption on-surface-variant font-mono text-truncate"
                >
                  {{ currentStage.formattedTimeRange }}
                </div>
              </div>
            </div>

            <!-- 右侧：交通推测 Chip 与 退出按钮（窄屏下交通 Chip 换到第二行铺满） -->
            <div v-if="currentLeg" class="explore-leg">
              <v-chip
                v-if="currentLeg"
                variant="tonal"
                :style="{
                  color: currentLeg.modeMeta.color,
                  borderColor: currentLeg.modeMeta.color
                }"
                class="px-3"
              >
                <v-icon start size="16">{{ currentLeg.modeMeta.icon }}</v-icon>
                <span class="font-weight-medium">{{
                  t(currentLeg.modeMeta.nameKey, currentLeg.modeMeta.defaultName)
                }}</span>
                <span class="ml-1 opacity-80 font-mono">
                  ·
                  {{ (currentLeg.distanceM / 1000).toFixed(currentLeg.distanceM > 10000 ? 0 : 1) }}
                  km
                  <template v-if="currentLeg.speedKmH">
                    ({{ currentLeg.speedKmH.toFixed(0) }} km/h)
                  </template>
                </span>
              </v-chip>
            </div>

            <v-btn
              icon
              size="small"
              variant="text"
              color="error"
              class="flex-shrink-0 explore-exit"
              :title="t('yarj.exploration.exit', '退出探索')"
              @click="emit('exit')"
            >
              <v-icon size="20">mdi-close</v-icon>
            </v-btn>
          </div>

          <v-divider class="mb-3 opacity-20" />

          <!-- 第二行：操作控制工具栏 -->
          <div class="d-flex align-center justify-space-between ga-3 flex-wrap explore-toolbar">
            <!-- 左侧：粒度选择器、自定义目标站数与视距聚焦 -->
            <div class="d-flex align-center ga-2 flex-wrap explore-tools">
              <div class="d-flex align-center ga-1 granularity-stepper">
                <span v-if="!compact" class="text-caption on-surface-variant mr-1"
                  >{{ t('yarj.exploration.granularity', '粒度') }}:</span
                >
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :disabled="currentGranularityIndex <= 0"
                  @click="emit('cycle-granularity', -1)"
                >
                  <v-icon size="16">mdi-chevron-left</v-icon>
                </v-btn>
                <v-menu location="top">
                  <template #activator="{ props: menuProps }">
                    <v-btn v-bind="menuProps" variant="tonal" class="font-weight-medium">
                      {{
                        customStageCount != null
                          ? `${customStageCount} 站 (自定义)`
                          : t(
                              GRANULARITY_PRESETS[explorationGranularity]?.nameKey,
                              GRANULARITY_PRESETS[explorationGranularity]?.defaultName
                            ).split(' ')[0] || '标准'
                      }}
                      <v-icon end size="14">mdi-menu-down</v-icon>
                    </v-btn>
                  </template>
                  <v-list density="compact">
                    <v-list-item
                      v-for="preset in Object.values(GRANULARITY_PRESETS)"
                      :key="preset.id"
                      :active="customStageCount == null && explorationGranularity === preset.id"
                      @click="emit('set-granularity', preset.id)"
                    >
                      <v-list-item-title class="text-caption">
                        {{ t(preset.nameKey, preset.defaultName) }}
                      </v-list-item-title>
                    </v-list-item>
                    <v-divider class="my-1 opacity-20" />
                    <v-list-item @click="targetCountMenuOpen = true">
                      <template #prepend>
                        <v-icon size="16">mdi-map-marker-distance</v-icon>
                      </template>
                      <v-list-item-title class="text-caption">
                        {{ t('yarj.exploration.customCountBtn', '自定义总站数...') }}
                      </v-list-item-title>
                    </v-list-item>
                  </v-list>
                </v-menu>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :disabled="currentGranularityIndex >= GRANULARITY_LIST.length - 1"
                  @click="emit('cycle-granularity', 1)"
                >
                  <v-icon size="16">mdi-chevron-right</v-icon>
                </v-btn>
              </div>

              <!-- 跳转至指定站点按钮（窄屏只留图标） -->
              <v-btn
                v-if="compact"
                icon
                size="small"
                variant="tonal"
                :title="t('yarj.exploration.jumpBtnTitle', '跳转站点')"
                @click="jumpMenuOpen = true"
              >
                <v-icon size="18">mdi-ray-start-arrow</v-icon>
              </v-btn>
              <v-btn
                v-else
                variant="tonal"
                class="font-weight-medium"
                prepend-icon="mdi-ray-start-arrow"
                :title="
                  t('yarj.exploration.jumpHint', '输入站点编号直接跳转 (1 ~ {total})').replace(
                    '{total}',
                    String(journeyData.stages.length)
                  )
                "
                @click="jumpMenuOpen = true"
              >
                {{ t('yarj.exploration.jumpBtnTitle', '跳转站点') }}
              </v-btn>

              <!-- 自定义目标站点数量弹窗 -->
              <v-dialog v-model="targetCountMenuOpen" max-width="360">
                <v-card
                  class="pa-4 rounded-xl elevation-6"
                  style="
                    background: rgba(var(--v-theme-surface), 0.95);
                    backdrop-filter: blur(24px);
                  "
                >
                  <div class="text-subtitle-2 font-weight-bold mb-1">
                    {{ t('yarj.exploration.customCountTitle', '键入目标站点数量') }}
                  </div>
                  <div class="text-caption on-surface-variant mb-3">
                    {{
                      t(
                        'yarj.exploration.customCountDesc',
                        '设定目标站数，自动将海量照片智能聚类为指定数量的代表站点，省去过多琐碎跳转。'
                      )
                    }}
                  </div>
                  <div class="d-flex align-center ga-2 mb-3">
                    <v-text-field
                      v-model="customTargetCountInput"
                      type="number"
                      :min="2"
                      :max="Math.min(100, explorationPhotos.length)"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :placeholder="String(journeyData.stages.length)"
                      @keyup.enter="applyCustomTargetCount"
                    />
                    <v-btn color="primary" variant="flat" @click="applyCustomTargetCount">
                      {{ t('yarj.exploration.apply', '生成') }}
                    </v-btn>
                  </div>
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip
                      v-for="presetCount in [5, 8, 12, 20].filter(
                        (c) => c < explorationPhotos.length
                      )"
                      :key="presetCount"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="setTargetCount(presetCount)"
                    >
                      {{ presetCount }} 站
                    </v-chip>
                    <v-chip
                      v-if="customStageCount != null"
                      size="small"
                      variant="tonal"
                      color="secondary"
                      class="cursor-pointer"
                      @click="resetToGranularity"
                    >
                      {{ t('yarj.exploration.resetGranularity', '恢复预设') }}
                    </v-chip>
                  </div>
                </v-card>
              </v-dialog>

              <!-- 视距聚焦与远距离淡化控制 -->
              <v-menu v-model="focusRangeMenuOpen" location="top">
                <template #activator="{ props: focusProps }">
                  <v-btn
                    v-bind="focusProps"
                    icon
                    size="small"
                    variant="tonal"
                    :color="journeyFocusRange > 0 ? 'primary' : undefined"
                    :title="
                      t('yarj.exploration.focusHint', '聚焦视距：远距离站点与航线自动淡化/隐藏')
                    "
                  >
                    <v-icon size="18">mdi-eye-circle-outline</v-icon>
                  </v-btn>
                </template>
                <v-list density="compact" min-width="160">
                  <v-list-item
                    v-for="item in [
                      { value: 3, label: t('yarj.exploration.focus3', '前后 3 站 (紧凑聚焦)') },
                      { value: 5, label: t('yarj.exploration.focus5', '前后 5 站 (推荐标准)') },
                      { value: 8, label: t('yarj.exploration.focus8', '前后 8 站 (开阔视野)') },
                      { value: 0, label: t('yarj.exploration.focusAll', '全部显示 (全局透视)') }
                    ]"
                    :key="item.value"
                    :active="journeyFocusRange === item.value"
                    @click="emit('set-focus-range', item.value)"
                  >
                    <v-list-item-title class="text-caption">
                      {{ item.label }}
                    </v-list-item-title>
                  </v-list-item>
                </v-list>
              </v-menu>
            </div>

            <!-- 右侧：本站照片 + 巡航播放控制 -->
            <div class="d-flex align-center ga-2 flex-wrap explore-playback">
              <v-btn
                v-if="currentStage?.photos.length && compact"
                icon
                size="small"
                variant="tonal"
                :title="t('yarj.exploration.viewPhotos', '本站照片')"
                @click="emit('open-photo-drawer', currentStage.photos, currentStage.center)"
              >
                <v-badge :content="currentStage.photos.length" color="primary" floating>
                  <v-icon size="18">mdi-image-multiple-outline</v-icon>
                </v-badge>
              </v-btn>
              <v-btn
                v-else-if="currentStage?.photos.length"
                variant="tonal"
                prepend-icon="mdi-image-multiple-outline"
                @click="emit('open-photo-drawer', currentStage.photos, currentStage.center)"
              >
                {{ t('yarj.exploration.viewPhotos', '本站照片') }} ({{
                  currentStage.photos.length
                }})
              </v-btn>

              <v-btn
                icon
                size="small"
                variant="tonal"
                :disabled="currentStageIndex <= 0"
                @click="emit('prev-stage')"
              >
                <v-icon size="20">mdi-skip-previous</v-icon>
              </v-btn>

              <v-btn
                :color="isPlaying ? 'secondary' : 'primary'"
                variant="flat"
                class="explore-play"
                :prepend-icon="isPlaying ? 'mdi-pause' : 'mdi-play'"
                @click="emit('toggle-play')"
              >
                {{
                  isPlaying
                    ? t('yarj.exploration.pause', '暂停')
                    : t('yarj.exploration.play', '自动巡航')
                }}
              </v-btn>

              <v-btn
                icon
                size="small"
                variant="tonal"
                :disabled="currentStageIndex >= journeyData.stages.length - 1"
                @click="emit('next-stage')"
              >
                <v-icon size="20">mdi-skip-next</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.yarj-exploration-bar {
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

.yarj-exploration-bar.has-drawer-open {
  left: 24px;
  transform: none;
  width: calc(100% - 420px - 56px);
  max-width: calc(100% - 420px - 56px);
}

.yarj-exploration-bar.is-compact,
.yarj-exploration-bar.is-compact.has-drawer-open {
  left: 8px;
  right: 8px;
  bottom: 8px;
  width: auto;
  max-width: none;
  transform: none;
}

.explore-leg {
  min-width: 0;
  flex-shrink: 1;
}

.explore-leg :deep(.v-chip) {
  max-width: 100%;
}

.is-compact .exploration-card {
  padding: 12px 14px;
}

/* 窄屏：交通 Chip 单独一行；播放按钮排在工具行上面并撑满 */
.is-compact .explore-leg {
  order: 3;
  flex-basis: 100%;
}

.is-compact .explore-exit {
  order: 2;
}

.is-compact .explore-toolbar {
  /* 工具类上的 d-flex / align-center / flex-wrap 都是 !important */
  flex-direction: column-reverse !important;
  align-items: stretch !important;
  flex-wrap: nowrap !important;
  gap: 10px !important;
}

.is-compact .explore-tools,
.is-compact .explore-playback {
  flex-wrap: nowrap !important;
}

.is-compact .explore-tools .granularity-stepper {
  flex: 1 1 auto;
  justify-content: space-between;
}

.is-compact .explore-playback .explore-play {
  flex: 1 1 auto;
}

.is-compact .explore-playback :deep(.v-badge) {
  margin-right: 6px;
}

.exploration-card {
  pointer-events: auto;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.88));
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  border-radius: 16px;
  padding: 16px 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
}

.granularity-stepper {
  background: rgba(var(--v-theme-surface-bright), 0.12);
  border-radius: 8px;
  padding: 2px 6px;
}

.yarj-journey-time-badge {
  position: absolute;
  /* 让出顶部菜单的下拉把手（高 24px，同样水平居中） */
  top: 34px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  pointer-events: none;
  transition:
    left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.yarj-journey-time-badge.has-drawer-open {
  left: calc((100% - 420px - 16px) / 2);
  transform: translateX(-50%);
}

/* 窄屏：照片抽屉铺满整屏，HUD 不必再避让，回到正中 */
.yarj-journey-time-badge.is-compact {
  left: 50%;
}

.is-compact .time-badge-inner {
  gap: 8px;
  padding: 8px 16px;
}

.is-compact .time-display {
  font-size: 1rem;
}

.time-badge-inner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  background: rgba(var(--v-theme-surface), 0.94);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  border: 1.5px solid rgba(var(--v-theme-primary), 0.55);
  border-radius: 36px;
  box-shadow:
    0 12px 36px rgba(0, 0, 0, 0.55),
    0 0 28px rgba(var(--v-theme-primary), 0.22);
  user-select: none;
}

.time-display {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.8px;
}

.time-date-text {
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.95;
}

.time-clock-text {
  color: rgb(var(--v-theme-primary));
  text-shadow: 0 0 14px rgba(var(--v-theme-primary), 0.45);
}

.time-shuttle-icon {
  filter: drop-shadow(0 0 8px rgba(var(--v-theme-primary), 0.6));
}

.time-shuttle-icon.is-shuttling {
  animation: yarj-spin 1.2s linear infinite;
}

@keyframes yarj-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
