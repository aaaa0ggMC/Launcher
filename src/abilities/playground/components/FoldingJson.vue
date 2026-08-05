<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

defineOptions({ name: 'FoldingJson' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/**
 * Folding JSON tree — Vue port of the React FoldingJson / FoldableString pair.
 *
 * Renders a parsed JSON value as a collapsible tree with syntax coloring.
 * Long strings fold behind a click-to-expand toggle instead of flooding the
 * view; object keys use the theme primary color, primitives get type colors.
 * Recursive: nested objects/arrays render themselves.
 */

const props = withDefaults(
  defineProps<{
    data: unknown
    /** nesting level (0 = root) */
    depth?: number
  }>(),
  { depth: 0 }
)

/** strings longer than this fold into a single click-to-expand line */
const LONG_STR = 80

const isObj = computed(
  () => props.data !== null && typeof props.data === 'object' && !Array.isArray(props.data)
)
const isArr = computed(() => Array.isArray(props.data))

const entries = computed<[string, unknown][]>(() => {
  if (isObj.value) return Object.entries(props.data as Record<string, unknown>)
  if (isArr.value)
    return (props.data as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
  return []
})

interface PrimitiveView {
  text: string
  cls: string
}
const primitive = computed<PrimitiveView>(() => {
  const d = props.data
  if (d === null) return { text: 'null', cls: 'fj-null' }
  switch (typeof d) {
    case 'number':
      return { text: String(d), cls: 'fj-num' }
    case 'boolean':
      return { text: String(d), cls: 'fj-bool' }
    case 'string':
      return { text: d, cls: 'fj-str' }
    default:
      return { text: String(d), cls: '' }
  }
})

const isLongStr = computed(
  () => typeof props.data === 'string' && (props.data as string).length > LONG_STR
)

/** nested containers start collapsed past depth 1 so big trees stay compact */
const open = ref(props.depth < 2)
const strOpen = ref(false)

function toggle(): void {
  open.value = !open.value
}

const childDepth = computed(() => props.depth + 1)
</script>

<template>
  <!-- object / array container -->
  <div v-if="isObj || isArr" class="fj-node">
    <div class="fj-brace-row" @click="toggle">
      <span class="fj-caret">{{ open ? '▾' : '▸' }}</span>
      <span class="fj-brace">{{ isArr ? '[' : '{' }}</span>
      <span v-if="!open" class="fj-count">{{ entries.length }} …</span>
      <span class="fj-brace">{{ isArr ? ']' : '}' }}</span>
    </div>
    <div v-if="open" class="fj-body">
      <div v-for="([k, v], i) in entries" :key="i" class="fj-entry">
        <span class="fj-key">{{ isArr ? '' : JSON.stringify(k) }}</span>
        <span v-if="isObj" class="fj-colon">: </span>
        <FoldingJson :data="v" :depth="childDepth" />
        <span v-if="i < entries.length - 1" class="fj-comma">,</span>
      </div>
    </div>
  </div>

  <!-- long string: fold behind expand toggle -->
  <span v-else-if="isLongStr" class="fj-longstr" @click="strOpen = !strOpen">
    <span v-if="!strOpen" class="fj-str">"{{ (data as string).slice(0, LONG_STR) }}…"</span>
    <template v-else>
      <span class="fj-str">"{{ data }}"</span>
      <span class="fj-unfold"> ▲</span>
    </template>
    <span v-if="!strOpen" class="fj-unfold">{{ t('pg.clickToExpand') }}</span>
  </span>

  <!-- plain string -->
  <span v-else-if="typeof data === 'string'" class="fj-str">"{{ data }}"</span>

  <!-- other primitives -->
  <span v-else :class="['fj-prim', primitive.cls]">{{ primitive.text }}</span>
</template>

<style scoped>
.fj-node {
  display: inline;
}
.fj-brace-row {
  cursor: pointer;
  display: inline;
  user-select: none;
}
.fj-caret {
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-size: 0.7rem;
  margin-right: 2px;
}
.fj-brace {
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.fj-count {
  color: rgba(var(--v-theme-on-surface), 0.4);
  font-style: italic;
}
.fj-body {
  padding-left: 16px;
  border-left: 1px solid rgba(var(--v-theme-surface-bright), 0.14);
  margin-left: 6px;
}
.fj-entry {
  white-space: nowrap;
}
.fj-key {
  color: rgb(var(--v-theme-primary));
  font-weight: 500;
}
.fj-colon,
.fj-comma {
  color: rgba(var(--v-theme-on-surface), 0.45);
}
.fj-str {
  color: rgb(var(--v-theme-tertiary));
}
.fj-num {
  color: rgb(var(--v-theme-warning));
}
.fj-bool {
  color: rgb(var(--v-theme-secondary));
}
.fj-null {
  color: rgba(var(--v-theme-on-surface), 0.45);
  font-style: italic;
}
.fj-longstr {
  cursor: pointer;
  user-select: none;
}
.fj-longstr .fj-str {
  color: rgb(var(--v-theme-tertiary));
}
.fj-unfold {
  color: rgb(var(--v-theme-primary));
  opacity: 0.75;
  font-size: 0.7rem;
  margin-left: 2px;
}
</style>
