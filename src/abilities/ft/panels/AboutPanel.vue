<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <div class="d-flex flex-column ga-2">
    <div class="chroma-text">{{ t('ft.about.author') }}</div>
    <div class="text-caption on-surface-variant">
      {{ t('ft.about.desc') }}
    </div>
    <v-divider />
    <div class="text-caption on-surface-variant">{{ t('ft.about.shortcutsTitle') }}</div>
    <div class="shortcut-row">
      <kbd>Space</kbd><span>{{ t('ft.about.playPause') }}</span>
    </div>
    <div class="shortcut-row">
      <kbd>R</kbd><span>{{ t('ft.about.repaint') }}</span>
    </div>
    <div class="shortcut-row">
      <kbd>F</kbd><span>{{ t('ft.about.follow') }}</span>
    </div>
    <div class="shortcut-row">
      <kbd>M</kbd><span>{{ t('ft.about.neon') }}</span>
    </div>
    <div class="shortcut-row">
      <kbd>+ / -</kbd><span>{{ t('ft.about.zoom') }}</span>
    </div>
  </div>
</template>

<style scoped>
.chroma-text {
  font-weight: 600;
  animation: chroma 6s linear infinite;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
}

kbd {
  min-width: 2.4rem;
  text-align: center;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  background: rgba(var(--v-theme-surface-bright), 0.4);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.6);
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 0.72rem;
}

@keyframes chroma {
  0% {
    color: hsl(0, 80%, 65%);
  }
  17% {
    color: hsl(60, 80%, 65%);
  }
  34% {
    color: hsl(120, 70%, 60%);
  }
  50% {
    color: hsl(180, 80%, 60%);
  }
  67% {
    color: hsl(240, 80%, 70%);
  }
  83% {
    color: hsl(300, 70%, 65%);
  }
  100% {
    color: hsl(0, 80%, 65%);
  }
}
</style>
