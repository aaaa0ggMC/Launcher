<script setup lang="ts">
defineOptions({ name: 'cockpit-settings' })

import { ref, inject, onMounted } from 'vue'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })

const theme = ref('dark')
const uiScale = ref(1.1)
const confirmBeforeLaunch = ref(false)
const frameless = ref(true)
const rounded = ref(true)
const searching = ref('')

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  theme.value = (cfg?.theme as string) ?? 'dark'
  const scale = Number(cfg?.uiScale)
  uiScale.value = Number.isFinite(scale) && scale > 0 ? scale : 1.1
  confirmBeforeLaunch.value = !!(cfg?.runtime as Record<string, unknown> | undefined)
    ?.confirmBeforeLaunch
  const win = (cfg?.window as Record<string, unknown> | undefined) ?? {}
  frameless.value = win.frameless !== false
  rounded.value = win.rounded !== false
  const appsCfg = (await window.cockpit.appsConfig()) as {
    searchRoots: { path: string; watch: boolean }[]
  }
  roots.value = appsCfg.searchRoots
})

const roots = ref<{ path: string; watch: boolean }[]>([])

async function setTheme(t: string): Promise<void> {
  theme.value = t
  await window.cockpit.setConfig({ theme: t })
}

async function commitUiScale(): Promise<void> {
  window.cockpit.setZoom(uiScale.value)
  await window.cockpit.setConfig({ uiScale: uiScale.value })
}

async function setConfirm(v: boolean | null): Promise<void> {
  const val = !!v
  confirmBeforeLaunch.value = val
  await window.cockpit.setConfig({
    runtime: {
      ...(config.value.runtime as Record<string, unknown> | undefined),
      confirmBeforeLaunch: val
    }
  })
}

async function setFrameless(v: boolean | null): Promise<void> {
  const val = !!v
  frameless.value = val
  await window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), frameless: val }
  })
}

async function setRounded(v: boolean | null): Promise<void> {
  const val = !!v
  rounded.value = val
  await window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), rounded: val }
  })
}

async function addRoot(): Promise<void> {
  if (!searching.value.trim()) return
  const list = (await window.cockpit.addRoot(searching.value.trim())) as {
    path: string
    watch: boolean
  }[]
  roots.value = list
  searching.value = ''
}

async function removeRoot(p: string): Promise<void> {
  const list = (await window.cockpit.removeRoot(p)) as { path: string; watch: boolean }[]
  roots.value = list
}

async function resetDashboardLayout(): Promise<void> {
  await window.cockpit.command('dashboard.reset-layout')
}
</script>

<template>
  <div>
    <div class="mb-4">
      <div class="text-h6 font-weight-medium">设置</div>
      <div class="text-caption on-surface-variant mt-1">外观 · 启动 · 应用目录</div>
    </div>

    <v-row dense>
      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">外观</v-card-title>
          <v-card-text>
            <div class="text-body-2 mb-2">主题</div>
            <v-radio-group
              v-model="theme"
              density="compact"
              hide-details
              @update:model-value="(v: string | null) => setTheme(v ?? 'dark')"
            >
              <v-radio label="深色 (Material 3)" value="dark" />
              <v-radio label="纯黑" value="pureblack" />
              <v-radio label="跟随系统" value="system" />
            </v-radio-group>

            <v-divider class="my-3" />

            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-body-2">界面缩放</span>
              <span class="text-caption on-surface-variant font-family-mono">
                {{ Math.round(uiScale * 100) }}%
              </span>
            </div>
            <v-slider
              v-model="uiScale"
              :min="0.8"
              :max="1.8"
              :step="0.05"
              color="primary"
              thumb-label
              show-ticks
              hide-details
              @end="commitUiScale"
            />
            <div class="d-flex justify-space-between text-caption on-surface-variant mt-1">
              <span>小</span>
              <span>默认</span>
              <span>大</span>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">窗口</v-card-title>
          <v-card-text class="d-flex flex-column">
            <v-switch
              :model-value="frameless"
              label="无边框窗口"
              density="compact"
              hide-details
              @update:model-value="setFrameless"
            />
            <v-switch
              :model-value="rounded"
              label="圆角窗口"
              density="compact"
              hide-details
              class="mt-1"
              @update:model-value="setRounded"
            />
            <div class="text-caption on-surface-variant mt-2">
              需要透明窗口支持 (Wayland/KDE 可用)。修改后下次启动生效。
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">总览排版</v-card-title>
          <v-card-text>
            <div class="text-body-2 mb-2">在总览页把卡片拖乱了吗？一键恢复默认排版。</div>
            <v-btn
              color="error"
              variant="tonal"
              prepend-icon="mdi-restore"
              @click="resetDashboardLayout"
            >
              重置排版
            </v-btn>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">启动</v-card-title>
          <v-card-text>
            <v-switch
              :model-value="confirmBeforeLaunch"
              label="所有启动前都需确认"
              density="compact"
              hide-details
              @update:model-value="setConfirm"
            />
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">应用搜索目录</v-card-title>
          <v-card-text>
            <div class="mb-3">
              <template v-for="r in roots" :key="r.path">
                <v-chip
                  size="small"
                  variant="outlined"
                  closable
                  class="mr-2 mb-1"
                  @click:close="removeRoot(r.path)"
                >
                  {{ r.path }}
                </v-chip>
              </template>
              <span v-if="roots.length === 0" class="text-caption on-surface-variant">未配置</span>
            </div>
            <div class="d-flex ga-2">
              <v-text-field
                v-model="searching"
                placeholder="/home/aaaa0ggmc/Apps"
                variant="outlined"
                density="compact"
                hide-details
              />
              <v-btn color="primary" variant="tonal" @click="addRoot">添加</v-btn>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">关于</v-card-title>
          <v-card-text class="text-body-2">
            Linux System Cockpit · Electron + Vue 3 + Vuetify 3 (Material 3)
            <br />
            <span class="text-caption on-surface-variant">
              能力由 config/abilities.yaml 驱动，可在 src/renderer/abilities 下动态增删。
            </span>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
