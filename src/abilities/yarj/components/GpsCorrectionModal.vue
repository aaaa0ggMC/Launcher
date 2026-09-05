<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-gps-correction-modal' })

import { ref, inject, watch, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { YarjConfig } from '../types'

const props = defineProps<{
  modelValue: boolean
  config?: YarjConfig
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'started'): void
  (e: 'cleared'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// 配置参数
const maxSpeedKmh = ref(800)
const minDriftKm = ref(80)
const maxTimeGapHours = ref(24)
const selectedRoot = ref<string>('')
const correctedCount = ref(0)
const loadingCount = ref(false)
const runningBt = ref(false)

const speedPresets = [
  { label: '陆行 (120 km/h)', value: 120 },
  { label: '高铁 (350 km/h)', value: 350 },
  { label: '民航常规 (800 km/h)', value: 800 },
  { label: '超音速极宽容 (1200 km/h)', value: 1200 }
]

async function refreshCount(): Promise<void> {
  loadingCount.value = true
  try {
    const res = (await window.cockpit.command('yarj.count-corrected', {
      root: selectedRoot.value || undefined
    })) as { ok: boolean; count?: number }
    if (res?.ok && typeof res.count === 'number') {
      correctedCount.value = res.count
    }
  } catch {
    /* ignore */
  } finally {
    loadingCount.value = false
  }
}

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      void refreshCount()
    }
  }
)

watch(selectedRoot, () => {
  void refreshCount()
})

onMounted(() => {
  if (props.modelValue) {
    void refreshCount()
  }
})

async function startCorrection(): Promise<void> {
  runningBt.value = true
  try {
    await window.cockpit.btJob('yarj.correct-gps', {
      maxSpeedKmh: maxSpeedKmh.value,
      minDriftKm: minDriftKm.value,
      maxTimeGapHours: maxTimeGapHours.value,
      root: selectedRoot.value || undefined
    })
    emit('started')
    emit('update:modelValue', false)
  } catch (err) {
    console.error('Failed to start GPS correction BT job:', err)
  } finally {
    runningBt.value = false
  }
}

async function clearCorrection(): Promise<void> {
  runningBt.value = true
  try {
    await window.cockpit.btJob('yarj.clear-gps-correction', {
      root: selectedRoot.value || undefined
    })
    emit('cleared')
    emit('update:modelValue', false)
  } catch (err) {
    console.error('Failed to clear GPS correction BT job:', err)
  } finally {
    runningBt.value = false
  }
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card class="rounded-xl border">
      <!-- 头部 -->
      <v-card-title class="d-flex align-center justify-space-between px-6 py-4 border-b">
        <div class="d-flex align-center ga-3">
          <v-icon color="primary" size="26">mdi-auto-fix</v-icon>
          <div>
            <div class="text-subtitle-1 font-weight-bold">
              {{ t('yarj.build.gpsCorrectionTitle', 'GPS 漂移时空速度纠正') }}
            </div>
            <div class="text-caption on-surface-variant">
              {{
                t(
                  'yarj.build.gpsCorrectionSubtitle',
                  '通过地区时序与移动速度合理性分析纠正异常漂移'
                )
              }}
            </div>
          </div>
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          @click="emit('update:modelValue', false)"
        />
      </v-card-title>

      <!-- 内容区 -->
      <v-card-text class="px-6 py-5 d-flex flex-column ga-5" style="max-height: 540px">
        <!-- 核心说明与当前状态卡片 -->
        <div class="pa-4 rounded-lg bg-surface-variant-opacity border">
          <div class="d-flex align-center justify-space-between mb-2">
            <div class="text-caption font-weight-bold text-primary d-flex align-center ga-1">
              <v-icon size="16">mdi-information-outline</v-icon>
              <span>{{ t('yarj.build.algoDescTitle', '分析与纠正原理') }}</span>
            </div>
            <v-chip
              size="small"
              :color="correctedCount > 0 ? 'secondary' : 'default'"
              variant="tonal"
            >
              {{ t('yarj.build.currentCorrectedCount', '已纠正照片') }}: {{ correctedCount }}
            </v-chip>
          </div>
          <div class="text-caption on-surface-variant line-height-relaxed">
            {{
              t(
                'yarj.build.algoDescContent',
                '照片按时间轴排列，通过测算相邻照片的大圆位移与用时算出时速。若瞬间速度超出合理上限（如漂移至另一国家），系统判定为离群跳点并通过前后基准点进行时间插值平滑修复。修复写入独立字段，不覆盖数据库原始记录。'
              )
            }}
          </div>
          <div class="mt-2 text-caption font-weight-medium text-primary font-mono">
            {{
              t(
                'yarj.build.priorityHint',
                'Map 读取优先级：corrected_gps > guess_gps > gps_in_db > exif'
              )
            }}
          </div>
        </div>

        <!-- 目录筛选 -->
        <div v-if="config?.galleryRoots && config.galleryRoots.length > 1">
          <div class="text-caption font-weight-bold mb-2">
            {{ t('yarj.build.targetRootLabel', '目标图库目录') }}
          </div>
          <v-select
            v-model="selectedRoot"
            :items="[
              { title: t('yarj.build.allRoots', '全部图库目录'), value: '' },
              ...config.galleryRoots.map((r) => ({ title: r.path, value: r.path }))
            ]"
            density="compact"
            variant="outlined"
            hide-details
          />
        </div>

        <!-- 速度上限预设与自定义滑块 -->
        <div>
          <div class="d-flex align-center justify-space-between mb-2">
            <span class="text-caption font-weight-bold">
              {{ t('yarj.build.maxSpeedLabel', '最大合理移动时速 (km/h)') }}
            </span>
            <span class="text-caption font-mono font-weight-bold text-primary">
              {{ maxSpeedKmh }} km/h
            </span>
          </div>
          <div class="d-flex ga-2 mb-3 flex-wrap">
            <v-chip
              v-for="p in speedPresets"
              :key="p.value"
              size="small"
              :variant="maxSpeedKmh === p.value ? 'flat' : 'outlined'"
              :color="maxSpeedKmh === p.value ? 'primary' : undefined"
              class="cursor-pointer"
              @click="maxSpeedKmh = p.value"
            >
              {{ p.label }}
            </v-chip>
          </div>
          <v-slider
            v-model="maxSpeedKmh"
            :min="60"
            :max="1500"
            :step="20"
            color="primary"
            hide-details
          />
        </div>

        <!-- 最小漂移判定距离 (km) -->
        <div>
          <div class="d-flex align-center justify-space-between mb-1">
            <span class="text-caption font-weight-bold">
              {{ t('yarj.build.minDriftLabel', '最小漂移判定距离 (km)') }}
            </span>
            <span class="text-caption font-mono font-weight-bold text-primary">
              {{ minDriftKm }} km
            </span>
          </div>
          <div class="text-caption on-surface-variant mb-2">
            {{
              t(
                'yarj.build.minDriftHint',
                '仅对位移偏差超过该距离的跳点执行纠正，避免误伤同城正常走动'
              )
            }}
          </div>
          <v-slider
            v-model="minDriftKm"
            :min="20"
            :max="500"
            :step="10"
            color="primary"
            hide-details
          />
        </div>

        <!-- 时间窗口 (小时) -->
        <div>
          <div class="d-flex align-center justify-space-between mb-1">
            <span class="text-caption font-weight-bold">
              {{ t('yarj.build.timeGapLabel', '漂移参考时间窗口 (小时)') }}
            </span>
            <span class="text-caption font-mono font-weight-bold text-primary">
              {{ maxTimeGapHours }} h
            </span>
          </div>
          <div class="text-caption on-surface-variant mb-2">
            {{ t('yarj.build.timeGapHint', '基准点与漂移点之间的最大时间跨度') }}
          </div>
          <v-slider
            v-model="maxTimeGapHours"
            :min="2"
            :max="72"
            :step="2"
            color="primary"
            hide-details
          />
        </div>
      </v-card-text>

      <v-divider />

      <!-- 操作底部栏 -->
      <v-card-actions class="px-6 py-4 d-flex align-center justify-space-between">
        <v-btn
          variant="tonal"
          color="error"
          prepend-icon="mdi-undo-variant"
          :disabled="correctedCount === 0 || runningBt"
          @click="clearCorrection"
        >
          {{ t('yarj.build.clearBtn', '取消/重置所有纠正') }}
        </v-btn>

        <div class="d-flex align-center ga-2">
          <v-btn variant="text" @click="emit('update:modelValue', false)">
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn
            variant="flat"
            color="primary"
            prepend-icon="mdi-play"
            :loading="runningBt"
            @click="startCorrection"
          >
            {{ t('yarj.build.startBtn', '启动后台纠正任务') }}
          </v-btn>
        </div>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.line-height-relaxed {
  line-height: 1.6;
}
.bg-surface-variant-opacity {
  background: rgba(var(--v-theme-surface-bright), 0.35);
}
.cursor-pointer {
  cursor: pointer;
}
</style>
