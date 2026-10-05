<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import type { PluginGroupInfo, PluginToolInfo } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'
import {
  approvalChipColor,
  approvalFromGlobal,
  effectiveApproval,
  setToolApproval,
  setToolEnabled,
  type ApprovalChoice
} from './plugin-state'

defineOptions({ name: 'cockpit-yaya-settings-plugin-tools' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  config: YayaConfig
  /** 只列这些工具（通常来自同一个插件） */
  tools: PluginToolInfo[]
  /** 插件未启用：整体置灰但仍可浏览 */
  dimmed?: boolean
  /** 插件的子分组（有则按分组小标题分组显示） */
  groups?: PluginGroupInfo[]
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const query = ref('')
type ToolFilter = 'all' | 'enabled' | 'disabled' | 'approval'
const filter = ref<ToolFilter>('all')

const filteredTools = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.tools.filter((tool) => {
    if (q && !tool.name.toLowerCase().includes(q) && !tool.description.toLowerCase().includes(q))
      return false
    if (filter.value === 'enabled' && !tool.enabled) return false
    if (filter.value === 'disabled' && tool.enabled) return false
    // 「需确认」按生效值过滤：显式设置 > 全局自动允许 > 提供方默认
    if (filter.value === 'approval' && effectiveApproval(props.config, tool) === 'auto')
      return false
    return true
  })
})

interface ToolSection {
  id: string
  label: string
  tools: PluginToolInfo[]
}

/** 插件声明了分组时按分组小标题分组显示（group 指向不存在的分组 = 无分组） */
const sections = computed<ToolSection[]>(() => {
  const groups = props.groups ?? []
  if (groups.length === 0) return [{ id: '', label: '', tools: filteredTools.value }]
  const byId = new Map<string, PluginToolInfo[]>()
  const plain: PluginToolInfo[] = []
  for (const tool of filteredTools.value) {
    if (tool.group && groups.some((g) => g.id === tool.group)) {
      const list = byId.get(tool.group) ?? []
      list.push(tool)
      byId.set(tool.group, list)
    } else plain.push(tool)
  }
  const out: ToolSection[] = groups
    .map((g) => ({ id: g.id, label: g.label, tools: byId.get(g.id) ?? [] }))
    .filter((s) => s.tools.length > 0)
  if (plain.length > 0)
    out.push({
      id: '',
      label: t('yaya.settings.plugins.tools_group_plain', '插件工具'),
      tools: plain
    })
  return out
})

/** 「默认」一档的说明文字带上该工具的提供方默认值 */
function approvalDefaultText(tool: PluginToolInfo): string {
  const [stateKey, stateFallback] =
    tool.defaultApproval === 'auto'
      ? (['yaya.settings.tools_def_auto', '免确认'] as const)
      : tool.defaultApproval === 'dynamic'
        ? (['yaya.settings.tools_def_dynamic', '按命令判断'] as const)
        : (['yaya.settings.tools_def_ask', '需确认'] as const)
  return te(
    'yaya.settings.tools_approval_default',
    { state: t(stateKey, stateFallback) },
    '默认（{state}）'
  )
}

/** 审批三档按钮 */
function approvalOptions(tool: PluginToolInfo): Array<{ value: ApprovalChoice; text: string }> {
  return [
    { value: 'default', text: approvalDefaultText(tool) },
    { value: 'ask', text: t('yaya.settings.tools_approval_ask', '总是确认') },
    { value: 'auto', text: t('yaya.settings.tools_approval_auto', '自动执行') }
  ]
}

function approvalValue(tool: PluginToolInfo): ApprovalChoice {
  return props.config.toolApproval?.[tool.wireName] ?? 'default'
}

function approvalChipText(tool: PluginToolInfo): string {
  const eff = effectiveApproval(props.config, tool)
  if (eff === 'auto') {
    return approvalFromGlobal(props.config, tool)
      ? t('yaya.settings.tools_eff_auto_global', '自动执行（全局）')
      : t('yaya.settings.tools_eff_auto', '自动执行')
  }
  if (eff === 'dynamic') return t('yaya.settings.tools_eff_dynamic', '按命令确认')
  return t('yaya.settings.tool_needs_approval', '需确认')
}

/** 全部启用 / 全部禁用当前筛选结果 */
function bulkSetEnabled(on: boolean): void {
  for (const tool of filteredTools.value) {
    if (tool.enabled !== on) setToolEnabled(props.config, tool, on)
  }
}

/** 把当前筛选结果的审批全部恢复到提供方默认（删除显式覆盖的键） */
function bulkResetApproval(): void {
  const next: Record<string, 'ask' | 'auto'> = { ...(props.config.toolApproval ?? {}) }
  let changed = false
  for (const tool of filteredTools.value) {
    if (!(tool.wireName in next)) continue
    delete next[tool.wireName]
    changed = true
  }
  if (changed) props.config.toolApproval = next
}

// 容器 < 560px（如手机 / 窄分栏）时审批控件换到描述下方独立一行，
// 用 ResizeObserver 量容器而不是窗口断点——设置页可能嵌在别处或被缩放。
const stack = ref<HTMLElement | null>(null)
const narrowRow = ref(false)
let resizeObs: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (stack.value) {
    narrowRow.value = stack.value.clientWidth < 560
    resizeObs = new ResizeObserver(() => {
      narrowRow.value = (stack.value?.clientWidth ?? 0) < 560
    })
    resizeObs.observe(stack.value)
  }
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
})
</script>

<template>
  <div class="tools-stack d-flex flex-column ga-3" :class="{ 'tools-stack--dim': dimmed }">
    <div class="text-caption text-medium-emphasis">
      {{ t('yaya.settings.tools_desc', '关闭后该工具不再提供给助手调用') }}
    </div>
    <div class="text-caption text-medium-emphasis">
      {{
        t(
          'yaya.settings.tools_approval_hint',
          '全局『自动允许工具调用』在执行策略里；对单个工具的设置优先于全局开关。'
        )
      }}
    </div>

    <template v-if="tools.length > 0">
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
          <v-btn variant="text" prepend-icon="mdi-backup-restore" @click="bulkResetApproval()">
            {{
              te(
                'yaya.settings.tools_reset_approval_all',
                { n: String(filteredTools.length) },
                '全部恢复默认审批（{n}）'
              )
            }}
          </v-btn>
        </div>
      </div>
    </template>

    <div
      v-if="tools.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon icon="mdi-wrench-outline" size="32" />
      <span class="text-body-2">
        {{ t('yaya.settings.plugins.tools_empty', '该插件没有提供任何工具') }}
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
    <div v-else ref="stack" class="d-flex flex-column ga-3">
      <template v-for="section in sections" :key="section.id || 'plain'">
        <div class="d-flex flex-column ga-2">
          <span v-if="section.label" class="text-caption font-weight-medium text-medium-emphasis">
            {{ section.label }}
          </span>
          <div
            v-for="tool in section.tools"
            :key="tool.wireName"
            class="tool-row d-flex flex-wrap align-center ga-3 py-3 px-3 rounded-lg border"
            :class="{ 'tool-row-narrow': narrowRow }"
          >
            <div class="min-w-0 flex-grow-1">
              <div class="d-flex align-center flex-wrap ga-2">
                <span class="font-family-mono text-body-2 font-weight-medium">
                  {{ tool.wireName }}
                </span>
                <v-chip
                  variant="tonal"
                  :color="approvalChipColor(effectiveApproval(config, tool))"
                  class="chip-pad flex-shrink-0"
                >
                  {{ approvalChipText(tool) }}
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis tool-desc">
                {{ tool.description }}
              </div>
            </div>
            <v-btn-toggle
              :model-value="approvalValue(tool)"
              class="approval-toggle flex-shrink-0"
              density="comfortable"
              variant="outlined"
              divided
              mandatory
              :disabled="!tool.enabled"
              @update:model-value="setToolApproval(config, tool, $event)"
            >
              <v-btn v-for="opt in approvalOptions(tool)" :key="opt.value" :value="opt.value">
                {{ opt.text }}
              </v-btn>
            </v-btn-toggle>
            <v-switch
              :model-value="tool.enabled"
              color="primary"
              hide-details
              density="compact"
              class="flex-shrink-0"
              @update:model-value="setToolEnabled(config, tool, $event === true)"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tools-stack {
  width: 100%;
  min-width: 0;
}

/* 插件未启用：工具列表整体置灰，但仍可浏览 */
.tools-stack--dim {
  opacity: 0.55;
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

/* 容器放不下时审批控件换到描述下方独立一行（flex 100% 触发换行） */
.tool-row-narrow .approval-toggle {
  flex: 0 0 100%;
  margin-top: 8px;
  /* 窄屏允许按钮自身换行，不在 toggle 内部出横向滚动条 */
  flex-wrap: wrap;
  height: auto !important;
  overflow: visible;
}

/* 审批按钮文字不裁切 */
.approval-toggle :deep(.v-btn) {
  white-space: nowrap;
}
</style>
