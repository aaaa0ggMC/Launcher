<script setup lang="ts">
/**
 * 设置 → 助手 → 上下文：对话太长时丢弃或压缩较早的消息（services/context.ts）。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { YayaConfig } from '../../types'
import { normalizeContextConfig, type ContextConfig } from '../../services/context'

defineOptions({ name: 'cockpit-yaya-settings-context' })
/* eslint-disable vue/no-mutating-props -- 与其他设置分区一样直接改外壳持有的配置对象 */

const props = defineProps<{ config: YayaConfig }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

if (!props.config.context) props.config.context = normalizeContextConfig(undefined)
const ctx = computed<ContextConfig>(() => props.config.context ?? normalizeContextConfig(undefined))

const modes = computed(() => [
  { value: 'off', title: t('yaya.context.mode_off', '不处理（总是发送完整历史）') },
  { value: 'drop', title: t('yaya.context.mode_drop', '丢弃较早的消息') },
  { value: 'compress', title: t('yaya.context.mode_compress', '把较早的消息压缩成摘要') }
])

const budgetText = computed({
  get: () => (ctx.value.maxTokens ? String(ctx.value.maxTokens) : ''),
  set: (v: string) => {
    const n = Number(v.trim())
    ctx.value.maxTokens = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  }
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="text-subtitle-2">{{ t('yaya.context.title', '上下文') }}</div>
    <v-select
      v-model="ctx.mode"
      :items="modes"
      :label="t('yaya.context.mode', '对话太长时')"
      variant="outlined"
      :hint="
        t(
          'yaya.context.mode_hint',
          '超出预算时，从较早的一轮切开：丢弃 = 切掉的消息不再发给 AI；压缩 = 先让模型把它们写成摘要（多一次模型调用）。切点会记住，之后的请求前缀不变，提示词缓存照常命中。'
        )
      "
      persistent-hint
    />
    <template v-if="ctx.mode !== 'off'">
      <v-text-field
        v-model="budgetText"
        inputmode="numeric"
        :label="t('yaya.context.budget', '上下文预算（token）')"
        :placeholder="t('yaya.context.budget_auto', '自动')"
        variant="outlined"
        :hint="
          t(
            'yaya.context.budget_hint',
            '留空 = 自动：按模型元数据里的上下文长度的 75%，没有记录时按 96K。按字数估算，不是精确值。'
          )
        "
        persistent-hint
      />
      <div>
        <div class="text-body-2 mb-1">
          {{ t('yaya.context.keep_turns', '始终完整保留最近几轮') }}：{{ ctx.keepTurns }}
        </div>
        <v-slider
          v-model="ctx.keepTurns"
          :min="1"
          :max="20"
          :step="1"
          color="primary"
          hide-details
        />
      </div>
    </template>
  </div>
</template>
