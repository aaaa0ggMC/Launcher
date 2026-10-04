<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig } from '../../types'

defineOptions({ name: 'cockpit-yaya-settings-assistant' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

defineProps<{
  /** 同一个 reactive 配置对象，子组件直接改字段，无需 emit */
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)
</script>

<template>
  <div class="section-page d-flex flex-column ga-4">
    <div class="text-caption text-medium-emphasis">
      {{ t('yaya.settings.assistant_desc', '配置助手的显示名称与默认系统提示词') }}
    </div>

    <v-text-field
      v-model="config.assistantName"
      :label="t('yaya.settings.assistant_name', '助手名称')"
      :placeholder="t('yaya.settings.assistant_name_placeholder', 'YAYA')"
      :hint="
        t(
          'yaya.settings.assistant_name_hint',
          '显示在聊天页顶部与消息署名，最长 32 字符，留空恢复默认'
        )
      "
      :counter="32"
      maxlength="32"
      variant="outlined"
      persistent-hint
    />

    <v-textarea
      v-model="config.systemPrompt"
      :label="t('yaya.settings.system_prompt', '系统提示词')"
      :hint="
        t(
          'yaya.settings.system_prompt_hint',
          '所有新会话的默认提示词，可用 {name} 占位符代表助手名称'
        )
      "
      variant="outlined"
      rows="3"
      persistent-hint
    />
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}
</style>
