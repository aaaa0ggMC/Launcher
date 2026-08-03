<script setup lang="ts">
import { statusColors, type UiNode } from '../transformer'

defineOptions({ name: 'UiNode' })

defineProps<{ node: UiNode }>()
</script>

<template>
  <span v-if="typeof node === 'string' || typeof node === 'number'" class="ui-text">{{
    node
  }}</span>

  <template v-else-if="node.t === 'text'">
    <div
      :class="{
        'ui-title': node.size === 'title',
        'ui-lg': node.size === 'lg',
        'ui-md': node.size === 'md' || !node.size,
        'ui-sm': node.size === 'sm',
        'ui-mono': node.mono
      }"
    >
      {{ node.v }}
    </div>
  </template>

  <div v-else-if="node.t === 'align'" class="ui-align" :style="{ gap: `${node.gap ?? 10}px` }">
    <UiNode v-for="(c, i) in node.children" :key="i" :node="c" />
  </div>

  <div v-else-if="node.t === 'bar'" class="ui-bar">
    <span v-if="node.label" class="ui-bar-label">{{ node.label }}</span>
    <v-progress-linear
      :model-value="node.pct"
      :color="statusColors[node.color ?? 'info']"
      rounded
      height="8"
    />
  </div>

  <v-chip
    v-else-if="node.t === 'status'"
    size="small"
    variant="tonal"
    :color="statusColors[node.color ?? 'info']"
  >
    {{ node.v }}
  </v-chip>

  <table v-else-if="node.t === 'table'" class="ui-table">
    <thead>
      <tr>
        <th v-for="(h, i) in node.head" :key="i">{{ h }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, i) in node.rows" :key="i">
        <td v-for="(c, j) in row" :key="j">
          <UiNode :node="c" />
        </td>
      </tr>
    </tbody>
  </table>

  <v-alert v-else-if="node.t === 'error'" type="error" variant="tonal" density="compact">
    {{ node.v }}
  </v-alert>
</template>

<style scoped>
.ui-text {
  display: inline-flex;
}

.ui-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--v-theme-on-surface);
}
.ui-lg {
  font-size: 1rem;
  font-weight: 600;
}
.ui-md {
  font-size: 0.95rem;
}
.ui-sm {
  font-size: 0.82rem;
  color: rgba(var(--v-theme-on-surface-variant), 0.8);
}
.ui-mono {
  font-family: var(--v-font-family-mono, monospace);
}
.ui-align {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.ui-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
}
.ui-bar-label {
  font-size: 0.82rem;
  white-space: nowrap;
  color: rgba(var(--v-theme-on-surface-variant), 0.9);
}
.ui-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.ui-table th,
.ui-table td {
  text-align: left;
  padding: 3px 12px 3px 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.12));
}
.ui-table th {
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  font-weight: 600;
  white-space: nowrap;
}
</style>
