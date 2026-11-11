<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-theme' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { schemeList, DEFAULT_SCHEME_ID } from '@ui/color_schemes'
import { KitSection } from '@ui/kit'

const theme = ref<string>(DEFAULT_SCHEME_ID)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const configured = cfg?.theme as string | undefined
  theme.value = schemeList.some((s) => s.id === configured)
    ? (configured ?? DEFAULT_SCHEME_ID)
    : DEFAULT_SCHEME_ID
})

async function setTheme(t: string | null): Promise<void> {
  const id = t ?? DEFAULT_SCHEME_ID
  theme.value = id
  await window.cockpit.setConfig({ theme: id })
}

/** Deep export: current theme name. */
defineExpose({
  toMarkdown: (): string => {
    const s = schemeList.find((x) => x.id === theme.value)
    const name = s ? translate(uiLang.value, s.name, s.id) : theme.value
    return `${translate(uiLang.value, 'theme.title')}: ${name}`
  }
})

/** Swatch chips for the preview strip: bg + primary + a couple accents. */
function previewColors(s: (typeof schemeList)[number]): { bg: string; dots: string[] } {
  const c = s.colors
  if (s.system || !c.background) return { bg: 'transparent', dots: ['#4cc4d6'] }
  return {
    bg: c.background,
    dots: [c.primary, c['accent-1'], c['accent-2'], c['accent-3']]
  }
}
</script>

<template>
  <KitSection :title="translate(uiLang, 'theme.title')" icon="mdi-palette-outline">
    <!-- 按容器宽度自动排列（不看窗口断点）：卡片所在栏变窄时减少列数，而不是挤压格子 -->
    <div class="theme-grid">
      <div v-for="s in schemeList" :key="s.id">
        <v-card
          variant="tonal"
          class="theme-card"
          :class="{ 'theme-card--active': theme === s.id }"
          :ripple="false"
          :aria-label="translate(uiLang, s.name, s.id)"
          :aria-pressed="theme === s.id"
          @click="setTheme(s.id)"
        >
          <div
            class="theme-preview"
            :style="{
              background: previewColors(s).bg,
              border: s.system ? '1px dashed rgba(var(--v-theme-on-surface-variant), 0.45)' : 'none'
            }"
          >
            <template v-if="!s.system">
              <span
                v-for="(dot, i) in previewColors(s).dots"
                :key="i"
                class="theme-dot"
                :style="{ background: dot }"
              />
            </template></div
        ></v-card>
      </div></div
  ></KitSection>
</template>
