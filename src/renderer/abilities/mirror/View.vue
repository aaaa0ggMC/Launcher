<script setup lang="ts">
import { ref, shallowRef, computed, onMounted } from 'vue'
import type { MirrorInfo, MirrorEntry } from '@shared/types'

interface MirrorTestItem {
  name: string
  url: string
  ok: boolean
  latency?: number
  speed?: number
  error?: string
}

const info = shallowRef<MirrorInfo | null>(null)
const error = ref('')
const toggling = ref<string | null>(null)
const testing = ref(false)
const testResults = shallowRef<Record<string, MirrorTestItem>>({})

async function load(): Promise<void> {
  info.value = await window.cockpit.getMirror()
  error.value = info.value?.lastError ?? ''
}

async function toggle(m: MirrorEntry, enabled: boolean): Promise<void> {
  toggling.value = m.name
  try {
    const res = (await window.cockpit.command('mirror.toggle', {
      name: m.name,
      enable: enabled
    })) as MirrorInfo
    info.value = res
    error.value = res.lastError ?? ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    toggling.value = null
  }
}

async function runTest(): Promise<void> {
  testing.value = true
  try {
    const results = (await window.cockpit.command('mirror.test')) as MirrorTestItem[]
    const map: Record<string, MirrorTestItem> = {}
    for (const r of results) map[r.name] = r
    testResults.value = map
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    testing.value = false
  }
}

function fmtSpeed(bytesPerSec: number | undefined): string {
  if (!bytesPerSec) return '—'
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${Math.round(bytesPerSec)} B/s`
}

function latencyColor(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 300) return 'success'
  if (ms < 800) return 'warning'
  return 'error'
}

const enabledCount = computed(() => info.value?.mirrors.filter((m) => m.enabled).length ?? 0)

const sortedMirrors = computed(() => {
  const list = [...(info.value?.mirrors ?? [])]
  return list.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const ra = testResults.value[a.name]
    const rb = testResults.value[b.name]
    if (!ra && !rb) return 0
    if (!ra) return 1
    if (!rb) return -1
    if (!ra.ok) return 1
    if (!rb.ok) return -1
    return (ra.latency ?? 9999) - (rb.latency ?? 9999)
  })
})

onMounted(load)

/** Custom markdown export — marks each mirror's enabled state explicitly
 * (the generic DOM extractor can't tell an on/off switch apart). */
function toMarkdown(): string {
  const lines: string[] = []
  lines.push('## 软件源')
  lines.push(`已启用 ${enabledCount.value} / ${info.value?.mirrors.length ?? 0} 个`)
  lines.push('')
  for (const m of sortedMirrors.value) {
    lines.push(`- **${m.name}** — ${m.enabled ? '✅ 启用' : '⛔ 未启用'}`)
    lines.push(`  - URL: \`${m.url}\``)
    const t = testResults.value[m.name]
    if (t) {
      if (t.ok) lines.push(`  - 测速: ${t.latency}ms · ${fmtSpeed(t.speed)}`)
      else if (t.error) lines.push(`  - 测速: 失败 — ${t.error}`)
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-1">
      <div>
        <div class="text-h6 font-weight-medium">软件源</div>
        <div class="text-caption on-surface-variant mt-1">
          Arch Linux 镜像源 · 已启用 {{ enabledCount }} 个
        </div>
      </div>
      <v-btn variant="tonal" prepend-icon="mdi-speedometer" :loading="testing" @click="runTest">
        测速
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-3 mt-3" density="compact">
      {{ error }}
    </v-alert>

    <v-row dense class="mt-2">
      <v-col v-for="m in sortedMirrors" :key="m.name" cols="12" sm="6" md="4">
        <v-card
          rounded="lg"
          variant="tonal"
          class="card-fill"
          :class="m.enabled ? 'mirror-enabled' : ''"
        >
          <v-card-text>
            <div class="d-flex align-center ga-2">
              <v-icon :color="m.enabled ? 'success' : 'on-surface-variant'">
                {{ m.enabled ? 'mdi-check-circle' : 'mdi-earth-off' }}
              </v-icon>
              <span class="text-body-1 font-weight-medium">{{ m.name }}</span>
              <v-spacer v-if="testResults[m.name]" />
              <template v-if="testResults[m.name]">
                <v-chip
                  v-if="testResults[m.name].ok"
                  size="x-small"
                  :color="latencyColor(testResults[m.name].latency)"
                  variant="tonal"
                >
                  {{ testResults[m.name].latency }}ms
                </v-chip>
                <v-chip v-else size="x-small" color="error" variant="tonal">超时</v-chip>
              </template>
            </div>
            <div class="text-caption on-surface-variant mt-2 text-truncate">{{ m.url }}</div>
            <div v-if="testResults[m.name]?.ok" class="text-caption on-surface-variant mt-1">
              <v-icon size="12" class="mr-1">mdi-download</v-icon>
              {{ fmtSpeed(testResults[m.name].speed) }}
            </div>
            <div
              v-else-if="testResults[m.name]?.error"
              class="text-caption text-error mt-1 text-truncate"
              :title="testResults[m.name].error"
            >
              {{ testResults[m.name].error }}
            </div>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0">
            <v-switch
              :model-value="m.enabled"
              color="success"
              density="compact"
              hide-details
              :loading="toggling === m.name"
              :label="m.enabled ? '已启用' : '已禁用'"
              @update:model-value="(v: boolean | null) => toggle(m, !!v)"
            />
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.mirror-enabled {
  border: 1px solid rgba(var(--v-theme-success), 0.4);
}
</style>
