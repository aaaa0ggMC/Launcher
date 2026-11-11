<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-font' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

type FontMode = 'default' | 'system' | 'custom'

const FONT_MODES: readonly FontMode[] = ['default', 'system', 'custom']

function isFontMode(v: unknown): v is FontMode {
  return typeof v === 'string' && (FONT_MODES as readonly string[]).includes(v)
}

const mode = ref<FontMode>('default')
const family = ref('')
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const font = (cfg?.font as { mode?: unknown; family?: unknown } | undefined) ?? {}
  mode.value = isFontMode(font.mode) ? font.mode : 'default'
  family.value = typeof font.family === 'string' ? font.family : ''
})

/** Whole-object write (same shape as window / animations) so the shallow merge
 *  in config.set never drops the sibling field. An empty custom family is saved
 *  as-is; App.vue falls back to the default stack for it. */
async function commit(nextMode?: FontMode, nextFamily?: string): Promise<void> {
  const m = nextMode ?? mode.value
  const f = nextFamily ?? family.value
  mode.value = m
  family.value = f
  await window.cockpit.setConfig({ font: { mode: m, family: f } })
}

async function setMode(v: string | null): Promise<void> {
  await commit(isFontMode(v) ? v : 'default')
}

function commitFamily(): void {
  void commit()
}

function currentModeLabel(): string {
  if (mode.value === 'system') return translate(uiLang.value, 'font.system')
  if (mode.value === 'custom') return translate(uiLang.value, 'font.custom')
  return translate(uiLang.value, 'font.default')
}

/** Deep export: font mode (+ family when custom). */
defineExpose({
  toMarkdown: (): string => {
    const head = `${translate(uiLang.value, 'font.title')}: ${currentModeLabel()}`
    return mode.value === 'custom' && family.value.trim()
      ? `${head} (${family.value.trim()})`
      : head
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'font.title') }}</v-card-title>
    <v-card-text class="d-flex flex-column">
      <v-radio-group
        :model-value="mode"
        density="compact"
        hide-details
        @update:model-value="setMode"
      >
        <v-radio :label="translate(uiLang, 'font.default')" value="default" />
        <v-radio :label="translate(uiLang, 'font.system')" value="system" />
        <v-radio :label="translate(uiLang, 'font.custom')" value="custom" />
      </v-radio-group>
      <v-text-field
        v-if="mode === 'custom'"
        v-model="family"
        class="mt-3"
        :label="translate(uiLang, 'font.family')"
        :placeholder="translate(uiLang, 'font.familyPlaceholder')"
        variant="outlined"
        density="compact"
        hide-details
        @blur="commitFamily"
        @keydown.enter.prevent="commitFamily"
      />
      <div class="text-caption on-surface-variant mt-2">
        {{ translate(uiLang, 'font.caption') }}
      </div>
    </v-card-text>
  </v-card>
</template>
