<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-zoom' })

import { ref, onMounted } from 'vue'

const uiScale = ref(1.1)

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
    <v-card-title class="text-subtitle-2">界面缩放</v-card-title>
    <v-card-text>
      <div class="d-flex align-center justify-space-between mb-1">
        <span class="text-body-2">缩放比例</span>
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
        <span>小</span>
        <span>默认</span>
        <span>大</span>
      </div>
    </v-card-text>
  </v-card>
</template>
