<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-zoom' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const uiScale = ref(1.1)
const uiLang = (inject('cockpit:lang', ref('zh')) as Ref<string>)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const scale = Number(cfg?.uiScale)
  uiScale.value = Number.isFinite(scale) && scale > 0 ? scale : 1.1
})

async function commitUiScale(): Promise<void> {
  window.cockpit.setZoom(uiScale.value)
  await window.cockpit.setConfig({ uiScale: uiScale.value })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'zoom.title') }}</v-card-title>
    <v-card-text>
      <div class="d-flex align-center justify-space-between mb-1">
        <span class="text-body-2">{{ translate(uiLang, 'zoom.label') }}</span>
        <span class="text-caption on-surface-variant font-family-mono">
          {{ Math.round(uiScale * 100) }}%
        </span>
      </div>
      <v-slider
        v-model="uiScale"
        :min="0.8"
        :max="1.8"
        :step="0.05"
        color="primary"
        thumb-label
        show-ticks
        hide-details
        @end="commitUiScale"
      />
      <div class="d-flex justify-space-between text-caption on-surface-variant mt-1">
        <span>{{ translate(uiLang, 'zoom.small') }}</span>
        <span>{{ translate(uiLang, 'zoom.default') }}</span>
        <span>{{ translate(uiLang, 'zoom.large') }}</span>
      </div>
    </v-card-text>
  </v-card>
</template>
