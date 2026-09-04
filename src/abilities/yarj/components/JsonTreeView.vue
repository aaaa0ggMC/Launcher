<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-json-tree-view' })

import { ref, watch } from 'vue'
import JsonTreeNode from './JsonTreeNode.vue'

const props = withDefaults(
  defineProps<{
    data: unknown
    rootName?: string
    defaultExpandedDepth?: number
    editable?: boolean
  }>(),
  {
    rootName: 'photo',
    defaultExpandedDepth: 2,
    editable: false
  }
)

const emit = defineEmits<{
  (e: 'update:data', val: unknown): void
  (e: 'save', val: unknown): void
}>()

const copied = ref(false)
const isEditingRaw = ref(false)
const rawJsonText = ref('')
const rawJsonError = ref('')

// 记录展开的节点路径（用 '/' 拼接）
const expandedPaths = ref<Set<string>>(new Set(['root']))

function initExpanded(obj: unknown, path = 'root', currentDepth = 0): void {
  if (currentDepth <= props.defaultExpandedDepth) {
    expandedPaths.value.add(path)
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const childPath = `${path}/${key}`
      if (value && typeof value === 'object') {
        initExpanded(value, childPath, currentDepth + 1)
      }
    }
  }
}

initExpanded(props.data)

watch(
  () => props.data,
  (newData) => {
    expandedPaths.value = new Set(['root'])
    initExpanded(newData)
  },
  { deep: true }
)

function toggleExpand(path: string): void {
  if (expandedPaths.value.has(path)) {
    expandedPaths.value.delete(path)
  } else {
    expandedPaths.value.add(path)
  }
}

function expandAll(): void {
  function collect(obj: unknown, path = 'root'): void {
    expandedPaths.value.add(path)
    if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          collect(value, `${path}/${key}`)
        }
      }
    }
  }
  collect(props.data)
}

function collapseAll(): void {
  expandedPaths.value.clear()
}

async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(props.data, null, 2))
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // ignore
  }
}

function startEditRaw(): void {
  rawJsonText.value = JSON.stringify(props.data, null, 2)
  rawJsonError.value = ''
  isEditingRaw.value = true
}

function cancelEditRaw(): void {
  isEditingRaw.value = false
  rawJsonError.value = ''
}

function saveEditRaw(): void {
  try {
    const parsed = JSON.parse(rawJsonText.value)
    emit('update:data', parsed)
    emit('save', parsed)
    isEditingRaw.value = false
    rawJsonError.value = ''
  } catch (err: unknown) {
    rawJsonError.value = (err as Error).message || 'JSON 语法错误'
  }
}
</script>

<template>
  <div class="json-tree-container rounded-lg pa-3">
    <!-- 头部工具条 -->
    <div class="d-flex align-center justify-space-between pb-2 mb-2 border-b">
      <div class="d-flex align-center ga-2">
        <v-icon size="18" color="primary">mdi-code-json</v-icon>
        <span class="text-caption font-weight-bold">{{ rootName }} (JSON)</span>
      </div>
      <div class="d-flex align-center ga-1">
        <v-btn
          v-if="!isEditingRaw"
          size="small"
          variant="text"
          icon="mdi-unfold-more-horizontal"
          title="全部展开"
          @click="expandAll"
        />
        <v-btn
          v-if="!isEditingRaw"
          size="small"
          variant="text"
          icon="mdi-unfold-less-horizontal"
          title="全部折叠"
          @click="collapseAll"
        />
        <v-btn
          size="small"
          variant="text"
          :icon="copied ? 'mdi-check' : 'mdi-content-copy'"
          :color="copied ? 'success' : undefined"
          :title="copied ? '已复制' : '复制 JSON'"
          @click="copyJson"
        />
        <v-btn
          v-if="editable && !isEditingRaw"
          size="small"
          variant="text"
          icon="mdi-pencil-outline"
          title="编辑元数据"
          @click="startEditRaw"
        />
      </div>
    </div>

    <!-- JSON 编辑态 -->
    <div v-if="isEditingRaw" class="d-flex flex-column ga-2">
      <v-textarea
        v-model="rawJsonText"
        rows="10"
        density="compact"
        variant="outlined"
        hide-details
        class="font-mono text-caption"
      />
      <div v-if="rawJsonError" class="text-caption text-error">
        {{ rawJsonError }}
      </div>
      <div class="d-flex justify-end ga-2 pt-2">
        <v-btn variant="text" @click="cancelEditRaw">取消</v-btn>
        <v-btn color="primary" variant="flat" @click="saveEditRaw">保存修改</v-btn>
      </div>
    </div>

    <!-- 树形展示态 -->
    <div v-else class="json-tree-body font-mono text-caption">
      <JsonTreeNode
        :node-key="rootName"
        :value="data"
        path="root"
        :expanded-paths="expandedPaths"
        @toggle="toggleExpand"
      />
    </div>
  </div>
</template>

<style scoped>
.json-tree-container {
  background: rgba(var(--v-theme-surface-variant), 0.35);
  border: 1px solid rgba(var(--v-theme-outline), 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.json-tree-body {
  max-height: 420px;
  overflow-y: auto;
  overflow-x: hidden;
  user-select: text;
}
</style>
