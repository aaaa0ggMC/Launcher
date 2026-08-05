<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { GlobalVar } from '../types'
import { translate } from '@ui/i18n'
import { inline } from '../markdown'

const props = defineProps<{ vars: GlobalVar[] }>()
const emit = defineEmits<{ change: [vars: GlobalVar[]] }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const collapsed = ref(true)

function add(): void {
  emit('change', [...props.vars, { key: '', value: '', secret: false }])
}
function update(i: number, patch: Partial<GlobalVar>): void {
  emit(
    'change',
    props.vars.map((v, j) => (j === i ? { ...v, ...patch } : v))
  )
}
function remove(i: number): void {
  emit(
    'change',
    props.vars.filter((_, j) => j !== i)
  )
}

/** Export globals as markdown — secret (password) vars are masked, never dumped. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdGlobals')]
  const vars = props.vars.filter((v) => v.key.trim())
  if (vars.length === 0) {
    lines.push(`- ${t('pg.noGlobals')}`)
    return lines.join('\n')
  }
  for (const v of vars) {
    if (v.secret) {
      lines.push(`- \`${inline(v.key)}\` = \`••••••\` ${t('pg.mdHidden')}`)
    } else {
      lines.push(`- \`${inline(v.key)}\` = \`${inline(v.value)}\``)
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="pg-globals mb-3">
    <div class="d-flex align-center ga-2 pa-2 pg-global-header" @click="collapsed = !collapsed">
      <v-icon>{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down' }}</v-icon>
      <span class="text-subtitle-2 font-weight-medium">{{ t('pg.globalVars') }}</span>
      <v-chip size="small" variant="tonal">{{ vars.length }}</v-chip>
      <v-spacer />
      <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click.stop="add">
        {{ t('pg.addGlobalVar') }}
      </v-btn>
    </div>

    <div v-if="!collapsed" class="pa-3">
      <div class="text-caption on-surface-variant mb-2">{{ t('pg.globalHint') }}</div>
      <div v-if="vars.length === 0" class="text-caption on-surface-variant mb-2">
        {{ t('pg.noGlobals') }}
      </div>
      <div v-for="(v, i) in vars" :key="i" class="d-flex align-center ga-2 mb-1">
        <v-text-field
          :model-value="v.key"
          density="compact"
          variant="outlined"
          hide-details
          :placeholder="t('pg.namePlaceholder')"
          class="pg-gv-key font-mono"
          spellcheck="false"
          @update:model-value="update(i, { key: $event as string })"
        />
        <v-text-field
          :model-value="v.value"
          :type="v.secret ? 'password' : 'text'"
          density="compact"
          variant="outlined"
          hide-details
          :placeholder="t('pg.valuePlaceholder')"
          class="flex-grow-1 font-mono"
          spellcheck="false"
          @update:model-value="update(i, { value: $event as string })"
        />
        <v-btn
          size="small"
          variant="flat"
          icon
          :title="v.secret ? t('pg.show') : t('pg.hide')"
          @click="update(i, { secret: !v.secret })"
        >
          <v-icon>{{ v.secret ? 'mdi-eye' : 'mdi-eye-off' }}</v-icon>
        </v-btn>
        <v-btn size="small" variant="flat" color="error" icon @click="remove(i)">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg-global-header {
  cursor: pointer;
  user-select: none;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 8px;
}
.pg-global-header:hover {
  background: rgba(var(--v-theme-surface-bright), 0.08);
}
/* count chip needs breathing room */
.pg-global-header .v-chip {
  padding-block: 4px;
  min-height: 24px;
}
.pg-gv-key {
  max-width: 180px;
}
.font-mono :deep(input) {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8rem;
}
</style>
