<template>
  <div ref="pageMenuRef" class="page-menu" :class="{ 'is-open': menuOpen }" @click.stop>
    <button class="page-menu-handle" @click="toggleMenu">
      <v-icon size="16">{{ menuOpen ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
    </button>

    <Transition name="menu-pop">
      <div v-if="menuOpen" class="page-menu-pop">
        <!-- 主菜单 -->
        <template v-if="menuStep === 'main'">
          <div class="menu-item" @click="handleStartExploration">
            <v-icon size="18" color="primary">mdi-compass-outline</v-icon>
            <span>{{ t('yarj.exploration.title', '我的探索') }}</span>
            <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
              {{ t('yarj.exploration.badge', '旅途漫游') }}
            </v-chip>
            <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'photo-search'">
            <v-icon size="18">mdi-image-search-outline</v-icon>
            <span>{{ t('yarj.menu.photoSearch', '照片搜索') }}</span>
            <v-chip
              v-if="photos.length"
              size="x-small"
              variant="tonal"
              color="primary"
              class="ml-auto"
            >
              {{ photos.length }}
            </v-chip>
            <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="handleOpenRoutes">
            <v-icon size="18" color="cyan">mdi-map-marker-path</v-icon>
            <span>{{ t('yarj.menu.routes', '运动航线') }}</span>
            <v-chip
              v-if="routes.length"
              size="x-small"
              variant="tonal"
              color="cyan"
              class="ml-auto"
            >
              {{ routes.length }}
            </v-chip>
            <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'search'">
            <v-icon size="18">mdi-map-search-outline</v-icon>
            <span>{{ t('yarj.menu.search', '地名搜索与跳转') }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="openProviders">
            <v-icon size="18">mdi-map-legend</v-icon>
            <span>{{ t('yarj.menu.providers', '图源切换') }}</span>
            <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
              {{ activeProviderName }}
            </v-chip>
            <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="emit('start-scan')">
            <v-icon size="18" :class="{ spin: scanRunning }">mdi-sync</v-icon>
            <span>{{ t('yarj.menu.scan', '扫描') }}</span>
            <v-icon v-if="scanRunning" size="14" class="ml-auto spin">mdi-loading</v-icon>
          </div>
          <div class="menu-item" @click="openStats">
            <v-icon size="18">mdi-chart-box-outline</v-icon>
            <span>{{ t('yarj.menu.stats', '数据统计') }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'explored'">
            <v-icon size="18">mdi-map-marker-distance</v-icon>
            <span>{{ t('yarj.menu.explored', '探索区域与粒度') }}</span>
            <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
              {{
                t(
                  GRANULARITY_PRESETS[exploredGranularity]?.nameKey,
                  GRANULARITY_PRESETS[exploredGranularity]?.defaultName
                )
              }}
            </v-chip>
            <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'layers'">
            <v-icon size="18">mdi-layers-outline</v-icon>
            <span>{{ t('yarj.menu.layers', '图层') }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'build'">
            <v-icon size="18">mdi-map-marker-path</v-icon>
            <span>{{ t('yarj.menu.footprintBuild', '足迹构建') }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item text-error" @click="handleOpenPrune">
            <v-icon size="18" color="error">mdi-broom</v-icon>
            <span>{{ t('yarj.menu.prune', '清理失效记录') }}</span>
          </div>
        </template>

        <!-- 足迹构建菜单 -->
        <template v-else-if="menuStep === 'build'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.footprintBuild', '足迹构建')
            }}</span>
          </div>

          <div class="px-2 pt-1 pb-2 d-flex flex-column ga-1">
            <div class="menu-item" @click="handleOpenGeotag">
              <v-icon size="18" color="cyan">mdi-crosshairs-gps</v-icon>
              <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                <span>{{ t('yarj.build.geotagFromRoute', '基于运动轨迹贴合照片') }}</span>
                <span
                  class="text-caption on-surface-variant text-truncate"
                  style="max-width: 200px"
                >
                  {{ t('yarj.build.geotagFromRouteDesc', '通过 GPX 时间戳对齐与插值纠正拍摄位置') }}
                </span>
              </div>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>

            <div class="menu-item" @click="handleOpenGpsCorrection">
              <v-icon size="18" color="primary">mdi-auto-fix</v-icon>
              <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                <span>{{ t('yarj.build.gpsCorrection', 'GPS 漂移时空纠正') }}</span>
                <span
                  class="text-caption on-surface-variant text-truncate"
                  style="max-width: 200px"
                >
                  {{
                    t('yarj.build.gpsCorrectionMenuDesc', '按时序与速度合理性修复跨国/跨区离群漂移')
                  }}
                </span>
              </div>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>

            <div class="menu-item" @click="emit('recompute-guesses')">
              <v-icon size="18" color="warning">mdi-map-marker-question-outline</v-icon>
              <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                <span>{{ t('yarj.build.recomputeGuesses', '重算未定位照片中点猜测') }}</span>
                <span
                  class="text-caption on-surface-variant text-truncate"
                  style="max-width: 200px"
                >
                  {{ t('yarj.build.recomputeGuessesDesc', '在相邻有坐标照片之间静态推算定位') }}
                </span>
              </div>
              <v-icon size="16" class="ml-auto">mdi-refresh</v-icon>
            </div>
          </div>
        </template>

        <!-- 探索区域与粒度设置 -->
        <template v-else-if="menuStep === 'explored'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.explored', '探索区域与粒度')
            }}</span>
          </div>

          <div class="px-2 py-2">
            <div
              class="d-flex align-center justify-space-between px-3 py-2 rounded-lg mb-2"
              style="background: rgba(var(--v-theme-surface-bright), 0.15)"
            >
              <div class="d-flex align-center ga-2">
                <v-icon size="18">mdi-map-clock-outline</v-icon>
                <span class="text-body-2">{{
                  t('yarj.explored.showLayer', '显示探索区域图层')
                }}</span>
              </div>
              <v-switch
                :model-value="showExploredLayer"
                color="primary"
                density="compact"
                hide-details
                @update:model-value="
                  (v: boolean | null) => emit('update:showExploredLayer', v ?? true)
                "
              />
            </div>

            <div class="text-caption on-surface-variant px-2 pt-1 pb-2">
              {{
                t(
                  'yarj.explored.granularityHint',
                  '粒度越大，对时间与空间距离变化越不敏感，能将整趟行程/多日活动平滑聚合成连贯探索领地。'
                )
              }}
            </div>

            <div class="d-flex flex-column ga-1">
              <div
                v-for="preset in Object.values(GRANULARITY_PRESETS)"
                :key="preset.id"
                class="menu-item d-flex align-center justify-space-between py-2"
                :class="{ active: exploredGranularity === preset.id }"
                @click="emit('update:exploredGranularity', preset.id)"
              >
                <div class="d-flex flex-column min-w-0 pr-2">
                  <span class="text-body-2 font-weight-medium">{{
                    t(preset.nameKey, preset.defaultName)
                  }}</span>
                  <span class="text-caption on-surface-variant">
                    {{
                      t(
                        'yarj.explored.presetDetail',
                        `时差 ≤ ${preset.timeWindowHours}h · 距离 ≤ ${(preset.maxLinkDistM / 1000).toFixed(1)}km`
                      )
                    }}
                  </span>
                </div>
                <v-icon v-if="exploredGranularity === preset.id" size="18" color="primary">
                  mdi-check
                </v-icon>
              </div>
            </div>
          </div>
        </template>

        <!-- 地名搜索与跳转菜单（谷歌 Geocoding） -->
        <template v-else-if="menuStep === 'search'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.search', '地名搜索与跳转')
            }}</span>
          </div>
          <div class="px-2 pt-1 pb-2">
            <v-text-field
              v-model="geocodeQuery"
              :placeholder="
                t('yarj.geocode.placeholder', '输入城市、景点或地名（如：东京铁塔、故宫）')
              "
              density="compact"
              variant="outlined"
              hide-details
              autofocus
              clearable
              append-inner-icon="mdi-magnify"
              :loading="geocodeLoading"
              @keydown.enter="searchLocation"
              @click:append-inner="searchLocation"
            />
          </div>
          <div class="sessions-scroll px-1 pb-1">
            <div
              v-if="!geocodeResults.length && !geocodeLoading"
              class="text-caption on-surface-variant pt-2 px-2"
            >
              {{ t('yarj.geocode.hint', '输入地名后按 Enter 搜索，点击结果将快速飞往目标位置') }}
            </div>
            <div
              v-for="(res, idx) in geocodeResults"
              :key="idx"
              class="menu-item d-flex align-start ga-2"
              @click="handleFlyToGeocode(res)"
            >
              <v-icon size="18" color="primary" class="mt-1 flex-shrink-0">mdi-map-marker</v-icon>
              <div class="min-w-0 flex-grow-1">
                <div class="text-caption font-weight-bold text-truncate">
                  {{ res.formattedAddress }}
                </div>
                <div class="text-caption on-surface-variant font-mono">
                  {{ res.lat.toFixed(4) }}°, {{ res.lon.toFixed(4) }}°
                </div>
              </div>
              <v-chip size="x-small" variant="tonal" color="primary" class="flex-shrink-0 mt-1">
                {{ res.provider.toUpperCase() }}
              </v-chip>
            </div>
          </div>
        </template>

        <!-- 照片模糊搜索菜单 -->
        <template v-else-if="menuStep === 'photo-search'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.photoSearch', '照片搜索')
            }}</span>
            <v-btn
              icon
              size="x-small"
              variant="text"
              :title="t('yarj.search.helpBtn', '高级搜索语法指南 (SEARCH.md)')"
              @click="emit('open-search-help')"
            >
              <v-icon size="16">mdi-help-circle-outline</v-icon>
            </v-btn>
            <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
              {{ photoSearchResults.length }}
            </v-chip>
          </div>

          <div class="px-2 pt-1 pb-2">
            <v-text-field
              v-model="photoSearchQuery"
              :placeholder="
                t('yarj.photoSearch.placeholder', '输入文件名、标签、地名、相机或备注…')
              "
              density="compact"
              variant="outlined"
              hide-details
              autofocus
              clearable
              prepend-inner-icon="mdi-magnify"
              @keydown.enter="handleShowAllSearchResults"
            />
          </div>

          <div v-if="photoSearchResults.length" class="px-2 pb-2">
            <v-btn
              variant="tonal"
              color="primary"
              block
              prepend-icon="mdi-page-layout-sidebar-right"
              @click="handleShowAllSearchResults"
            >
              {{ t('yarj.photoSearch.showInDrawer', '在右侧抽屉展示全部匹配照片') }} ({{
                photoSearchResults.length
              }})
            </v-btn>
          </div>

          <div class="sessions-scroll px-1 pb-1">
            <div
              v-if="!photoSearchResults.length"
              class="text-caption on-surface-variant pt-2 px-2 text-center"
            >
              {{
                photoSearchQuery
                  ? t('yarj.photoSearch.noResults', '未找到匹配的照片')
                  : t('yarj.photoSearch.hint', '支持按文件名、标签、地址、拍摄机型或备注模糊搜索')
              }}
            </div>
            <div
              v-for="(p, idx) in photoSearchResults.slice(0, 40)"
              :key="p.id || idx"
              class="menu-item d-flex align-center ga-2"
              @click="handleSelectPhoto(p)"
            >
              <v-img
                :src="photoThumbUrl(p.path)"
                width="36"
                height="36"
                cover
                class="rounded-md flex-shrink-0"
              >
                <template #placeholder>
                  <div
                    class="d-flex align-center justify-center fill-height bg-surface-variant-subtle"
                  >
                    <v-progress-circular indeterminate color="primary" size="14" width="1.5" />
                  </div>
                </template>
              </v-img>
              <div class="min-w-0 flex-grow-1">
                <div class="text-caption font-weight-bold text-truncate">
                  {{ p.path.split('/').pop() }}
                </div>
                <div class="text-caption on-surface-variant text-truncate">
                  {{
                    (p.appendix?.formatted_address as string) ||
                    (p.appendix?.tags as string[])?.join(', ') ||
                    p.camera_model ||
                    (p.gps_lat != null
                      ? `${p.gps_lat.toFixed(4)}°, ${p.gps_lon?.toFixed(4)}°`
                      : guessedGpsMap.get(p.path)
                        ? `[${t('yarj.guess.badge', '大致 GPS 猜测')}] ${guessedGpsMap.get(p.path)!.lat.toFixed(4)}°, ${guessedGpsMap.get(p.path)!.lon.toFixed(4)}°`
                        : '无 GPS')
                  }}
                </div>
              </div>
              <v-icon size="16" color="primary" class="flex-shrink-0">mdi-chevron-right</v-icon>
            </div>
          </div>
        </template>

        <!-- 图源切换菜单 -->
        <template v-else-if="menuStep === 'providers'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.providers', '图源切换')
            }}</span>
          </div>
          <div class="sessions-scroll px-1 pb-1">
            <div
              v-for="p in providers"
              :key="p.id"
              class="menu-item provider-item"
              :class="{ 'is-active': p.id === activeProviderId }"
              @click="handleSwitchProvider(p.id)"
            >
              <v-icon size="18" :color="p.id === activeProviderId ? 'primary' : 'default'">
                {{ p.id === activeProviderId ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank' }}
              </v-icon>
              <span class="text-caption font-weight-medium text-truncate flex-grow-1">{{
                p.name
              }}</span>
              <div class="d-flex align-center ga-1 flex-shrink-0">
                <v-chip
                  v-if="p.coordSystem === 'gcj02'"
                  size="x-small"
                  variant="flat"
                  color="warning"
                >
                  GCJ-02
                </v-chip>
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="
                    p.category === 'google'
                      ? 'primary'
                      : p.category === 'google-official'
                        ? 'warning'
                        : p.category === 'amap' || p.category === 'tencent'
                          ? 'warning'
                          : p.isLocal
                            ? 'secondary'
                            : 'default'
                  "
                >
                  {{ p.category === 'google-official' ? 'TILES API' : p.category.toUpperCase() }}
                </v-chip>
              </div>
            </div>
          </div>
        </template>

        <!-- 数据统计菜单 -->
        <template v-else-if="menuStep === 'stats'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('yarj.menu.stats', '数据统计')
            }}</span>
          </div>
          <div class="px-1 pt-1 stats-grid">
            <div class="stat-card">
              <div class="stat-value">{{ stats?.photoCount ?? 0 }}</div>
              <div class="stat-label">{{ t('yarj.stats.photos', '照片总数') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" :class="{ 'text-primary': (stats?.withGps ?? 0) > 0 }">
                {{ stats?.withGps ?? 0 }}
              </div>
              <div class="stat-label">{{ t('yarj.stats.withGps', '含 GPS 定位') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ (stats?.photoCount ?? 0) - (stats?.withGps ?? 0) }}</div>
              <div class="stat-label">{{ t('yarj.stats.noGps', '无定位照片') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ Object.keys(stats?.byRoot ?? {}).length }}</div>
              <div class="stat-label">{{ t('yarj.stats.rootsCount', '已接入目录') }}</div>
            </div>
          </div>

          <div
            class="text-caption font-weight-medium px-2 pt-3 pb-1 on-surface-variant d-flex align-center"
          >
            <span>{{ t('yarj.stats.recentScans', '最近扫描历史') }}</span>
            <span v-if="stats?.lastRuns?.length" class="ml-auto text-caption font-weight-regular">
              {{ stats.lastRuns.length }} 次
            </span>
          </div>
          <div class="sessions-scroll px-1 pb-1">
            <div v-if="!stats?.lastRuns?.length" class="text-caption on-surface-variant pt-2 px-1">
              {{ t('yarj.scan.none', '还没有扫描记录') }}
            </div>
            <div
              v-for="r in stats?.lastRuns ?? []"
              :key="r.id"
              class="scan-run-row d-flex align-center ga-2"
            >
              <v-chip
                size="x-small"
                variant="tonal"
                :color="
                  r.status === 'done' ? 'success' : r.status === 'error' ? 'error' : 'warning'
                "
                class="status-chip"
              >
                {{ formatRunStatus(r.status) }}
              </v-chip>
              <span class="text-caption text-truncate min-w-0 flex-grow-1" :title="r.root">
                {{ r.root.split('/').filter(Boolean).pop() || r.root }}
              </span>
              <span class="text-caption on-surface-variant">
                共 {{ r.total }} · 含定位 {{ r.with_gps }}
              </span>
            </div>
          </div>

          <!-- 瓦片本地缓存配额占用 -->
          <div class="px-2 pt-2 pb-1 border-t mt-1">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption font-weight-medium on-surface-variant">
                {{ t('yarj.settings.cacheTitle', '瓦片本地磁盘缓存') }}
              </span>
              <span class="text-caption on-surface-variant">
                {{ formatBytes(cacheStats?.totalBytes ?? 0) }} /
                {{
                  (cacheStats?.maxMb ?? 1024) > 0
                    ? formatBytes((cacheStats?.maxMb ?? 1024) * 1024 * 1024)
                    : t('yarj.cache.unlimited', '无限制')
                }}
              </span>
            </div>
            <v-progress-linear
              v-if="(cacheStats?.maxMb ?? 1024) > 0"
              :model-value="
                Math.min(
                  100,
                  Math.round(
                    ((cacheStats?.totalBytes ?? 0) / ((cacheStats?.maxMb ?? 1024) * 1024 * 1024)) *
                      100
                  )
                )
              "
              :color="
                (cacheStats?.totalBytes ?? 0) / ((cacheStats?.maxMb ?? 1024) * 1024 * 1024) > 0.9
                  ? 'warning'
                  : 'primary'
              "
              height="4"
              rounded
              class="mb-1"
            />
          </div>
        </template>

        <!-- 图层开关菜单 -->
        <template v-else-if="menuStep === 'layers'">
          <div class="sessions-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('yarj.menu.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{ t('yarj.menu.layers', '图层') }}</span>
          </div>
          <div class="px-1 pt-1 d-flex flex-column ga-1">
            <v-switch
              :model-value="showPhotosLayer"
              color="primary"
              hide-details
              density="compact"
              :label="t('yarj.layers.photos', '照片点')"
              @update:model-value="(v: boolean | null) => emit('update:showPhotosLayer', v ?? true)"
            />
            <v-switch
              :model-value="showExploredLayer"
              color="primary"
              hide-details
              density="compact"
              :label="t('yarj.layers.explored', '探索区域')"
              @update:model-value="
                (v: boolean | null) => emit('update:showExploredLayer', v ?? true)
              "
            />
            <v-switch
              :model-value="showRoutesLayer"
              color="cyan"
              hide-details
              density="compact"
              :label="t('yarj.layers.routes', '运动航线')"
              @update:model-value="(v: boolean | null) => emit('update:showRoutesLayer', v ?? true)"
            />
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, inject } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import { GRANULARITY_PRESETS, photoThumbUrl } from '../types'
import type {
  Photo,
  Route,
  ProviderItem,
  ScanStats,
  ExploredGranularity,
  GeocodeResult,
  TileCacheStats
} from '../types'
import { filterPhotosWithQuery } from '../search-parser'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(uiLang)

const props = defineProps<{
  photos: Photo[]
  routes: Route[]
  providers: ProviderItem[]
  activeProviderId: string
  activeProviderName: string
  scanRunning: boolean
  stats: ScanStats | null
  cacheStats: TileCacheStats | null
  exploredGranularity: ExploredGranularity
  showExploredLayer: boolean
  showPhotosLayer: boolean
  showRoutesLayer: boolean
  guessedGpsMap: Map<string, { lat: number; lon: number }>
}>()

const emit = defineEmits<{
  (e: 'start-exploration'): void
  (e: 'open-routes-drawer'): void
  (e: 'switch-provider', id: string): void
  (e: 'start-scan'): void
  (e: 'refresh-stats'): void
  (e: 'open-prune-dialog'): void
  (e: 'open-route-geotag'): void
  (e: 'open-gps-correction'): void
  (e: 'recompute-guesses'): void
  (e: 'update:showExploredLayer', val: boolean): void
  (e: 'update:exploredGranularity', val: ExploredGranularity): void
  (e: 'update:showPhotosLayer', val: boolean): void
  (e: 'update:showRoutesLayer', val: boolean): void
  (e: 'fly-to-geocode', res: GeocodeResult): void
  (e: 'open-search-help'): void
  (e: 'show-all-search-results', results: Photo[]): void
  (e: 'select-search-photo', p: Photo): void
}>()

const pageMenuRef = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
const menuStep = ref<
  'main' | 'build' | 'explored' | 'search' | 'photo-search' | 'providers' | 'stats' | 'layers'
>('main')

let menuCleanup: (() => void) | null = null

function menuClose(): void {
  menuOpen.value = false
  menuStep.value = 'main'
}

function toggleMenu(): void {
  if (menuOpen.value) {
    menuClose()
  } else {
    menuOpen.value = true
    menuStep.value = 'main'
  }
}

function onMenuDocClick(e: MouseEvent): void {
  const el = pageMenuRef.value
  const target = e.target as Node | null
  if (!el || !target || !target.isConnected) return
  if (el.contains(target)) return
  const elTarget = target instanceof Element ? target : target.parentElement
  if (
    elTarget?.closest('.v-overlay') ||
    elTarget?.closest('.v-dialog') ||
    elTarget?.closest('.v-menu') ||
    elTarget?.closest('.v-snackbar')
  ) {
    return
  }
  menuClose()
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuClose()
}

watch(menuOpen, (open) => {
  menuCleanup?.()
  menuCleanup = null
  if (open) {
    document.addEventListener('click', onMenuDocClick)
    document.addEventListener('contextmenu', onMenuDocClick)
    document.addEventListener('keydown', onMenuKey)
    menuCleanup = (): void => {
      document.removeEventListener('click', onMenuDocClick)
      document.removeEventListener('contextmenu', onMenuDocClick)
      document.removeEventListener('keydown', onMenuKey)
    }
  }
})

onUnmounted(() => {
  menuCleanup?.()
  menuCleanup = null
})

function handleStartExploration(): void {
  emit('start-exploration')
  menuClose()
}

function handleOpenRoutes(): void {
  emit('open-routes-drawer')
  menuClose()
}

function openProviders(): void {
  menuStep.value = 'providers'
}

function openStats(): void {
  menuStep.value = 'stats'
  emit('refresh-stats')
}

function handleOpenPrune(): void {
  emit('open-prune-dialog')
  menuClose()
}

function handleOpenGeotag(): void {
  emit('open-route-geotag')
  menuClose()
}

function handleOpenGpsCorrection(): void {
  emit('open-gps-correction')
  menuClose()
}

function handleSwitchProvider(id: string): void {
  emit('switch-provider', id)
  menuClose()
}

// ---------------------------------------------------------------------------
// 地名搜索
// ---------------------------------------------------------------------------
const geocodeQuery = ref('')
const geocodeLoading = ref(false)
const geocodeResults = ref<GeocodeResult[]>([])

async function searchLocation(): Promise<void> {
  const q = geocodeQuery.value.trim()
  if (!q) return
  geocodeLoading.value = true
  try {
    const res = (await window.cockpit.command('yarj.geocode', {
      query: q,
      lang: uiLang.value
    })) as { ok?: boolean; results?: GeocodeResult[] } | null
    if (res?.ok && Array.isArray(res.results)) {
      geocodeResults.value = res.results
    }
  } catch (err) {
    console.error('Geocode search failed:', err)
  } finally {
    geocodeLoading.value = false
  }
}

function handleFlyToGeocode(r: GeocodeResult): void {
  emit('fly-to-geocode', r)
  menuClose()
}

// ---------------------------------------------------------------------------
// 照片模糊搜索
// ---------------------------------------------------------------------------
const photoSearchQuery = ref('')

const photoSearchResults = computed(() => {
  const q = photoSearchQuery.value.trim()
  if (!q) return props.photos
  return filterPhotosWithQuery(props.photos, q)
})

function handleShowAllSearchResults(): void {
  if (!photoSearchResults.value.length) return
  emit('show-all-search-results', photoSearchResults.value)
  menuClose()
}

function handleSelectPhoto(p: Photo): void {
  emit('select-search-photo', p)
  menuClose()
}

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------
function formatRunStatus(s: string): string {
  if (s === 'running') return t('yarj.scan.running', '扫描中')
  if (s === 'done') return t('yarj.scan.done', '扫描完成')
  if (s === 'cancelled') return t('yarj.scan.cancelled', '已取消')
  return t('yarj.scan.failed', '扫描失败')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

defineExpose({
  menuClose,
  toggleMenu
})
</script>

<style scoped>
.page-menu {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.page-menu-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 24px;
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-top: none;
  border-radius: 0 0 24px 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: color 0.15s ease;
}

.page-menu-handle:hover {
  color: rgb(var(--v-theme-primary));
}

.page-menu.is-open .page-menu-handle {
  color: rgb(var(--v-theme-primary));
}

.page-menu-pop {
  margin-top: 4px;
  width: 360px;
  background: rgba(var(--v-theme-surface), 0.75);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
  overflow: hidden;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.menu-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}

.provider-item.is-active {
  background: rgba(var(--v-theme-primary), 0.15);
  color: rgb(var(--v-theme-primary));
}

.sessions-head {
  padding: 2px 4px 6px;
}

.sessions-scroll {
  max-height: 320px;
  overflow-y: auto;
  min-height: 0;
}

.sessions-scroll::-webkit-scrollbar {
  width: 6px;
}

.sessions-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding-bottom: 8px;
}

.stat-card {
  padding: 12px;
  border-radius: 8px;
  text-align: center;
  background: rgba(var(--v-theme-primary), 0.1);
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
}

.stat-value {
  font-size: 1.4rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  font-variant-numeric: tabular-nums;
}

.stat-label {
  margin-top: 2px;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}

.scan-run-row {
  padding: 6px 2px;
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.15);
}

.status-chip {
  padding-block: 4px;
  min-height: 24px;
}

.spin {
  animation: yarj-spin 1.1s linear infinite;
}

@keyframes yarj-spin {
  to {
    transform: rotate(360deg);
  }
}

.menu-pop-enter-active,
.menu-pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
