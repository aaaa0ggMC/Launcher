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

/** Per-preset leading icon, matching the apps ability's icon+label button style. */
const PRESET_ICONS: Record<string, string> = {
  circle: 'mdi-circle-outline',
  circle3d: 'mdi-orbit',
  torus: 'mdi-ring',
  limacon: 'mdi-chart-arc',
  cardioid: 'mdi-heart-outline',
  square: 'mdi-square-outline',
  star: 'mdi-star-outline',
  heart: 'mdi-heart',
  random: 'mdi-shuffle-variant'
}
</script>

<template>
  <div class="preset-grid">
    <v-btn
      v-for="p in presets"
      :key="p.name"
      variant="tonal"
      :color="state.currentPreset === p.name ? 'primary' : ''"
      :loading="loading && state.currentPreset === p.name"
      :title="t('ft.presetDesc.' + p.name, p.description)"
      class="preset-btn"
      @click="loadPreset(p.name)"
    >
      <v-icon v-if="PRESET_ICONS[p.name]" start :size="18">{{ PRESET_ICONS[p.name] }}</v-icon>
      <span class="preset-btn__label">{{ t('ft.preset.' + p.name, p.name) }}</span>
    </v-btn>
  </div>
</template>

<style scoped>
.preset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.preset-btn {
  width: 100%;
  min-height: 44px;
  padding-inline: 12px;
}

.preset-btn__label {
  font-size: 0.9rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}
</style>
