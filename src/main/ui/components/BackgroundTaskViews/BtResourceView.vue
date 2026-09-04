<script setup lang="ts">
import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import type { BtTaskInfo, BtNetworkPort } from '@shared/types'
import { translate } from '@ui/i18n'

defineProps<{
  task: BtTaskInfo
}>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const copiedSnack = ref(false)

async function copyCommand(text?: string): Promise<void> {
  if (!text) return
  await window.cockpit.copyText(text)
  copiedSnack.value = true
}

async function openWebUrl(url?: string): Promise<void> {
  if (!url) return
  await window.cockpit.openExternal(url)
}

function fmtMem(mb?: number): string {
  if (mb === undefined || isNaN(mb)) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function fmtUptime(ms?: number): string {
  if (ms === undefined) return '—'
  const sec = Math.floor(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function portTypeColor(type: BtNetworkPort['type']): string {
  switch (type) {
    case 'web':
      return 'primary'
    case 'tcp':
      return 'info'
    case 'udp':
      return 'warning'
    default:
      return 'default'
  }
}

function portTypeIcon(type: BtNetworkPort['type']): string {
  switch (type) {
    case 'web':
      return 'mdi-web'
    case 'tcp':
      return 'mdi-lan-connect'
    case 'udp':
      return 'mdi-access-point-network'
    default:
      return 'mdi-lan'
  }
}

function portTypeLabel(type: BtNetworkPort['type']): string {
  switch (type) {
    case 'web':
      return t('bt.res.webService')
    case 'tcp':
      return t('bt.res.tcpService')
    case 'udp':
      return t('bt.res.udpService')
    default:
      return t('bt.res.unknownService')
  }
}
</script>

<template>
  <div class="bt-resources-root px-4 py-3">
    <div class="d-flex flex-column ga-4 pb-4">
      <!-- CPU & Memory Metrics -->
      <v-card variant="tonal" rounded="lg" class="pa-4">
        <div class="text-subtitle-2 font-weight-bold mb-3 d-flex align-center ga-2">
          <v-icon color="primary">mdi-speedometer</v-icon>
          <span>{{ t('bt.tabResources') }}</span>
        </div>

        <v-row dense class="ga-y-3">
          <!-- CPU -->
          <v-col cols="12" sm="6">
            <div
              class="d-flex flex-column justify-space-between ga-2 pa-3 rounded-lg bt-metric-box"
            >
              <div class="d-flex align-center justify-space-between">
                <span class="text-caption on-surface-variant font-weight-medium">
                  {{ t('bt.res.cpu') }}
                </span>
                <span class="text-body-2 font-weight-bold font-family-mono">
                  {{ task.stats.cpu !== undefined ? `${task.stats.cpu}%` : '—' }}
                </span>
              </div>
              <v-progress-linear
                :model-value="task.stats.cpu ?? 0"
                :color="(task.stats.cpu ?? 0) > 80 ? 'error' : 'primary'"
                height="8"
                rounded
              />
            </div>
          </v-col>

          <!-- Memory -->
          <v-col cols="12" sm="6">
            <div
              class="d-flex flex-column justify-space-between ga-2 pa-3 rounded-lg bt-metric-box"
            >
              <div class="d-flex align-center justify-space-between">
                <span class="text-caption on-surface-variant font-weight-medium">
                  {{ t('bt.res.mem') }}
                </span>
                <span class="text-body-2 font-weight-bold font-family-mono">
                  {{ fmtMem(task.stats.mem) }}
                </span>
              </div>
              <v-progress-linear
                :model-value="Math.min(100, ((task.stats.mem ?? 0) / 4096) * 100)"
                color="secondary"
                height="8"
                rounded
              />
            </div>
          </v-col>
        </v-row>
      </v-card>

      <!-- GPU & VRAM Metrics -->
      <v-card variant="tonal" rounded="lg" class="pa-4">
        <div class="text-subtitle-2 font-weight-bold mb-3 d-flex align-center ga-2">
          <v-icon color="primary">mdi-expansion-card</v-icon>
          <span>{{ t('bt.res.gpu') }}</span>
        </div>

        <template v-if="task.stats.gpuInfo || task.stats.gpu !== undefined">
          <div class="d-flex align-center ga-2 mb-3 flex-wrap">
            <v-chip
              v-if="task.stats.gpuInfo?.name"
              variant="flat"
              color="secondary-container"
              prepend-icon="mdi-expansion-card"
              class="font-weight-medium"
            >
              {{ task.stats.gpuInfo.name }}
            </v-chip>
            <v-chip
              v-if="task.stats.gpuInfo?.temperature !== undefined"
              variant="tonal"
              color="warning"
              prepend-icon="mdi-thermometer"
            >
              {{ task.stats.gpuInfo.temperature }} °C
            </v-chip>
          </div>

          <v-row dense class="ga-y-3">
            <!-- GPU Load -->
            <v-col cols="12" sm="4">
              <div
                class="d-flex flex-column justify-space-between ga-2 pa-3 rounded-lg bt-metric-box"
              >
                <div class="d-flex align-center justify-space-between">
                  <span class="text-caption on-surface-variant font-weight-medium">
                    {{ t('bt.res.gpuLoad') }}
                  </span>
                  <span class="text-body-2 font-weight-bold font-family-mono">
                    {{
                      task.stats.gpuInfo?.utilization !== undefined
                        ? `${task.stats.gpuInfo.utilization}%`
                        : '—'
                    }}
                  </span>
                </div>
                <v-progress-linear
                  :model-value="task.stats.gpuInfo?.utilization ?? 0"
                  color="accent"
                  height="8"
                  rounded
                />
              </div>
            </v-col>

            <!-- Process VRAM -->
            <v-col cols="12" sm="4">
              <div
                class="d-flex flex-column justify-space-between ga-2 pa-3 rounded-lg bt-metric-box"
              >
                <div class="d-flex align-center justify-space-between">
                  <span class="text-caption on-surface-variant font-weight-medium">
                    {{ t('bt.res.gpuProcessMem') }}
                  </span>
                  <span class="text-body-2 font-weight-bold font-family-mono">
                    {{
                      task.stats.gpu !== undefined
                        ? `${task.stats.gpu} MB`
                        : fmtMem(task.stats.gpuInfo?.processMemory)
                    }}
                  </span>
                </div>
                <v-progress-linear
                  :model-value="
                    task.stats.gpuInfo?.totalMemory
                      ? ((task.stats.gpu ?? 0) / task.stats.gpuInfo.totalMemory) * 100
                      : 0
                  "
                  color="primary"
                  height="8"
                  rounded
                />
              </div>
            </v-col>

            <!-- Total System VRAM -->
            <v-col cols="12" sm="4">
              <div
                class="d-flex flex-column justify-space-between ga-2 pa-3 rounded-lg bt-metric-box"
              >
                <div class="d-flex align-center justify-space-between">
                  <span class="text-caption on-surface-variant font-weight-medium">
                    {{ t('bt.res.gpuTotalMem') }}
                  </span>
                  <span class="text-body-2 font-weight-bold font-family-mono">
                    {{
                      task.stats.gpuInfo?.usedMemory !== undefined &&
                      task.stats.gpuInfo?.totalMemory !== undefined
                        ? `${task.stats.gpuInfo.usedMemory} / ${task.stats.gpuInfo.totalMemory} MB`
                        : '—'
                    }}
                  </span>
                </div>
                <v-progress-linear
                  :model-value="
                    task.stats.gpuInfo?.totalMemory
                      ? ((task.stats.gpuInfo.usedMemory ?? 0) / task.stats.gpuInfo.totalMemory) *
                        100
                      : 0
                  "
                  color="secondary"
                  height="8"
                  rounded
                />
              </div>
            </v-col>
          </v-row>
        </template>

        <div v-else class="d-flex align-center ga-2 pa-2 on-surface-variant text-caption">
          <v-icon size="small">mdi-information-outline</v-icon>
          <span>{{ t('bt.res.gpuNone') }}</span>
        </div>
      </v-card>

      <!-- Network Ports & Web Services -->
      <v-card variant="tonal" rounded="lg" class="pa-4">
        <div class="d-flex align-center justify-space-between mb-3">
          <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
            <v-icon color="primary">mdi-lan</v-icon>
            <span>{{ t('bt.res.ports') }}</span>
            <v-chip
              v-if="task.stats.ports?.length"
              variant="tonal"
              color="primary"
              size="small"
              class="ml-1"
            >
              {{ task.stats.ports.length }}
            </v-chip>
          </div>
        </div>

        <div v-if="task.stats.ports && task.stats.ports.length" class="d-flex flex-column ga-2">
          <div
            v-for="p in task.stats.ports"
            :key="`${p.proto}:${p.port}:${p.localAddress}`"
            class="d-flex align-center justify-space-between pa-3 rounded-lg bt-port-row flex-wrap ga-2"
          >
            <div class="d-flex align-center ga-3 flex-wrap">
              <v-chip
                variant="tonal"
                :color="portTypeColor(p.type)"
                :prepend-icon="portTypeIcon(p.type)"
                class="font-weight-medium"
              >
                {{ portTypeLabel(p.type) }}
              </v-chip>

              <div class="d-flex flex-column">
                <div class="d-flex align-center ga-2">
                  <span class="text-body-2 font-weight-bold font-family-mono">
                    {{ p.localAddress }}:{{ p.port }}
                  </span>
                  <span
                    v-if="p.state"
                    class="text-caption on-surface-variant text-uppercase font-weight-medium"
                  >
                    ({{ p.state }})
                  </span>
                </div>
                <span v-if="p.title" class="text-caption on-surface-variant">
                  {{ p.title }}
                </span>
              </div>
            </div>

            <!-- Web Browser Action -->
            <div v-if="p.type === 'web' && p.url" class="d-flex align-center ga-2">
              <v-btn
                variant="tonal"
                color="primary"
                prepend-icon="mdi-open-in-new"
                @click="openWebUrl(p.url)"
              >
                {{ t('bt.res.openWeb') }}
              </v-btn>
            </div>
          </div>
        </div>

        <div v-else class="d-flex align-center ga-2 pa-2 on-surface-variant text-caption">
          <v-icon size="small">mdi-lan-disconnect</v-icon>
          <span>{{ t('bt.res.noPorts') }}</span>
        </div>
      </v-card>

      <!-- Process Details -->
      <v-card variant="tonal" rounded="lg" class="pa-4">
        <div class="text-subtitle-2 font-weight-bold mb-3 d-flex align-center ga-2">
          <v-icon color="primary">mdi-information-outline</v-icon>
          <span>{{ t('bt.res.processInfo') }}</span>
        </div>

        <div class="d-flex flex-column ga-2">
          <div class="d-flex align-center justify-space-between py-1 border-bottom">
            <span class="text-caption on-surface-variant">{{ t('bt.res.pid') }}</span>
            <span class="text-body-2 font-family-mono">{{ task.pid ?? '—' }}</span>
          </div>
          <div
            v-if="task.stats.ppid"
            class="d-flex align-center justify-space-between py-1 border-bottom"
          >
            <span class="text-caption on-surface-variant">{{ t('bt.res.ppid') }}</span>
            <span class="text-body-2 font-family-mono">{{ task.stats.ppid }}</span>
          </div>
          <div class="d-flex align-center justify-space-between py-1 border-bottom">
            <span class="text-caption on-surface-variant">{{ t('bt.res.uptime') }}</span>
            <span class="text-body-2 font-family-mono">
              {{ fmtUptime(task.stats.elapsed) }}
            </span>
          </div>
          <div class="d-flex align-center justify-space-between py-1 border-bottom">
            <span class="text-caption on-surface-variant">{{ t('bt.res.startedAt') }}</span>
            <span class="text-body-2">{{ fmtDate(task.startedAt) }}</span>
          </div>
          <div v-if="task.cwd" class="d-flex flex-column py-1 border-bottom">
            <span class="text-caption on-surface-variant mb-1">{{ t('bt.res.cwd') }}</span>
            <span class="text-body-2 font-family-mono word-break-all">{{ task.cwd }}</span>
          </div>
          <div v-if="task.command" class="d-flex flex-column py-1">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption on-surface-variant">{{ t('bt.res.command') }}</span>
              <v-btn
                size="small"
                variant="text"
                icon
                :title="t('bt.res.copied')"
                @click="copyCommand(task.command)"
              >
                <v-icon size="small">mdi-content-copy</v-icon>
              </v-btn>
            </div>
            <span class="text-body-2 font-family-mono word-break-all pa-2 rounded bt-cmd-box">
              {{ task.command }}
            </span>
          </div>
        </div>
      </v-card>
    </div>

    <!-- Copied snackbar -->
    <v-snackbar v-model="copiedSnack" :timeout="2000" color="success" location="top">
      {{ t('bt.res.copied') }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.bt-resources-root {
  height: 100%;
  overflow-y: auto;
}
.bt-metric-box {
  height: 100%;
  min-height: 64px;
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}
.bt-port-row {
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}
.bt-cmd-box {
  background: rgba(var(--v-theme-surface), 0.45);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
}
.word-break-all {
  word-break: break-all;
}
.border-bottom {
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.08);
}
</style>
