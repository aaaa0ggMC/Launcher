<script setup lang="ts">
/** KitTitle —— 标题（gallery / 分区标题都用它，不写裸 <div class="text-subtitle-2">）。 */
defineProps<{
  /** 主标题 / 次级标题 */
  level?: 'h' | 'sub'
  /** mdi 图标（可选） */
  icon?: string
}>()
</script>

<template>
  <div class="kit-title" :class="level === 'sub' ? 'kit-title--sub' : undefined">
    <v-icon v-if="icon" class="kit-title__icon" :size="16">{{ icon }}</v-icon>
    <span><slot /></span>
  </div>
</template>

<style scoped>
.kit-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
