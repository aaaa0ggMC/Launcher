<script setup lang="ts">
/**
 * 安卓 App（android/）的设置：只在 App 里出现（settings/index.ts 的 `visible`）。
 * 设置存在 App 自己那里（SharedPreferences），经 `window.cockpit.client.call` 读写，不进宿主配置——
 * 同一个宿主可能同时被浏览器和 App 打开，这些选项只属于这台手机上的 App。
 */
defineOptions({ name: 'cockpit-settings-android-client' })

import { inject, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

interface ClientInfo {
  version: string
  sdk: number
  device: string
  url: string
  keepAlive: boolean
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const tr = (key: string, fallback: string): string => translate(uiLang.value, key, fallback)

const info = ref<ClientInfo | null>(null)
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    info.value = (await window.cockpit.client?.call<ClientInfo>('info')) ?? null
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  }
})

async function setKeepAlive(on: boolean | null): Promise<void> {
  const client = window.cockpit.client
  if (!client || !info.value) return
  busy.value = true
  try {
    const r = await client.call<{ keepAlive: boolean }>('settings.set', { keepAlive: on === true })
    info.value = { ...info.value, keepAlive: r.keepAlive }
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  } finally {
    busy.value = false
  }
}

function switchHost(): void {
  void window.cockpit.client?.call('openConnect')
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ tr('android.title', 'Android 客户端') }}</v-card-title>
    <v-card-text class="d-flex flex-column ga-3">
      <p class="text-body-2 text-medium-emphasis">
        {{
          tr('android.hint', '这些选项只保存在这台手机的 App 里，不影响同一个宿主上的浏览器页面。')
        }}
      </p>

      <div v-if="info" class="info-grid text-body-2">
        <span class="text-medium-emphasis">{{ tr('android.version', '版本') }}</span>
        <span>{{ info.version }}</span>
        <span class="text-medium-emphasis">{{ tr('android.device', '设备') }}</span>
        <span>{{ info.device }} · Android API {{ info.sdk }}</span>
        <span class="text-medium-emphasis">{{ tr('android.host', '宿主') }}</span>
        <code class="text-truncate">{{ info.url }}</code>
      </div>

      <v-switch
        v-if="info"
        :model-value="info.keepAlive"
        :label="tr('android.keep_alive', '后台保持运行（常驻通知，切到后台时播放器与连接不断）')"
        color="primary"
        density="compact"
        hide-details
        :disabled="busy"
        @update:model-value="setKeepAlive"
      />

      <p v-if="error" class="text-caption text-error">{{ error }}</p>

      <div class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-swap-horizontal" @click="switchHost">
          {{ tr('android.switch_host', '切换宿主') }}
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.info-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 16px;
  align-items: baseline;
}
</style>
