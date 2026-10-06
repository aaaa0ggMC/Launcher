<script setup lang="ts">
/** 圆形头像：图片 / 模型缩写 / 图标三选一（YAYA 的用户与助手形象） */
defineProps<{
  image?: string
  monogram?: { text: string; hue: number } | null
  icon?: string
  size?: number
}>()
</script>

<template>
  <span
    class="avatar-badge"
    :style="{
      width: `${size ?? 38}px`,
      height: `${size ?? 38}px`,
      fontSize: `${Math.round((size ?? 38) * 0.4)}px`,
      ...(monogram && !image ? { background: `hsl(${monogram.hue} 55% 45%)`, color: '#fff' } : {})
    }"
    aria-hidden="true"
  >
    <img v-if="image" :src="image" alt="" />
    <span v-else-if="monogram" class="mono">{{ monogram.text }}</span>
    <v-icon
      v-else
      :icon="icon || 'mdi-robot-happy-outline'"
      :size="Math.round((size ?? 38) * 0.58)"
    />
  </span>
</template>

<style scoped>
.avatar-badge {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
}
.avatar-badge img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mono {
  font-weight: 700;
  letter-spacing: 0.02em;
}
</style>
