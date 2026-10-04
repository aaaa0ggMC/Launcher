<script setup lang="ts">
/**
 * 保存状态小字：保存中（转圈）/ 已保存（2s 后淡出）/ 保存失败（保留到下次成功）。
 * 只占一行里的一小段，不用 v-alert，不单独撑一行。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'

defineOptions({ name: 'cockpit-yaya-settings-save-status' })

const props = defineProps<{
  saving: boolean
  /** 是否显示「已保存」 */
  saved: boolean
  /** 「已保存」是否正在淡出 */
  fading: boolean
  /** 保存失败的错误文案（保留到下次成功） */
  error: string | null
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

type StatusState = 'saving' | 'saved' | 'error' | 'idle'

const state = computed<StatusState>(() => {
  if (props.saving) return 'saving'
  if (props.error) return 'error'
  if (props.saved) return 'saved'
  return 'idle'
})

const text = computed(() => {
  if (state.value === 'saving') return t('yaya.settings.saving', '保存中…')
  if (state.value === 'error') return props.error ?? ''
  if (state.value === 'saved') return t('yaya.settings.saved', '已保存')
  return ''
})
</script>

<template>
  <span
    v-if="state !== 'idle'"
    class="save-status text-caption d-inline-flex align-center ga-1"
    :class="`save-status--${state} ${fading && state === 'saved' ? 'save-status--fading' : ''}`"
    role="status"
    aria-live="polite"
  >
    <v-progress-circircular
      v-if="state === 'saving'"
      indeterminate
      size="12"
      width="2"
      class="save-status-spin"
    />
    <v-icon v-else-if="state === 'error'" icon="mdi-alert-circle-outline" size="12" />
    <v-icon v-else icon="mdi-check" size="12" />
    <span class="save-status-text text-truncate">{{ text }}</span>
  </span>
</template>

<style scoped>
.save-status {
  min-width: 0;
  max-width: 100%;
  transition: opacity 0.35s ease;
}

.save-status--saving {
  color: rgb(var(--v-theme-primary));
}

.save-status--saved {
  color: rgb(var(--v-theme-success));
}

.save-status--error {
  color: rgb(var(--v-theme-error));
}

.save-status--fading {
  opacity: 0;
}

.save-status-text {
  min-width: 0;
}
</style>
