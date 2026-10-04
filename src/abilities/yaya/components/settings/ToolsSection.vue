<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import type { ToolInfo, YayaConfig } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-tools' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const tools = ref<ToolInfo[]>([])
const toolsLoading = ref(false)
const toolsError = ref<string | null>(null)

const query = ref('')
type ToolFilter = 'all' | 'enabled' | 'disabled' | 'approval'
const filter = ref<ToolFilter>('all')

onMounted(async () => {
  toolsLoading.value = true
  toolsError.value = null
  try {
    const res = (await window.cockpit.command('yaya.tools-list')) as
      ToolInfo[] | { tools?: ToolInfo[] }
    tools.value = Array.isArray(res) ? res : (res.tools ?? [])
  } catch (err) {
    tools.value = []
    toolsError.value = String(err)
  } finally {
    toolsLoading.value = false
  }
})

function setToolEnabled(tool: ToolInfo, on: boolean): void {
  tool.enabled = on
  const disabled = new Set(props.config.disabledTools ?? [])
  if (on) disabled.delete(tool.name)
  else disabled.add(tool.name)
  props.config.disabledTools = [...disabled]
}

const filteredTools = computed(() => {
  const q = query.value.trim().toLowerCase()
  return tools.value.filter((tool) => {
    if (q && !tool.name.toLowerCase().includes(q) && !tool.description.toLowerCase().includes(q))
      return false
    if (filter.value === 'enabled' && !tool.enabled) return false
    if (filter.value === 'disabled' && tool.enabled) return false
    if (filter.value === 'approval' && !tool.requiresApproval) return false
    return true
  })
})

/** 只有一种来源时不显示组标题 */
const multiSource = computed(() => new Set(filteredTools.value.map((tool) => tool.source)).size > 1)

const sourceOrder: Array<'builtin' | 'mcp' | 'custom'> = ['builtin', 'mcp', 'custom']

const groups = computed(() =>
  sourceOrder
    .map((source) => ({
      source,
      items: filteredTools.value.filter((tool) => tool.source === source)
    }))
    .filter((group) => group.items.length > 0)
)

function groupTitle(source: 'builtin' | 'mcp' | 'custom'): string {
  if (source === 'builtin') return t('yaya.settings.tools_group_builtin', '内置工具')
  if (source === 'mcp') return t('yaya.settings.tools_group_mcp', 'MCP 工具')
  return t('yaya.settings.tools_group_custom', '自定义工具')
}

/** 全部启用 / 全部禁用当前筛选结果 */
function bulkSetEnabled(on: boolean): void {
  for (const tool of filteredTools.value) {
    if (tool.enabled !== on) setToolEnabled(tool, on)
  }
}
</script>

<template>
  <div class="section-page d-flex flex-column ga-4">
    <div class="text-caption text-medium-emphasis">
      {{ t('yaya.settings.tools_desc', '关闭后该工具不再提供给助手调用') }}
    </div>

    <template v-if="!toolsLoading && tools.length > 0">
      <v-text-field
        v-model="query"
        :label="t('yaya.settings.tools_search', '搜索工具')"
        :placeholder="t('yaya.settings.tools_search_placeholder', '按名称或描述搜索')"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        clearable
        hide-details
        @update:model-value="query = $event ?? ''"
      />

      <div class="d-flex flex-wrap align-center ga-2">
        <v-chip-group
          v-model="filter"
          class="tools-filter-group"
          selected-class="text-primary"
          mandatory
        >
          <v-chip
            v-for="item in [
              { value: 'all', text: t('yaya.settings.tools_filter_all', '全部') },
              { value: 'enabled', text: t('yaya.settings.tools_filter_enabled', '已启用') },
              { value: 'disabled', text: t('yaya.settings.tools_filter_disabled', '已禁用') },
              { value: 'approval', text: t('yaya.settings.tools_filter_approval', '需确认') }
            ]"
            :key="item.value"
            :value="item.value"
            variant="outlined"
            class="chip-pad"
          >
            {{ item.text }}
          </v-chip>
        </v-chip-group>

        <v-spacer />

        <div class="d-flex flex-wrap align-center ga-2">
          <v-btn variant="text" prepend-icon="mdi-check-all" @click="bulkSetEnabled(true)">
            {{
              te(
                'yaya.settings.tools_enable_all',
                { n: String(filteredTools.length) },
                '全部启用（{n}）'
              )
            }}
          </v-btn>
          <v-btn
            variant="text"
            prepend-icon="mdi-close-box-multiple"
            @click="bulkSetEnabled(false)"
          >
            {{
              te(
                'yaya.settings.tools_disable_all',
                { n: String(filteredTools.length) },
                '全部禁用（{n}）'
              )
            }}
          </v-btn>
        </div>
      </div>
    </template>

    <div v-if="toolsLoading" class="text-body-2 text-medium-emphasis py-4">
      {{ t('yaya.settings.tools_loading', '正在加载工具列表…') }}
    </div>
    <div
      v-else-if="tools.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon icon="mdi-wrench-outline" size="32" />
      <span class="text-body-2">
        {{
          toolsError
            ? t('yaya.settings.tools_load_failed', '工具列表加载失败')
            : t('yaya.settings.tools_empty', '暂无可用的工具')
        }}
      </span>
    </div>
    <div
      v-else-if="filteredTools.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon icon="mdi-magnify-close" size="32" />
      <span class="text-body-2">
        {{ t('yaya.settings.tools_filter_empty', '没有匹配的工具') }}
      </span>
    </div>
    <div v-else class="tools-stack d-flex flex-column ga-3">
      <template v-for="group in groups" :key="group.source">
        <div v-if="multiSource" class="text-caption font-weight-medium text-medium-emphasis pt-1">
          {{ groupTitle(group.source) }}
        </div>
        <div class="d-flex flex-column ga-2">
          <div
            v-for="tool in group.items"
            :key="tool.name"
            class="tool-row d-flex align-center ga-3 py-2 px-3 rounded-lg border"
          >
            <div class="min-w-0 flex-grow-1">
              <div class="d-flex align-center flex-wrap ga-2">
                <span class="font-family-mono text-body-2 font-weight-medium">
                  {{ tool.name }}
                </span>
                <v-chip
                  v-if="tool.requiresApproval"
                  size="small"
                  variant="tonal"
                  color="warning"
                  class="chip-pad flex-shrink-0"
                >
                  {{ t('yaya.settings.tool_needs_approval', '需确认') }}
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis tool-desc">
                {{ tool.description }}
              </div>
            </div>
            <v-switch
              :model-value="tool.enabled"
              color="primary"
              hide-details
              density="compact"
              class="flex-shrink-0"
              @update:model-value="setToolEnabled(tool, $event === true)"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}

.tool-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

/* 筛选 chip 组允许换行，窄屏不出横向滚动条 */
.tools-filter-group {
  flex-wrap: wrap !important;
}

/* 工具行说明允许换行，不截断 */
.tool-desc {
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
