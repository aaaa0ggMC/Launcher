<script setup lang="ts">
defineOptions({ name: 'cockpit-mirror' })

import { ref, shallowRef, computed, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import type { MirrorInfo, MirrorEntry } from './types'
import { translate, translateTemplate } from '@ui/i18n'
import { KitCaption, KitEmpty, KitGrid, KitPage, KitProse, KitSection, KitSwitch } from '@ui/kit'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

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
  lines.push(translate(uiLang.value, 'mirror.mdHeading'))
  lines.push(
    translateTemplate(uiLang.value, 'mirror.mdEnabledCount', {
      n: String(enabledCount.value),
      total: String(info.value?.mirrors.length ?? 0)
    })
  )
  lines.push('')
  for (const m of sortedMirrors.value) {
    lines.push(
      `- **${m.name}** — ${m.enabled ? translate(uiLang.value, 'mirror.mdEnabled') : translate(uiLang.value, 'mirror.mdDisabled')}`
    )
    lines.push(`  - URL: \`${m.url}\``)
    const t = testResults.value[m.name]
    if (t) {
      if (t.ok)
        lines.push(
          translateTemplate(uiLang.value, 'mirror.mdTestOk', {
            latency: String(t.latency),
            speed: fmtSpeed(t.speed)
          })
        )
      else if (t.error)
        lines.push(translateTemplate(uiLang.value, 'mirror.mdTestFail', { error: t.error }))
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <!-- 样板页：KitPage(document) + KitSection + KitSettingRow + 控件层 + KitEmpty。
       这就是「几分钟一个页面」的参考实现——后续 ability 迁移照抄这个结构。 -->
  <KitPage mode="document">
    <KitSection :title="translate(uiLang, 'mirror.heading')" icon="mdi-earth">
      <template #actions>
        <v-btn variant="tonal" prepend-icon="mdi-speedometer" :loading="testing" @click="runTest">
          {{ translate(uiLang, 'mirror.test') }}
        </v-btn>
      </template>

      <KitProse>
        {{ translateTemplate(uiLang, 'mirror.subtitle', { n: String(enabledCount) }) }}
      </KitProse>

      <v-alert v-if="error" type="error" variant="tonal" density="compact">
        {{ error }}
      </v-alert>

      <!-- 空状态走 kit 的 KitEmpty（语义 icon 表：list = 列表类空态） -->
      <KitEmpty
        v-if="info && sortedMirrors.length === 0 && !error"
        kind="list"
        :title="translate(uiLang, 'mirror.empty')"
        :text="translate(uiLang, 'mirror.emptyText')"
      />

      <!-- 镜像卡片网格：等宽栏 + 等高 + 统一栏距（网格令牌） -->
      <KitGrid v-if="sortedMirrors.length" :min-col="260" :gap="12">
        <v-card
          v-for="m in sortedMirrors"
          :key="m.name"
          rounded="lg"
          variant="tonal"
          class="card-fill mirror-card"
          :class="{ 'mirror-card--enabled': m.enabled }"
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
                <v-chip v-else size="x-small" color="error" variant="tonal">{{
                  translate(uiLang, 'mirror.timeout')
                }}</v-chip>
              </template>
            </div>
            <div class="mt-2 text-truncate" :title="m.url">
              <KitCaption>{{ m.url }}</KitCaption>
            </div>
            <KitCaption v-if="testResults[m.name]?.ok" class="mt-1">
              <v-icon size="12" class="mr-1">mdi-download</v-icon>
              {{ fmtSpeed(testResults[m.name].speed) }}
            </KitCaption>
            <div
              v-else-if="testResults[m.name]?.error"
              class="mt-1 text-error text-truncate"
              :title="testResults[m.name].error"
            >
              <KitCaption>{{ testResults[m.name].error }}</KitCaption>
            </div>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0">
            <KitSwitch
              :model-value="m.enabled"
              :loading="toggling === m.name"
              :aria-label="m.name"
              @update:model-value="(v: boolean) => toggle(m, v)"
            />
            <span class="text-body-2 ml-2">
              {{
                m.enabled
                  ? translate(uiLang, 'mirror.enabled')
                  : translate(uiLang, 'mirror.disabled')
              }}
            </span>
          </v-card-actions>
        </v-card>
      </KitGrid>
    </KitSection>
  </KitPage>
</template>
