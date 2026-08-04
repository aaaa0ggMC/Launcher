<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-language' })

import { ref, onMounted } from 'vue'
import { availableLanguages } from '../../../i18n'
const selected = ref('zh')

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  selected.value = (cfg?.language as string) ?? 'zh'
})

async function setLang(code: string | null): Promise<void> {
  const v = code || 'zh'
  selected.value = v
  await window.cockpit.setConfig({ language: v })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">语言 / Language</v-card-title>
    <v-card-text>
      <v-radio-group
        :model-value="selected"
        density="compact"
        hide-details
        @update:model-value="setLang"
      >
        <v-radio v-for="lang in availableLanguages" :key="lang.code" :label="lang.label" :value="lang.code" />
      </v-radio-group>
      <div class="text-caption on-surface-variant mt-2">
        {{ selected === 'en-US' ? 'Switch language — reloads the page to apply.' : '切换语言后需重载页面才能生效。' }}
      </div>
    </v-card-text>
  </v-card>
</template>