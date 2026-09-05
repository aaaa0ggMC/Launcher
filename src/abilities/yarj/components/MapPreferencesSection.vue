<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-preferences-section' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { YarjConfig, PhotoFilterRule, PhotoFilterOperator } from '../types'
import { DEFAULT_YARJ_CONFIG, GRANULARITY_PRESETS } from '../types'
import { parseValuesList } from '../photo-filter'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const config = ref<YarjConfig>({ ...DEFAULT_YARJ_CONFIG })
const loading = ref(true)
const saving = ref(false)
const savedSnackbar = ref(false)

const AI_TYPES = [
  'Document',
  'Blackboard',
  'Screenshot',
  'Portrait',
  'GroupPhoto',
  'Scenery',
  'Architecture',
  'Food',
  'Pet',
  'Object',
  'Interior',
  'Activity'
]

const COMMON_FIELDS = [
  { title: 'AI 识别类型 (ai_generated.type)', value: 'ai_generated.type' },
  { title: 'AI 识别简述 (ai_generated.brief)', value: 'ai_generated.brief' },
  { title: 'OCR 文字识别 (ai_generated.ocr)', value: 'ai_generated.ocr' },
  { title: '相机厂商 (camera_make)', value: 'camera_make' },
  { title: '相机型号 (camera_model)', value: 'camera_model' },
  { title: '拍摄时间 (taken_at)', value: 'taken_at' },
  { title: '标签列表 (appendix.tags)', value: 'appendix.tags' },
  { title: '日记备注 (appendix.comment)', value: 'appendix.comment' },
  { title: '文件路径 (path)', value: 'path' },
  { title: '文件大小 (file_size)', value: 'file_size' },
  { title: 'GPS 纬度 (gps_lat)', value: 'gps_lat' },
  { title: 'GPS 经度 (gps_lon)', value: 'gps_lon' }
]

const OPERATORS: { title: string; value: PhotoFilterOperator }[] = [
  { title: '不属于 (not in)', value: 'not_in' },
  { title: '属于 (in)', value: 'in' },
  { title: '包含关键词 (contains)', value: 'contains' },
  { title: '不包含 (not contains)', value: 'not_contains' },
  { title: '等于 (==)', value: 'equals' },
  { title: '不等于 (!=)', value: 'not_equals' },
  { title: '非空 (is not empty)', value: 'is_not_empty' },
  { title: '为空 (is empty)', value: 'is_empty' },
  { title: '大于 (>)', value: 'gt' },
  { title: '小于 (<)', value: 'lt' }
]

async function loadConfig(): Promise<void> {
  loading.value = true
  try {
    const res = ((await window.cockpit.command('yarj.config', {})) as YarjConfig) ?? {}
    config.value = { ...DEFAULT_YARJ_CONFIG, ...res }
    if (!config.value.photoFilterRules) {
      config.value.photoFilterRules = []
    }
  } catch {
    config.value = { ...DEFAULT_YARJ_CONFIG }
  } finally {
    loading.value = false
  }
}

async function savePreferences(): Promise<void> {
  saving.value = true
  try {
    await window.cockpit.command('yarj.save-config', {
      patch: {
        defaultProjection: config.value.defaultProjection,
        initialViewMode: config.value.initialViewMode,
        mapLanguage: config.value.mapLanguage,
        zoomSpeed: config.value.zoomSpeed,
        doubleClickAction: config.value.doubleClickAction,
        cruiseStayDurationSec: config.value.cruiseStayDurationSec,
        flightSpeed: config.value.flightSpeed,
        defaultFocusRange: config.value.defaultFocusRange,
        autoPlayOnExplore: config.value.autoPlayOnExplore,
        autoOpenDrawerOnCruise: config.value.autoOpenDrawerOnCruise,
        exploredRadiusM: config.value.exploredRadiusM,
        exploredGranularity: config.value.exploredGranularity,
        footprintOpacity: config.value.footprintOpacity,
        showPhotosLayer: config.value.showPhotosLayer,
        showExploredLayer: config.value.showExploredLayer,
        drawerPageSize: config.value.drawerPageSize,
        timeShuttleStyle: config.value.timeShuttleStyle,
        clusterDensity: config.value.clusterDensity,
        autoScanOnStartup: config.value.autoScanOnStartup,
        gpsPriority: JSON.parse(
          JSON.stringify(config.value.gpsPriority || ['track', 'corrected', 'guess', 'db', 'exif'])
        ),
        showRoutesLayer: config.value.showRoutesLayer,
        photoFilterRules: JSON.parse(JSON.stringify(config.value.photoFilterRules || []))
      }
    })
    savedSnackbar.value = true
  } finally {
    saving.value = false
  }
}

const GPS_SOURCE_META: Record<
  string,
  { label: string; desc: string; icon: string; color: string }
> = {
  track: {
    label: '运动航线插值 (GPX Track)',
    desc: '基于运动航线时序与速度高精度插值，位置精确贴合实际骑行/跑步路径',
    icon: 'mdi-routes',
    color: 'primary'
  },
  corrected: {
    label: '时空异常纠正 (Drift Corrected)',
    desc: '基于时序合理性与巡航速度算法纠正后的无漂移真实坐标',
    icon: 'mdi-auto-fix',
    color: 'success'
  },
  guess: {
    label: '智能邻近推算 (Smart Guess)',
    desc: '基于相邻照片的时间与距离智能推测的中点估计位置',
    icon: 'mdi-compass-outline',
    color: 'amber'
  },
  db: {
    label: '数据库固化坐标 (Database)',
    desc: '用户在地图上手工拖拽指定或正式保存/固化的坐标',
    icon: 'mdi-database',
    color: 'info'
  },
  exif: {
    label: '照片原始定位 (EXIF GPS)',
    desc: '拍摄设备/手机相机直接写入照片文件的原始经纬度',
    icon: 'mdi-crosshairs-gps',
    color: 'default'
  }
}

function moveGpsPriority(index: number, dir: -1 | 1): void {
  if (!config.value.gpsPriority) {
    config.value.gpsPriority = ['track', 'corrected', 'guess', 'db', 'exif']
  }
  const target = index + dir
  if (target < 0 || target >= config.value.gpsPriority.length) return
  const item = config.value.gpsPriority[index]
  config.value.gpsPriority[index] = config.value.gpsPriority[target]
  config.value.gpsPriority[target] = item
  savePreferences()
}

function resetGpsPriority(): void {
  config.value.gpsPriority = ['track', 'corrected', 'guess', 'db', 'exif']
  savePreferences()
}

function addFilterRule(): void {
  if (!config.value.photoFilterRules) {
    config.value.photoFilterRules = []
  }
  config.value.photoFilterRules.push({
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    enabled: true,
    field: 'ai_generated.type',
    operator: 'not_in',
    value: '["Document", "Blackboard"]'
  })
  savePreferences()
}

function removeFilterRule(index: number): void {
  config.value.photoFilterRules?.splice(index, 1)
  savePreferences()
}

function toggleAiTypeInRule(rule: PhotoFilterRule, typeName: string): void {
  const currentList = parseValuesList(rule.value || '')
  const idx = currentList.findIndex((s) => s.toLowerCase() === typeName.toLowerCase())
  if (idx >= 0) {
    currentList.splice(idx, 1)
  } else {
    currentList.push(typeName)
  }
  rule.value = JSON.stringify(currentList)
  savePreferences()
}

function resetToDefaults(): void {
  config.value = {
    ...config.value,
    defaultProjection: DEFAULT_YARJ_CONFIG.defaultProjection,
    initialViewMode: DEFAULT_YARJ_CONFIG.initialViewMode,
    mapLanguage: DEFAULT_YARJ_CONFIG.mapLanguage,
    zoomSpeed: DEFAULT_YARJ_CONFIG.zoomSpeed,
    doubleClickAction: DEFAULT_YARJ_CONFIG.doubleClickAction,
    cruiseStayDurationSec: DEFAULT_YARJ_CONFIG.cruiseStayDurationSec,
    flightSpeed: DEFAULT_YARJ_CONFIG.flightSpeed,
    defaultFocusRange: DEFAULT_YARJ_CONFIG.defaultFocusRange,
    autoPlayOnExplore: DEFAULT_YARJ_CONFIG.autoPlayOnExplore,
    autoOpenDrawerOnCruise: DEFAULT_YARJ_CONFIG.autoOpenDrawerOnCruise,
    exploredRadiusM: DEFAULT_YARJ_CONFIG.exploredRadiusM,
    exploredGranularity: DEFAULT_YARJ_CONFIG.exploredGranularity,
    footprintOpacity: DEFAULT_YARJ_CONFIG.footprintOpacity,
    showPhotosLayer: DEFAULT_YARJ_CONFIG.showPhotosLayer,
    showExploredLayer: DEFAULT_YARJ_CONFIG.showExploredLayer,
    drawerPageSize: DEFAULT_YARJ_CONFIG.drawerPageSize,
    timeShuttleStyle: DEFAULT_YARJ_CONFIG.timeShuttleStyle,
    clusterDensity: DEFAULT_YARJ_CONFIG.clusterDensity,
    autoScanOnStartup: DEFAULT_YARJ_CONFIG.autoScanOnStartup
  }
  savePreferences()
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div v-if="loading" class="d-flex align-center justify-center py-12">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <template v-else>
      <!-- 1. 地图与视图交互偏好 -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title class="text-subtitle-2">
          {{ t('yarj.prefs.viewTitle', '地图与视图交互偏好') }}
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-3">
            {{ t('yarj.prefs.viewDesc', '设置默认投影模式、初始缩放聚焦规则与地图操作手感') }}
          </div>

          <v-row dense class="ga-y-3">
            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.defaultProjection', '默认投影模式') }}
              </div>
              <v-select
                v-model="config.defaultProjection"
                :items="[
                  {
                    title: t('yarj.prefs.projRemember', '记忆上次退出状态 (推荐)'),
                    value: 'remember'
                  },
                  { title: t('yarj.prefs.projGlobe', '3D 地球仪 (Globe)'), value: 'globe' },
                  {
                    title: t('yarj.prefs.projMercator', '2D 平面地图 (Mercator)'),
                    value: 'mercator'
                  }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.initialViewMode', '启动视角聚焦规则') }}
              </div>
              <v-select
                v-model="config.initialViewMode"
                :items="[
                  {
                    title: t('yarj.prefs.viewFitAll', '自动全景聚焦全部照片 (默认)'),
                    value: 'fit-all'
                  },
                  {
                    title: t('yarj.prefs.viewRemember', '恢复上次浏览的中心位置与层级'),
                    value: 'remember'
                  }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.mapLanguage', '地名注记语言偏好') }}
              </div>
              <v-select
                v-model="config.mapLanguage"
                :items="[
                  { title: t('yarj.prefs.langAuto', '自动跟随系统语言 (默认)'), value: 'auto' },
                  { title: '简体中文 (zh-CN)', value: 'zh-CN' },
                  { title: '繁體中文 (zh-TW)', value: 'zh-TW' },
                  { title: 'English (en)', value: 'en' },
                  {
                    title: t('yarj.prefs.langLocal', '当地原生语言 (Local Native)'),
                    value: 'local'
                  }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.doubleClickAction', '双击地图行为') }}
              </div>
              <v-select
                v-model="config.doubleClickAction"
                :items="[
                  {
                    title: t('yarj.prefs.doubleClickZoom', '平滑放大并居中点击处 (默认)'),
                    value: 'zoom-in'
                  },
                  { title: t('yarj.prefs.doubleClickNone', '无操作 (防止误触)'), value: 'none' }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption font-weight-medium on-surface-variant">
                  {{ t('yarj.prefs.zoomSpeed', '滚轮缩放灵敏度') }}
                </span>
                <span class="text-caption font-mono on-surface-variant">
                  {{ (config.zoomSpeed ?? 1.0).toFixed(1) }}x
                </span>
              </div>
              <v-slider
                v-model="config.zoomSpeed"
                :min="0.5"
                :max="2.0"
                :step="0.1"
                color="primary"
                hide-details
                density="compact"
                thumb-label
                @end="savePreferences"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- 2. 旅途漫游与时空穿梭偏好 -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title class="text-subtitle-2">
          {{ t('yarj.prefs.journeyTitle', '旅途漫游与时空穿梭') }}
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-3">
            {{ t('yarj.prefs.journeyDesc', '调整自动巡航漫游速度、相机飞行跃迁节奏与视距聚焦') }}
          </div>

          <v-row dense class="ga-y-3">
            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.flightSpeed', '相机飞行跃迁节奏') }}
              </div>
              <v-select
                v-model="config.flightSpeed"
                :items="[
                  { title: t('yarj.prefs.speedSmooth', '标准平滑 (1.5s，推荐)'), value: 'smooth' },
                  {
                    title: t('yarj.prefs.speedCinematic', '舒缓电影感 (2.5s)'),
                    value: 'cinematic'
                  },
                  { title: t('yarj.prefs.speedBrisk', '疾速跃迁 (0.8s)'), value: 'brisk' },
                  { title: t('yarj.prefs.speedInstant', '瞬间直达 (0s 无过渡)'), value: 'instant' }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.defaultFocusRange', '漫游默认聚焦视距') }}
              </div>
              <v-select
                v-model="config.defaultFocusRange"
                :items="[
                  { title: t('yarj.exploration.focus3', '前后 3 站 (紧凑聚焦)'), value: 'focus3' },
                  { title: t('yarj.exploration.focus5', '前后 5 站 (推荐标准)'), value: 'focus5' },
                  { title: t('yarj.exploration.focus8', '前后 8 站 (开阔视野)'), value: 'focus8' },
                  { title: t('yarj.exploration.focusAll', '全部显示 (全局透视)'), value: 'all' }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption font-weight-medium on-surface-variant">
                  {{ t('yarj.prefs.cruiseStayDuration', '自动巡航单站驻留时间') }}
                </span>
                <span class="text-caption font-mono on-surface-variant">
                  {{ (config.cruiseStayDurationSec ?? 2.2).toFixed(1) }}s
                </span>
              </div>
              <v-slider
                v-model="config.cruiseStayDurationSec"
                :min="1.0"
                :max="6.0"
                :step="0.2"
                color="primary"
                hide-details
                density="compact"
                thumb-label
                @end="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <v-switch
                v-model="config.autoPlayOnExplore"
                color="primary"
                density="compact"
                hide-details
                :label="t('yarj.prefs.autoPlayOnExplore', '开启探索漫游时自动播放巡航')"
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <v-switch
                v-model="config.autoOpenDrawerOnCruise"
                color="primary"
                density="compact"
                hide-details
                :label="t('yarj.prefs.autoOpenDrawerOnCruise', '巡航漫游时自动展开本站照片抽屉')"
                @update:model-value="savePreferences"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- 3. 战争迷雾与足迹渲染偏好 -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title class="text-subtitle-2">
          {{ t('yarj.prefs.footprintTitle', '战争迷雾与足迹渲染') }}
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-3">
            {{ t('yarj.prefs.footprintDesc', '配置足迹探索半径、布尔融合粒度与多边形色彩通透度') }}
          </div>

          <v-row dense class="ga-y-3">
            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.defaultGranularity', '默认时空聚合粒度') }}
              </div>
              <v-select
                v-model="config.exploredGranularity"
                :items="
                  Object.values(GRANULARITY_PRESETS).map((p) => ({
                    title: t(p.nameKey, p.defaultName),
                    value: p.id
                  }))
                "
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption font-weight-medium on-surface-variant">
                  {{ t('yarj.prefs.exploredRadius', '默认探索足迹半径') }}
                </span>
                <span class="text-caption font-mono on-surface-variant">
                  {{ config.exploredRadiusM ?? 60 }} m
                </span>
              </div>
              <v-slider
                v-model="config.exploredRadiusM"
                :min="30"
                :max="300"
                :step="5"
                color="primary"
                hide-details
                density="compact"
                thumb-label
                @end="savePreferences"
              />
            </v-col>

            <v-col cols="12">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption font-weight-medium on-surface-variant">
                  {{ t('yarj.prefs.footprintOpacity', '探索多边形填充不透明度') }}
                </span>
                <span class="text-caption font-mono on-surface-variant">
                  {{ Math.round((config.footprintOpacity ?? 0.52) * 100) }}%
                </span>
              </div>
              <v-slider
                v-model="config.footprintOpacity"
                :min="0.2"
                :max="0.9"
                :step="0.02"
                color="primary"
                hide-details
                density="compact"
                thumb-label
                @end="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <v-switch
                v-model="config.showPhotosLayer"
                color="primary"
                density="compact"
                hide-details
                :label="t('yarj.layers.photos', '照片标记点图层默认显示')"
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <v-switch
                v-model="config.showExploredLayer"
                color="primary"
                density="compact"
                hide-details
                :label="t('yarj.layers.explored', '探索区域图层默认显示')"
                @update:model-value="savePreferences"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- 4. 界面与性能调优偏好 -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title class="text-subtitle-2">
          {{ t('yarj.prefs.perfTitle', '界面与性能调优') }}
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-3">
            {{ t('yarj.prefs.perfDesc', '配置列表流式滑动加载窗口、HUD 胶囊风格与点位聚合密度') }}
          </div>

          <v-row dense class="ga-y-3">
            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.drawerPageSize', '照片侧栏抽屉每次滑动加载数量') }}
              </div>
              <v-select
                v-model="config.drawerPageSize"
                :items="[
                  { title: t('yarj.prefs.pageSize20', '20 张 (极致流畅)'), value: 20 },
                  { title: t('yarj.prefs.pageSize30', '30 张 (推荐平衡)'), value: 30 },
                  { title: t('yarj.prefs.pageSize50', '50 张 (宽屏开阔)'), value: 50 },
                  { title: t('yarj.prefs.pageSize100', '100 张 (大屏极速)'), value: 100 }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.timeShuttleStyle', '顶部时空穿梭 HUD 风格') }}
              </div>
              <v-select
                v-model="config.timeShuttleStyle"
                :items="[
                  {
                    title: t('yarj.prefs.shuttleProminent', '醒目高光霓虹 HUD (推荐)'),
                    value: 'prominent'
                  },
                  {
                    title: t('yarj.prefs.shuttleMinimal', '极简纯净半透 (Minimal)'),
                    value: 'minimal'
                  }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <div class="text-caption font-weight-medium mb-1 on-surface-variant">
                {{ t('yarj.prefs.clusterDensity', '照片打点聚合密度') }}
              </div>
              <v-select
                v-model="config.clusterDensity"
                :items="[
                  { title: t('yarj.prefs.clusterTight', '密集聚合 (半径 35px)'), value: 'tight' },
                  {
                    title: t('yarj.prefs.clusterStandard', '标准聚合 (半径 50px，推荐)'),
                    value: 'standard'
                  },
                  { title: t('yarj.prefs.clusterLoose', '稀疏聚合 (半径 70px)'), value: 'loose' }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                @update:model-value="savePreferences"
              />
            </v-col>

            <v-col cols="12" md="6">
              <v-switch
                v-model="config.autoScanOnStartup"
                color="primary"
                density="compact"
                hide-details
                :label="t('yarj.prefs.autoScanOnStartup', '启动时在后台静默增量扫描新照片')"
                @update:model-value="savePreferences"
              />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- 5. 地图照片高级筛选器 (Photo Filters) -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title
          class="text-subtitle-2 d-flex align-center justify-space-between flex-wrap ga-2"
        >
          <span>{{ t('yarj.prefs.filtersTitle', '照片展示高级筛选规则 (Photo Filters)') }}</span>
          <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="addFilterRule">
            {{ t('yarj.prefs.addFilter', '添加筛选条件') }}
          </v-btn>
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-3">
            {{
              t(
                'yarj.prefs.filtersDesc',
                '支持类似数据库的通用字段过滤，隐藏文档、黑板或特定类型的图片，仅展示符合条件的内容'
              )
            }}
          </div>

          <div
            v-if="!config.photoFilterRules?.length"
            class="text-center py-6 text-disabled text-body-2"
          >
            {{ t('yarj.prefs.noFilters', '当前未设置任何筛选规则，地图将呈现全部含定位照片。') }}
          </div>

          <div v-else class="d-flex flex-column ga-4">
            <v-card
              v-for="(rule, idx) in config.photoFilterRules"
              :key="rule.id || idx"
              variant="outlined"
              class="pa-4 rounded-lg"
              :style="{ opacity: rule.enabled ? 1 : 0.6 }"
            >
              <div class="d-flex align-center justify-space-between pb-2 mb-3 border-b">
                <div class="d-flex align-center ga-3">
                  <v-switch
                    v-model="rule.enabled"
                    color="primary"
                    density="compact"
                    hide-details
                    @update:model-value="savePreferences"
                  />
                  <span class="text-body-2 font-weight-bold">
                    {{ t('yarj.prefs.rule', '规则') }} #{{ idx + 1 }}
                  </span>
                  <v-chip
                    size="small"
                    :color="rule.enabled ? 'primary' : 'default'"
                    variant="tonal"
                    class="filter-chip"
                  >
                    {{
                      rule.enabled
                        ? t('yarj.prefs.enabled', '已启用')
                        : t('yarj.prefs.disabled', '已禁用')
                    }}
                  </v-chip>
                </div>
                <v-btn
                  size="small"
                  variant="text"
                  color="error"
                  icon="mdi-delete-outline"
                  :title="t('yarj.prefs.deleteRule', '删除规则')"
                  @click="removeFilterRule(idx)"
                />
              </div>

              <v-row dense class="align-center">
                <!-- 字段选择 -->
                <v-col cols="12" md="4">
                  <div class="text-caption font-weight-medium mb-1">
                    {{ t('yarj.prefs.field', '筛选字段 (Field / Metadata Key)') }}
                  </div>
                  <v-combobox
                    v-model="rule.field"
                    :items="COMMON_FIELDS"
                    item-title="title"
                    item-value="value"
                    :return-object="false"
                    density="compact"
                    variant="outlined"
                    hide-details
                    @update:model-value="savePreferences"
                  />
                </v-col>

                <!-- 操作符选择 -->
                <v-col cols="12" md="3">
                  <div class="text-caption font-weight-medium mb-1">
                    {{ t('yarj.prefs.operator', '运算符 (Operator)') }}
                  </div>
                  <v-select
                    v-model="rule.operator"
                    :items="OPERATORS"
                    item-title="title"
                    item-value="value"
                    density="compact"
                    variant="outlined"
                    hide-details
                    @update:model-value="savePreferences"
                  />
                </v-col>

                <!-- 目标值输入 -->
                <v-col cols="12" md="5">
                  <div class="text-caption font-weight-medium mb-1">
                    {{ t('yarj.prefs.targetValue', '目标值 (Value / 列表)') }}
                  </div>
                  <v-text-field
                    v-model="rule.value"
                    :disabled="rule.operator === 'is_empty' || rule.operator === 'is_not_empty'"
                    density="compact"
                    variant="outlined"
                    hide-details
                    placeholder='例如: ["Document", "Blackboard"] 或逗号分隔'
                    @update:model-value="savePreferences"
                  />
                </v-col>
              </v-row>

              <!-- 针对 AI 分类的快捷 Chip 勾选栏 -->
              <div
                v-if="
                  rule.field.includes('ai_generated.type') &&
                  (rule.operator === 'in' || rule.operator === 'not_in')
                "
                class="pt-3"
              >
                <div class="text-caption text-disabled mb-2">
                  {{ t('yarj.prefs.quickSelectAi', '快捷点选分类（点击添加到排除/包含集合）：') }}
                </div>
                <div class="d-flex flex-wrap ga-1-5">
                  <v-chip
                    v-for="typeName in AI_TYPES"
                    :key="typeName"
                    size="small"
                    :variant="
                      parseValuesList(rule.value || '').some(
                        (s) => s.toLowerCase() === typeName.toLowerCase()
                      )
                        ? 'flat'
                        : 'outlined'
                    "
                    :color="
                      parseValuesList(rule.value || '').some(
                        (s) => s.toLowerCase() === typeName.toLowerCase()
                      )
                        ? rule.operator === 'not_in'
                          ? 'error'
                          : 'primary'
                        : undefined
                    "
                    class="cursor-pointer filter-type-chip"
                    @click="toggleAiTypeInRule(rule, typeName)"
                  >
                    <v-icon
                      v-if="
                        parseValuesList(rule.value || '').some(
                          (s) => s.toLowerCase() === typeName.toLowerCase()
                        )
                      "
                      size="14"
                      class="mr-1"
                    >
                      {{ rule.operator === 'not_in' ? 'mdi-close-circle' : 'mdi-check-circle' }}
                    </v-icon>
                    {{ typeName }}
                  </v-chip>
                </div>
              </div>
            </v-card>
          </div>
        </v-card-text>
      </v-card>

      <!-- 6. GPS 坐标生效优先级排序 -->
      <v-card rounded="lg" variant="tonal" class="card-fill">
        <v-card-title
          class="text-subtitle-2 d-flex align-center justify-space-between flex-wrap ga-2"
        >
          <div class="d-flex align-center ga-2">
            <v-icon color="primary">mdi-format-list-numbered</v-icon>
            <span>{{ t('yarj.prefs.gpsPriorityTitle', 'GPS 坐标生效优先级') }}</span>
          </div>
          <v-btn size="small" variant="text" prepend-icon="mdi-restore" @click="resetGpsPriority">
            {{ t('yarj.prefs.restoreDefaultPriority', '恢复默认顺序') }}
          </v-btn>
        </v-card-title>
        <v-card-text>
          <div class="text-caption on-surface-variant mb-4">
            {{
              t(
                'yarj.prefs.gpsPriorityDesc',
                '当单张照片同时存在多种来源的地理信息时，系统按照下列排序自上而下选用首个有效坐标：'
              )
            }}
          </div>

          <div class="d-flex flex-column ga-2">
            <v-card
              v-for="(src, idx) in config.gpsPriority || [
                'track',
                'corrected',
                'guess',
                'db',
                'exif'
              ]"
              :key="src"
              variant="outlined"
              rounded="lg"
              class="pa-3 d-flex align-center justify-space-between"
            >
              <div class="d-flex align-center ga-3 flex-grow-1 min-width-0">
                <v-chip size="small" variant="flat" :color="idx === 0 ? 'primary' : 'default'">
                  优先级 {{ idx + 1 }}
                </v-chip>
                <v-icon
                  :icon="GPS_SOURCE_META[src]?.icon ?? 'mdi-map-marker'"
                  :color="GPS_SOURCE_META[src]?.color"
                />
                <div class="min-width-0">
                  <div class="text-body-2 font-weight-medium">
                    {{ GPS_SOURCE_META[src]?.label ?? src }}
                  </div>
                  <div class="text-caption text-medium-emphasis text-truncate">
                    {{ GPS_SOURCE_META[src]?.desc ?? '' }}
                  </div>
                </div>
              </div>

              <div class="d-flex align-center ga-1 ml-2 flex-shrink-0">
                <v-btn
                  icon="mdi-arrow-up"
                  size="small"
                  variant="flat"
                  :disabled="idx === 0"
                  title="上移"
                  @click="moveGpsPriority(idx, -1)"
                />
                <v-btn
                  icon="mdi-arrow-down"
                  size="small"
                  variant="flat"
                  :disabled="idx === (config.gpsPriority?.length ?? 5) - 1"
                  title="下移"
                  @click="moveGpsPriority(idx, 1)"
                />
              </div>
            </v-card>
          </div>
        </v-card-text>
      </v-card>

      <!-- 底部重置与状态 -->
      <div class="d-flex align-center justify-space-between pt-1">
        <v-btn variant="tonal" color="error" prepend-icon="mdi-restore" @click="resetToDefaults">
          {{ t('yarj.prefs.resetDefaults', '恢复全部偏好默认值') }}
        </v-btn>

        <span v-if="saving" class="text-caption on-surface-variant">
          {{ t('yarj.prefs.saving', '保存中...') }}
        </span>
      </div>
    </template>

    <v-snackbar v-model="savedSnackbar" timeout="1800" color="success" location="bottom end">
      {{ t('yarj.prefs.saveSuccess', '偏好设置已更新并保存') }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.filter-chip,
.filter-type-chip {
  padding-block: 4px;
  min-height: 24px;
}
</style>
