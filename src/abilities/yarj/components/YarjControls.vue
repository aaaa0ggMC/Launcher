<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-controls' })

import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

defineProps<{
  explorationActive: boolean
  routePlaybackActive: boolean
  isGlobe: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-exploration'): void
  (e: 'zoom-in'): void
  (e: 'zoom-out'): void
  (e: 'toggle-projection'): void
  (e: 'reset-view'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="yarj-controls">
    <v-btn
      icon
      variant="flat"
      class="yarj-ctrl-btn"
      :class="{ active: explorationActive }"
      :disabled="routePlaybackActive"
      :title="
        routePlaybackActive
          ? '行程播放中，无法开启探索'
          : explorationActive
            ? '退出探索'
            : t('yarj.exploration.title', '我的探索')
      "
      @click="emit('toggle-exploration')"
    >
      <v-icon :color="explorationActive ? 'primary' : undefined">mdi-compass</v-icon>
    </v-btn>
    <v-btn
      icon
      variant="flat"
      class="yarj-ctrl-btn"
      :title="t('yarj.map.zoomIn', '放大')"
      @click="emit('zoom-in')"
    >
      <v-icon>mdi-plus</v-icon>
    </v-btn>
    <v-btn
      icon
      variant="flat"
      class="yarj-ctrl-btn"
      :title="t('yarj.map.zoomOut', '缩小')"
      @click="emit('zoom-out')"
    >
      <v-icon>mdi-minus</v-icon>
    </v-btn>
    <v-btn
      icon
      variant="flat"
      class="yarj-ctrl-btn"
      :title="t('yarj.map.projection', '切换地球/平面')"
      @click="emit('toggle-projection')"
    >
      <v-icon v-if="isGlobe">mdi-earth</v-icon>
      <v-icon v-else>mdi-map-outline</v-icon>
    </v-btn>
    <v-btn
      icon
      variant="flat"
      class="yarj-ctrl-btn"
      :title="t('yarj.map.reset', '复位视图')"
      @click="emit('reset-view')"
    >
      <v-icon>mdi-crosshairs-gps</v-icon>
    </v-btn>
  </div>
</template>

<style scoped>
.yarj-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.yarj-ctrl-btn {
  width: 42px !important;
  height: 42px !important;
  border-radius: 12px !important;
  background: rgba(var(--v-theme-surface), 0.65) !important;
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  transition:
    transform 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.yarj-ctrl-btn:hover {
  color: rgb(var(--v-theme-primary)) !important;
  transform: translateY(-2px);
}
</style>
