<script setup lang="ts">
import { ref, inject, onMounted } from 'vue'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })

const theme = ref('dark')
const confirmBeforeLaunch = ref(false)
const searching = ref('')

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  theme.value = (cfg?.theme as string) ?? 'dark'
  confirmBeforeLaunch.value = !!((cfg?.runtime as Record<string, unknown> | undefined)?.confirmBeforeLaunch)
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

async function setConfirm(v: boolean | null): Promise<void> {
  const val = !!v
  confirmBeforeLaunch.value = val
  await window.cockpit.setConfig({
    runtime: { ...(config.value.runtime as Record<string, unknown> | undefined), confirmBeforeLaunch: val }
  })
}

async function addRoot(): Promise<void> {
  if (!searching.value.trim()) return
  const list = (await window.cockpit.addRoot(searching.value.trim())) as { path: string; watch: boolean }[]
  roots.value = list
  searching.value = ''
}

async function removeRoot(p: string): Promise<void> {
  const list = (await window.cockpit.removeRoot(p)) as { path: string; watch: boolean }[]
  roots.value = list
}
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-4">设置</div>

    <v-row dense>
      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="text-subtitle-2">外观</v-card-title>
          <v-card-text>
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
                <v-chip size="small" variant="outlined" closable class="mr-2 mb-1" @click:close="removeRoot(r.path)">
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
