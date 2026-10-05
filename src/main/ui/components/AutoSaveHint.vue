<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../i18n'
import type { AutoSaveStatus } from '../composables/autoSave'

/** 自动保存状态的一行小字（配合 `useAutoSave`）：替代设置页里的「保存」按钮与 toast。 */
const props = defineProps<{ status: AutoSaveStatus; error?: string }>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (key: string, fallback: string): string => translate(uiLang.value, key, fallback)

const view = computed(() => {
  switch (props.status) {
    case 'pending':
    case 'saving':
      return { icon: 'mdi-sync', text: t('autosave.saving', '正在保存…'), color: '' }
    case 'saved':
      return { icon: 'mdi-check', text: t('autosave.saved', '已自动保存'), color: 'success' }
    case 'error':
      return {
        icon: 'mdi-alert-circle-outline',
        text: `${t('autosave.failed', '保存失败')}${props.error ? `：${props.error}` : ''}`,
        color: 'error'
      }
    default:
      return {
        icon: 'mdi-content-save-check-outline',
        text: t('autosave.idle', '修改后自动保存'),
        color: ''
      }
  }
})
</script>

<template>
  <div
    class="autosave-hint text-caption d-flex align-center ga-1"
    :class="view.color ? `text-${view.color}` : 'text-medium-emphasis'"
    role="status"
    aria-live="polite"
  >
    <v-icon :icon="view.icon" size="16" :class="{ spin: status === 'saving' }" />
    <span>{{ view.text }}</span>
  </div>
</template>

<style scoped>
.autosave-hint {
  min-height: 24px;
}
.spin {
  animation: autosave-spin 1s linear infinite;
}
@keyframes autosave-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
