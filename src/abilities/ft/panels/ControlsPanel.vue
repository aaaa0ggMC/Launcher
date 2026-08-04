<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { FtUiState } from '../types'
import { translate } from '@ui/i18n'

const state = inject('ft:state') as FtUiState
const emit = defineEmits<{ repaint: []; resetView: [] }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="d-flex flex-column ga-3">
    <!-- playback row -->
    <div class="d-flex ga-2">
      <v-btn
        variant="tonal"
        :color="state.running ? '' : 'success'"
        :prepend-icon="state.running ? 'mdi-pause' : 'mdi-play'"
        @click="state.running = !state.running"
      >
        {{ state.running ? t('ft.ctrl.pause') : t('ft.ctrl.play') }}
      </v-btn>
      <v-btn variant="tonal" prepend-icon="mdi-eraser" @click="emit('repaint')">
        {{ t('ft.ctrl.repaint') }}
      </v-btn>
      <v-btn variant="tonal" prepend-icon="mdi-crosshairs-gps" @click="emit('resetView')">
        {{ t('ft.ctrl.resetView') }}
      </v-btn>
    </div>

    <!-- toggles -->
    <div class="d-flex flex-column ga-1">
      <v-switch
        v-model="state.follow"
        density="compact"
        hide-details
        color="primary"
        :label="t('ft.ctrl.follow')"
      />
      <v-switch
        v-model="state.neon"
        density="compact"
        hide-details
        color="primary"
        :label="t('ft.ctrl.neon')"
      />
      <v-switch
        :model-value="state.mode === '3d'"
        density="compact"
        hide-details
        color="primary"
        :label="t('ft.ctrl.mode3d')"
        @update:model-value="state.mode = $event ? '3d' : '2d'"
      />
    </div>

    <!-- display toggles -->
    <div class="d-flex flex-wrap ga-1">
      <v-checkbox
        v-model="state.show.vectors"
        density="compact"
        hide-details
        :label="t('ft.ctrl.vectors')"
      />
      <v-checkbox
        v-model="state.show.circles"
        density="compact"
        hide-details
        :label="t('ft.ctrl.circles')"
      />
      <v-checkbox
        v-model="state.show.coords"
        density="compact"
        hide-details
        :label="t('ft.ctrl.coords')"
      />
      <v-checkbox
        v-model="state.show.track"
        density="compact"
        hide-details
        :label="t('ft.ctrl.track')"
      />
      <v-checkbox
        v-model="state.show.final"
        density="compact"
        hide-details
        :label="t('ft.ctrl.final')"
      />
    </div>

    <!-- sliders -->
    <div>
      <div class="d-flex justify-space-between text-caption on-surface-variant">
        <span>{{ t('ft.ctrl.speed') }}</span>
        <span class="font-family-mono">{{ state.runSpeed.toFixed(2) }}</span>
      </div>
      <v-slider
        v-model="state.runSpeed"
        :min="0.05"
        :max="4"
        :step="0.05"
        density="compact"
        hide-details
      />
    </div>
    <div>
      <div class="d-flex justify-space-between text-caption on-surface-variant">
        <span>{{ t('ft.ctrl.pointsLimit') }}</span>
        <span class="font-family-mono">{{ state.verticesLimit }}</span>
      </div>
      <v-slider
        v-model="state.verticesLimit"
        :min="200"
        :max="8000"
        :step="200"
        density="compact"
        hide-details
      />
    </div>
  </div>
</template>
