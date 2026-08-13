<script setup lang="ts">
defineOptions({ name: 'cockpit-aidj-model-select' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/**
 * Temporary model switcher — fetch `/v1/models` (via `aidj.get-models`), let the
 * user pick a model on the fly. When the API can't list models (offline /
 * unsupported endpoint) the selector locks (disabled). Selecting persists the
 * model (aidj.model + save-config) so both the next chat and any started
 * persistent session pick it up.
 */
const models = ref<string[]>([])
const model = ref('')
const locked = ref(false)
const loading = ref(true)

async function loadCurrent(): Promise<void> {
  try {
    const r = (await window.cockpit.command('aidj.get-config')) as {
      ok?: boolean
      config?: { preferences?: { model?: string } }
    } | null
    const m = r?.ok && r.config?.preferences?.model
    if (m) model.value = m
  } catch {
    /* keep default */
  }
}

async function refreshModels(): Promise<void> {
  loading.value = true
  try {
    const r = (await window.cockpit.command('aidj.get-models')) as {
      ok?: boolean
      models?: string[]
    } | null
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      models.value = r.models
      locked.value = false
    } else {
      locked.value = true
    }
  } catch {
    locked.value = true
  } finally {
    loading.value = false
  }
}

async function selectModel(v: string | null): Promise<void> {
  if (!v) return
  model.value = v
  await window.cockpit.command('aidj.model', { set: v }).catch(() => {})
  await window.cockpit.command('aidj.save-config').catch(() => {})
}

onMounted(async () => {
  await loadCurrent()
  await refreshModels()
})
</script>

<template>
  <v-select
    :model-value="model"
    :items="models"
    density="compact"
    variant="outlined"
    hide-details
    :disabled="locked"
    :loading="loading"
    :placeholder="
      locked ? t('aidj.modelselect.unavailable', '模型不可用') : t('aidj.modelselect.model', '模型')
    "
    class="model-select"
    @update:model-value="selectModel"
  />
</template>

<style scoped>
.model-select {
  min-width: 140px;
  max-width: 220px;
  flex-shrink: 0;
}
.model-select :deep(.v-field) {
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.model-select :deep(.v-field--disabled) {
  opacity: 0.55;
}
</style>
