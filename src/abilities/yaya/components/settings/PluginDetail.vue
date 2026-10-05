<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { PluginGroupInfo, PluginInfo } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'
import { handleMarkdownClick, renderMarkdown } from '../markdown'
import { settingsViewFor } from '../plugin-ui-registry'
import PluginConfigForm from './PluginConfigForm.vue'
import PluginToolsList from './PluginToolsList.vue'
import { isPluginEnabled, pluginFallbackIcon, setPluginEnabled } from './plugin-state'

defineOptions({ name: 'cockpit-yaya-settings-plugin-detail' })

const props = defineProps<{
  plugin: PluginInfo
  config: YayaConfig
  /** 正在重新连接该插件 */
  restarting?: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'restart', id: string): void
  (e: 'editServer', id: string): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const docsOpen = ref(false)

const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))
/** markdown-it html:false：原始 HTML 一律转义，可直接 v-html */
const docsHtml = computed(() => renderMarkdown(props.plugin.docs ?? '', labels.value))

/** 插件自己在 ui.ts 里提供的配置界面（有它就替代 schema 自动生成的表单） */
const customConfigView = computed(() =>
  props.plugin.config ? settingsViewFor(props.plugin.id, props.plugin.kind) : null
)

function kindLabel(plugin: PluginInfo): string {
  if (plugin.kind === 'mcp') return t('yaya.settings.plugins.kind_mcp', 'MCP')
  if (plugin.kind === 'skill') return t('yaya.settings.plugins.kind_skill', 'Skill')
  return t('yaya.settings.plugins.kind_builtin', '内置')
}

function statusText(plugin: PluginInfo): string {
  if (plugin.status.state === 'connecting')
    return t('yaya.settings.plugins.status_connecting', '连接中')
  if (plugin.status.state === 'error') return t('yaya.settings.plugins.status_error', '错误')
  if (plugin.status.state === 'idle') return t('yaya.settings.plugins.status_idle', '未连接')
  return t('yaya.settings.plugins.status_ready', '就绪')
}

function statusColor(plugin: PluginInfo): string | undefined {
  if (plugin.status.state === 'error') return 'error'
  if (plugin.status.state === 'connecting') return 'info'
  if (plugin.status.state === 'idle') return undefined
  return 'success'
}

function groupStatusText(group: PluginGroupInfo): string {
  if (group.status.state === 'error')
    return group.status.message || t('yaya.settings.plugins.status_error', '错误')
  if (group.status.state === 'connecting')
    return t('yaya.settings.plugins.status_connecting', '连接中')
  if (group.status.state === 'idle') return t('yaya.settings.plugins.status_idle', '未连接')
  return t('yaya.settings.plugins.status_ready', '就绪')
}

/** 分组不可用的原因（被关掉 / 状态不是就绪） */
function groupUnavailableReason(group: PluginGroupInfo): string {
  if (!group.enabled)
    return t('yaya.settings.plugins.group_off_reason', '已关闭，该分组的工具不会提供给助手')
  return group.status.message || t('yaya.settings.plugins.group_not_ready', '该分组此刻不可用')
}

/** 分组开关：直接调命令（保存 / 刷新 / 广播都在主进程做） */
function toggleGroup(group: PluginGroupInfo, on: boolean): void {
  void window.cockpit
    .command('yaya.plugin-group-set', { id: props.plugin.id, group: group.id, enabled: on })
    .catch((err) => console.error('failed to toggle plugin group', err))
}

function toggleEnabled(on: boolean): void {
  setPluginEnabled(props.config, props.plugin, on)
}

function onDocsClick(ev: MouseEvent): void {
  // 代码块复制按钮 / 外链点击
  handleMarkdownClick(ev, labels.value.copy)
}
</script>

<template>
  <div class="plugin-detail d-flex flex-column ga-4">
    <v-btn
      variant="text"
      prepend-icon="mdi-chevron-left"
      class="align-self-start"
      @click="emit('back')"
    >
      {{ t('yaya.settings.plugins.back', '返回插件列表') }}
    </v-btn>

    <!-- 标题行：图标 / 名称 / 类型 / 状态 / 启用开关 -->
    <div class="detail-head d-flex flex-wrap align-center ga-3">
      <v-icon
        :icon="plugin.icon || pluginFallbackIcon(plugin)"
        color="primary"
        size="28"
        class="flex-shrink-0"
      />
      <span class="text-h6 font-weight-bold min-w-0 detail-title">{{ plugin.label }}</span>
      <v-chip variant="tonal" class="chip-pad flex-shrink-0">
        {{ kindLabel(plugin) }}
      </v-chip>
      <v-chip
        v-if="plugin.status.state !== 'ready'"
        variant="tonal"
        :color="statusColor(plugin)"
        class="chip-pad flex-shrink-0"
      >
        <v-progress-circular
          v-if="plugin.status.state === 'connecting'"
          indeterminate
          size="12"
          width="2"
          class="me-1"
        />
        {{ statusText(plugin)
        }}<template v-if="plugin.status.message">：{{ plugin.status.message }}</template>
      </v-chip>
      <v-spacer />
      <div class="d-flex align-center ga-2 flex-shrink-0">
        <span class="text-caption text-medium-emphasis">
          {{ t('yaya.settings.plugins.enable_plugin', '启用该插件') }}
        </span>
        <v-switch
          :model-value="isPluginEnabled(config, plugin)"
          color="primary"
          hide-details
          density="compact"
          @update:model-value="toggleEnabled($event === true)"
        />
      </div>
    </div>

    <div class="text-body-2 detail-desc">{{ plugin.description }}</div>

    <div v-if="plugin.instructionsChars > 0" class="text-caption text-medium-emphasis">
      {{
        te(
          'yaya.settings.plugins.instructions_chars',
          { n: String(plugin.instructionsChars) },
          '会向系统提示词加入约 {n} 字'
        )
      }}
    </div>

    <!-- MCP 插件：重新连接 / 编辑服务器 -->
    <div v-if="plugin.kind === 'mcp'" class="d-flex flex-wrap align-center ga-2">
      <v-btn
        variant="tonal"
        prepend-icon="mdi-restart"
        :loading="restarting"
        @click="emit('restart', plugin.id)"
      >
        {{ t('yaya.settings.plugins.reconnect', '重新连接') }}
      </v-btn>
      <v-btn
        variant="text"
        prepend-icon="mdi-pencil-outline"
        @click="emit('editServer', plugin.id)"
      >
        {{ t('yaya.settings.plugins.edit', '编辑服务器') }}
      </v-btn>
    </div>

    <v-divider
      v-if="plugin.docs || plugin.tools.length > 0 || plugin.groups?.length || plugin.config"
    />

    <!-- 文档：Markdown 渲染，默认折叠 -->
    <div v-if="plugin.docs" class="docs-box rounded-lg border">
      <v-btn
        variant="text"
        block
        class="justify-start docs-toggle"
        :append-icon="docsOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        @click="docsOpen = !docsOpen"
      >
        {{ t('yaya.settings.plugins.docs', '查看说明') }}
      </v-btn>
      <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
      <div v-if="docsOpen" class="docs-body md-body pa-3" @click="onDocsClick" v-html="docsHtml" />
    </div>

    <!-- 子分组：每组一行（名称 / 说明 / 状态 / 开关），关掉后整组工具不提供给助手 -->
    <div v-if="plugin.groups && plugin.groups.length > 0" class="d-flex flex-column ga-2">
      <span class="text-body-2 font-weight-medium">
        {{ t('yaya.settings.plugins.groups_title', '分组') }}
      </span>
      <div class="text-caption text-medium-emphasis">
        {{
          t('yaya.settings.plugins.groups_desc', '分组不可用或被关闭时，该分组的工具不会提供给助手')
        }}
      </div>
      <div
        v-for="group in plugin.groups"
        :key="group.id"
        class="group-row d-flex flex-wrap align-center ga-3 py-3 px-3 rounded-lg border"
      >
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex align-center flex-wrap ga-2">
            <span class="text-body-2 font-weight-medium">{{ group.label }}</span>
            <span
              class="status-dot flex-shrink-0"
              :class="group.available ? 'status-dot--ok' : 'status-dot--off'"
              :title="group.available ? groupStatusText(group) : groupUnavailableReason(group)"
            />
            <span class="text-caption text-medium-emphasis">
              {{ group.available ? groupStatusText(group) : groupUnavailableReason(group) }}
            </span>
          </div>
          <div v-if="group.description" class="text-caption text-medium-emphasis group-desc">
            {{ group.description }}
          </div>
        </div>
        <v-switch
          :model-value="group.enabled"
          color="primary"
          hide-details
          density="compact"
          class="flex-shrink-0"
          :title="
            te('yaya.settings.plugins.group_toggle_named', { name: group.label }, '启用分组 {name}')
          "
          :aria-label="
            te('yaya.settings.plugins.group_toggle_named', { name: group.label }, '启用分组 {name}')
          "
          @update:model-value="toggleGroup(group, $event === true)"
        />
      </div>
    </div>

    <!-- 插件配置：插件自定义界面优先，否则按 schema 自动生成表单 -->
    <div v-if="plugin.config" class="d-flex flex-column ga-2">
      <span class="text-body-2 font-weight-medium">
        {{ t('yaya.settings.plugins.config_title', '配置') }}
      </span>
      <component
        :is="customConfigView"
        v-if="customConfigView"
        :plugin-id="plugin.id"
        :info="plugin"
      />
      <PluginConfigForm
        v-else
        :plugin="plugin"
        :schema="plugin.config.schema"
        :values="plugin.config.values"
        :secrets-set="plugin.config.secretsSet"
      />
    </div>

    <!-- 该插件的工具（有分组时按分组小标题分组显示） -->
    <div class="d-flex flex-column ga-2">
      <span class="text-body-2 font-weight-medium">
        {{
          te('yaya.settings.plugins.tools_count', { n: String(plugin.tools.length) }, '{n} 个工具')
        }}
      </span>
      <PluginToolsList
        v-if="plugin.tools.length > 0"
        :config="config"
        :tools="plugin.tools"
        :groups="plugin.groups"
        :dimmed="!isPluginEnabled(config, plugin)"
      />
      <div v-else class="text-body-2 text-medium-emphasis py-2">
        {{ t('yaya.settings.plugins.tools_empty', '该插件没有提供任何工具') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-detail {
  width: 100%;
  min-width: 0;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.detail-title {
  overflow-wrap: anywhere;
}

.detail-desc {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 分组行：背景与工具行一致，状态点 + 说明 + 开关 */
.group-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.status-dot--ok {
  background: rgb(var(--v-theme-success));
}

.status-dot--off {
  background: rgba(var(--v-theme-on-surface), 0.38);
}

.group-desc {
  margin-top: 2px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.docs-box {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  min-width: 0;
  overflow: hidden;
}

.docs-toggle {
  min-height: 44px;
}

.docs-body {
  font-size: 0.95rem;
  line-height: 1.7;
  word-break: break-word;
  min-width: 0;
}

.docs-body :deep(> :first-child) {
  margin-top: 0;
}

.docs-body :deep(> :last-child) {
  margin-bottom: 0;
}

.docs-body :deep(p),
.docs-body :deep(ul),
.docs-body :deep(ol),
.docs-body :deep(blockquote),
.docs-body :deep(table) {
  margin: 0 0 0.75em;
}

.docs-body :deep(ul),
.docs-body :deep(ol) {
  padding-left: 1.4em;
}

.docs-body :deep(h1),
.docs-body :deep(h2),
.docs-body :deep(h3),
.docs-body :deep(h4) {
  margin: 1.1em 0 0.5em;
  line-height: 1.35;
  font-weight: 600;
}

.docs-body :deep(h1) {
  font-size: 1.3rem;
}

.docs-body :deep(h2) {
  font-size: 1.15rem;
}

.docs-body :deep(h3) {
  font-size: 1.02rem;
}

.docs-body :deep(a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}

.docs-body :deep(blockquote) {
  padding-left: 12px;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.2);
  color: rgba(var(--v-theme-on-surface), 0.75);
}

.docs-body :deep(:not(pre) > code) {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  font-family: ui-monospace, monospace;
  font-size: 0.86em;
}

.docs-body :deep(pre) {
  margin: 0 0 0.75em;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface-variant), 0.45);
  overflow-x: auto;
}

.docs-body :deep(pre code) {
  font-family: ui-monospace, monospace;
  font-size: 0.86em;
}

.docs-body :deep(.md-code) {
  margin: 0 0 0.75em;
  border-radius: 10px;
  overflow: hidden;
}

.docs-body :deep(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  max-width: 100%;
}

.docs-body :deep(th),
.docs-body :deep(td) {
  padding: 6px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

@media (max-width: 720px) {
  .detail-head {
    gap: 8px;
  }
}
</style>
