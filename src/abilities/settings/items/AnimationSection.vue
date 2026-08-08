<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-animations' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { PAGE_TRANSITIONS, type PageTransitionKey } from '@ui/animations'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

/** Theme-switch reveal origin: top-left corner or the mouse position. */
const THEME_TRANSITIONS = ['corner', 'cursor'] as const
type ThemeTransition = (typeof THEME_TRANSITIONS)[number]

function isThemeTransition(v: string | null | undefined): v is ThemeTransition {
  return !!v && (THEME_TRANSITIONS as readonly string[]).includes(v)
}

const modernMotion = ref(true)
const enabled = ref(true)
const pageTransition = ref<PageTransitionKey>('fade')
const themeTransition = ref<ThemeTransition>('corner')

function isKnown(v: string | null | undefined): v is PageTransitionKey {
  return !!v && PAGE_TRANSITIONS.some((t) => t.key === v)
}

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const a =
    (cfg?.animations as
      | {
          enabled?: boolean
          pageTransition?: string
          modernMotion?: boolean
          themeTransition?: string
        }
      | undefined) ?? {}
  modernMotion.value = a.modernMotion !== false
  enabled.value = a.enabled !== false
  pageTransition.value = isKnown(a.pageTransition) ? a.pageTransition : 'fade'
  themeTransition.value = isThemeTransition(a.themeTransition) ? a.themeTransition : 'corner'
})

async function save(patch: {
  modernMotion?: boolean
  enabled?: boolean
  pageTransition?: PageTransitionKey
  themeTransition?: ThemeTransition
}): Promise<void> {
  const next = {
    modernMotion: patch.modernMotion ?? modernMotion.value,
    enabled: patch.enabled ?? enabled.value,
    pageTransition: patch.pageTransition ?? pageTransition.value,
    themeTransition: patch.themeTransition ?? themeTransition.value
  }
  modernMotion.value = next.modernMotion
  enabled.value = next.enabled
  pageTransition.value = next.pageTransition
  themeTransition.value = next.themeTransition
  await window.cockpit.setConfig({ animations: next })
}

async function setModernMotion(v: boolean | null): Promise<void> {
  await save({ modernMotion: !!v })
}

async function setEnabled(v: boolean | null): Promise<void> {
  await save({ enabled: !!v })
}

async function setStyle(v: string | null): Promise<void> {
  await save({ pageTransition: isKnown(v) ? v : 'fade' })
}

async function setThemeTransition(v: string | null): Promise<void> {
  await save({ themeTransition: isThemeTransition(v) ? v : 'corner' })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'animation.title') }}</v-card-title>
    <v-card-text>
      <v-switch
        :model-value="modernMotion"
        :label="translate(uiLang, 'animation.modernMotion')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="setModernMotion"
      />
      <div class="text-caption on-surface-variant mt-1 mb-2">
        {{ translate(uiLang, 'animation.modernMotionCaption') }}
      </div>
      <v-divider class="my-3" />
      <v-switch
        :model-value="enabled"
        :label="translate(uiLang, 'animation.enabled')"
        color="primary"
        density="compact"
        hide-details
        :disabled="!modernMotion"
        @update:model-value="setEnabled"
      />
      <v-divider class="my-3" />
      <div class="text-body-2 mb-1">{{ translate(uiLang, 'animation.style') }}</div>
      <v-radio-group
        :model-value="enabled ? pageTransition : null"
        density="compact"
        hide-details
        :disabled="!enabled || !modernMotion"
        @update:model-value="setStyle"
      >
        <v-radio
          v-for="t in PAGE_TRANSITIONS"
          :key="t.key"
          :label="translate(uiLang, t.labelKey)"
          :value="t.key"
        />
      </v-radio-group>
      <div class="text-caption on-surface-variant mt-2">
        {{ translate(uiLang, 'animation.caption') }}
      </div>
      <v-divider class="my-3" />
      <div class="text-body-2 mb-1">{{ translate(uiLang, 'animation.themeTransition') }}</div>
      <v-radio-group
        :model-value="themeTransition"
        density="compact"
        hide-details
        :disabled="!modernMotion"
        @update:model-value="setThemeTransition"
      >
        <v-radio :label="translate(uiLang, 'animation.themeCorner')" value="corner" />
        <v-radio :label="translate(uiLang, 'animation.themeCursor')" value="cursor" />
      </v-radio-group>
      <div class="text-caption on-surface-variant mt-2">
        {{ translate(uiLang, 'animation.themeTransitionCaption') }}
      </div>
    </v-card-text>
  </v-card>
</template>
