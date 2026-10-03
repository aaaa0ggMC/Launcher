<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-screenshot' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const enabled = ref(false)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  enabled.value = !!(cfg?.screenshot as { enabled?: boolean } | undefined)?.enabled
})

async function setEnabled(v: boolean | null): Promise<void> {
  const val = !!v
  enabled.value = val
  await window.cockpit.setConfig({
    screenshot: {
      ...(config.value.screenshot as Record<string, unknown> | undefined),
      enabled: val
    }
  })
}

defineExpose({
  toMarkdown: (): string =>
    `${translate(uiLang.value, 'screenshot.title')}: ${
      enabled.value
        ? translate(uiLang.value, 'settings.on', '开')
        : translate(uiLang.value, 'settings.off', '关')
    }`
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'screenshot.title') }}</v-card-title>
    <v-card-text>
      <v-switch
        :model-value="enabled"
        :label="translate(uiLang, 'screenshot.switch')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="setEnabled"
      />
      <div class="text-body-2 text-medium-emphasis mt-3">
        {{ translate(uiLang, 'screenshot.hint') }}
      </div>
    </v-card-text>
  </v-card>
</template>
