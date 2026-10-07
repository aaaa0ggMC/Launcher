<script setup lang="ts">
/**
 * 工作流写进对话的数据卡片（`ctx.addCard`）：插件给了 `cardViews[type]` 就用它渲染，
 * 否则显示标题 + 卡片自带的 Markdown（markdown-it html:false，原始 HTML 一律转义）。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageNode } from '../types'
import { renderMarkdown } from './markdown'
import { cardViewFor } from './plugin-ui-registry'

const props = defineProps<{ node: MessageNode }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const card = computed(() => props.node.meta?.card)
const view = computed(() => (card.value ? cardViewFor(card.value.pluginId, card.value.type) : null))
const html = computed(() =>
  card.value?.markdown ? renderMarkdown(card.value.markdown, { copy: t('yaya.copy', '复制') }) : ''
)
</script>

<template>
  <div v-if="card" class="data-card" :data-card-type="card.type">
    <component
      :is="view"
      v-if="view"
      :type="card.type"
      :title="card.title"
      :data="card.data"
      :markdown="card.markdown"
      :message-id="node.id"
      :session-id="node.sessionId"
    />
    <div v-else class="data-card-frame">
      <div v-if="card.title" class="data-card-title">
        <v-icon icon="mdi-card-text-outline" size="16" class="flex-shrink-0" />
        <span>{{ card.title }}</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
      <div v-if="html" class="md-body data-card-body" v-html="html" />
    </div>
  </div>
</template>

<style scoped>
.data-card {
  margin: 4px 0 10px;
  min-width: 0;
}
.data-card-frame {
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.data-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  margin-bottom: 4px;
}
.data-card-body {
  font-size: 0.875rem;
}
</style>
