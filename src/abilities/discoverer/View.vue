<script setup lang="ts">
defineOptions({ name: 'cockpit-discoverer' })

import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { DiscovererPeer, DiscovererSelf } from './types'
import type { FlavorCode, PlatformCode } from './packet'
import { translate, translateTemplate } from '@ui/i18n'
import LoadingBar from '@ui/components/LoadingBar.vue'
import { useSettings } from '@ui/composables/settings'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const settings = useSettings()

/** 后台任务面板里这个作业的显示名（与 discoverer.start / boot-services 一致） */
const SCAN_TASK_NAME = '设备发现'
const POLL_MS = 1000

const self = shallowRef<DiscovererSelf | null>(null)
const peers = shallowRef<DiscovererPeer[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref(false)
/** 触发过的命令错误（一次性提示） */
const actionError = ref('')

const verifiedCount = computed(() => peers.value.filter((p) => p.verified).length)

async function refresh(): Promise<void> {
  try {
    const [selfRes, peersRes] = await Promise.all([
      window.cockpit.command('discoverer.self'),
      window.cockpit.command('discoverer.peers')
    ])
    self.value = (selfRes as { self: DiscovererSelf }).self
    peers.value = (peersRes as { peers: DiscovererPeer[] }).peers
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function announce(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    const r = (await window.cockpit.command('discoverer.announce')) as {
      ok: boolean
      error?: string
    }
    if (!r.ok) actionError.value = r.error ?? t('discoverer.err.sendFailed', '广播发送失败')
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function startScan(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    const r = (await window.cockpit.command('discoverer.start')) as { ok: boolean; error?: string }
    if (!r.ok) actionError.value = r.error ?? t('discoverer.err.startFailed', '启动失败')
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    await refresh()
  }
}

/** 停止 = 在后台任务面板里停掉对应任务（用 btList 反查，刷新页面也不丢）。 */
async function stopScan(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    const list = (await window.cockpit.btList()) as {
      id: string
      name: string
      status: string
    }[]
    const task = list.find((x) => x.name === SCAN_TASK_NAME && x.status === 'running')
    if (task) await window.cockpit.btStop(task.id)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    await refresh()
  }
}

async function verify(name: string): Promise<void> {
  actionError.value = ''
  try {
    const r = (await window.cockpit.command('discoverer.verify', { name })) as {
      ok: boolean
      error?: string
    }
    if (!r.ok) actionError.value = r.error ?? ''
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

async function unverify(name: string): Promise<void> {
  actionError.value = ''
  try {
    await window.cockpit.command('discoverer.unverify', { name })
    await refresh()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  loading.value = true
  await refresh()
  loading.value = false
  timer = setInterval(() => void refresh(), POLL_MS)
})
onBeforeUnmount(() => timer && clearInterval(timer))

/* ------------------------------ 展示辅助 ------------------------------ */

const PLATFORM_ICON: Record<PlatformCode, string> = {
  0: 'mdi-help-network-outline',
  1: 'mdi-linux',
  2: 'mdi-apple',
  3: 'mdi-microsoft-windows',
  4: 'mdi-android'
}

const FLAVOR_KEY: Record<FlavorCode, string> = {
  0: 'discoverer.flavor.unknown',
  1: 'discoverer.flavor.kde',
  2: 'discoverer.flavor.gnome',
  3: 'discoverer.flavor.xfce',
  4: 'discoverer.flavor.desktop',
  5: 'discoverer.flavor.tty',
  6: 'discoverer.flavor.termux',
  7: 'discoverer.flavor.windows',
  8: 'discoverer.flavor.macos'
}

function platformIcon(code: PlatformCode): string {
  return PLATFORM_ICON[code] ?? PLATFORM_ICON[0]
}
function flavorLabel(code: FlavorCode): string {
  return t(FLAVOR_KEY[code] ?? FLAVOR_KEY[0])
}

/** 相对时间（轮询驱动，每秒重算） */
function ago(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 5) return t('discoverer.justNow', '刚刚')
  if (sec < 60)
    return translateTemplate(uiLang.value, 'discoverer.secondsAgo', { n: String(sec) }, '{n} 秒前')
  const min = Math.round(sec / 60)
  return translateTemplate(uiLang.value, 'discoverer.minutesAgo', { n: String(min) }, '{n} 分钟前')
}

function ipv4Text(p: DiscovererPeer): string {
  return p.ipv4 || t('discoverer.unknownIp', '未知')
}

/** 侧栏「复制当前页面为 Markdown」 */
function toMarkdown(): string {
  const lines: string[] = [`## ${t('discoverer.heading', '设备发现')}`]
  if (self.value) {
    lines.push(`- **${t('discoverer.me', '我的设备')}** · ${self.value.name}`)
    lines.push(`  - IPv4: \`${self.value.ipv4 || t('discoverer.unknownIp', '未知')}\``)
    lines.push(`  - IPv6: \`${self.value.ipv6 || t('discoverer.none', '无')}\``)
  }
  if (!peers.value.length) {
    lines.push(`- ${t('discoverer.empty', '还没有发现设备')}`)
    return lines.join('\n')
  }
  for (const p of peers.value) {
    lines.push(
      `- **${p.name}**${p.verified ? ` ${t('discoverer.verified', '已验证')}` : ''} · ${flavorLabel(p.flavor)}`
    )
    lines.push(`  - IPv4: \`${ipv4Text(p)}\` · IPv6: \`${p.ipv6 || t('discoverer.none', '无')}\``)
  }
  return lines.join('\n')
}
defineExpose({ toMarkdown })
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-1">
      <div>
        <div class="text-h6 font-weight-medium">{{ t('discoverer.heading', '设备发现') }}</div>
        <div class="text-caption on-surface-variant mt-1">
          {{ t('discoverer.subtitle', '局域网内的 Launcher 通过 UDP 广播互相发现') }}
        </div>
      </div>
      <div class="d-flex align-center ga-2 flex-wrap">
        <v-btn variant="tonal" prepend-icon="mdi-broadcast" :loading="busy" @click="announce">
          {{ t('discoverer.announce', '发送一次') }}
        </v-btn>
        <v-btn
          v-if="!self?.running"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-play"
          :loading="busy"
          @click="startScan"
        >
          {{ t('discoverer.start', '开始发现') }}
        </v-btn>
        <v-btn
          v-else
          variant="tonal"
          color="error"
          prepend-icon="mdi-stop"
          :loading="busy"
          @click="stopScan"
        >
          {{ t('discoverer.stop', '停止发现') }}
        </v-btn>
        <v-btn
          variant="text"
          icon="mdi-cog-outline"
          size="small"
          :aria-label="t('discoverer.openSettings', '打开设备发现设置')"
          @click="settings.open('discoverer')"
        />
      </div>
    </div>

    <LoadingBar :loading="loading" :error="error" skeleton />

    <v-alert v-if="actionError" type="warning" variant="tonal" density="compact" class="mb-3">
      {{ actionError }}
    </v-alert>

    <!-- 我的设备 -->
    <v-card v-if="self" rounded="lg" variant="tonal" class="mb-4">
      <v-card-text class="d-flex align-center flex-wrap ga-4">
        <v-icon :color="self.running ? 'success' : 'on-surface-variant'" size="36">
          {{ platformIcon(self.platform) }}
        </v-icon>
        <div class="min-width-0">
          <div class="d-flex align-center ga-2 flex-wrap">
            <span class="text-body-1 font-weight-medium">{{ self.name }}</span>
            <v-chip size="small" variant="tonal" class="dchip">
              {{ t('discoverer.me', '我的设备') }}
            </v-chip>
            <v-chip
              size="small"
              variant="tonal"
              :color="self.running ? 'success' : ''"
              class="dchip"
            >
              {{
                self.running
                  ? t('discoverer.running', '广播中')
                  : t('discoverer.notRunning', '未运行')
              }}
            </v-chip>
          </div>
          <div class="text-caption on-surface-variant mt-1">
            {{ flavorLabel(self.flavor) }} · UDP {{ self.port }}
          </div>
        </div>
        <v-spacer />
        <div class="d-flex flex-column align-end ga-1">
          <div class="d-flex align-center ga-2">
            <span class="text-caption on-surface-variant">IPv4</span>
            <code class="text-body-2">{{ self.ipv4 || t('discoverer.unknownIp', '未知') }}</code>
          </div>
          <div class="d-flex align-center ga-2">
            <span class="text-caption on-surface-variant">IPv6</span>
            <code class="text-body-2">{{ self.ipv6 || t('discoverer.none', '无') }}</code>
          </div>
        </div>
      </v-card-text>
    </v-card>

    <!-- 已发现设备 -->
    <div class="d-flex align-center ga-2 mb-3">
      <span class="text-subtitle-2">{{ t('discoverer.peers', '已发现设备') }}</span>
      <v-chip size="small" variant="tonal" class="dchip">{{ peers.length }}</v-chip>
      <v-chip v-if="verifiedCount" size="small" variant="tonal" color="primary" class="dchip">
        <v-icon start size="16">mdi-check-decagram</v-icon>
        {{ verifiedCount }}
      </v-chip>
    </div>

    <v-row v-if="peers.length" dense>
      <v-col v-for="p in peers" :key="p.name" cols="12" sm="6" lg="4">
        <v-card
          rounded="lg"
          variant="tonal"
          :class="Date.now() - p.lastSeen > 10000 ? 'opacity-70' : ''"
        >
          <v-card-text class="d-flex flex-column ga-3">
            <div class="d-flex align-center ga-3">
              <v-icon size="28">{{ platformIcon(p.platform) }}</v-icon>
              <div class="flex-grow-1 min-width-0">
                <div class="d-flex align-center ga-2">
                  <span class="text-body-1 font-weight-medium text-truncate">{{ p.name }}</span>
                  <v-icon
                    v-if="p.verified"
                    color="primary"
                    size="20"
                    :title="t('discoverer.verified', '已验证')"
                  >
                    mdi-check-decagram
                  </v-icon>
                </div>
                <div class="text-caption on-surface-variant text-truncate mt-1">
                  {{ flavorLabel(p.flavor) }} · {{ t('discoverer.lastSeen', '最后见到') }}
                  {{ ago(p.lastSeen) }}
                </div>
              </div>
            </div>
            <div class="d-flex flex-column ga-1">
              <div class="d-flex align-center ga-2">
                <span class="text-caption on-surface-variant ip-label">IPv4</span>
                <code class="text-body-2">{{ ipv4Text(p) }}</code>
              </div>
              <div class="d-flex align-center ga-2">
                <span class="text-caption on-surface-variant ip-label">IPv6</span>
                <code class="text-body-2">{{ p.ipv6 || t('discoverer.none', '无') }}</code>
              </div>
            </div>
            <div class="d-flex align-center ga-2 flex-wrap">
              <v-btn
                v-if="!p.verified && self?.verifySet"
                variant="tonal"
                prepend-icon="mdi-shield-check"
                @click="verify(p.name)"
              >
                {{ t('discoverer.verify', '验证') }}
              </v-btn>
              <v-btn
                v-if="p.verified"
                variant="text"
                prepend-icon="mdi-shield-off"
                @click="unverify(p.name)"
              >
                {{ t('discoverer.unverify', '取消验证') }}
              </v-btn>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-empty-state
      v-if="!loading && !peers.length"
      icon="mdi-lan-connect"
      :title="t('discoverer.empty', '还没有发现设备')"
      :text="
        t(
          'discoverer.emptyText',
          '启动发现后，同一局域网里开着设备发现的其他 Launcher 会出现在这里。'
        )
      "
      class="mt-6"
    />
  </div>
</template>

<style scoped>
.opacity-70 {
  opacity: 0.7;
}
.min-width-0 {
  min-width: 0;
}
/* chip 默认密度 + 显式内边距，避免 label 贴边（DESIGN.md §4.3） */
.dchip {
  padding-block: 4px;
  min-height: 24px;
}
.ip-label {
  min-width: 34px;
}
code {
  word-break: break-all;
}
</style>
