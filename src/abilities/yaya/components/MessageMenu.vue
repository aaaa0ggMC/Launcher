<script setup lang="ts">
import { computed } from 'vue'
import type { MessageMenuItem, MessageMenuRequest } from './message-menu'

const props = defineProps<{
  request: MessageMenuRequest | null
  items: MessageMenuItem[]
}>()

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'close'): void
}>()

const open = computed({
  get: () => props.request !== null,
  set: (v) => {
    if (!v) emit('close')
  }
})
const target = computed<[number, number]>(() => [props.request?.x ?? 0, props.request?.y ?? 0])
</script>

<template>
  <v-menu v-model="open" :target="target" location="bottom start" :close-on-content-click="true">
    <v-list density="comfortable" min-width="220" class="message-menu" role="menu">
      <template v-for="item in items" :key="item.key">
        <v-divider v-if="item.divider" class="my-1" />
        <v-list-item
          :prepend-icon="item.icon"
          :title="item.label"
          :disabled="item.disabled"
          :base-color="item.danger ? 'error' : undefined"
          role="menuitem"
          @click="emit('select', item.key)"
        />
      </template>
    </v-list>
  </v-menu>
</template>

<style scoped>
.message-menu :deep(.v-list-item) {
  min-height: 44px;
}
</style>
