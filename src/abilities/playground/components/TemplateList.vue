<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { RequestTemplate } from '../types'
import { translate } from '@ui/i18n'
import { inline } from '../markdown'

const props = defineProps<{
  templates: RequestTemplate[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  new: []
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/** Export all templates as a compact markdown list. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdTemplateList')]
  if (props.templates.length === 0) {
    lines.push(`- ${t('pg.noTemplates')}`)
    return lines.join('\n')
  }
  for (const tpl of props.templates) {
    const mark = tpl.id === props.activeId ? ' *(active)*' : ''
    lines.push(
      `- **${tpl.name || t('pg.untitled')}**${mark} — \`${tpl.method}\` ${inline(tpl.urlTemplate)}`
    )
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="pg-templatelist d-flex flex-column" style="height: 100%">
    <div class="d-flex align-center justify-space-between mb-2">
      <span class="text-subtitle-2 font-weight-medium">Provider Playground</span>
      <v-btn size="small" color="primary" prepend-icon="mdi-plus" @click="emit('new')">
        {{ t('pg.new') }}
      </v-btn>
    </div>

    <div class="pg-tl-items flex-grow-1" style="min-height: 0; overflow-y: auto">
      <v-list v-if="templates.length" density="compact" class="pa-1">
        <v-list-item
          v-for="tpl in templates"
          :key="tpl.id"
          :active="tpl.id === activeId"
          rounded="lg"
          density="compact"
          class="mb-1"
          @click="emit('select', tpl.id)"
        >
          <v-list-item-title class="d-flex align-center ga-2">
            <span class="text-truncate">{{ tpl.name || t('pg.untitled') }}</span>
          </v-list-item-title>
          <v-list-item-subtitle class="d-flex align-center ga-2 mt-1">
            <v-chip variant="tonal" class="pg-method-chip">
              {{ tpl.method }}
            </v-chip>
            <span class="text-caption on-surface-variant text-truncate">{{ tpl.urlTemplate }}</span>
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <div v-else class="text-caption on-surface-variant pa-3">{{ t('pg.noTemplates') }}</div>
    </div>
  </div>
</template>

<style scoped>
.pg-method-chip {
  padding-block: 2px;
  min-height: 18px;
  font-size: 0.65rem;
}
.pg-method-chip {
  padding-block: 4px;
  min-height: 22px;
}
</style>
