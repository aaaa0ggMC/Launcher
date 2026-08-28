<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-maps' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

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

const maps = ref<MapFileInfo[]>([])
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('error')

function showSnack(text: string, color = 'error'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

async function refresh(): Promise<void> {
  maps.value = ((await window.cockpit.command('yarj.maps')) as MapFileInfo[]) ?? []
}

onMounted(refresh)

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
    showSnack(r?.error ?? t('yarj.maps.invalid', '文件无效或已添加'))
    return
  }
  maps.value = r.maps ?? []
}

async function removeMap(m: MapFileInfo): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.remove-map', { id: m.id })) as {
    maps?: MapFileInfo[]
  }
  maps.value = cfg.maps ?? []
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
    const title = t('yarj.maps.title', '地图文件')
    if (!maps.value.length) return `${title}: ${t('yarj.maps.unconfigured', '未配置地图文件')}`
    return `${title}:\n  ${maps.value
      .map((m) => `- ${m.path} (zoom ${m.defaultZoom})`)
      .join('\n  ')}`
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ t('yarj.maps.title', '地图文件') }}</v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{
          t(
            'yarj.maps.desc',
            '添加 MBTiles 地图文件（如 GlobalMap_ADM0_2.mbtiles），「缩放级别」决定打开时的默认缩放。'
          )
        }}
      </div>

      <div v-if="maps.length > 0" class="d-flex flex-column ga-2 rules-list">
        <div v-for="(m, i) in maps" :key="m.id" class="d-flex align-center ga-2 flex-wrap map-row">
          <!-- Zoom 范围 -->
          <v-chip
            variant="tonal"
            size="small"
            class="zoom-chip"
            :title="
              t('yarj.maps.zoomRange', '缩放范围 {min}–{max}')
                .replace('{min}', String(m.minzoom ?? '?'))
                .replace('{max}', String(m.maxzoom ?? '?'))
            "
          >
            {{ m.minzoom ?? '?' }}–{{ m.maxzoom ?? '?' }}
          </v-chip>

          <!-- File -->
          <v-text-field
            :model-value="m.path"
            :label="t('yarj.maps.row', '地图 {n}').replace('{n}', String(i + 1))"
            readonly
            density="compact"
            variant="outlined"
            hide-details
            class="flex-grow-1 rule-input"
          >
            <template #append-inner>
              <v-btn v-if="m.error" icon variant="text" size="small" color="error" :title="m.error">
                <v-icon>mdi-alert-circle-outline</v-icon>
              </v-btn>
              <v-btn
                v-else
                icon
                variant="text"
                size="small"
                :title="t('yarj.maps.info', '地图信息')"
                @click="
                  showSnack(
                    `${m.path} — ${t('yarj.maps.format', '格式')}: ${m.format ?? '?'} · ${t('yarj.maps.tiles', '瓦片数')}: ${m.tileCount ?? '?'}`,
                    'info'
                  )
                "
              >
                <v-icon>mdi-information-outline</v-icon>
              </v-btn>
            </template>
          </v-text-field>

          <!-- ZoomLevel −/+ 步进 -->
          <div class="d-flex align-center ga-1 zoom-stepper">
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="(m.defaultZoom ?? m.minzoom ?? 0) <= (m.minzoom ?? 0)"
              :title="t('yarj.map.zoomOut', '缩小')"
              @click="setZoom(m, -1)"
            >
              <v-icon size="small">mdi-minus</v-icon>
            </v-btn>
            <span class="zoom-value" :title="t('yarj.maps.zoomLevel', '缩放级别')">
              {{ m.defaultZoom ?? m.minzoom ?? 0 }}
            </span>
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="(m.defaultZoom ?? m.minzoom ?? 0) >= (m.maxzoom ?? 14)"
              :title="t('yarj.map.zoomIn', '放大')"
              @click="setZoom(m, 1)"
            >
              <v-icon size="small">mdi-plus</v-icon>
            </v-btn>
          </div>

          <v-btn
            icon
            size="small"
            variant="flat"
            color="error"
            :title="t('yarj.maps.remove', '移除该地图')"
            @click="removeMap(m)"
          >
            <v-icon size="small">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>
      <div v-else class="text-caption on-surface-variant d-flex align-center ga-2 rules-empty">
        <span>{{ t('yarj.maps.unconfigured', '未配置地图文件') }}</span>
      </div>

      <div class="d-flex align-center ga-2 mt-2 flex-wrap">
        <v-btn color="primary" variant="tonal" height="40" class="px-5" @click="addMap">
          <v-icon start>mdi-map-plus</v-icon>
          {{ t('yarj.maps.add', '添加地图文件') }}
        </v-btn>
      </div>
    </v-card-text>

    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="3500">
      {{ snackText }}
    </v-snackbar>
  </v-card>
</template>

<style scoped>
.rules-list {
  overflow-y: auto;
  padding: 10px 6px 8px 2px;
}
.rules-empty {
  min-height: 44px;
}
.rule-input {
  min-width: 200px;
}
.zoom-chip {
  padding-block: 4px;
  min-height: 24px;
  font-variant-numeric: tabular-nums;
}
.zoom-stepper {
  min-width: 96px;
}
.zoom-value {
  min-width: 28px;
  text-align: center;
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}
.map-row {
  padding-block: 2px;
}
</style>
