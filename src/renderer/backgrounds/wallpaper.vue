<script setup lang="ts">
import { computed } from 'vue'

/**
 * `wallpaper` preset — the KDE desktop wallpaper (resolved by main process),
 * optionally Gaussian-blurred.
 */
const props = defineProps<{ imageUrl: string; blur: number; opacity: number }>()

const imgStyle = computed(() => {
  const style: Record<string, string> = { opacity: String(props.opacity) }
  if (props.blur > 0) {
    style.filter = `blur(${props.blur}px)`
    style.transform = `scale(${1 + props.blur / 160})`
  }
  return style
})
</script>

<template>
  <img v-if="imageUrl" :src="imageUrl" class="bg-img" :style="imgStyle" alt="" />
</template>

<style scoped>
.bg-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
