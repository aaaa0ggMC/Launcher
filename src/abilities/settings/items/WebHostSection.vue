<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-web-host' })

import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

interface WebHostStatus {
  mode: 'electron' | 'headless'
  running: boolean
  enabled: boolean
  host: string
  port: number
  url: string | null
  webBuilt: boolean
  clients: number
  error?: string
}

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const tr = (key: string, fallback: string): string => translate(uiLang.value, key, fallback)

const status = ref<WebHostStatus | null>(null)
const enabled = ref(false)
const lan = ref(false)
const port = ref('47810')
const busy = ref(false)
const copied = ref(false)

const web = computed(() => (config.value.web ?? {}) as Record<string, unknown>)
const headless = computed(() => status.value?.mode === 'headless')
const portValid = computed(() => {
  const n = Number(port.value)
  return Number.isInteger(n) && n >= 1024 && n <= 65535
})

async function refresh(): Promise<void> {
  try {
    status.value = (await window.cockpit.command('web.status')) as WebHostStatus
  } catch {
    status.value = null
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const w = (cfg?.web ?? {}) as Record<string, unknown>
  enabled.value = w.enabled === true
  lan.value = w.host === '0.0.0.0'
  port.value = String(w.port ?? 47810)
  await refresh()
  // 在线标签页数 / 启动结果
  timer = setInterval(refresh, 4000)
})
onBeforeUnmount(() => timer && clearInterval(timer))

async function save(): Promise<void> {
  if (!portValid.value) return
  busy.value = true
  try {
    await window.cockpit.setConfig({
      web: {
        ...web.value,
        enabled: enabled.value,
        host: lan.value ? '0.0.0.0' : '127.0.0.1',
        port: Number(port.value)
      }
    })
    // config.set 触发主进程重启服务；稍等再取状态
    await new Promise((r) => setTimeout(r, 400))
    await refresh()
  } finally {
    busy.value = false
  }
}

async function toggle(v: boolean | null): Promise<void> {
  enabled.value = !!v
  await save()
}
async function toggleLan(v: boolean | null): Promise<void> {
  lan.value = !!v
  await save()
}

async function copyLink(): Promise<void> {
  const r = (await window.cockpit.command('web.link')) as { ok: boolean; url?: string }
  if (!r.ok || !r.url) return
  await window.cockpit.copyText(r.url)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

defineExpose({
  toMarkdown: (): string =>
    `${tr('web.title', '网页服务')}: ${
      status.value?.running
        ? `${tr('settings.on', '开')} (${status.value.url})`
        : tr('settings.off', '关')
    }`
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ tr('web.title', '网页服务') }}</v-card-title>
    <v-card-text class="d-flex flex-column ga-3">
      <p class="text-body-2 text-medium-emphasis">
        {{
          tr(
            'web.hint',
            '在浏览器 / 手机上打开同一个 Cockpit：和桌面版共用同一个进程，后台任务、播放器、配置都只有一份。'
          )
        }}
      </p>

      <template v-if="headless">
        <div class="text-body-2">
          {{ tr('web.headless_mode', '当前就是无头宿主（网页服务由启动参数决定）：') }}
          <code>{{ status?.url }}</code>
        </div>
      </template>

      <template v-else>
        <v-switch
          :model-value="enabled"
          :label="tr('web.enable', '开启网页服务')"
          color="primary"
          density="compact"
          hide-details
          :disabled="busy"
          @update:model-value="toggle"
        />
        <div v-agent-forbidden class="d-flex flex-column ga-3">
          <v-switch
            :model-value="lan"
            :label="tr('web.lan', '允许局域网访问（0.0.0.0）')"
            color="warning"
            density="compact"
            hide-details
            :disabled="busy"
            @update:model-value="toggleLan"
          />
          <p v-if="lan" class="text-caption text-warning">
            {{
              tr(
                'web.lan_warning',
                '明文 HTTP：同一网络里的人只要拿到带 token 的链接就能完全控制 Cockpit。只在可信网络里开。'
              )
            }}
          </p>
          <div class="d-flex align-center flex-wrap ga-3">
            <v-text-field
              v-model="port"
              :label="tr('web.port', '端口')"
              type="number"
              density="comfortable"
              variant="outlined"
              hide-details="auto"
              :error-messages="portValid ? [] : [tr('web.port_invalid', '1024–65535')]"
              class="port-field"
            />
            <v-btn variant="tonal" :loading="busy" :disabled="!portValid" @click="save">
              {{ tr('web.apply', '应用') }}
            </v-btn>
          </div>
        </div>
      </template>

      <div v-if="status" class="status">
        <span class="dot" :class="{ 'is-on': status.running, 'is-err': !!status.error }" />
        <span v-if="status.running" class="text-body-2">
          {{ tr('web.running', '运行中') }} · <code>{{ status.url }}</code> ·
          {{
            translate(uiLang, 'web.clients', '{n} 个页面在线').replace(
              '{n}',
              String(status.clients)
            )
          }}
        </span>
        <span v-else-if="status.error" class="text-body-2 text-error">{{ status.error }}</span>
        <span v-else class="text-body-2 text-medium-emphasis">{{
          tr('web.stopped', '未运行')
        }}</span>
      </div>
      <p v-if="status && !status.webBuilt && !headless" class="text-caption text-medium-emphasis">
        {{
          tr('web.not_built', '网页资源还没构建：先运行 pnpm build:web（pnpm build 会一并构建）')
        }}
      </p>

      <div v-if="status?.running" v-agent-forbidden>
        <v-btn
          variant="tonal"
          :prepend-icon="copied ? 'mdi-check' : 'mdi-link-variant'"
          @click="copyLink"
        >
          {{ copied ? tr('web.copied', '已复制') : tr('web.copy_link', '复制带 token 的链接') }}
        </v-btn>
        <p class="text-caption text-medium-emphasis mt-2">
          {{ tr('web.token_hint', '链接里的 token 等同于登录凭据，不要发给别人。') }}
        </p>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.port-field {
  max-width: 160px;
  min-width: 120px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: rgba(var(--v-theme-on-surface), 0.3);
}
.dot.is-on {
  background: rgb(var(--v-theme-success));
}
.dot.is-err {
  background: rgb(var(--v-theme-error));
}
code {
  word-break: break-all;
}
</style>
