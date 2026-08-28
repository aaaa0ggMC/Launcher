<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-map-sources' })

import { ref, computed, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { TileCacheStats, ProviderItem } from '../types'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

interface MapFileInfo {
  id: string
  path: string
  defaultZoom: number
  enabled: boolean
  minzoom?: number
  maxzoom?: number
  format?: string
  tileCount?: number
  error?: string
}

const activeId = ref('google-hybrid')
const providers = ref<ProviderItem[]>([])
const maps = ref<MapFileInfo[]>([])
const googleKey = ref('')
const showGoogleKey = ref(false)
const tiandituKey = ref('')
const customUrl = ref('')
const mapLanguage = ref('auto')
const enableCache = ref(true)
const maxCacheMb = ref<number>(1024)
const cacheStats = ref<TileCacheStats | null>(null)

const CACHE_QUOTA_OPTIONS = computed(() => [
  { title: t('yarj.cache.quota500Mb', '500 MB'), value: 500 },
  { title: t('yarj.cache.quota1Gb', '1 GB (默认)'), value: 1024 },
  { title: t('yarj.cache.quota2Gb', '2 GB'), value: 2048 },
  { title: t('yarj.cache.quota5Gb', '5 GB'), value: 5120 },
  { title: t('yarj.cache.quota10Gb', '10 GB'), value: 10240 },
  { title: t('yarj.cache.quotaUnlimited', '无限制 (不自动清理)'), value: 0 }
])

const LANGUAGE_OPTIONS = computed(() => [
  { title: t('yarj.settings.langAuto', '跟随 Cockpit 界面语言 (自动)'), value: 'auto' },
  { title: t('yarj.settings.langZhCn', '简体中文 (zh-CN)'), value: 'zh-CN' },
  { title: t('yarj.settings.langZhTw', '繁体中文 (zh-TW)'), value: 'zh-TW' },
  { title: t('yarj.settings.langEn', '英语 (English)'), value: 'en' },
  { title: t('yarj.settings.langJa', '日语 (日本語)'), value: 'ja' },
  { title: t('yarj.settings.langKo', '韩语 (한국어)'), value: 'ko' },
  { title: t('yarj.settings.langLocal', '当地原生语言 (无指定)'), value: 'local' }
])

const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

async function refresh(): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.config')) as {
    activeProviderId?: string
    googleApiKey?: string
    tiandituApiKey?: string
    customUrlTemplate?: string
    enableTileCache?: boolean
    maxTileCacheMb?: number
    mapLanguage?: string
  }
  activeId.value = cfg.activeProviderId || 'google-hybrid'
  googleKey.value = cfg.googleApiKey ?? ''
  tiandituKey.value = cfg.tiandituApiKey ?? ''
  customUrl.value = cfg.customUrlTemplate ?? ''
  enableCache.value = cfg.enableTileCache !== false
  maxCacheMb.value = typeof cfg.maxTileCacheMb === 'number' ? cfg.maxTileCacheMb : 1024
  mapLanguage.value = cfg.mapLanguage ?? 'auto'

  const pRes = (await window.cockpit.command('yarj.providers')) as {
    activeId: string
    providers: ProviderItem[]
  }
  if (pRes?.providers) {
    providers.value = pRes.providers
    if (pRes.activeId) activeId.value = pRes.activeId
  }

  maps.value = ((await window.cockpit.command('yarj.maps')) as MapFileInfo[]) ?? []
  cacheStats.value = (await window.cockpit.command('yarj.cache-stats')) as TileCacheStats
}

onMounted(refresh)

async function onProviderChange(newId: string): Promise<void> {
  activeId.value = newId
  await window.cockpit.command('yarj.set-active-provider', { id: newId })
  showSnack(t('yarj.providers.switched', '已切换当前地图图源'))
}

async function onLanguageChange(newLang: string): Promise<void> {
  mapLanguage.value = newLang
  await window.cockpit.command('yarj.save-config', {
    patch: {
      mapLanguage: newLang
    }
  })
  showSnack(t('yarj.settings.langSaved', '地图语言已更新'))
  await refresh()
}

async function onCacheQuotaChange(quota: number): Promise<void> {
  maxCacheMb.value = quota
  await window.cockpit.command('yarj.save-config', {
    patch: {
      maxTileCacheMb: quota
    }
  })
  showSnack(t('yarj.cache.quotaSaved', '缓存上限配额已更新'))
  await refresh()
}

async function saveKeys(): Promise<void> {
  await window.cockpit.command('yarj.save-config', {
    patch: {
      googleApiKey: googleKey.value.trim(),
      tiandituApiKey: tiandituKey.value.trim(),
      customUrlTemplate: customUrl.value.trim(),
      enableTileCache: enableCache.value,
      maxTileCacheMb: maxCacheMb.value,
      mapLanguage: mapLanguage.value
    }
  })
  showSnack(t('yarj.settings.saved', '设置已保存'))
  await refresh()
}

function getProviderName(id: string): string {
  const p = providers.value.find((x) => x.id === id)
  return p ? p.name : id
}

async function handleClearCache(): Promise<void> {
  await window.cockpit.command('yarj.clear-cache')
  showSnack(t('yarj.cache.cleared', '全部瓦片磁盘缓存已清空'))
  await refresh()
}

async function handleClearProviderCache(pId: string): Promise<void> {
  await window.cockpit.command('yarj.clear-cache', { id: pId })
  showSnack(
    t('yarj.cache.clearedCurrent', '已清空 {name} 缓存').replace('{name}', getProviderName(pId))
  )
  await refresh()
}

async function addMap(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('yarj.maps.selectFile', '选择 MBTiles 文件'),
    filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }]
  })
  if (!path) return
  const r = (await window.cockpit.command('yarj.add-map', { path })) as {
    ok?: boolean
    error?: string
    maps?: MapFileInfo[]
  }
  if (!r?.ok) {
    showSnack(r?.error ?? t('yarj.maps.invalid', '文件无效或已添加'), 'error')
    return
  }
  maps.value = r.maps ?? []
  await refresh()
}

async function removeMap(m: MapFileInfo): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.remove-map', { id: m.id })) as {
    maps?: MapFileInfo[]
  }
  maps.value = cfg.maps ?? []
  await refresh()
}

async function setZoom(m: MapFileInfo, delta: -1 | 1): Promise<void> {
  const min = m.minzoom ?? 0
  const max = m.maxzoom ?? 14
  const next = Math.min(max, Math.max(min, (m.defaultZoom ?? min) + delta))
  if (next === m.defaultZoom) return
  const cfg = (await window.cockpit.command('yarj.set-map-zoom', {
    id: m.id,
    zoom: next
  })) as { maps?: MapFileInfo[] }
  maps.value = cfg.maps ?? []
}

defineExpose({
  toMarkdown: (): string => {
    const title = t('yarj.settings.mapsTitle', '地图图源与配置')
    return `${title}:\n  当前图源: ${activeId.value}\n  MBTiles 数量: ${maps.value.length}`
  }
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <!-- 图源选择 -->
    <v-card rounded="lg" variant="tonal" class="card-fill">
      <v-card-title class="text-subtitle-2">{{
        t('yarj.settings.sourceTitle', '当前地图图源')
      }}</v-card-title>
      <v-card-text>
        <div class="text-caption on-surface-variant mb-3">
          {{
            t(
              'yarj.settings.sourceDesc',
              '选择应用主界面使用的底图服务，支持谷歌地图、CartoDB 极简相册风、ArcGIS 高清卫星图等。'
            )
          }}
        </div>
        <v-select
          v-model="activeId"
          :items="providers"
          item-title="name"
          item-value="id"
          variant="outlined"
          density="comfortable"
          hide-details
          class="max-w-lg mb-4"
          @update:model-value="onProviderChange"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps">
              <template #append>
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="
                    item.raw.category === 'google'
                      ? 'primary'
                      : item.raw.category === 'google-official'
                        ? 'warning'
                        : item.raw.isLocal
                          ? 'secondary'
                          : 'default'
                  "
                >
                  {{
                    item.raw.category === 'google-official'
                      ? 'TILES API'
                      : item.raw.category.toUpperCase()
                  }}
                </v-chip>
              </template>
            </v-list-item>
          </template>
        </v-select>

        <div class="text-caption font-weight-medium mb-1">
          {{ t('yarj.settings.mapLangTitle', '地图注记语言') }}
        </div>
        <v-select
          v-model="mapLanguage"
          :items="LANGUAGE_OPTIONS"
          item-title="title"
          item-value="value"
          variant="outlined"
          density="comfortable"
          hide-details
          class="max-w-lg"
          @update:model-value="onLanguageChange"
        />
        <div class="text-caption on-surface-variant mt-1">
          {{
            t(
              'yarj.settings.mapLangHint',
              '支持跟随 Cockpit 软件语言或指定语言；语言独立缓存，切换无需重复下载。'
            )
          }}
        </div>
      </v-card-text>
    </v-card>

    <!-- 密钥与模版配置 -->
    <v-card rounded="lg" variant="tonal" class="card-fill">
      <v-card-title class="text-subtitle-2">{{
        t('yarj.settings.keysTitle', 'API 密钥与在线模版')
      }}</v-card-title>
      <v-card-text>
        <div class="d-flex flex-column ga-3">
          <div>
            <div class="text-caption font-weight-medium mb-1">
              {{ t('yarj.settings.googleKey', 'Google Maps API Key') }}
            </div>
            <v-text-field
              v-model="googleKey"
              :type="showGoogleKey ? 'text' : 'password'"
              :append-inner-icon="showGoogleKey ? 'mdi-eye-off' : 'mdi-eye'"
              variant="outlined"
              density="compact"
              hide-details
              placeholder="AIzaSy..."
              class="max-w-lg"
              @click:append-inner="showGoogleKey = !showGoogleKey"
              @change="saveKeys"
            />
            <div class="text-caption on-surface-variant mt-1">
              {{
                t(
                  'yarj.settings.googleKeyHint',
                  '用于 Google 卫星图、混合图、街道图与地形图（每月享 100,000 次免费瓦片请求）。'
                )
              }}
            </div>
          </div>

          <div>
            <div class="text-caption font-weight-medium mb-1">
              {{ t('yarj.settings.tiandituKey', '天地图 API Key (Token)') }}
            </div>
            <v-text-field
              v-model="tiandituKey"
              type="password"
              variant="outlined"
              density="compact"
              hide-details
              placeholder="天地图服务密钥"
              class="max-w-lg"
              @change="saveKeys"
            />
          </div>

          <div>
            <div class="text-caption font-weight-medium mb-1">
              {{ t('yarj.settings.customUrl', '自定义 XYZ 瓦片 URL 模版') }}
            </div>
            <v-text-field
              v-model="customUrl"
              variant="outlined"
              density="compact"
              hide-details
              placeholder="https://{s}.domain.com/{z}/{x}/{y}.png"
              class="max-w-lg"
              @change="saveKeys"
            />
            <div class="text-caption on-surface-variant mt-1">
              {{
                t(
                  'yarj.settings.customUrlHint',
                  '支持占位符: {z}, {x}, {y}, {-y}, {s}, {r}, {apiKey}'
                )
              }}
            </div>
          </div>

          <div class="pt-2">
            <v-btn color="primary" variant="flat" height="40" class="px-5" @click="saveKeys">
              {{ t('yarj.settings.saveBtn', '保存配置') }}
            </v-btn>
          </div>
        </div>
      </v-card-text>
    </v-card>

    <!-- 瓦片本地磁盘缓存 -->
    <v-card rounded="lg" variant="tonal" class="card-fill">
      <v-card-title class="text-subtitle-2">{{
        t('yarj.settings.cacheTitle', '瓦片本地磁盘缓存')
      }}</v-card-title>
      <v-card-text>
        <div class="text-caption on-surface-variant mb-3">
          {{
            t(
              'yarj.settings.cacheDesc',
              '自动缓存浏览过的在线地图切片至本地磁盘，实现离线浏览并 100% 避免重复消耗 API 免费配额。'
            )
          }}
        </div>
        <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
          <div class="d-flex align-center ga-3">
            <v-switch
              v-model="enableCache"
              color="primary"
              hide-details
              density="compact"
              :label="t('yarj.settings.enableCache', '启用磁盘缓存')"
              @update:model-value="saveKeys"
            />
            <v-chip size="small" variant="tonal" color="primary">
              {{ t('yarj.cache.total', '总缓存') }}:
              {{ formatBytes(cacheStats?.totalBytes ?? 0) }} · {{ cacheStats?.tileCount ?? 0 }}
              {{ t('yarj.maps.tiles', '瓦片') }}
            </v-chip>
          </div>
          <v-btn
            color="error"
            variant="outlined"
            size="small"
            height="36"
            class="px-4"
            prepend-icon="mdi-trash-can-outline"
            :disabled="!cacheStats?.tileCount"
            @click="handleClearCache"
          >
            {{ t('yarj.settings.clearAllCacheBtn', '清空全部缓存') }}
          </v-btn>
        </div>

        <!-- 缓存上限配额配置与占用条 -->
        <div class="d-flex flex-column ga-2 mb-4 p-3 rounded bg-surface-subtle">
          <div class="d-flex align-center justify-space-between flex-wrap ga-2">
            <span class="text-caption font-weight-medium">{{
              t('yarj.cache.quotaLabel', '缓存上限配额（超额自动按 LRU 淘汰旧瓦片）')
            }}</span>
            <span class="text-caption on-surface-variant">
              {{ formatBytes(cacheStats?.totalBytes ?? 0) }} /
              {{
                maxCacheMb > 0
                  ? formatBytes(maxCacheMb * 1024 * 1024)
                  : t('yarj.cache.unlimited', '无限制')
              }}
            </span>
          </div>

          <v-progress-linear
            v-if="maxCacheMb > 0"
            :model-value="
              Math.min(
                100,
                Math.round(((cacheStats?.totalBytes ?? 0) / (maxCacheMb * 1024 * 1024)) * 100)
              )
            "
            :color="
              (cacheStats?.totalBytes ?? 0) / (maxCacheMb * 1024 * 1024) > 0.9
                ? 'warning'
                : 'primary'
            "
            height="6"
            rounded
          />

          <v-select
            v-model="maxCacheMb"
            :items="CACHE_QUOTA_OPTIONS"
            item-title="title"
            item-value="value"
            variant="outlined"
            density="comfortable"
            hide-details
            class="max-w-lg mt-1"
            @update:model-value="onCacheQuotaChange"
          />
        </div>

        <!-- 缓存分区明细 -->
        <div
          v-if="cacheStats && Object.keys(cacheStats.byProvider).length"
          class="cache-partitions pt-2 border-t"
        >
          <div class="text-caption font-weight-medium on-surface-variant mb-2">
            {{ t('yarj.cache.partitionsTitle', '图源缓存分区') }}
          </div>
          <div class="d-flex flex-column ga-2">
            <div
              v-for="(sub, pId) in cacheStats.byProvider"
              :key="pId"
              class="d-flex align-center justify-space-between ga-2 py-1 px-2 rounded bg-surface-subtle"
            >
              <div class="d-flex align-center ga-2 min-w-0">
                <v-icon size="16" color="primary">mdi-folder-outline</v-icon>
                <span class="text-caption font-weight-medium text-truncate">{{
                  getProviderName(String(pId))
                }}</span>
                <span class="text-caption on-surface-variant"
                  >({{ formatBytes(sub.bytes) }} · {{ sub.count }} 瓦片)</span
                >
              </div>
              <v-btn
                icon
                size="x-small"
                variant="text"
                color="error"
                :title="t('yarj.cache.clearThis', '清空该图源缓存')"
                @click="handleClearProviderCache(String(pId))"
              >
                <v-icon size="16">mdi-delete-outline</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
      </v-card-text>
    </v-card>

    <!-- 本地 MBTiles 文件管理 -->
    <v-card rounded="lg" variant="tonal" class="card-fill">
      <v-card-title class="text-subtitle-2">{{
        t('yarj.maps.title', '离线 MBTiles 地图')
      }}</v-card-title>
      <v-card-text>
        <div class="text-caption on-surface-variant mb-3">
          {{ t('yarj.maps.desc', '可添加离线 MBTiles 文件作为备选本地图源。') }}
        </div>

        <div v-if="!maps.length" class="text-caption on-surface-variant py-2">
          {{ t('yarj.maps.unconfigured', '未添加本地 MBTiles 文件') }}
        </div>

        <div v-else class="maps-table mb-3">
          <div
            class="table-head text-caption font-weight-medium on-surface-variant d-flex align-center"
          >
            <span class="col-zoom">{{ t('yarj.maps.zoomRangeHead', '可用级别') }}</span>
            <span class="col-file flex-grow-1">{{ t('yarj.maps.fileHead', '文件') }}</span>
            <span class="col-default-zoom">{{ t('yarj.maps.defaultZoomHead', '默认缩放') }}</span>
            <span class="col-actions"></span>
          </div>

          <div
            v-for="m in maps"
            :key="m.id"
            class="table-row d-flex align-center ga-2 py-2 border-b"
          >
            <div class="col-zoom">
              <v-chip size="x-small" variant="tonal" :color="m.error ? 'error' : 'primary'">
                {{
                  m.error
                    ? t('yarj.maps.error', '读取失败')
                    : `${m.minzoom ?? 0}–${m.maxzoom ?? 14}`
                }}
              </v-chip>
            </div>

            <div class="col-file flex-grow-1 min-w-0">
              <div class="text-body-2 text-truncate" :title="m.path">{{ m.path }}</div>
            </div>

            <div class="col-default-zoom d-flex align-center ga-1">
              <v-btn
                icon
                size="small"
                variant="text"
                :disabled="!m.enabled || (m.defaultZoom ?? 0) <= (m.minzoom ?? 0)"
                @click="setZoom(m, -1)"
              >
                <v-icon size="16">mdi-minus</v-icon>
              </v-btn>
              <span class="zoom-value text-caption font-weight-medium">{{ m.defaultZoom }}</span>
              <v-btn
                icon
                size="small"
                variant="text"
                :disabled="!m.enabled || (m.defaultZoom ?? 0) >= (m.maxzoom ?? 14)"
                @click="setZoom(m, 1)"
              >
                <v-icon size="16">mdi-plus</v-icon>
              </v-btn>
            </div>

            <div class="col-actions">
              <v-btn
                icon
                size="small"
                variant="text"
                color="error"
                :title="t('yarj.maps.remove', '移除该地图')"
                @click="removeMap(m)"
              >
                <v-icon size="16">mdi-delete-outline</v-icon>
              </v-btn>
            </div>
          </div>
        </div>

        <div class="d-flex align-center ga-2">
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-plus"
            height="40"
            class="px-5"
            @click="addMap"
          >
            {{ t('yarj.maps.add', '添加 MBTiles 文件') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="3000">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.card-fill {
  background: rgba(var(--v-theme-surface), 0.6);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.15);
}

.max-w-lg {
  max-width: 520px;
}

.maps-table {
  border-radius: 6px;
}

.col-zoom {
  width: 90px;
  flex-shrink: 0;
}

.col-default-zoom {
  width: 110px;
  flex-shrink: 0;
  justify-content: center;
}

.zoom-value {
  min-width: 20px;
  text-align: center;
}

.col-actions {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
}

.border-b {
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}

.border-t {
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}

.bg-surface-subtle {
  background: rgba(var(--v-theme-surface-bright), 0.08);
}
</style>
