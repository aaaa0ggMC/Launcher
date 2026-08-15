<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-launch' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const confirmBeforeLaunch = ref(false)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  confirmBeforeLaunch.value = !!(cfg?.runtime as Record<string, unknown> | undefined)
    ?.confirmBeforeLaunch
})

async function setConfirm(v: boolean | null): Promise<void> {
  const val = !!v
  confirmBeforeLaunch.value = val
  await window.cockpit.setConfig({
    runtime: {
      ...(config.value.runtime as Record<string, unknown> | undefined),
      confirmBeforeLaunch: val
    }
  })
}

/** Deep export: confirm-before-launch state. */
defineExpose({
  toMarkdown: (): string =>
    `${translate(uiLang.value, 'launch.title')}: ${
      confirmBeforeLaunch.value
        ? translate(uiLang.value, 'settings.on', '开')
        : translate(uiLang.value, 'settings.off', '关')
    }`
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'launch.title') }}</v-card-title>
    <v-card-text>
      <v-switch
        :model-value="confirmBeforeLaunch"
        :label="translate(uiLang, 'launch.switch')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="setConfirm"
      />
    </v-card-text>
  </v-card>
</template>
