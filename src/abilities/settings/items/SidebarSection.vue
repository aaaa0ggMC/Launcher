<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-sidebar' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const sort = ref<'alpha' | 'frequency' | 'recent'>('alpha')
const clearing = ref(false)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const s = (cfg?.sidebar as { sort?: string } | undefined)?.sort
  sort.value = s === 'frequency' || s === 'recent' ? s : 'alpha'
})

async function setSort(v: string | null): Promise<void> {
  const mode = (v === 'frequency' || v === 'recent' ? v : 'alpha') as typeof sort.value
  sort.value = mode
  await window.cockpit.setConfig({
    sidebar: {
      ...(config.value.sidebar as Record<string, unknown> | undefined),
      sort: mode
    }
  })
}

async function clearRecords(): Promise<void> {
  clearing.value = true
  try {
    await window.cockpit.command('stats.clear')
  } finally {
    clearing.value = false
  }
}

/** Deep export: current sidebar sort rule. */
defineExpose({
  toMarkdown: (): string => {
    const label =
      sort.value === 'frequency'
        ? translate(uiLang.value, 'sidebar.frequency')
        : sort.value === 'recent'
          ? translate(uiLang.value, 'sidebar.recent')
          : translate(uiLang.value, 'sidebar.alpha')
    return `${translate(uiLang.value, 'sidebar.title')}: ${label}`
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'sidebar.title') }}</v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{ translate(uiLang, 'sidebar.caption') }}
      </div>
      <v-radio-group
        v-model="sort"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="setSort"
      >
        <v-radio :label="translate(uiLang, 'sidebar.alpha')" value="alpha" />
        <v-radio :label="translate(uiLang, 'sidebar.frequency')" value="frequency" />
        <v-radio :label="translate(uiLang, 'sidebar.recent')" value="recent" />
      </v-radio-group>
      <div class="text-caption text-medium-emphasis mt-2 mb-2">
        {{ translate(uiLang, 'sidebar.statsHint') }}
      </div>
      <v-btn
        variant="text"
        color="error"
        prepend-icon="mdi-delete-outline"
        :disabled="clearing"
        :loading="clearing"
        @click="clearRecords"
      >
        {{ translate(uiLang, 'sidebar.clear') }}
      </v-btn>
    </v-card-text>
  </v-card>
</template>
