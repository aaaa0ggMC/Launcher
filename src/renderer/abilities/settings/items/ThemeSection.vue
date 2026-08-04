<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-theme' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../i18n'

const theme = ref('dark')
const uiLang = (inject('cockpit:lang', ref('zh')) as Ref<string>)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  theme.value = (cfg?.theme as string) ?? 'dark'
})

async function setTheme(t: string): Promise<void> {
  theme.value = t
  await window.cockpit.setConfig({ theme: t })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'theme.title') }}</v-card-title>
    <v-card-text>
      <v-radio-group
        v-model="theme"
        density="compact"
        hide-details
        @update:model-value="(v: string | null) => setTheme(v ?? 'dark')"
      >
        <v-radio :label="translate(uiLang, 'theme.dark')" value="dark" />
        <v-radio :label="translate(uiLang, 'theme.pureblack')" value="pureblack" />
        <v-radio :label="translate(uiLang, 'theme.system')" value="system" />
      </v-radio-group>
    </v-card-text>
  </v-card>
</template>
