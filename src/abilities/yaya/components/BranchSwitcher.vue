<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'

const props = defineProps<{
  /** 同级分支 id（按创建时间） */
  ids: string[]
  current: string
}>()

const emit = defineEmits<{
  (e: 'switch', id: string): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const index = computed(() => Math.max(0, props.ids.indexOf(props.current)))
</script>

<template>
  <div class="branch-switcher">
    <v-btn
      icon="mdi-chevron-left"
      variant="text"
      density="comfortable"
      :disabled="index <= 0"
      :title="t('yaya.branch_prev', '上一个分支')"
      :aria-label="t('yaya.branch_prev', '上一个分支')"
      @click="emit('switch', ids[index - 1])"
    />
    <span class="branch-index">{{ index + 1 }} / {{ ids.length }}</span>
    <v-btn
      icon="mdi-chevron-right"
      variant="text"
      density="comfortable"
      :disabled="index >= ids.length - 1"
      :title="t('yaya.branch_next', '下一个分支')"
      :aria-label="t('yaya.branch_next', '下一个分支')"
      @click="emit('switch', ids[index + 1])"
    />
  </div>
</template>

<style scoped>
.branch-switcher {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.branch-index {
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  min-width: 3em;
  text-align: center;
}
</style>
