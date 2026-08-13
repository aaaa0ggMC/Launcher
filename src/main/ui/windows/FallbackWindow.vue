<script setup lang="ts">
/**
 * Fallback root for a child window whose `?view=<key>` failed to resolve (the
 * loader globs found nothing, or the module threw). Instead of silently falling
 * back to the full App shell, the window shows a centered failure hint so a
 * broken/renamed view is immediately visible in the BT panel / window list.
 */
defineOptions({ name: 'cockpit-fallback-window' })

import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const viewKey = new URLSearchParams(location.search).get('view') ?? ''
</script>

<template>
  <div class="fallback-shell">
    <div class="fallback-card">
      <v-icon size="56" color="error" class="mb-4">mdi-alert-octagon-outline</v-icon>
      <div class="text-h6 mb-2">{{ t('app.fallback.title') }}</div>
      <div
        class="text-body-2 text-medium-emphasis mb-1"
        v-html="tt('app.fallback.viewMissing', { view: '<code>' + (viewKey || '?') + '</code>' })"
      ></div>
      <div class="text-caption text-medium-emphasis">
        {{ t('app.fallback.reasons') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.fallback-shell {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-surface), 0.92);
}
.fallback-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 420px;
  padding: 32px;
}
code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(var(--v-theme-surface-bright), 0.12);
  padding: 2px 6px;
  border-radius: 4px;
}
</style>
