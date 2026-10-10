<script setup lang="ts">
/* eslint-disable vue/no-mutating-props -- 与其他设置分区一样直接改外壳持有的配置对象 */
import { useI18n } from '@ui/i18n'
import { computed, inject, onBeforeUnmount, onMounted, onActivated, ref } from 'vue'
import type { Ref } from 'vue'
import { useScrollMemory } from '@ui/composables/scroll-memory'
import { useSettings } from '@ui/composables/settings'
import {
  YAYA_SAVE_API_KEY,
  YAYA_SETTINGS_NAV_KEY,
  requestYayaSection,
  type YayaSettingsNav,
  type YayaSettingsSaveApi
} from './shared'
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
  /** 全局配置（助手页的「手动同步 / 自动同步根配置」要读根配置的那份插件开关） */
  rootConfig?: YayaConfig
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

// 列表 / 详情 / 分页各自记住滚动位置：从 MCP 详情返回时回到点进去的位置
const rootEl = ref<HTMLElement | null>(null)
useScrollMemory(
  rootEl,
  () => `${tab.value}|${selectedId.value ?? ''}`,
  `yaya-plugins:${props.assistantId ?? ''}`
)

function closeDetail(): void {
  selectedId.value = null
}

// 窄屏：头部的「返回」先关详情，详情里就不再放自己的返回按钮
const nav = inject<YayaSettingsNav | null>(YAYA_SETTINGS_NAV_KEY, null)
const saveApi = inject<YayaSettingsSaveApi | null>(YAYA_SAVE_API_KEY, null)
const settings = useSettings()

// ---- 助手插件页：「自动同步根配置」（默认开） ----
// 开：这个助手的插件开关 / 分组整份跟随根配置（YAYA → 插件），此处不显示具体开关，
//     只给「前往根配置」；关：用助手自己那份，可「手动同步」把根配置拷过来再改。
// scopedConfig 代理把 pluginsFollowRoot 路由到助手对象上，YayaConfig 类型里没有它
type ScopedFlagView = { pluginsFollowRoot?: boolean }
const followRoot = computed(
  () => (props.config as unknown as ScopedFlagView).pluginsFollowRoot !== false
)

function setFollowRoot(v: boolean | null): void {
  ;(props.config as unknown as ScopedFlagView).pluginsFollowRoot = v !== false
  saveApi?.saveNow()
  void loadPlugins()
}

/** 把根配置的插件开关 / 分组拷进这个助手（手动同步） */
function syncFromRoot(): void {
  const root = props.rootConfig
  if (!root) return
  props.config.pluginEnabled = { ...(root.pluginEnabled ?? {}) }
  props.config.pluginGroupEnabled = { ...(root.pluginGroupEnabled ?? {}) }
  saveApi?.saveNow()
  void loadPlugins()
}

/** 跳到 YAYA 设置的插件分区（根配置）；设置页已经开着也照切 */
function gotoRootPlugins(): void {
  requestYayaSection('plugins')
  settings.open({ ability: 'yaya' })
}
const offBack = nav?.onBack(() => {
  if (!selectedId.value) return false
  closeDetail()
  return true
})
onBeforeUnmount(() => offBack?.())
</script>

<template>
  <div ref="rootEl" class="plugins-section d-flex flex-column ga-4">
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
      :hide-back="!!nav?.narrow.value"
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

      <!-- 助手插件页：自动同步根配置（默认开）——开着就不显示具体开关，给跳转 -->
      <v-card v-if="assistantId && tab === 'plugins'" variant="tonal" class="sync-card pa-3" border>
        <div class="d-flex align-center ga-3">
          <v-icon icon="mdi-sync-circle" class="flex-shrink-0" />
          <div class="min-w-0 flex-grow-1">
            <div class="text-body-2 font-weight-medium">
              {{ t('yaya.assistants.plugins_sync', '自动同步根配置') }}
            </div>
            <div class="text-caption text-medium-emphasis">
              {{
                followRoot
                  ? t(
                      'yaya.assistants.plugins_sync_hint_on',
                      '这个助手的插件开关与分组跟随根配置（YAYA → 插件），此处不显示具体开关'
                    )
                  : t(
                      'yaya.assistants.plugins_sync_hint_off',
                      '已独立：下面的开关只影响这个助手，可先从根配置同步一次再改'
                    )
              }}
            </div>
          </div>
          <v-switch
            :model-value="followRoot"
            color="primary"
            density="compact"
            hide-details
            class="flex-shrink-0"
            :aria-label="t('yaya.assistants.plugins_sync', '自动同步根配置')"
            @update:model-value="setFollowRoot"
          />
        </div>
        <div class="d-flex ga-2 flex-wrap mt-3">
          <v-btn
            v-if="followRoot"
            size="small"
            variant="tonal"
            prepend-icon="mdi-open-in-new"
            @click="gotoRootPlugins"
          >
            {{ t('yaya.assistants.plugins_sync_goto', '前往根配置') }}
          </v-btn>
          <v-btn v-else size="small" variant="tonal" prepend-icon="mdi-sync" @click="syncFromRoot">
            {{ t('yaya.assistants.plugins_sync_now', '手动同步') }}
          </v-btn>
        </div>
      </v-card>

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
        v-if="tab === 'plugins' && !(assistantId && followRoot)"
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
.sync-card {
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
