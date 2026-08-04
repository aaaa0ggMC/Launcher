<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { FtUiState } from '../types'
import { translate } from '@ui/i18n'

export interface FtPresetMeta {
  name: string
  description: string
}

const state = inject('ft:state') as FtUiState
const presets = inject('ft:presets') as Ref<FtPresetMeta[]>
const loading = inject('ft:presetLoading') as Ref<boolean>
const loadPreset = inject('ft:loadPreset') as (name: string) => Promise<void>

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="d-flex flex-column ga-1">
    <v-btn
      v-for="p in presets"
      :key="p.name"
      variant="tonal"
      :color="state.currentPreset === p.name ? 'primary' : ''"
      :loading="loading && state.currentPreset === p.name"
      size="small"
      class="justify-space-between px-3"
      @click="loadPreset(p.name)"
    >
      <span>{{ t('ft.preset.' + p.name, p.name) }}</span>
      <span class="text-caption on-surface-variant">
        {{ t('ft.presetDesc.' + p.name, p.description) }}
      </span>
    </v-btn>
  </div>
</template>
