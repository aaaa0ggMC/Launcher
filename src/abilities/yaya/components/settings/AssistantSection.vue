<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig } from '../../types'
import ProfileSection from './ProfileSection.vue'

defineOptions({ name: 'cockpit-yaya-settings-assistant' })

// config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  /** 同一个 reactive 配置对象，子组件直接改字段，无需 emit */
  config: YayaConfig
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 系统提示词变量（与 services/prompt-vars.ts 的 PROMPT_VARS 对应）：点一下插到光标处 */
const VARS = computed<{ key: string; token: string; label: string }[]>(() =>
  [
    { key: 'name', label: t('yaya.settings.var_name', '助手名称') },
    { key: 'user', label: t('yaya.settings.var_user', '你的名字（「形象」里设置）') },
    { key: 'model', label: t('yaya.settings.var_model', '当前模型') },
    { key: 'provider', label: t('yaya.settings.var_provider', '模型服务商') },
    { key: 'date', label: t('yaya.settings.var_date', '日期，如 2026-10-06') },
    { key: 'time', label: t('yaya.settings.var_time', '时间，如 14:05') },
    { key: 'datetime', label: t('yaya.settings.var_datetime', '日期和时间') },
    { key: 'weekday', label: t('yaya.settings.var_weekday', '星期几') },
    { key: 'timezone', label: t('yaya.settings.var_timezone', '时区') },
    { key: 'system', label: t('yaya.settings.var_system', '操作系统，如 Arch Linux / Android') },
    { key: 'power', label: t('yaya.settings.var_power', '电量与充电状态') },
    { key: 'language', label: t('yaya.settings.var_language', '界面语言') }
  ].map((v) => ({ ...v, token: `{${v.key}}` }))
)

const promptField = ref<{ $el?: HTMLElement } | null>(null)

async function insertVar(key: string): Promise<void> {
  const token = `{${key}}`
  const el = promptField.value?.$el?.querySelector('textarea') ?? null
  const text = props.config.systemPrompt ?? ''
  const start = el?.selectionStart ?? text.length
  const end = el?.selectionEnd ?? text.length
  props.config.systemPrompt = text.slice(0, start) + token + text.slice(end)
  await nextTick()
  if (el) {
    el.focus()
    el.setSelectionRange(start + token.length, start + token.length)
  }
}
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
      ref="promptField"
      v-model="config.systemPrompt"
      :label="t('yaya.settings.system_prompt', '系统提示词')"
      :hint="
        t(
          'yaya.settings.system_prompt_hint',
          '所有新会话的默认提示词，可以插入下面的变量，发送时替换成实际值'
        )
      "
      variant="outlined"
      rows="3"
      persistent-hint
    />

    <div class="d-flex flex-column ga-2">
      <div class="d-flex flex-wrap ga-2">
        <button
          v-for="v in VARS"
          :key="v.key"
          type="button"
          class="var-chip"
          :title="v.label"
          :aria-label="`${t('yaya.settings.var_insert', '插入变量')} ${v.token}: ${v.label}`"
          @click="insertVar(v.key)"
        >
          <code>{{ v.token }}</code>
          <span class="text-medium-emphasis">{{ v.label }}</span>
        </button>
      </div>
      <div class="text-caption text-medium-emphasis">
        {{
          t(
            'yaya.settings.var_hint',
            '变量在每次运行开始时取值。{time}、{power} 这类会变的变量会让每次运行的提示词都不同，提示词缓存会失效，费用更高。'
          )
        }}
      </div>
    </div>

    <v-divider />
    <ProfileSection :config="config" />
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}
.var-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.04);
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}
.var-chip:hover {
  background: rgba(var(--v-theme-primary), 0.1);
}
.var-chip code {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
</style>
