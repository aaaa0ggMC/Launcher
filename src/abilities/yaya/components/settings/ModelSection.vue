<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import type { WorkflowInfo, YayaConfig } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-model' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

// 默认工作流列表（命令失败 / 列表为空时整项隐藏）
const workflows = ref<WorkflowInfo[]>([])
const workflowsLoaded = ref(false)

onMounted(async () => {
  try {
    const res = (await window.cockpit.command('yaya.workflows-list')) as
      WorkflowInfo[] | { workflows?: WorkflowInfo[] }
    const list = Array.isArray(res) ? res : (res.workflows ?? [])
    if (list.length > 0) {
      workflows.value = list
      workflowsLoaded.value = true
    }
  } catch {
    // 命令不存在或失败：隐藏「默认工作流」这一项
  }
})

/** 默认服务商下拉只列启用中的服务商 */
const enabledProviders = computed(() =>
  (props.config.providers ?? [])
    .filter((p) => p.enabled)
    .map((p) => ({ title: p.name, value: p.id }))
)

/** 默认模型下拉：当前默认服务商的模型列表 */
const activeProviderModels = computed(
  () => props.config.providers.find((p) => p.id === props.config.activeProviderId)?.models ?? []
)

/** 缺省工作流 id 为 'agent' */
const currentWorkflow = computed(() => props.config.defaultWorkflow ?? 'agent')

function pickWorkflow(id: string): void {
  props.config.defaultWorkflow = id
}
</script>

<template>
  <div class="section-page d-flex flex-column ga-4">
    <div class="text-caption text-medium-emphasis">
      {{ t('yaya.settings.model_desc', '新会话默认使用的服务商与模型') }}
    </div>

    <v-row dense>
      <v-col cols="12" sm="6">
        <v-select
          v-model="config.activeProviderId"
          :items="enabledProviders"
          :label="t('yaya.settings.default_provider', '默认服务商')"
          :hint="
            enabledProviders.length === 0
              ? t(
                  'yaya.settings.no_enabled_provider',
                  '暂无已启用的服务商，请先到下方「服务商」分区添加'
                )
              : undefined
          "
          persistent-hint
          variant="outlined"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-combobox
          v-model="config.activeModel"
          :items="activeProviderModels"
          :label="t('yaya.settings.default_model', '默认模型')"
          :placeholder="t('yaya.settings.model_placeholder', '选择或输入模型 ID')"
          variant="outlined"
        />
      </v-col>
    </v-row>

    <template v-if="workflowsLoaded">
      <v-divider class="my-1" />
      <div>
        <div class="text-body-2 font-weight-medium mb-1">
          {{ t('yaya.settings.default_workflow', '默认工作流') }}
        </div>
        <div class="text-caption text-medium-emphasis mb-3">
          {{
            t('yaya.settings.default_workflow_desc', '新会话默认使用的对话模式，会话内仍可随时切换')
          }}
        </div>

        <div class="wf-stack d-flex flex-column ga-2" role="radiogroup">
          <div
            v-for="wf in workflows"
            :key="wf.id"
            class="wf-card d-flex align-start ga-3 pa-3 rounded-lg border"
            :class="{ 'wf-card--active': currentWorkflow === wf.id }"
            role="radio"
            :aria-checked="currentWorkflow === wf.id"
            tabindex="0"
            @click="pickWorkflow(wf.id)"
            @keydown.enter.prevent="pickWorkflow(wf.id)"
            @keydown.space.prevent="pickWorkflow(wf.id)"
          >
            <v-icon
              :icon="currentWorkflow === wf.id ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'"
              :color="currentWorkflow === wf.id ? 'primary' : undefined"
              size="20"
              class="mt-1 flex-shrink-0"
            />
            <div class="min-w-0 flex-grow-1">
              <div class="d-flex align-center flex-wrap ga-2">
                <span class="font-weight-bold text-body-2">{{ wf.label }}</span>
                <v-chip
                  v-if="!wf.usesTools"
                  size="small"
                  variant="tonal"
                  class="chip-pad flex-shrink-0"
                >
                  {{ t('yaya.settings.workflow_no_tools', '不调用工具') }}
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis wf-desc">
                {{ wf.description }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}

.wf-card {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
  cursor: pointer;
}

.wf-card--active {
  border-color: rgb(var(--v-theme-primary)) !important;
  border-width: 2px;
  background: rgba(var(--v-theme-primary), 0.1);
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.wf-desc {
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
