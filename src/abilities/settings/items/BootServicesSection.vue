<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-boot-services' })

import { inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

/** 与主进程 boot-services.ts 的 BootServiceState 对应 */
interface BootServiceState {
  id: string
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  job: string
  mustComplete: boolean
  enabled: boolean
  running: boolean
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const tr = (key: string, fallback: string): string => translate(uiLang.value, key, fallback)

const services = ref<BootServiceState[]>([])
const loading = ref(false)
const error = ref('')
const busyId = ref<string | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = (await window.cockpit.command('boot.list')) as {
      ok: boolean
      services?: BootServiceState[]
    }
    services.value = r.services ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function toggle(s: BootServiceState, value: boolean | null): Promise<void> {
  const enabled = value === true
  busyId.value = s.id
  try {
    await window.cockpit.command('boot.set', { id: s.id, enabled })
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyId.value = null
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await refresh()
  // 运行态（是否已启动）轮询；开关本身变化不大，4s 足够
  timer = setInterval(refresh, 4000)
})
onBeforeUnmount(() => timer && clearInterval(timer))

function labelOf(s: BootServiceState): string {
  return s.labelKey ? tr(s.labelKey, s.label) : s.label
}
function descOf(s: BootServiceState): string {
  return s.descriptionKey ? tr(s.descriptionKey, s.description ?? '') : (s.description ?? '')
}

defineExpose({
  toMarkdown: (): string => {
    const lines = [`${tr('bootServices.title', '开机服务')}`]
    if (!services.value.length) lines.push(`- ${tr('bootServices.empty', '暂无开机服务')}`)
    for (const s of services.value) {
      lines.push(
        `- **${labelOf(s)}** — ${
          s.enabled ? tr('bootServices.on', '已开启') : tr('bootServices.off', '已关闭')
        }`
      )
    }
    return lines.join('\n')
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ tr('bootServices.title', '开机服务') }}</v-card-title>
    <v-card-text class="d-flex flex-column ga-3">
      <p class="text-body-2 text-medium-emphasis">
        {{
          tr(
            'bootServices.hint',
            '能力可以向 Launcher 登记开机自启服务。开启后，每次启动 Launcher 会自动运行对应的后台任务；开关默认全部关闭，改动在下一次启动时生效。'
          )
        }}
      </p>

      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-1">
        {{ error }}
      </v-alert>

      <v-progress-linear v-if="loading && !services.length" indeterminate color="primary" />

      <v-list
        v-if="services.length"
        lines="three"
        class="pa-0 boot-list"
        aria-label="boot services"
      >
        <v-list-item
          v-for="s in services"
          :key="s.id"
          class="px-0"
          :title="labelOf(s)"
          :subtitle="descOf(s)"
        >
          <template #append>
            <div class="d-flex align-center ga-3 flex-wrap">
              <v-chip
                v-if="s.running"
                size="small"
                variant="tonal"
                color="success"
                class="boot-chip"
              >
                {{ tr('bootServices.running', '运行中') }}
              </v-chip>
              <v-chip v-else size="small" variant="tonal" class="boot-chip">
                {{ tr('bootServices.notRunning', '未运行') }}
              </v-chip>
              <v-chip size="small" variant="outlined" class="boot-chip">
                {{
                  s.mustComplete
                    ? tr('bootServices.mustComplete', '退出前弹窗确认')
                    : tr('bootServices.expendable', '退出时直接结束')
                }}
              </v-chip>
              <v-switch
                :model-value="s.enabled"
                color="primary"
                density="compact"
                hide-details
                :loading="busyId === s.id"
                :aria-label="labelOf(s)"
                @update:model-value="toggle(s, $event)"
              />
            </div>
          </template>
        </v-list-item>
      </v-list>

      <div v-else-if="!loading" class="text-body-2 text-medium-emphasis">
        {{ tr('bootServices.empty', '暂无开机服务') }}
      </div>

      <p class="text-caption text-medium-emphasis">
        {{
          tr(
            'bootServices.footnote',
            '「退出时直接结束」的服务内容被认为不重要：关闭 Launcher 时不弹窗、直接终止；「退出前弹窗确认」的服务会在任务没跑完时先问一声。'
          )
        }}
      </p>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.boot-list :deep(.v-list-item__append) {
  margin-inline-start: 12px;
}
/* chip 默认密度 + 显式内边距，避免 label 贴边（DESIGN.md §4.3） */
.boot-chip {
  padding-block: 4px;
  min-height: 24px;
}
</style>
