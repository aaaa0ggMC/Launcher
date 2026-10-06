<script setup lang="ts">
/**
 * 对话里的上下文切点：这条之前的消息已压缩成摘要 / 不再发给 AI。
 * 点「查看摘要」看模型写的摘要，点「恢复完整上下文」清掉切点（下次运行发完整历史，超出预算会重新切）。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ContextState } from '../services/context'

const props = defineProps<{ state: ContextState }>()
const emit = defineEmits<{ (e: 'reset'): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const showSummary = ref(false)
const compressed = computed(() => props.state.mode === 'compress' && !!props.state.summary)
const label = computed(() =>
  compressed.value
    ? te(
        'yaya.context.marker_compress',
        { n: String(props.state.dropped) },
        '以上 {n} 条消息已压缩成摘要'
      )
    : te(
        'yaya.context.marker_drop',
        { n: String(props.state.dropped) },
        '以上 {n} 条消息不再发给 AI'
      )
)
const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))
const detail = computed(() =>
  te(
    'yaya.context.marker_tokens',
    { before: fmt(props.state.before), after: fmt(props.state.after) },
    '约 {before} → {after} token'
  )
)
</script>

<template>
  <div class="context-marker" role="separator" :aria-label="label">
    <div class="marker-line" />
    <div class="marker-body">
      <div class="marker-text text-caption text-medium-emphasis">
        <v-icon
          :icon="compressed ? 'mdi-archive-arrow-down-outline' : 'mdi-content-cut'"
          size="16"
          class="marker-icon"
        />
        {{ label }} · {{ detail }}
      </div>
      <div class="marker-actions">
        <v-btn v-if="compressed" variant="text" size="small" @click="showSummary = true">
          {{ t('yaya.context.view_summary', '查看摘要') }}
        </v-btn>
        <v-btn variant="text" size="small" @click="emit('reset')">
          {{ t('yaya.context.reset', '恢复完整上下文') }}
        </v-btn>
      </div>
    </div>
    <div class="marker-line" />

    <v-dialog v-model="showSummary" max-width="640" scrollable>
      <v-card class="yaya-pop" rounded="xl">
        <v-card-title class="px-6 pt-5 pb-2">
          {{ t('yaya.context.summary_title', '较早对话的摘要') }}
        </v-card-title>
        <v-card-text class="px-6 summary-text">{{ state.summary }}</v-card-text>
        <v-card-actions class="px-6 pb-5">
          <v-spacer />
          <v-btn variant="text" @click="showSummary = false">
            {{ t('yaya.context.close', '关闭') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.context-marker {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 16px;
}
.marker-line {
  flex: 1 1 24px;
  border-top: 1px dashed rgba(var(--v-border-color), 0.4);
}
.marker-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 85%;
  text-align: center;
}
.marker-icon {
  vertical-align: -3px;
  margin-right: 4px;
}
.marker-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
}
.summary-text {
  white-space: pre-wrap;
  line-height: 1.6;
}
</style>
