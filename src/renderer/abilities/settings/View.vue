<script setup lang="ts">
defineOptions({ name: 'cockpit-settings' })

import { ref, inject, onMounted } from 'vue'
import { backgrounds } from '../../backgrounds'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })

const theme = ref('dark')
const uiScale = ref(1.1)
const confirmBeforeLaunch = ref(false)
const frameless = ref(true)
const rounded = ref(true)
const background = ref('transparent')
const backgroundImage = ref('')
const backgroundOpacity = ref(1)
const fuseAlpha = ref(0.85)
const fuseBlur = ref(28)
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
  background.value = (win.background as string) ?? 'transparent'
  backgroundImage.value = (win.backgroundImage as string) ?? ''
  const bop = Number(win.backgroundOpacity)
  backgroundOpacity.value = Number.isFinite(bop) ? bop : 1
  const alpha = Number(win.fuseAlpha)
  fuseAlpha.value = Number.isFinite(alpha) ? alpha : 0.85
  const blur = Number(win.fuseBlur)
  fuseBlur.value = Number.isFinite(blur) ? blur : 28
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

function saveWindow(patch: Record<string, unknown>): Promise<unknown> {
  return window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), ...patch }
  })
}

async function setBackground(v: string | null): Promise<void> {
  background.value = v ?? 'transparent'
  await saveWindow({ background: background.value })
}

async function setBackgroundImage(): Promise<void> {
  await saveWindow({ backgroundImage: backgroundImage.value.trim() || undefined })
}

async function browseBackgroundImage(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: '选择背景图片',
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'gif', 'avif'] }
    ]
  })
  if (!path) return
  backgroundImage.value = path
  await saveWindow({ backgroundImage: path })
}

async function commitFuseAlpha(): Promise<void> {
  await saveWindow({ fuseAlpha: fuseAlpha.value })
}

async function commitBackgroundOpacity(): Promise<void> {
  await saveWindow({ backgroundOpacity: backgroundOpacity.value })
}

async function commitFuseBlur(): Promise<void> {
  await saveWindow({ fuseBlur: fuseBlur.value })
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

            <v-divider class="my-3" />

            <div class="text-body-2 mb-1">背景</div>
            <v-select
              v-model="background"
              :items="backgrounds"
              item-title="name"
              item-value="id"
              label="背景"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="setBackground"
            />
            <div class="text-caption on-surface-variant mt-1">
              {{ backgrounds.find((b) => b.id === background)?.description }}
            </div>
            <div v-if="background === 'image'" class="d-flex align-center ga-2 mt-2">
              <v-text-field
                v-model="backgroundImage"
                label="图片路径"
                placeholder="/home/user/Pictures/wall.jpg"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
                @change="setBackgroundImage"
              />
              <v-btn icon variant="tonal" @click="browseBackgroundImage">
                <v-icon>mdi-folder-image</v-icon>
              </v-btn>
            </div>

            <div class="d-flex align-center justify-space-between mt-3 mb-1">
              <span class="text-body-2">Fuse 蒙层不透明度</span>
              <span class="text-caption on-surface-variant font-family-mono">
                {{ Math.round(fuseAlpha * 100) }}%
              </span>
            </div>
            <v-slider
              v-model="fuseAlpha"
              :min="0"
              :max="1"
              :step="0.01"
              color="primary"
              thumb-label
              hide-details
              @update:model-value="commitFuseAlpha"
            />

            <template v-if="background !== 'transparent'">
              <div class="d-flex align-center justify-space-between mt-3 mb-1">
                <span class="text-body-2">背景图片不透明度</span>
                <span class="text-caption on-surface-variant font-family-mono">
                  {{ Math.round(backgroundOpacity * 100) }}%
                </span>
              </div>
              <v-slider
                v-model="backgroundOpacity"
                :min="0"
                :max="1"
                :step="0.01"
                color="primary"
                thumb-label
                hide-details
                @update:model-value="commitBackgroundOpacity"
              />
            </template>

            <div class="d-flex align-center justify-space-between mt-3 mb-1">
              <span class="text-body-2">背景模糊</span>
              <span class="text-caption on-surface-variant font-family-mono">
                {{ fuseBlur }}px
              </span>
            </div>
            <v-slider
              v-model="fuseBlur"
              :min="0"
              :max="60"
              :step="1"
              color="primary"
              thumb-label
              hide-details
              @end="commitFuseBlur"
            />

            <div class="text-caption on-surface-variant mt-2">
              frameless/rounded 下次启动生效；背景/fuse 即时生效。图层: Background(底) →
              Fuse(中) → Data(顶)。Fuse 100% 时完全盖住背景；调低 Fuse 透出背景，图片可见度
              = 背景图片不透明度 × (1 − Fuse 蒙层不透明度)。
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
