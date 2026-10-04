<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { PluginInfo } from '../../services/plugins/types'
import type { McpServerConfig, YayaConfig } from '../../types'
import McpServerDialog from './McpServerDialog.vue'
import { setPluginEnabled } from './plugin-state'
import { YAYA_SAVE_API_KEY, type YayaSettingsSaveApi } from './shared'

defineOptions({ name: 'cockpit-yaya-settings-mcp-servers' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  config: YayaConfig
  plugins: PluginInfo[]
  loading: boolean
  /** 外壳转来的「打开编辑器」请求：'new' 或服务器 id */
  pendingEdit: string | null
}>()

const emit = defineEmits<{
  (e: 'selectPlugin', pluginId: string): void
  (e: 'clearEdit'): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 外壳注入的保存接口：增删服务器不适合走防抖 */
const saveApi = inject<YayaSettingsSaveApi | null>(YAYA_SAVE_API_KEY, null)

const notice = ref<{ text: string; error: boolean } | null>(null)
const confirmDeleteId = ref<string | null>(null)

const dialogOpen = ref(false)
const editingId = ref<string | null>(null)

const servers = computed<McpServerConfig[]>(() => props.config.mcpServers ?? [])

/** 容器放不下对话框时全屏（ResizeObserver 量容器，不用窗口断点） */
const rootEl = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
let resizeObs: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    const measure = (): void => {
      fullscreen.value = (rootEl.value?.clientWidth ?? 0) < 720
    }
    measure()
    resizeObs = new ResizeObserver(measure)
    resizeObs.observe(rootEl.value)
  }
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
})

/** 插件详情里的「编辑」：由外壳转来，打开对应服务器的编辑器 */
watch(
  () => props.pendingEdit,
  (value) => {
    if (!value) return
    openEditor(value)
    emit('clearEdit')
  }
)

function openEditor(value: string): void {
  if (value === 'new') {
    editingId.value = null
  } else {
    const server = servers.value.find((s) => s.id === value || `mcp-${s.id}` === value)
    editingId.value = server?.id ?? null
  }
  dialogOpen.value = true
}

const editingServer = computed<McpServerConfig | null>(
  () => servers.value.find((s) => s.id === editingId.value) ?? null
)

function pluginOf(server: McpServerConfig): PluginInfo | undefined {
  return props.plugins.find((p) => p.id === `mcp-${server.id}`)
}

function statusText(server: McpServerConfig): string {
  const state = pluginOf(server)?.status.state
  if (state === 'connecting') return t('yaya.settings.plugins.status_connecting', '连接中')
  if (state === 'error') return t('yaya.settings.plugins.status_error', '错误')
  if (state === 'idle') return t('yaya.settings.plugins.status_idle', '未连接')
  return t('yaya.settings.plugins.status_ready', '就绪')
}

function statusColor(server: McpServerConfig): string | undefined {
  const state = pluginOf(server)?.status.state
  if (state === 'error') return 'error'
  if (state === 'connecting') return 'info'
  if (state === 'ready') return 'success'
  return undefined
}

function transportLabel(server: McpServerConfig): string {
  return server.transport === 'sse'
    ? t('yaya.settings.plugins.mcp_transport_sse', 'SSE')
    : t('yaya.settings.plugins.mcp_transport_http', 'Streamable HTTP')
}

/** 服务器开关 = `server.enabled` 与插件启用（mcp-<id>）一起改 */
function toggleServer(server: McpServerConfig, on: boolean): void {
  server.enabled = on
  const plugin = pluginOf(server)
  if (plugin) setPluginEnabled(props.config, plugin, on)
}

function saveServer(server: McpServerConfig): void {
  const list = [...servers.value]
  const idx = list.findIndex((s) => s.id === server.id)
  if (idx === -1) list.push(server)
  else list[idx] = server
  props.config.mcpServers = list
  saveApi?.saveNow()
  notice.value = {
    text: te('yaya.settings.plugins.mcp_saved', { name: server.name }, '已保存 MCP 服务器 {name}'),
    error: false
  }
}

function doDeleteServer(server: McpServerConfig): void {
  props.config.mcpServers = servers.value.filter((s) => s.id !== server.id)
  // 插件启用覆盖一并清掉：重新加回同一个 id 时不应继承旧的停用状态
  const next = { ...(props.config.pluginEnabled ?? {}) }
  delete next[`mcp-${server.id}`]
  props.config.pluginEnabled = next
  confirmDeleteId.value = null
  saveApi?.saveNow()
  notice.value = {
    text: te(
      'yaya.settings.plugins.mcp_removed',
      { name: server.name },
      '已删除 MCP 服务器 {name}'
    ),
    error: false
  }
}
</script>

<template>
  <div ref="rootEl" class="mcp-panel d-flex flex-column ga-3">
    <div class="d-flex flex-wrap align-center ga-2">
      <div class="text-caption text-medium-emphasis mcp-desc">
        {{
          t(
            'yaya.settings.plugins.mcp_desc',
            '连接 MCP 服务器后，它提供的工具会加入助手，可在插件详情里逐个启停'
          )
        }}
      </div>
      <v-spacer />
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="openEditor('new')">
        {{ t('yaya.settings.plugins.mcp_add', '添加服务器') }}
      </v-btn>
    </div>

    <v-alert
      v-if="notice"
      :color="notice.error ? 'error' : 'success'"
      variant="tonal"
      density="compact"
      closable
      @click:close="notice = null"
    >
      {{ notice.text }}
    </v-alert>

    <div v-if="loading" class="text-body-2 text-medium-emphasis py-4">
      {{ t('yaya.settings.plugins.loading', '正在加载插件列表…') }}
    </div>
    <div
      v-else-if="servers.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon icon="mdi-connection" size="32" />
      <span class="text-body-2">
        {{ t('yaya.settings.plugins.mcp_empty', '尚未添加任何 MCP 服务器') }}
      </span>
    </div>
    <div v-else class="d-flex flex-column ga-2">
      <div
        v-for="server in servers"
        :key="server.id"
        class="server-row d-flex align-center ga-3 pa-3 rounded-lg border"
        role="button"
        :aria-label="server.name"
        tabindex="0"
        @click="emit('selectPlugin', `mcp-${server.id}`)"
        @keydown.enter.prevent="emit('selectPlugin', `mcp-${server.id}`)"
        @keydown.space.prevent="emit('selectPlugin', `mcp-${server.id}`)"
      >
        <v-icon icon="mdi-connection" color="primary" class="flex-shrink-0" />
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex align-center flex-wrap ga-2">
            <span class="font-weight-bold text-subtitle-2">{{ server.name }}</span>
            <v-chip variant="tonal" class="chip-pad flex-shrink-0">
              {{ transportLabel(server) }}
            </v-chip>
            <v-chip variant="tonal" :color="statusColor(server)" class="chip-pad flex-shrink-0">
              {{ statusText(server) }}
            </v-chip>
          </div>
          <div class="text-caption text-medium-emphasis server-url">{{ server.url }}</div>
        </div>
        <v-icon icon="mdi-chevron-right" class="flex-shrink-0" />
        <!-- 开关单独一层：点击 / 按键都不触发行进详情 -->
        <div class="row-switch flex-shrink-0" @click.stop @keydown.stop>
          <v-switch
            :model-value="server.enabled"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggleServer(server, $event === true)"
          />
        </div>
        <!-- 删除：行内二次确认 -->
        <div class="row-actions flex-shrink-0 d-flex align-center ga-1" @click.stop @keydown.stop>
          <template v-if="confirmDeleteId === server.id">
            <v-btn variant="text" color="error" @click="doDeleteServer(server)">
              {{ t('yaya.settings.delete_confirm', '确认删除？') }}
            </v-btn>
            <v-btn variant="text" @click="confirmDeleteId = null">
              {{ t('yaya.settings.cancel', '取消') }}
            </v-btn>
          </template>
          <v-btn
            v-else
            icon="mdi-delete-outline"
            size="small"
            :title="t('yaya.settings.plugins.mcp_delete', '删除该服务器')"
            :aria-label="t('yaya.settings.plugins.mcp_delete', '删除该服务器')"
            @click="confirmDeleteId = server.id"
          />
        </div>
      </div>
    </div>

    <McpServerDialog
      v-model="dialogOpen"
      :server="editingServer"
      :existing-ids="servers.map((s) => s.id)"
      :fullscreen="fullscreen"
      @save="saveServer"
    />
  </div>
</template>

<style scoped>
.mcp-panel {
  width: 100%;
  min-width: 0;
}

.mcp-desc {
  min-width: 0;
}

.server-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
  cursor: pointer;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

/* URL 等宽 + 省略，超长也不撑破布局 */
.server-url {
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 容器放不下时换行，不出横向滚动条 */
@media (max-width: 560px) {
  .server-row {
    flex-wrap: wrap;
  }

  .server-url {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}
</style>
