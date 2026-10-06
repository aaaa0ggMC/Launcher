<script setup lang="ts">
/**
 * 导出去向（Electron）：原生保存对话框加不了按钮，所以导出前先在这里选
 * 「保存为文件…」还是「复制到剪贴板」。网页版由 HostFilePicker 的保存模式提供同样的按钮。
 * 请求来自 composables/export.ts 的 `pickExportTarget`。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../i18n'
import type { ExportTargetRequest } from '../composables/export'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)

const req = ref<ExportTargetRequest | null>(null)
const open = ref(false)

const fileName = computed(() => {
  const p = req.value?.opts.defaultPath ?? ''
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
})

function onRequest(ev: Event): void {
  const detail = (ev as CustomEvent<ExportTargetRequest>).detail
  detail.handled = true
  req.value?.resolve(null)
  req.value = detail
  open.value = true
}

function finish(choice: 'file' | 'clipboard' | null): void {
  const r = req.value
  req.value = null
  open.value = false
  r?.resolve(choice)
}

onMounted(() => window.addEventListener('cockpit:export-target', onRequest))
onBeforeUnmount(() => {
  window.removeEventListener('cockpit:export-target', onRequest)
  finish(null)
})
</script>

<template>
  <v-dialog v-model="open" max-width="440" @update:model-value="(v: boolean) => !v && finish(null)">
    <v-card class="pa-2">
      <v-card-title class="text-h6 pt-4 px-4">
        {{ req?.opts.title || t('export.title', '导出') }}
      </v-card-title>
      <v-card-text class="px-4 pb-2 text-medium-emphasis">
        <div v-if="fileName" class="file-name">{{ fileName }}</div>
        {{ t('export.desc', '保存为文件，或者直接复制到剪贴板。') }}
      </v-card-text>
      <v-card-actions class="px-4 pb-4 ga-2 flex-wrap">
        <v-btn variant="text" @click="finish(null)">{{ t('export.cancel', '取消') }}</v-btn>
        <v-spacer />
        <v-btn variant="tonal" prepend-icon="mdi-content-copy" @click="finish('clipboard')">
          {{ t('export.clipboard', '复制到剪贴板') }}
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-content-save-outline"
          @click="finish('file')"
        >
          {{ t('export.file', '保存为文件…') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.file-name {
  margin-bottom: 8px;
  font-family: monospace;
  color: rgb(var(--v-theme-on-surface));
  word-break: break-all;
}
</style>
