<script setup lang="ts">
defineOptions({ name: 'cockpit-discoverer-settings' })

import { inject, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { useSettings } from '@ui/composables/settings'

interface DiscovererConfigView {
  deviceName: string
  port: number
  intervalSec: number
  verifyPasswordSet: boolean
  verifiedPeers: string[]
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const settings = useSettings()

const deviceName = ref('')
const port = ref('47820')
const intervalSec = ref('5')
const password = ref('')
const passwordSet = ref(false)
const verifiedPeers = ref<string[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const saved = ref(false)

const portValid =
  /^\d{4,5}$/.test(port.value) && Number(port.value) >= 1024 && Number(port.value) <= 65535

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = (await window.cockpit.command('discoverer.config-get')) as {
      ok: boolean
      config?: DiscovererConfigView
    }
    const cfg = r.config
    if (cfg) {
      deviceName.value = cfg.deviceName
      port.value = String(cfg.port)
      intervalSec.value = String(cfg.intervalSec)
      passwordSet.value = cfg.verifyPasswordSet
      verifiedPeers.value = [...cfg.verifiedPeers]
    }
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  busy.value = true
  saved.value = false
  error.value = ''
  try {
    const patch: Record<string, unknown> = {
      deviceName: deviceName.value.trim(),
      port: Number(port.value),
      intervalSec: Number(intervalSec.value)
    }
    if (password.value) patch.verifyPassword = password.value
    const r = (await window.cockpit.command('discoverer.config-save', patch)) as {
      ok: boolean
      error?: string
      config?: DiscovererConfigView
    }
    if (!r.ok) {
      error.value = r.error ?? t('discoverer.err.saveFailed', '保存失败')
      return
    }
    if (r.config) {
      passwordSet.value = r.config.verifyPasswordSet
      verifiedPeers.value = [...r.config.verifiedPeers]
    }
    password.value = ''
    saved.value = true
    setTimeout(() => (saved.value = false), 1500)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function clearPassword(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await window.cockpit.command('discoverer.config-save', { verifyPassword: '' })
    passwordSet.value = false
    password.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function unverify(name: string): Promise<void> {
  error.value = ''
  try {
    await window.cockpit.command('discoverer.unverify', { name })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)

defineExpose({
  toMarkdown: (): string =>
    `${t('discoverer.settings.title', '设备发现')}: ${deviceName.value || t('discoverer.unnamed', '未命名')}`
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{
      t('discoverer.settings.title', '设备发现')
    }}</v-card-title>
    <v-card-text class="d-flex flex-column ga-3">
      <p class="text-body-2 text-medium-emphasis">
        {{
          t(
            'discoverer.settings.hint',
            '设备名会随广播报文发给局域网里的其他 Launcher（最多 32 个字符）。改端口 / 周期后，正在运行的发现任务要在停止后重新开始才生效。'
          )
        }}
      </p>

      <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>

      <v-text-field
        v-model="deviceName"
        :label="t('discoverer.settings.name', '设备显示名')"
        :placeholder="t('discoverer.settings.namePlaceholder', '例如：书房台式机')"
        variant="outlined"
        density="comfortable"
        hide-details="auto"
        :maxlength="32"
      />

      <div class="d-flex align-center flex-wrap ga-3">
        <v-text-field
          v-model="port"
          :label="t('discoverer.settings.port', 'UDP 端口')"
          type="number"
          variant="outlined"
          density="comfortable"
          hide-details="auto"
          :error-messages="portValid ? [] : [t('discoverer.settings.portInvalid', '1024–65535')]"
          class="num-field"
        />
        <v-text-field
          v-model="intervalSec"
          :label="t('discoverer.settings.interval', '广播周期（秒）')"
          type="number"
          variant="outlined"
          density="comfortable"
          hide-details="auto"
          class="num-field"
        />
      </div>

      <v-divider />

      <div v-agent-forbidden class="d-flex flex-column ga-3">
        <div class="text-subtitle-2">{{ t('discoverer.settings.verify', '验证（蓝 V）') }}</div>
        <p class="text-body-2 text-medium-emphasis">
          {{
            t(
              'discoverer.settings.verifyHint',
              '在想要互相信任的设备上填写相同的共享密码：发现对方后会自动二次推送验证报文，成功后设备名旁出现蓝 V 标记。留空 = 关闭验证。'
            )
          }}
        </p>
        <div class="d-flex align-center flex-wrap ga-3">
          <v-text-field
            v-model="password"
            :label="t('discoverer.settings.password', '共享密码')"
            :placeholder="
              passwordSet
                ? t('discoverer.settings.passwordKeep', '已设置，留空则不修改')
                : t('discoverer.settings.passwordEmpty', '未设置')
            "
            type="password"
            variant="outlined"
            density="comfortable"
            hide-details="auto"
            autocomplete="new-password"
            class="password-field"
          />
          <v-btn
            v-if="passwordSet"
            variant="text"
            color="error"
            :loading="busy"
            @click="clearPassword"
          >
            {{ t('discoverer.settings.passwordClear', '清除') }}
          </v-btn>
        </div>
      </div>

      <div v-if="verifiedPeers.length" class="d-flex flex-column ga-2">
        <div class="text-subtitle-2">{{ t('discoverer.settings.verified', '已验证设备') }}</div>
        <div class="d-flex flex-wrap ga-2">
          <v-chip
            v-for="name in verifiedPeers"
            :key="name"
            variant="tonal"
            color="primary"
            class="dchip"
            closable
            @click:close="unverify(name)"
          >
            <v-icon start size="16">mdi-check-decagram</v-icon>
            {{ name }}
          </v-chip>
        </div>
      </div>

      <div class="d-flex align-center ga-3 flex-wrap">
        <v-btn variant="tonal" color="primary" :loading="busy" :disabled="!portValid" @click="save">
          {{
            saved ? t('discoverer.settings.saved', '已保存') : t('discoverer.settings.save', '保存')
          }}
        </v-btn>
        <v-btn
          variant="text"
          prepend-icon="mdi-power-cycle"
          @click="settings.open({ ability: 'settings', category: 'boot' })"
        >
          {{ t('discoverer.settings.gotoBoot', '去设置开机自启') }}
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.num-field {
  max-width: 180px;
  min-width: 140px;
}
.password-field {
  max-width: 280px;
  min-width: 200px;
}
/* chip 默认密度 + 显式内边距，避免 label 贴边（DESIGN.md §4.3） */
.dchip {
  padding-block: 4px;
  min-height: 24px;
}
</style>
