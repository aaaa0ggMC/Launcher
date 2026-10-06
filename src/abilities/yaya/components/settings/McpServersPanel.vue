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
  /**
   * 某个助手的 MCP 页：开关只改这个助手的启用状态（config 是助手视图），
   * 不改服务器的默认启用，也不在这里增删 / 编辑服务器（它们是所有助手共用的）
   */
  assistantScope?: boolean
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

/**
 * 容器放不下的宽度阈值（ResizeObserver 量容器宽，不用窗口断点——页面可能被缩放或嵌在别处）：
 * 窄容器时对话框全屏、卡片从「一行排不开就换行」改成堆叠布局。
 */
const NARROW_PX = 720

const rootEl = ref<HTMLElement | null>(null)
const narrow = ref(false)
let resizeObs: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    const measure = (): void => {
      narrow.value = (rootEl.value?.clientWidth ?? 0) < NARROW_PX
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
  if (state === 'ready') return t('yaya.settings.plugins.status_ready', '就绪')
  // 插件列表里还没有这个服务器（刚添加 / 列表尚未刷新）→ 不能显示「就绪」，按未连接兜底
  return t('yaya.settings.plugins.status_idle', '未连接')
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
  if (!props.assistantScope) server.enabled = on
  const plugin = pluginOf(server)
  if (plugin) setPluginEnabled(props.config, plugin, on)
  // 插件列表里还没有这个服务器（刚添加、列表未刷新）时上面没有 plugin 可写；
  // 这里无论如何都显式落一份布尔值，保证注册表读到的是「本次切换」的结果。
  const next: Record<string, boolean> = { ...(props.config.pluginEnabled ?? {}) }
  next[`mcp-${server.id}`] = on
  props.config.pluginEnabled = next
}

/** 开关显示的值：助手页 = 这个助手的启用状态（没单独设过 = 服务器的默认启用） */
function serverOn(server: McpServerConfig): boolean {
  if (!props.assistantScope) return server.enabled
  return props.config.pluginEnabled?.[`mcp-${server.id}`] ?? server.enabled
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
          assistantScope
            ? t(
                'yaya.assistants.mcp_desc',
                '选择这个助手能用哪些 MCP 服务器。添加 / 编辑服务器在「设置 → 插件 → MCP」，所有助手共用'
              )
            : t(
                'yaya.settings.plugins.mcp_desc',
                '连接 MCP 服务器后，它提供的工具会加入助手，可在插件详情里逐个启停'
              )
        }}
      </div>
      <v-spacer />
      <v-btn
        v-if="!assistantScope"
        color="primary"
        variant="tonal"
        prepend-icon="mdi-plus"
        @click="openEditor('new')"
      >
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

    <!-- 初次加载（一份数据都没有）才用整块 loader；有数据时后台刷新不走这里 -->
    <div
      v-if="loading && servers.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-progress-circular indeterminate color="primary" size="24" width="2" />
      <span class="text-body-2">
        {{ t('yaya.settings.plugins.loading', '正在加载插件列表…') }}
      </span>
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
    <!--
      服务器列表：后台刷新时整份保留（只在顶部叠一条进度线），
      几何与滚动位置都不动，不再出现「一点开关滚回首屏」。
    -->
    <div v-else class="server-cards d-flex flex-column ga-2">
      <div v-if="loading" class="refresh-line" aria-hidden="true">
        <v-progress-linear indeterminate color="primary" height="2" />
      </div>
      <span v-if="loading" class="sr-only">
        {{ t('yaya.settings.plugins.mcp_refreshing', '正在刷新…') }}
      </span>

      <div
        v-for="server in servers"
        :key="server.id"
        class="server-card rounded-lg border"
        :class="{ 'server-card--compact': narrow }"
      >
        <!-- 头部：图标 + 名称同一行，传输方式 / 状态第二行（窄容器时换行独占一行） -->
        <div class="card-head">
          <v-icon icon="mdi-server-network" color="primary" size="24" class="flex-shrink-0" />
          <span class="card-name font-weight-bold text-subtitle-2" :title="server.name">
            {{ server.name }}
          </span>
          <span class="card-meta d-flex align-center flex-wrap ga-2">
            <v-chip variant="tonal" class="chip-pad">{{ transportLabel(server) }}</v-chip>
            <v-chip variant="tonal" :color="statusColor(server)" class="chip-pad">
              {{ statusText(server) }}
            </v-chip>
          </span>
          <span class="head-grow" />
          <!-- 开关带文字标签，卡片本身不是按钮，点开关不会误进详情 -->
          <div class="switch-cell d-flex align-center ga-2">
            <span class="switch-label text-caption">
              {{ t('yaya.settings.plugins.enable_plugin', '启用该插件') }}
            </span>
            <v-switch
              :model-value="serverOn(server)"
              color="primary"
              hide-details
              density="compact"
              :title="
                te(
                  'yaya.settings.plugins.mcp_toggle_named',
                  { name: server.name },
                  '启用服务器 {name}'
                )
              "
              :aria-label="
                te(
                  'yaya.settings.plugins.mcp_toggle_named',
                  { name: server.name },
                  '启用服务器 {name}'
                )
              "
              @update:model-value="toggleServer(server, $event === true)"
            />
          </div>
        </div>

        <!-- 地址：宽容器单行省略，窄容器最多两行；悬停看全文 -->
        <div class="server-url text-caption text-medium-emphasis" :title="server.url">
          {{ server.url }}
        </div>

        <!-- 操作区与信息区分开：详情 / 编辑 + 删除 -->
        <div class="card-foot d-flex flex-wrap align-center ga-2">
          <v-btn
            variant="text"
            prepend-icon="mdi-connection"
            @click="emit('selectPlugin', `mcp-${server.id}`)"
          >
            {{ t('yaya.settings.plugins.mcp_details', '详情') }}
          </v-btn>
          <v-btn
            v-if="!assistantScope"
            variant="text"
            prepend-icon="mdi-pencil-outline"
            @click="openEditor(server.id)"
          >
            {{
              narrow
                ? t('yaya.settings.plugins.mcp_edit_short', '编辑')
                : t('yaya.settings.plugins.edit', '编辑服务器')
            }}
          </v-btn>
          <v-spacer />
          <template v-if="!assistantScope && confirmDeleteId === server.id">
            <v-btn variant="text" color="error" @click="doDeleteServer(server)">
              {{ t('yaya.settings.delete_confirm', '确认删除？') }}
            </v-btn>
            <v-btn variant="text" @click="confirmDeleteId = null">
              {{ t('yaya.settings.cancel', '取消') }}
            </v-btn>
          </template>
          <v-btn
            v-else-if="!assistantScope"
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
      :fullscreen="narrow"
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

/* 卡片列表容器：相对定位，供刷新进度线定位用（绝对定位，不占布局） */
.server-cards {
  position: relative;
  min-width: 0;
}

.refresh-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 2px;
  overflow: hidden;
  z-index: 1;
}

/* 仅供读屏 / 无障碍树：刷新提示 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.server-card {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
  padding: 16px;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.card-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.card-meta {
  flex-shrink: 0;
}

.head-grow {
  flex: 1 1 auto;
  min-width: 4px;
}

.switch-cell {
  flex-shrink: 0;
}

.switch-label {
  white-space: nowrap;
}

/* URL 等宽 + 省略，超长也不撑破布局 */
.server-url {
  margin-top: 12px;
  min-width: 0;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 操作区与信息区分开，上方一条细分隔线 */
.card-foot {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.14);
}

.server-card--compact .card-head {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 8px;
}
.server-card--compact .card-meta {
  grid-column: 1 / -1;
  grid-row: 2;
}
.server-card--compact .switch-cell {
  grid-column: 3;
  grid-row: 1;
}
.server-card--compact .head-grow,
.server-card--compact .switch-label,
.server-card--compact .card-foot :deep(.v-spacer) {
  display: none;
}
.server-card--compact .card-foot > :deep(.v-btn:last-child) {
  margin-left: auto;
}

/* 窄容器（量容器宽）：元信息独占第二行、URL 最多两行、触摸目标放大 */
.server-card--compact .card-meta {
  flex-basis: 100%;
}

.server-card--compact .server-url {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow-wrap: anywhere;
}

.server-card--compact :deep(.v-btn) {
  --v-btn-height: 48px;
}

.server-card--compact :deep(.v-switch) {
  --v-selection-control-size: 48px;
}

/* 触屏设备：按钮 / 开关的触摸热区不小于 48px */
@media (pointer: coarse) {
  .server-card :deep(.v-btn) {
    --v-btn-height: 48px;
  }

  .server-card :deep(.v-switch) {
    --v-selection-control-size: 48px;
  }
}
</style>
