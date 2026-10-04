<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { PluginInfo } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'
import { isPluginEnabled, pluginFallbackIcon, setPluginEnabled } from './plugin-state'

defineOptions({ name: 'cockpit-yaya-settings-plugin-list' })

const props = defineProps<{
  plugins: PluginInfo[]
  config: YayaConfig
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'select', plugin: PluginInfo): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const query = ref('')

/** 一行 = 一个内置插件 + 命中的工具数（0 = 插件本身命中，不显示） */
interface PluginRow {
  plugin: PluginInfo
  matchedTools: number
}

const rows = computed<PluginRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  return props.plugins
    .filter((plugin) => plugin.kind === 'builtin')
    .map((plugin) => {
      if (!q) return { plugin, matchedTools: 0 }
      const hitPlugin =
        plugin.label.toLowerCase().includes(q) || plugin.description.toLowerCase().includes(q)
      if (hitPlugin) return { plugin, matchedTools: 0 }
      const matchedTools = plugin.tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(q) ||
          tool.wireName.toLowerCase().includes(q) ||
          tool.description.toLowerCase().includes(q)
      ).length
      return { plugin, matchedTools }
    })
    .filter((row) => !query.value.trim() || row.matchedTools > 0)
})

function openRow(plugin: PluginInfo): void {
  emit('select', plugin)
}

function toggleEnabled(plugin: PluginInfo, on: boolean): void {
  setPluginEnabled(props.config, plugin, on)
}
</script>

<template>
  <div class="plugin-list d-flex flex-column ga-3">
    <div class="text-caption text-medium-emphasis">
      {{ t('yaya.settings.plugins.desc', '插件为助手提供工具；点进去可查看文档、逐个启停工具') }}
    </div>

    <v-text-field
      v-model="query"
      :label="t('yaya.settings.plugins.search', '搜索插件')"
      :placeholder="t('yaya.settings.plugins.search_placeholder', '按名称、描述或工具名搜索')"
      prepend-inner-icon="mdi-magnify"
      variant="outlined"
      clearable
      hide-details
      @update:model-value="query = $event ?? ''"
    />

    <div v-if="loading" class="text-body-2 text-medium-emphasis py-4">
      {{ t('yaya.settings.plugins.loading', '正在加载插件列表…') }}
    </div>
    <div
      v-else-if="rows.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon :icon="query ? 'mdi-magnify-close' : 'mdi-puzzle-outline'" size="32" />
      <span class="text-body-2">
        {{
          query
            ? t('yaya.settings.plugins.filter_empty', '没有匹配的插件')
            : t('yaya.settings.plugins.empty', '暂无可用的内置插件')
        }}
      </span>
    </div>
    <div v-else class="d-flex flex-column ga-2">
      <div
        v-for="row in rows"
        :key="row.plugin.id"
        class="plugin-row d-flex align-center ga-3 pa-3 rounded-lg border"
        role="button"
        :aria-label="row.plugin.label"
        tabindex="0"
        @click="openRow(row.plugin)"
        @keydown.enter.prevent="openRow(row.plugin)"
        @keydown.space.prevent="openRow(row.plugin)"
      >
        <v-icon
          :icon="row.plugin.icon || pluginFallbackIcon(row.plugin)"
          color="primary"
          size="24"
          class="flex-shrink-0"
        />
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex align-center flex-wrap ga-2">
            <span class="font-weight-bold text-subtitle-2">{{ row.plugin.label }}</span>
            <v-chip variant="tonal" class="chip-pad flex-shrink-0">
              {{
                te(
                  'yaya.settings.plugins.tools_count',
                  { n: String(row.plugin.tools.length) },
                  '{n} 个工具'
                )
              }}
            </v-chip>
            <span v-if="row.matchedTools > 0" class="text-caption text-primary matched-tip">
              {{
                te(
                  'yaya.settings.plugins.matched_tools',
                  { n: String(row.matchedTools) },
                  '匹配 {n} 个工具'
                )
              }}
            </span>
          </div>
          <div class="text-caption text-medium-emphasis row-desc">{{ row.plugin.description }}</div>
        </div>
        <v-progress-circular
          v-if="row.plugin.status.state === 'connecting'"
          indeterminate
          size="16"
          width="2"
          color="primary"
          class="flex-shrink-0"
        />
        <span
          v-else-if="row.plugin.status.state === 'error'"
          class="status-dot status-dot--error flex-shrink-0"
          :title="row.plugin.status.message || t('yaya.settings.plugins.status_error', '错误')"
        />
        <v-icon icon="mdi-chevron-right" class="flex-shrink-0" />
        <!-- 开关单独一层：点击 / 按键都不触发行进详情 -->
        <div class="row-switch flex-shrink-0" @click.stop @keydown.stop>
          <v-switch
            :model-value="isPluginEnabled(config, row.plugin)"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggleEnabled(row.plugin, $event === true)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-list {
  width: 100%;
  min-width: 0;
}

.plugin-row {
  cursor: pointer;
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

/* 插件描述一行省略，行高保持稳定 */
.row-desc {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.matched-tip {
  white-space: nowrap;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.status-dot--error {
  background: rgb(var(--v-theme-error));
}

/* 容器放不下时让开关也能换行，不出横向滚动条 */
@media (max-width: 560px) {
  .plugin-row {
    flex-wrap: wrap;
  }

  .row-desc {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}
</style>
