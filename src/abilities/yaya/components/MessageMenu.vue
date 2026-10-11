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
    <v-list density="compact" min-width="180" class="message-menu yaya-pop" role="menu">
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
  min-height: 36px;
}
.message-menu :deep(.v-list-item-title) {
  font-size: 0.875rem;
  line-height: 1.35;
}
.message-menu :deep(.v-list-item__prepend > .v-icon) {
  font-size: 20px;
}
.message-menu :deep(.v-list-item__spacer) {
  width: 12px !important;
}
/*
 * 插件操作（朗读等）注进来后菜单会变长：封顶 + 内部滚动（.v-list 自带 overflow: auto），
 * 不遮住半屏。高度用 --app-vh（手机上 100vh 比可见区域高，见 viewport.ts）。
 */
.message-menu {
  max-height: min(380px, calc(var(--app-vh, 100vh) * 0.5));
  overflow-y: auto;
}
</style>
