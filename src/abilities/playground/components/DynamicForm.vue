<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { ParsedVar, SendHistoryEntry, VarConstraint } from '../types'
import { translate, translateTemplate } from '@ui/i18n'
import { inline } from '../markdown'

const props = defineProps<{
  vars: ParsedVar[]
  values: Record<string, string>
  loading: boolean
  history: SendHistoryEntry[]
}>()

const emit = defineEmits<{
  change: [name: string, value: string]
  send: []
  fill: [values: Record<string, string>]
  clearHistory: []
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const te = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const showHistory = ref(false)

function hintText(c: VarConstraint, type: string): string {
  switch (c.kind) {
    case 'range':
      return `(${c.min} – ${c.max})`
    case 'min':
      return `(min ${c.val})`
    case 'max':
      return `(max ${c.val})`
    case 'options':
      return type === 'select' ? '' : `(${c.values.join(', ')})`
  }
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Export the currently filled form values + send history as markdown. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdFormVars')]
  const filled = props.vars.filter(
    (v) => props.values[v.name] !== undefined && props.values[v.name] !== ''
  )
  if (filled.length === 0) {
    lines.push(`- ${t('pg.mdEmpty')}`)
  } else {
    for (const v of filled)
      lines.push(`- \`${inline(v.name)}\` = \`${inline(props.values[v.name])}\``)
  }
  if (props.history.length) {
    lines.push('', translate(uiLang.value, 'pg.mdHistory'))
    for (const h of props.history.slice(0, 20)) {
      const time = new Date(h.timestamp).toLocaleString(uiLang.value)
      const dur = h.error ? 'Error' : h.duration !== null ? `${h.duration}ms` : '?'
      lines.push(`- ${time} · ${dur}`)
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="pg-form">
    <div class="d-flex align-center justify-space-between mb-2">
      <span class="text-subtitle-2 font-weight-medium">
        {{ vars.length > 0 ? t('pg.fillVars') : t('pg.send') }}
      </span>
      <div v-if="history.length" class="d-flex align-center ga-2">
        <v-btn size="small" variant="text" @click="showHistory = !showHistory">
          {{ te('pg.history', { n: String(history.length) }) }} {{ showHistory ? '▲' : '▼' }}
        </v-btn>
        <v-btn size="small" variant="flat" color="error" @click="emit('clearHistory')">
          {{ t('pg.clearHistory') }}
        </v-btn>
      </div>
    </div>

    <div v-if="showHistory && history.length" class="pg-history mb-3">
      <v-list density="compact" class="pa-1">
        <v-list-item
          v-for="h in history.slice(0, 20)"
          :key="h.id"
          density="compact"
          rounded="lg"
          class="mb-1"
          @click="emit('fill', h.values)"
        >
          <v-list-item-title class="text-caption">
            {{ new Date(h.timestamp).toLocaleString() }} ·
            {{ h.error ? 'Error' : h.duration !== null ? `${h.duration}ms` : '?' }}
          </v-list-item-title>
          <v-list-item-subtitle class="text-caption text-truncate">
            {{
              Object.entries(h.values)
                .map(([k, v]) => `${k}=${trunc(v, 20)}`)
                .join(', ')
            }}
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
    </div>

    <div v-if="vars.length" class="pg-fields d-flex flex-column ga-2">
      <div v-for="v in vars" :key="v.name" class="pg-field">
        <div class="d-flex align-center ga-1 mb-1">
          <span class="text-body-2 font-weight-medium">{{ v.name }}</span>
          <span v-if="v.constraint" class="text-caption on-surface-variant">
            {{ hintText(v.constraint, v.type) }}
          </span>
        </div>

        <v-checkbox
          v-if="v.type === 'bool'"
          :model-value="values[v.name] === 'true'"
          density="compact"
          hide-details
          @update:model-value="emit('change', v.name, $event ? 'true' : 'false')"
        />

        <v-select
          v-else-if="v.type === 'select' || v.constraint?.kind === 'options'"
          :model-value="values[v.name] ?? ''"
          :items="v.constraint?.kind === 'options' ? v.constraint.values : []"
          density="compact"
          variant="outlined"
          hide-details
          :placeholder="t('pg.selectPlaceholder')"
          @update:model-value="emit('change', v.name, $event as string)"
        />
        <v-textarea
          v-else-if="v.type === 'textarea'"
          :model-value="values[v.name] ?? ''"
          variant="outlined"
          hide-details
          rows="3"
          :placeholder="te('pg.inputPlaceholder', { name: v.name })"
          @update:model-value="emit('change', v.name, $event as string)"
        />

        <template v-else-if="v.type === 'number' && v.constraint?.kind === 'range'">
          <div class="pg-slider">
            <div class="pg-slider__head">
              <span class="text-caption on-surface-variant font-family-mono">
                {{ values[v.name] === '' ? v.constraint.min : values[v.name] }}
              </span>
            </div>
            <v-slider
              :model-value="Number(values[v.name]) || v.constraint.min"
              :min="v.constraint.min"
              :max="v.constraint.max"
              :step="v.constraint.max - v.constraint.min <= 2 ? 0.1 : 1"
              color="primary"
              density="compact"
              hide-details
              @update:model-value="emit('change', v.name, String($event))"
            />
            <div class="pg-slider__foot">
              <span class="text-caption on-surface-variant">{{ v.constraint.min }}</span>
              <v-text-field
                :model-value="values[v.name] === '' ? String(v.constraint.min) : values[v.name]"
                type="number"
                density="compact"
                variant="outlined"
                hide-details
                :min="v.constraint.min"
                :max="v.constraint.max"
                class="pg-slider__num"
                @update:model-value="emit('change', v.name, $event as string)"
              />
              <span class="text-caption on-surface-variant">{{ v.constraint.max }}</span>
            </div>
          </div>
        </template>

        <v-text-field
          v-else
          :model-value="values[v.name] ?? ''"
          :type="v.type === 'number' ? 'number' : 'text'"
          density="compact"
          variant="outlined"
          hide-details
          :placeholder="te('pg.inputPlaceholder', { name: v.name })"
          @update:model-value="emit('change', v.name, $event as string)"
        />
      </div>
    </div>

    <v-btn
      color="primary"
      block
      class="mt-3"
      prepend-icon="mdi-send"
      :loading="loading"
      @click="emit('send')"
    >
      {{ loading ? t('pg.sending') : t('pg.send') }}
    </v-btn>
  </div>
</template>

<style scoped>
.pg-history {
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 8px;
}

/* Vuetify's v-slider pads its track by default; strip it so the track spans
   the full field width and the slider looks consistent across layouts. */
.pg-slider :deep(.v-slider) {
  margin-inline: 0;
}
.pg-slider__head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 2px;
}
/* slider footer: min/max captions flank a compact numeric input (dual
   control, mirrors React's slider + number field) */
.pg-slider__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.pg-slider__num {
  max-width: 96px;
  flex: 1;
}
.pg-slider__num :deep(input) {
  text-align: center;
}
</style>
