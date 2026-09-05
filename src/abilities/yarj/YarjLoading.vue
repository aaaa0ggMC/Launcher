<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-loading' })

import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="yarj-entry-loading">
    <div class="yarj-loading-card">
      <div class="yarj-radar-wrapper mb-5">
        <div class="radar-ping" />
        <div class="radar-circle">
          <v-icon size="44" color="primary" class="radar-icon">mdi-compass-outline</v-icon>
        </div>
      </div>

      <div class="text-h6 font-weight-bold mb-1 tracking-wide">
        {{ t('ability.yarj.name', '旅行记录') }}
      </div>
      <div class="text-body-2 on-surface-variant mb-5">
        {{ t('yarj.loading.hint', '正在载入旅行足迹与地图资源…') }}
      </div>

      <v-progress-linear
        indeterminate
        color="primary"
        rounded
        height="4"
        style="width: 220px; max-width: 80%"
      />
    </div>
  </div>
</template>

<style scoped>
.yarj-entry-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-surface), 0.94);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 100;
  user-select: none;
}

.yarj-loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 40px;
  border-radius: 20px;
  background: rgba(var(--v-theme-surface-bright), 0.35);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
}

.yarj-radar-wrapper {
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radar-circle {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-primary), 0.12);
  border: 1.5px solid rgba(var(--v-theme-primary), 0.35);
  box-shadow: 0 0 20px rgba(var(--v-theme-primary), 0.2);
}

.radar-ping {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(var(--v-theme-primary), 0.6);
  animation: radar-pulse 2s cubic-bezier(0.2, 0.8, 0.4, 1) infinite;
}

.radar-icon {
  animation: compass-sway 3s ease-in-out infinite alternate;
}

@keyframes radar-pulse {
  0% {
    transform: scale(0.85);
    opacity: 0.9;
  }
  100% {
    transform: scale(1.45);
    opacity: 0;
  }
}

@keyframes compass-sway {
  0% {
    transform: rotate(-18deg);
  }
  100% {
    transform: rotate(24deg);
  }
}
</style>
