<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, onBeforeUnmount, onMounted, onActivated, ref } from 'vue'
import type { Ref } from 'vue'
import type { PluginInfo } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'
import McpServersPanel from './McpServersPanel.vue'
import PluginDetail from './PluginDetail.vue'
import PluginList from './PluginList.vue'
import SkillsPanel from './SkillsPanel.vue'

defineOptions({ name: 'cockpit-yaya-settings-plugins' })

const props = defineProps<{
  /** 同一个 reactive 配置对象，子组件直接改字段，无需 emit */
  config: YayaConfig
  /** 某个助手的插件页：config 是这个助手的视图，启用 / 分组状态按它算 */
  assistantId?: string
  /** 只显示这几个分页（助手页把 MCP 单独放一页） */
  only?: PluginsTab[]
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

type PluginsTab = 'plugins' | 'mcp' | 'skills'

const allTabs = computed<{ value: PluginsTab; title: string; icon: string }[]>(() => [
  {
    value: 'plugins',
    title: t('yaya.settings.plugins.tab_plugins', '插件'),
    icon: 'mdi-puzzle-outline'
  },
  { value: 'mcp', title: t('yaya.settings.plugins.tab_mcp', 'MCP'), icon: 'mdi-connection' },
  {
    value: 'skills',
    title: t('yaya.settings.plugins.tab_skills', 'Skills'),
    icon: 'mdi-file-document-outline'
  }
])

const tabs = computed(() =>
  props.only?.length ? allTabs.value.filter((x) => props.only!.includes(x.value)) : allTabs.value
)

const plugins = ref<PluginInfo[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)

const tab = ref<PluginsTab>(props.only?.[0] ?? 'plugins')
/** 正在查看详情的插件 id（三个分页共用） */
const selectedId = ref<string | null>(null)
const restartingId = ref<string | null>(null)
/** 转给 MCP 分页的「打开编辑器」请求：'new' 或服务器 id */
const mcpEdit = ref<string | null>(null)

const selectedPlugin = computed<PluginInfo | null>(
  () => plugins.value.find((p) => p.id === selectedId.value) ?? null
)

let loadSequence = 0

async function loadPlugins(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = null
  try {
    const res = (await window.cockpit.command(
      'yaya.plugins-list',
      props.assistantId ? { assistant: props.assistantId } : {}
    )) as PluginInfo[] | { plugins?: PluginInfo[] } | null
    if (sequence !== loadSequence) return
    plugins.value = Array.isArray(res) ? res : (res?.plugins ?? [])
  } catch (err) {
    if (sequence !== loadSequence) return
    loadError.value = String(err)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

const unsubscribes: (() => void)[] = []
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void loadPlugins()
  }, 80)
}
function refreshOnVisible(): void {
  if (document.visibilityState === 'visible') scheduleRefresh()
}
onMounted(() => {
  for (const channel of [
    'cockpit:yaya-plugins-changed',
    'cockpit:yaya-config-changed',
    'cockpit:host-reconnected'
  ])
    unsubscribes.push(window.cockpit.on(channel, scheduleRefresh))
  document.addEventListener('visibilitychange', refreshOnVisible)
  void loadPlugins()
})
onActivated(scheduleRefresh)
onBeforeUnmount(() => {
  loadSequence++
  for (const unsubscribe of unsubscribes) unsubscribe()
  if (refreshTimer) clearTimeout(refreshTimer)
  document.removeEventListener('visibilitychange', refreshOnVisible)
})

async function restart(pluginId: string): Promise<void> {
  restartingId.value = pluginId
  actionError.value = null
  try {
    await window.cockpit.command('yaya.plugin-restart', { id: pluginId })
    await loadPlugins()
  } catch (err) {
    actionError.value = String(err)
  } finally {
    restartingId.value = null
  }
}

/** 插件详情里的「编辑服务器」：切到 MCP 分页并打开对应编辑器 */
function editServer(pluginId: string): void {
  const serverId = pluginId.startsWith('mcp-') ? pluginId.slice(4) : pluginId
  selectedId.value = null
  tab.value = 'mcp'
  mcpEdit.value = serverId
}

function closeDetail(): void {
  selectedId.value = null
}
</script>

<template>
  <div class="plugins-section d-flex flex-column ga-4">
    <v-alert
      v-if="actionError"
      color="error"
      variant="tonal"
      density="compact"
      closable
      @click:close="actionError = null"
    >
      {{ actionError }}
    </v-alert>

    <!-- 插件详情（三个分页共用；窄屏下是列表内的新一层，顶部有返回） -->
    <PluginDetail
      v-if="selectedPlugin"
      :key="selectedPlugin.id"
      :plugin="selectedPlugin"
      :config="config"
      :assistant-id="assistantId"
      :restarting="restartingId === selectedPlugin.id"
      @back="closeDetail"
      @restart="restart"
      @edit-server="editServer"
    />

    <template v-else>
      <div v-if="!assistantId" class="text-caption text-medium-emphasis">
        {{
          t(
            'yaya.settings.plugins.defaults_note',
            '这里的启用开关是新建助手的默认值；已有的助手在「助手 → 插件 / MCP」里各自设置。插件配置、MCP 服务器和 Skill 所有助手共用。'
          )
        }}
      </div>
      <v-alert v-if="loadError" color="error" variant="tonal" density="compact" class="mb-1">
        {{ t('yaya.settings.plugins.load_failed', '插件列表加载失败') }}
      </v-alert>

      <v-tabs
        v-if="tabs.length > 1"
        v-model="tab"
        class="plugins-tabs"
        selected-class="text-primary"
      >
        <v-tab v-for="item in tabs" :key="item.value" :value="item.value">
          <v-icon :icon="item.icon" size="small" start />
          {{ item.title }}
        </v-tab>
      </v-tabs>

      <PluginList
        v-if="tab === 'plugins'"
        :plugins="plugins"
        :config="config"
        :loading="loading"
        @select="selectedId = $event.id"
      />
      <McpServersPanel
        v-else-if="tab === 'mcp'"
        :config="config"
        :plugins="plugins"
        :loading="loading"
        :pending-edit="mcpEdit"
        :assistant-scope="!!assistantId"
        @select-plugin="selectedId = $event"
        @clear-edit="mcpEdit = null"
      />
      <SkillsPanel
        v-else
        :config="config"
        :plugins="plugins"
        :loading="loading"
        @select-plugin="selectedId = $event"
        @changed="loadPlugins()"
      />
    </template>
  </div>
</template>

<style scoped>
.plugins-section {
  width: 100%;
  min-width: 0;
}

/* 分页栏：窄屏不出横向滚动条 */
.plugins-tabs {
  flex: 0 0 auto;
}

@media (max-width: 720px) {
  /* 三个分页挤在一行：收紧 tab 内边距，避免 tab 栏内部横向滚动 */
  .plugins-tabs :deep(.v-tab) {
    padding-inline: 8px !important;
  }
}
</style>
