<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-json-tree-node' })

defineProps<{
  nodeKey: string
  value: unknown
  path: string
  expandedPaths: Set<string>
}>()

const emit = defineEmits<{
  (e: 'toggle', path: string): void
}>()

function isObj(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object'
}

function getDisplayVal(val: unknown): string {
  if (val === null) return 'null'
  return JSON.stringify(val)
}

function getValClass(val: unknown): string {
  if (typeof val === 'number') return 'val-number'
  if (typeof val === 'boolean') return 'val-boolean'
  if (val === null) return 'val-null'
  return 'val-string'
}
</script>

<template>
  <!-- 基础类型叶子节点 -->
  <div v-if="!isObj(value)" class="tree-leaf py-0-5 d-flex align-center">
    <span class="node-key mr-2">"{{ nodeKey }}":</span>
    <span :class="getValClass(value)">{{ getDisplayVal(value) }}</span>
  </div>

  <!-- 对象/数组分支节点 -->
  <div v-else class="tree-branch py-0-5">
    <div class="branch-header d-flex align-center cursor-pointer" @click="emit('toggle', path)">
      <v-icon
        size="16"
        class="mr-1 toggle-icon"
        :icon="expandedPaths.has(path) ? 'mdi-menu-down' : 'mdi-menu-right'"
      />
      <span class="node-key font-weight-medium mr-1">"{{ nodeKey }}":</span>
      <span class="text-disabled">{{ Array.isArray(value) ? '[' : '{' }}</span>
      <span
        v-if="!expandedPaths.has(path)"
        class="collapsed-summary mx-1 text-caption text-disabled"
      >
        ... {{ Object.keys(value).length }} {{ Array.isArray(value) ? 'items' : 'keys' }} ...
      </span>
      <span v-if="!expandedPaths.has(path)" class="text-disabled">
        {{ Array.isArray(value) ? ']' : '}' }}
      </span>
    </div>

    <div v-if="expandedPaths.has(path)" class="branch-children pl-4 border-l ml-2 my-0-5">
      <JsonTreeNode
        v-for="[childKey, childVal] in Object.entries(value)"
        :key="childKey"
        :node-key="childKey"
        :value="childVal"
        :path="`${path}/${childKey}`"
        :expanded-paths="expandedPaths"
        @toggle="(p) => emit('toggle', p)"
      />
    </div>

    <div v-if="expandedPaths.has(path)" class="branch-close text-disabled">
      {{ Array.isArray(value) ? ']' : '}' }}
    </div>
  </div>
</template>

<style scoped>
.node-key {
  color: rgb(var(--v-theme-primary));
}

.val-string {
  color: #4caf50;
  word-break: break-all;
}

.val-number {
  color: #ff9800;
}

.val-boolean {
  color: #2196f3;
}

.val-null {
  color: #9e9e9e;
  font-style: italic;
}

.toggle-icon {
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.branch-children {
  border-left: 1px dashed rgba(var(--v-theme-outline), 0.25);
}

.cursor-pointer {
  cursor: pointer;
}
</style>
