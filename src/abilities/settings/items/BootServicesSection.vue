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
  /** 最近一次任务以 error 结束且当前没有在跑（自动拉起失败，要显式露出） */
  failed: boolean
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
      const state = s.enabled ? tr('bootServices.on', '已开启') : tr('bootServices.off', '已关闭')
      const badge = s.failed ? `（${tr('bootServices.failed', '启动失败')}）` : ''
      lines.push(`- **${labelOf(s)}** — ${state}${badge}`)
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

      <!-- 行 = 文本组 + 状态/开关组：flex-wrap 分组兜底（DESIGN §4.2），窄屏换到下一行不挤压；
           行本身不带底色——卡片与页面是半透明玻璃，这里不引入不透明色块 -->
      <div
        v-if="services.length"
        class="boot-rows"
        role="list"
        :aria-label="tr('bootServices.title', '开机服务')"
      >
        <div v-for="s in services" :key="s.id" class="boot-row" role="listitem">
          <div class="boot-text min-w-0">
            <div class="boot-title text-body-2 font-weight-medium">{{ labelOf(s) }}</div>
            <div v-if="descOf(s)" class="boot-desc text-caption text-medium-emphasis">
              {{ descOf(s) }}
            </div>
          </div>
          <div class="boot-side">
            <v-chip v-if="s.running" size="small" variant="tonal" color="success" class="boot-chip">
              {{ tr('bootServices.running', '运行中') }}
            </v-chip>
            <v-chip
              v-else-if="s.failed"
              size="small"
              color="error"
              variant="tonal"
              class="boot-chip"
              :title="
                tr(
                  'bootServices.failed_hint',
                  '任务启动后以错误结束——打开后台任务面板查看日志；常见原因：对应能力还没完成初始化配置（如 设备发现 未填设备名）'
                )
              "
            >
              {{ tr('bootServices.failed', '启动失败') }}
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
        </div>
      </div>

      <!-- 空状态统一走 v-empty-state（DESIGN §7） -->
      <v-empty-state
        v-else-if="!loading"
        icon="mdi-power-plug-off"
        :title="tr('bootServices.empty', '暂无开机服务')"
        :text="
          tr(
            'bootServices.empty_text',
            '还没有能力登记开机自启服务；登记后会列在这里，逐个开关即可。'
          )
        "
      />

      <p v-if="services.length" class="text-caption text-medium-emphasis">
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
.boot-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.boot-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
/* 文本组占主导，窄屏先换行；标题单行省略，描述正常换行（不按字符断词） */
.boot-text {
  flex: 1 1 220px;
  min-width: 0;
}
.boot-title {
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.boot-desc {
  line-height: 1.5;
  overflow-wrap: break-word;
}
/* 状态/开关组靠右；chip 默认密度 + 显式内边距，避免 label 贴边（DESIGN §4.3） */
.boot-side {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-inline-start: auto;
}
.boot-chip {
  padding-block: 4px;
  min-height: 24px;
}

@media (max-width: 720px) {
  /* 窄屏：文本占满一行，chips + 开关换到下一行，不与标题抢宽度 */
  .boot-text {
    flex: 1 1 100%;
  }
  .boot-title {
    white-space: normal;
  }
  .boot-side {
    margin-inline-start: 0;
  }
}
</style>
