<script setup lang="ts">
import { computed, ref } from 'vue'
defineOptions({ name: 'JsonTree' })
const props = withDefaults(defineProps<{ value: unknown; label?: string; depth?: number }>(), {
  label: '$',
  depth: 0
})
const expanded = ref(props.depth < 1)
const container = computed(() => props.value !== null && typeof props.value === 'object')
const entries = computed(() =>
  container.value ? Object.entries(props.value as Record<string, unknown>).slice(0, 200) : []
)
const length = computed(() => (container.value ? Object.keys(props.value as object).length : 0))
const summary = computed(() =>
  container.value
    ? `${Array.isArray(props.value) ? 'Array' : 'Object'} (${length.value})`
    : JSON.stringify(props.value)
)
</script>
<template>
  <div class="json-node">
    <button
      v-if="container"
      type="button"
      class="node-label"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? '▾' : '▸' }}</span> {{ label }}:
      <span class="text-medium-emphasis">{{ summary }}</span>
    </button>
    <div v-else class="leaf">
      <strong>{{ label }}</strong
      >: <span>{{ summary }}</span>
    </div>
    <div v-if="container && expanded" class="node-children">
      <template v-if="depth < 12"
        ><JsonTree
          v-for="[key, item] in entries"
          :key="key"
          :label="key"
          :value="item"
          :depth="depth + 1"
        />
        <div v-if="length > entries.length" class="text-medium-emphasis">
          … {{ length - entries.length }} more
        </div></template
      >
      <div v-else class="text-medium-emphasis">… depth limit</div>
    </div>
  </div>
</template>
<style scoped>
.json-node {
  font-family: monospace;
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.node-label {
  text-align: left;
  color: inherit;
  padding: 6px 4px;
  border-radius: 4px;
}
.node-label:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.node-children {
  margin-left: 16px;
  padding-left: 12px;
  border-left: 1px solid rgba(var(--v-theme-on-surface), 0.2);
}
.leaf {
  padding: 4px;
}
</style>
