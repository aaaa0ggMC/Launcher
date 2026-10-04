<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-policy' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 过程卡片收起时预览的步数上限（与主进程 config.ts 的归一化一致） */
const stepsMax = 5

// 最大步数：用本地草稿输入，失焦 / 回车才夹取（1–100）写回 config，
// 避免输入过程中的空值 / 超范围值被自动保存
const stepsDraft = ref('')

watch(
  () => props.config.maxLoopSteps,
  (v) => {
    stepsDraft.value = v === undefined || v === null ? '' : String(v)
  },
  { immediate: true }
)

function commitSteps(): void {
  const parsed = Number.parseInt(stepsDraft.value, 10)
  const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 10
  stepsDraft.value = String(clamped)
  props.config.maxLoopSteps = clamped
}

/** 收起时预览的步数：夹到 0–5（0 = 完全折叠） */
function onPreviewSteps(v: number | null): void {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 1
  props.config.processPreviewSteps = Math.min(stepsMax, Math.max(0, n))
}
</script>

<template>
  <div class="section-page d-flex flex-column ga-2">
    <div class="text-caption text-medium-emphasis mb-2">
      {{ t('yaya.settings.policy_desc', '控制工具调用的确认方式与单次任务的思考步数') }}
    </div>

    <div class="switch-row d-flex align-center ga-3 py-2">
      <div class="min-w-0 flex-grow-1">
        <div class="text-body-2 font-weight-medium">
          {{ t('yaya.settings.auto_approve', '自动允许工具调用') }}
        </div>
        <div class="text-caption text-medium-emphasis switch-desc">
          {{ t('yaya.settings.auto_approve_desc', '打开后调用工具不再逐次弹窗确认') }}
        </div>
      </div>
      <v-switch
        v-model="config.autoApproveTools"
        v-agent-forbidden
        color="primary"
        hide-details
        density="compact"
        class="flex-shrink-0"
      />
    </div>

    <div
      v-if="config.autoApproveTools"
      class="warn-hint d-flex align-center ga-2 mt-2 pa-3 rounded-lg"
    >
      <v-icon icon="mdi-alert-outline" color="warning" size="small" />
      <span class="text-caption">
        {{
          t(
            'yaya.settings.auto_approve_warning',
            '开启后将不经确认直接执行 shell 命令、读写文件等操作，请谨慎评估风险'
          )
        }}
      </span>
    </div>

    <v-text-field
      v-model="stepsDraft"
      :label="t('yaya.settings.max_loop_steps', '最大循环步数')"
      :hint="t('yaya.settings.max_loop_steps_hint', '单次任务中最多连续执行的步数（1–100）')"
      persistent-hint
      type="number"
      min="1"
      max="100"
      step="1"
      variant="outlined"
      class="max-w-field mt-4"
      @blur="commitSteps"
      @keydown.enter.prevent="commitSteps"
    />

    <div class="mt-6">
      <div class="d-flex align-center ga-3">
        <span class="text-body-2 font-weight-medium">
          {{ t('yaya.settings.preview_steps', '收起时显示最近几步') }}
        </span>
        <v-spacer />
        <span class="text-body-2 text-medium-emphasis text-right" style="min-width: 2em">
          {{ config.processPreviewSteps }}
        </span>
      </div>
      <div class="text-caption text-medium-emphasis mt-1 mb-2">
        {{ t('yaya.settings.preview_steps_hint', '过程卡片收起时仍预览最后几步，0 = 完全折叠') }}
      </div>
      <v-slider
        :model-value="config.processPreviewSteps ?? 1"
        :min="0"
        :max="stepsMax"
        :step="1"
        show-ticks
        color="primary"
        hide-details
        density="compact"
        class="preview-slider"
        :aria-label="t('yaya.settings.preview_steps', '收起时显示最近几步')"
        @update:model-value="onPreviewSteps"
      />
    </div>
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}

.warn-hint {
  background: rgba(var(--v-theme-warning), 0.12);
}

/* 开关行说明允许换行，不截断 */
.switch-desc {
  white-space: normal;
  overflow-wrap: anywhere;
}

.max-w-field {
  max-width: 320px;
}

.preview-slider {
  max-width: 320px;
}

@media (max-width: 720px) {
  .max-w-field {
    max-width: 100%;
  }
}
</style>
