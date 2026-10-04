<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-policy' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

defineProps<{
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)
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
      v-model.number="config.maxLoopSteps"
      :label="t('yaya.settings.max_loop_steps', '最大循环步数')"
      :hint="t('yaya.settings.max_loop_steps_hint', '单次任务中最多连续执行的步数（1–100）')"
      persistent-hint
      type="number"
      min="1"
      max="100"
      step="1"
      variant="outlined"
      class="max-w-field mt-4"
    />
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

@media (max-width: 720px) {
  .max-w-field {
    max-width: 100%;
  }
}
</style>
