<script setup lang="ts">
/**
 * 安卓 App（android/）的设置：只在 App 里出现（settings/index.ts 的 `visible`）。
 * 设置存在 App 自己那里（SharedPreferences），经 `window.cockpit.client.call` 读写，不进宿主配置——
 * 同一个宿主可能同时被浏览器和 App 打开，这些选项只属于这台手机上的 App。
 */
defineOptions({ name: 'cockpit-settings-android-client' })

import { computed, inject, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import { iconToDataUrl } from './shortcut-icon'

interface ClientInfo {
  version: string
  sdk: number
  device: string
  url: string
  keepAlive: boolean
  /** 启动器支持固定快捷方式（0.6.0+ 才有这个字段） */
  pinShortcuts?: boolean
}

interface AbilityItem {
  id: string
  name: string
  icon: string | null
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

/* ---- 添加到桌面：某个能力页的快捷方式（点了直接打开 App 并跳到这一页） ---- */
const abilitiesCtx = inject<{ list: Ref<AbilityItem[]> } | null>('cockpit:abilities', null)
const pageOptions = computed(() =>
  (abilitiesCtx?.list.value ?? []).map((a) => ({ value: a.id, title: a.name, icon: a.icon }))
)
const pinAbility = ref<string | null>(null)
const pinLabel = ref('')
const pinMsg = ref('')
const pinBusy = ref(false)
const iconEl = ref<HTMLElement | null>(null)
const pinIcon = computed(() => pageOptions.value.find((o) => o.value === pinAbility.value)?.icon)
watch(pinAbility, (id) => {
  pinLabel.value = pageOptions.value.find((o) => o.value === id)?.title ?? ''
  pinMsg.value = ''
})

async function pinPage(): Promise<void> {
  const client = window.cockpit.client
  if (!client || !pinAbility.value) return
  pinBusy.value = true
  pinMsg.value = ''
  try {
    const icon = iconEl.value ? await iconToDataUrl(iconEl.value) : null
    await client.call('shortcut.pin', {
      ability: pinAbility.value,
      label: pinLabel.value.trim() || pinAbility.value,
      ...(icon ? { icon } : {})
    })
    pinMsg.value = tr(
      'android.pin_sent',
      '已发送到桌面：按系统弹窗确认即可（已存在同名快捷方式时直接更新）'
    )
  } catch (e) {
    pinMsg.value = String((e as Error).message ?? e)
  } finally {
    pinBusy.value = false
  }
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

      <template v-if="info?.pinShortcuts">
        <div class="text-subtitle-2 pt-1">{{ tr('android.pin_title', '添加到桌面') }}</div>
        <p class="text-caption text-medium-emphasis">
          {{ tr('android.pin_hint', '把某个页面放到手机桌面，点它直接打开 App 并跳到这一页。') }}
        </p>
        <div class="d-flex flex-wrap align-center ga-2">
          <div ref="iconEl" class="pin-icon" aria-hidden="true">
            <AbilityIcon v-if="pinAbility" :icon="pinIcon" :size="32" />
          </div>
          <v-select
            v-model="pinAbility"
            :items="pageOptions"
            :label="tr('android.pin_page', '页面')"
            variant="outlined"
            density="compact"
            hide-details
            class="pin-field"
          />
          <v-text-field
            v-model="pinLabel"
            :label="tr('android.pin_label', '名字')"
            variant="outlined"
            density="compact"
            hide-details
            class="pin-field"
            :disabled="!pinAbility"
          />
          <v-btn
            variant="tonal"
            color="primary"
            prepend-icon="mdi-cellphone-arrow-down"
            :disabled="!pinAbility"
            :loading="pinBusy"
            @click="pinPage"
          >
            {{ tr('android.pin_button', '添加') }}
          </v-btn>
        </div>
        <p v-if="pinMsg" class="text-caption">{{ pinMsg }}</p>
      </template>

      <div class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-swap-horizontal" @click="switchHost">
          {{ tr('android.switch_host', '切换宿主') }}
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.pin-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: rgb(var(--v-theme-primary));
}
.pin-field {
  flex: 1 1 160px;
  min-width: 0;
}
.info-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 16px;
  align-items: baseline;
}
</style>
