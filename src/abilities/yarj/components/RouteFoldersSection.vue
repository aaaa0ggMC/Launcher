<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-route-folders' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { GalleryRoot, Route, YarjConfig } from '../types'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const routeRoots = ref<GalleryRoot[]>([])
const routes = ref<Route[]>([])
const searching = ref('')
const loading = ref(true)
const snackbar = ref(false)
const snackbarText = ref('')

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const cfg = (await window.cockpit.command('yarj.config')) as YarjConfig
    routeRoots.value = cfg.routeRoots ?? []
    const list = (await window.cockpit.command('yarj.routes')) as Route[]
    routes.value = list ?? []
  } catch {
    /* ignore */
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
})

async function addRoot(): Promise<void> {
  const p = searching.value.trim()
  if (!p) return
  const cfg = (await window.cockpit.command('yarj.add-route-root', { path: p })) as YarjConfig
  routeRoots.value = cfg.routeRoots ?? []
  searching.value = ''
  showMsg('成功添加航线目录')
}

async function removeRoot(p: string): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.remove-route-root', { path: p })) as YarjConfig
  routeRoots.value = cfg.routeRoots ?? []
  showMsg('已移除航线目录')
}

async function moveRoot(p: string, dir: -1 | 1): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.move-route-root', {
    path: p,
    dir: dir === -1 ? 'up' : 'down'
  })) as YarjConfig
  routeRoots.value = cfg.routeRoots ?? []
}

async function pickDirectory(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('yarj.routes.selectDir', '选择运动航线目录'),
    directory: true
  })
  if (!path) return
  searching.value = path
}

async function importSingleFile(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: '选择 GPX / KML 轨迹文件',
    directory: false,
    filters: [{ name: 'GPS Track (*.gpx, *.kml)', extensions: ['gpx', 'kml'] }]
  })
  if (!path) return
  try {
    const res = (await window.cockpit.command('yarj.import-route-file', { path })) as {
      ok: boolean
      route?: Route
      error?: string
    }
    if (res.ok && res.route) {
      showMsg(`成功导入轨迹：${res.route.name}`)
      await refresh()
    } else {
      showMsg(`导入失败：${res.error || '未知错误'}`)
    }
  } catch (err) {
    showMsg(`导入失败：${String(err)}`)
  }
}

async function scanRoutes(): Promise<void> {
  try {
    await window.cockpit.btJob('yarj.scan-routes', {})
    showMsg('已在后台启动航线目录扫描')
  } catch (err) {
    showMsg(`启动扫描失败: ${String(err)}`)
  }
}

function showMsg(text: string): void {
  snackbarText.value = text
  snackbar.value = true
}

defineExpose({
  toMarkdown: (): string => {
    const title = '运动航线目录'
    if (!routeRoots.value.length) return `${title}: 未配置`
    return `${title}:\n  ${routeRoots.value.map((r) => `- ${r.path}`).join('\n  ')}\n已入库航线数: ${routes.value.length}`
  }
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <v-card rounded="lg" variant="tonal" class="card-fill">
      <v-card-title class="text-subtitle-2 d-flex align-center justify-space-between">
        <span>{{ t('label.航线目录', '航线目录') }}</span>
        <v-chip v-if="routes.length > 0" size="small" variant="flat" color="primary">
          已入库 {{ routes.length }} 条轨迹
        </v-chip>
      </v-card-title>
      <v-card-text>
        <div class="text-caption on-surface-variant mb-3">
          {{
            t(
              'desc.航线目录',
              '扫描器从这些目录收集 GPX / KML 运动航线文件，绘制专属荧光路线图层并支持照片时序贴合。'
            )
          }}
        </div>

        <div v-if="routeRoots.length > 0" class="d-flex flex-column ga-2 rules-list">
          <div
            v-for="(r, i) in routeRoots"
            :key="r.path"
            class="d-flex align-center ga-2 flex-wrap"
          >
            <v-text-field
              :model-value="r.path"
              :label="t('yarj.gallery.row', '目录 {n}').replace('{n}', String(i + 1))"
              readonly
              density="compact"
              variant="outlined"
              hide-details
              class="flex-grow-1 rule-input"
            />
            <div class="d-flex ga-1">
              <v-btn
                icon
                size="small"
                variant="flat"
                :disabled="i === 0"
                :title="t('yarj.gallery.moveUp', '上移')"
                @click="moveRoot(r.path, -1)"
              >
                <v-icon size="small">mdi-arrow-up</v-icon>
              </v-btn>
              <v-btn
                icon
                size="small"
                variant="flat"
                :disabled="i === routeRoots.length - 1"
                :title="t('yarj.gallery.moveDown', '下移')"
                @click="moveRoot(r.path, 1)"
              >
                <v-icon size="small">mdi-arrow-down</v-icon>
              </v-btn>
              <v-btn
                icon
                size="small"
                variant="flat"
                color="error"
                :title="t('yarj.gallery.remove', '移除该目录')"
                @click="removeRoot(r.path)"
              >
                <v-icon size="small">mdi-close</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
        <div v-else class="text-caption on-surface-variant d-flex align-center ga-2 rules-empty">
          <span>{{ t('yarj.gallery.unconfigured', '未配置') }}</span>
        </div>

        <!-- 目录添加栏 (对齐图库目录 UI 规范) -->
        <div class="d-flex align-center ga-2 mt-2 flex-wrap">
          <v-text-field
            v-model="searching"
            :placeholder="t('yarj.gallery.selectDir', '选择目录')"
            variant="outlined"
            density="compact"
            hide-details
            class="flex-grow-1 rule-input"
            @keydown.enter="addRoot"
          >
            <template #append-inner>
              <v-btn
                icon
                variant="text"
                size="small"
                :title="t('yarj.gallery.selectDir', '选择目录')"
                @click="pickDirectory"
              >
                <v-icon>mdi-folder-open</v-icon>
              </v-btn>
            </template>
          </v-text-field>
          <v-btn color="primary" variant="tonal" height="40" class="px-5" @click="addRoot">
            {{ t('yarj.gallery.add', '添加') }}
          </v-btn>
        </div>

        <!-- 快捷动作区 -->
        <v-divider class="my-4" />
        <div class="d-flex flex-wrap align-center justify-space-between ga-2">
          <div class="d-flex ga-2">
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-radar" @click="scanRoutes">
              扫描全部目录
            </v-btn>
            <v-btn variant="outlined" prepend-icon="mdi-file-import" @click="importSingleFile">
              导入单个 GPX 文件
            </v-btn>
          </div>
          <v-btn variant="text" icon size="small" title="刷新" @click="refresh">
            <v-icon size="small">mdi-refresh</v-icon>
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar" timeout="2500">
      {{ snackbarText }}
    </v-snackbar>
  </div>
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
  min-width: 160px;
}
.card-fill {
  width: 100%;
}
</style>
