<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-language' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate, availableLanguages } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

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

/** Deep export: current interface language. */
defineExpose({
  toMarkdown: (): string => {
    const lang = availableLanguages.find((l) => l.code === selected.value)
    return `${translate(uiLang.value, 'label.语言', 'Language')}: ${lang?.label ?? selected.value}`
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{
      translate(uiLang, 'settings.languageTitle')
    }}</v-card-title>
    <v-card-text>
      <v-radio-group
        :model-value="selected"
        density="compact"
        hide-details
        @update:model-value="setLang"
      >
        <v-radio
          v-for="lang in availableLanguages"
          :key="lang.code"
          :label="lang.label"
          :value="lang.code"
        />
      </v-radio-group>
      <div class="text-caption on-surface-variant mt-2">
        {{ translate(uiLang, 'settings.languageCaption') }}
      </div>
    </v-card-text>
  </v-card>
</template>
