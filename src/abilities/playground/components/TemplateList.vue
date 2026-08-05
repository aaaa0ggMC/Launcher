<script setup lang="ts">
import type { RequestTemplate } from '../types'

defineProps<{
  templates: RequestTemplate[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  new: []
}>()
</script>

<template>
  <div class="pg-templatelist d-flex flex-column" style="height: 100%">
    <div class="d-flex align-center justify-space-between mb-2">
      <span class="text-subtitle-2 font-weight-medium">Provider Playground</span>
      <v-btn size="small" color="primary" prepend-icon="mdi-plus" @click="emit('new')">
        新建
      </v-btn>
    </div>

    <div class="pg-tl-items flex-grow-1" style="min-height: 0; overflow-y: auto">
      <v-list v-if="templates.length" density="compact" class="pa-1">
        <v-list-item
          v-for="t in templates"
          :key="t.id"
          :active="t.id === activeId"
          rounded="lg"
          density="compact"
          class="mb-1"
          @click="emit('select', t.id)"
        >
          <v-list-item-title class="d-flex align-center ga-2">
            <span class="text-truncate">{{ t.name || '未命名' }}</span>
          </v-list-item-title>
          <v-list-item-subtitle class="d-flex align-center ga-2 mt-1">
            <v-chip variant="tonal" class="pg-method-chip">
              {{ t.method }}
            </v-chip>
            <span class="text-caption on-surface-variant text-truncate">{{ t.urlTemplate }}</span>
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <div v-else class="text-caption on-surface-variant pa-3">暂无请求模板，点击「新建」创建</div>
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
