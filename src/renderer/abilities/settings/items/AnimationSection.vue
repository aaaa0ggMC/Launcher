<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-animations' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const enabled = ref(true)
const pageTransition = ref<'fade' | 'slide'>('fade')

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const a = (cfg?.animations as { enabled?: boolean; pageTransition?: string } | undefined) ?? {}
  enabled.value = a.enabled !== false
  pageTransition.value = a.pageTransition === 'slide' ? 'slide' : 'fade'
})

async function save(patch: {
  enabled?: boolean
  pageTransition?: 'fade' | 'slide'
}): Promise<void> {
  const next = {
    enabled: patch.enabled ?? enabled.value,
    pageTransition: patch.pageTransition ?? pageTransition.value
  }
  enabled.value = next.enabled
  pageTransition.value = next.pageTransition
  await window.cockpit.setConfig({ animations: next })
}

async function setEnabled(v: boolean | null): Promise<void> {
  await save({ enabled: !!v })
}

async function setStyle(v: string | null): Promise<void> {
  await save({ pageTransition: v === 'slide' ? 'slide' : 'fade' })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'animation.title') }}</v-card-title>
    <v-card-text>
      <v-switch
        :model-value="enabled"
        :label="translate(uiLang, 'animation.enabled')"
        density="compact"
        hide-details
        @update:model-value="setEnabled"
      />
      <v-divider class="my-3" />
      <div class="text-body-2 mb-1">{{ translate(uiLang, 'animation.style') }}</div>
      <v-radio-group
        :model-value="enabled ? pageTransition : null"
        density="compact"
        hide-details
        :disabled="!enabled"
        @update:model-value="setStyle"
      >
        <v-radio :label="translate(uiLang, 'animation.fade')" value="fade" />
        <v-radio :label="translate(uiLang, 'animation.slide')" value="slide" />
      </v-radio-group>
      <div class="text-caption on-surface-variant mt-2">
        {{ translate(uiLang, 'animation.caption') }}
      </div>
    </v-card-text>
  </v-card>
</template>
