<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { McpServerConfig, McpTransport } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-mcp-server-dialog' })

const props = defineProps<{
  modelValue: boolean
  /** null = 新建；非空 = 编辑该服务器（id 不可改） */
  server: McpServerConfig | null
  /** 已存在的服务器 id（新建时用来避开冲突） */
  existingIds: string[]
  /** 窄屏全屏 */
  fullscreen?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', open: boolean): void
  (e: 'save', server: McpServerConfig): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 请求头编辑行：existed = 编辑前就已设置（值不下发，只显示「已设置」） */
interface HeaderRow {
  name: string
  value: string
  existed: boolean
}

interface Draft {
  name: string
  id: string
  transport: McpTransport
  url: string
  enabled: boolean
  timeoutSec: number
}

const draft = ref<Draft>({
  name: '',
  id: '',
  transport: 'streamable-http',
  url: '',
  enabled: true,
  timeoutSec: 60
})
/** 用户手动改过 id 就不再跟随名称自动生成 */
const idTouched = ref(false)
const headerRows = ref<HeaderRow[]>([])
/** 被用户删掉的头名：保存时走 clearHeaders */
const removedNames = ref<string[]>([])
const notice = ref<{ text: string; error: boolean } | null>(null)
const testing = ref(false)
const testResult = ref<{
  ok: boolean
  name?: string
  version?: string
  tools?: { name: string; description: string }[]
  error?: string
} | null>(null)

const isNew = computed(() => props.server === null)

const transports = computed<{ title: string; value: McpTransport }[]>(() => [
  {
    title: t('yaya.settings.plugins.mcp_transport_http', 'Streamable HTTP'),
    value: 'streamable-http'
  },
  { title: t('yaya.settings.plugins.mcp_transport_sse', 'SSE'), value: 'sse' }
])

const urlInvalid = computed(() => {
  const url = draft.value.url.trim()
  if (!url) return false
  return !/^https?:\/\//i.test(url)
})

function reset(): void {
  const s = props.server
  draft.value = s
    ? {
        name: s.name,
        id: s.id,
        transport: s.transport,
        url: s.url,
        enabled: s.enabled,
        timeoutSec: Math.max(1, Math.round((s.timeoutMs ?? 60000) / 1000))
      }
    : { name: '', id: '', transport: 'streamable-http', url: '', enabled: true, timeoutSec: 60 }
  const names = s ? (s.headersSet ?? Object.keys(s.headers ?? {})) : []
  headerRows.value = names.map((name) => ({ name, value: '', existed: true }))
  removedNames.value = []
  idTouched.value = false
  notice.value = null
  testResult.value = null
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  },
  { immediate: true }
)

watch(
  () => draft.value.name,
  (name) => {
    if (!isNew.value || idTouched.value) return
    draft.value.id = slugify(name)
  }
)

/** 名称 → id：只留 [a-z0-9-]，与已有 id 冲突时自动加数字后缀 */
function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'mcp'
  const taken = new Set(props.existingIds.filter((id) => id !== props.server?.id))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

function addHeader(): void {
  headerRows.value.push({ name: '', value: '', existed: false })
}

function removeHeader(index: number): void {
  const row = headerRows.value[index]
  headerRows.value.splice(index, 1)
  if (row.existed && row.name && !removedNames.value.includes(row.name)) {
    removedNames.value.push(row.name)
  }
}

/** 组装保存用的配置：空值 = 保留原值，删除行走 clearHeaders */
function buildServer(): McpServerConfig {
  const headers: Record<string, string> = {}
  for (const row of headerRows.value) {
    const name = row.name.trim()
    if (!name) continue
    headers[name] = row.value
  }
  const timeoutSec = Number(draft.value.timeoutSec)
  const server: McpServerConfig = {
    id: draft.value.id,
    name: draft.value.name.trim(),
    transport: draft.value.transport,
    url: draft.value.url.trim(),
    enabled: draft.value.enabled,
    timeoutMs: Number.isFinite(timeoutSec) ? Math.round(timeoutSec * 1000) : 60000
  }
  if (Object.keys(headers).length > 0) server.headers = headers
  if (removedNames.value.length > 0) server.clearHeaders = [...removedNames.value]
  return server
}

/** 测试连接：带上全部请求头（空值由主进程用已保存的明文补） */
function testPayload(): McpServerConfig {
  const headers: Record<string, string> = {}
  for (const row of headerRows.value) {
    const name = row.name.trim()
    if (name) headers[name] = row.value
  }
  return { ...buildServer(), headers }
}

function validate(): string | null {
  if (!draft.value.name.trim()) return t('yaya.settings.plugins.mcp_need_name', '请输入服务器名称')
  if (!draft.value.id.trim()) return t('yaya.settings.plugins.mcp_need_id', '请输入服务器 ID')
  const url = draft.value.url.trim()
  if (!url) return t('yaya.settings.plugins.mcp_need_url', '请输入服务器地址')
  if (!/^https?:\/\//i.test(url))
    return t('yaya.settings.plugins.mcp_url_invalid', '地址必须以 http:// 或 https:// 开头')
  return null
}

async function runTest(): Promise<void> {
  const invalid = validate()
  if (invalid) {
    notice.value = { text: invalid, error: true }
    return
  }
  testing.value = true
  notice.value = null
  testResult.value = null
  try {
    // 入参来自 ref：先深拷贝成普通对象再走 IPC
    const payload = JSON.parse(JSON.stringify(testPayload())) as McpServerConfig
    const res = (await window.cockpit.command('yaya.mcp-test', { server: payload })) as {
      ok: boolean
      serverInfo?: { name: string; version: string }
      tools?: { name: string; description: string }[]
      error?: string
    }
    testResult.value = {
      ok: res.ok,
      name: res.serverInfo?.name,
      version: res.serverInfo?.version,
      tools: res.tools ?? [],
      error: res.error
    }
  } catch (err) {
    testResult.value = { ok: false, error: String(err) }
  } finally {
    testing.value = false
  }
}

function save(): void {
  const invalid = validate()
  if (invalid) {
    notice.value = { text: invalid, error: true }
    return
  }
  const server = JSON.parse(JSON.stringify(buildServer())) as McpServerConfig
  emit('save', server)
  emit('update:modelValue', false)
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    :fullscreen="fullscreen"
    scrollable
    transition="dialog-bottom-transition"
    @update:model-value="emit('update:modelValue', $event === true)"
  >
    <v-card class="mcp-dialog-card pa-4 rounded-lg">
      <v-card-title class="px-0 pt-0 text-h6 font-weight-bold d-flex align-center ga-2">
        <v-icon icon="mdi-connection" color="primary" />
        <span>
          {{
            isNew
              ? t('yaya.settings.plugins.mcp_dialog_add', '添加 MCP 服务器')
              : t('yaya.settings.plugins.mcp_dialog_edit', '编辑 MCP 服务器')
          }}
        </span>
      </v-card-title>
      <v-card-subtitle class="px-0 text-caption text-medium-emphasis">
        {{
          t('yaya.settings.plugins.mcp_dialog_desc', '连接后该服务器的工具会加入助手，可逐个启停')
        }}
      </v-card-subtitle>

      <div class="dialog-body d-flex flex-column ga-3 mt-4">
        <v-text-field
          v-model="draft.name"
          :label="t('yaya.settings.plugins.mcp_name', '服务器名称')"
          :placeholder="t('yaya.settings.plugins.mcp_name_placeholder', '如 我的工具服务器')"
          variant="outlined"
        />

        <v-text-field
          v-model="draft.id"
          :label="t('yaya.settings.plugins.mcp_id', '服务器 ID')"
          :hint="t('yaya.settings.plugins.mcp_id_hint', '工具名前缀，创建后不能修改')"
          :readonly="!isNew"
          :placeholder="t('yaya.settings.plugins.mcp_id_placeholder', 'my-server')"
          variant="outlined"
          persistent-hint
          @update:model-value="idTouched = true"
        />

        <v-select
          v-model="draft.transport"
          :items="transports"
          :label="t('yaya.settings.plugins.mcp_transport', '传输方式')"
          variant="outlined"
        />

        <v-text-field
          v-model="draft.url"
          :label="t('yaya.settings.plugins.mcp_url', '服务器地址')"
          placeholder="https://example.com/mcp"
          :hint="
            urlInvalid
              ? t('yaya.settings.plugins.mcp_url_invalid', '地址必须以 http:// 或 https:// 开头')
              : t('yaya.settings.plugins.mcp_url_hint', 'MCP 服务的 http / https 地址')
          "
          :error="urlInvalid"
          variant="outlined"
          persistent-hint
        />

        <v-text-field
          v-model.number="draft.timeoutSec"
          :label="t('yaya.settings.plugins.mcp_timeout', '单次调用超时（秒）')"
          type="number"
          min="1"
          max="600"
          step="1"
          variant="outlined"
          class="timeout-field"
        />

        <!-- 请求头：值不下发，已设置的只显示「已设置」占位 -->
        <div class="headers-block d-flex flex-column ga-2">
          <div class="d-flex flex-wrap align-center ga-2">
            <span class="text-body-2 font-weight-medium">
              {{ t('yaya.settings.plugins.mcp_headers', '请求头') }}
            </span>
            <v-spacer />
            <v-btn variant="text" prepend-icon="mdi-plus" @click="addHeader">
              {{ t('yaya.settings.plugins.mcp_header_add', '添加请求头') }}
            </v-btn>
          </div>
          <div v-if="headerRows.length === 0" class="text-caption text-medium-emphasis">
            {{ t('yaya.settings.plugins.mcp_headers_empty', '没有自定义请求头') }}
          </div>
          <div
            v-for="(row, index) in headerRows"
            :key="index"
            class="header-row d-flex flex-wrap align-center ga-2"
          >
            <v-text-field
              v-model="row.name"
              :label="t('yaya.settings.plugins.mcp_header_name', '头名称')"
              placeholder="Authorization"
              variant="outlined"
              hide-details
              class="header-name"
            />
            <v-text-field
              v-model="row.value"
              v-agent-forbidden
              :label="t('yaya.settings.plugins.mcp_header_value', '值')"
              :placeholder="
                row.existed
                  ? t('yaya.settings.plugins.mcp_header_set_placeholder', '已设置（留空不修改）')
                  : ''
              "
              type="password"
              variant="outlined"
              hide-details
              class="header-value"
            />
            <v-btn
              icon="mdi-close"
              size="small"
              :title="t('yaya.settings.plugins.mcp_header_remove', '删除该请求头')"
              :aria-label="t('yaya.settings.plugins.mcp_header_remove', '删除该请求头')"
              @click="removeHeader(index)"
            />
          </div>
        </div>

        <!-- 测试连接 -->
        <div class="d-flex flex-wrap align-center ga-2">
          <v-btn variant="tonal" prepend-icon="mdi-connection" :loading="testing" @click="runTest">
            {{ t('yaya.settings.plugins.mcp_test', '测试连接') }}
          </v-btn>
          <span v-if="testing" class="text-caption text-medium-emphasis">
            {{ t('yaya.settings.plugins.mcp_testing', '正在连接…') }}
          </span>
        </div>

        <v-alert
          v-if="notice"
          :color="notice.error ? 'error' : 'success'"
          variant="tonal"
          class="mt-1"
          density="compact"
        >
          {{ notice.text }}
        </v-alert>
        <v-alert
          v-else-if="testResult && !testResult.ok"
          color="error"
          variant="tonal"
          class="mt-1"
          density="compact"
        >
          {{
            te(
              'yaya.settings.plugins.mcp_test_failed',
              { msg: testResult.error ?? 'unknown' },
              '连接失败：{msg}'
            )
          }}
        </v-alert>
        <v-alert
          v-else-if="testResult && testResult.ok"
          color="success"
          variant="tonal"
          class="mt-1"
          density="compact"
        >
          <div>
            {{
              te(
                'yaya.settings.plugins.mcp_test_ok',
                { name: testResult.name ?? '', version: testResult.version ?? '' },
                '连接成功：{name} {version}'
              )
            }}
          </div>
          <div v-if="testResult.tools && testResult.tools.length > 0" class="text-caption mt-1">
            {{
              te(
                'yaya.settings.plugins.mcp_test_tools',
                { n: String(testResult.tools.length) },
                '发现 {n} 个工具'
              )
            }}：{{ testResult.tools.map((tool) => tool.name).join('、') }}
          </div>
        </v-alert>
      </div>

      <v-card-actions class="px-0 pb-0 pt-4 mt-2">
        <v-spacer />
        <v-btn variant="text" @click="close">
          {{ t('yaya.settings.cancel', '取消') }}
        </v-btn>
        <v-btn color="primary" variant="elevated" prepend-icon="mdi-check" @click="save">
          {{ t('yaya.settings.plugins.mcp_save', '保存') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mcp-dialog-card {
  background: rgba(var(--v-theme-surface), 0.98);
}

.timeout-field {
  max-width: 220px;
}

.header-name {
  flex: 1 1 180px;
  min-width: 0;
}

.header-value {
  flex: 2 1 220px;
  min-width: 0;
}

/* 窄屏（手机 ≤720px）：全屏弹窗，表单区滚动 */
@media (max-width: 720px) {
  .mcp-dialog-card {
    display: flex;
    flex-direction: column;
    max-height: 100%;
  }

  .dialog-body {
    flex-grow: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .timeout-field {
    max-width: 100%;
  }
}
</style>
