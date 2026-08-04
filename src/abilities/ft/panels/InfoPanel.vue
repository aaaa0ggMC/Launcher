<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { FtUiState } from '../types'
import { translate } from '@ui/i18n'

const state = inject('ft:state') as FtUiState

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="info-grid">
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.status') }}</span>
      <span class="info-value">
        <v-icon size="14" :color="state.running ? 'success' : 'warning'" class="mr-1">
          {{ state.running ? 'mdi-play-circle' : 'mdi-pause-circle' }}
        </v-icon>
        {{ state.running ? t('ft.info.running') : t('ft.info.paused') }}
      </span>
    </div>
    <div class="info-cell">
      <span class="info-label">FPS</span>
      <span class="info-value font-family-mono">
        {{ state.fps }}<span class="on-surface-variant"> / {{ state.maxFps }}</span>
      </span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.time') }}</span>
      <span class="info-value font-family-mono">{{ state.time.toFixed(2) }} s</span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.vectors') }}</span>
      <span class="info-value font-family-mono">{{ state.vectorCount }}</span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.points') }}</span>
      <span class="info-value font-family-mono">
        {{ state.trackCount }}<span class="on-surface-variant"> / {{ state.verticesLimit }}</span>
      </span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.tip') }}</span>
      <span class="info-value font-family-mono">
        ({{ state.tip.x.toFixed(1) }}, {{ state.tip.y.toFixed(1) }})
      </span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.mode') }}</span>
      <span class="info-value">{{ state.mode === '3d' ? '3D' : '2D' }}</span>
    </div>
    <div class="info-cell">
      <span class="info-label">{{ t('ft.info.zoom') }}</span>
      <span class="info-value font-family-mono">×{{ state.zoom.toFixed(2) }}</span>
    </div>
  </div>
</template>

<style scoped>
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}

.info-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.info-label {
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  margin-bottom: 1px;
}

.info-value {
  font-size: 0.875rem;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
