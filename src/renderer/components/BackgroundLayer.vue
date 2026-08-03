<script setup lang="ts">
import { computed } from 'vue'
import { backgrounds } from '../backgrounds'

/**
 * Background layer — the lowest of the three (Background / Fuse / Data) stack.
 * Renders the active preset component (registry in ../backgrounds) inside the
 * fixed full-viewport slot. `transparent` paints nothing so the OS window
 * transparency + Fuse tint give a semi-transparent window.
 */
const props = defineProps<{
  mode: string
  imageUrl: string
  blur: number
  opacity: number
}>()

const active = computed(() => backgrounds.find((b) => b.id === props.mode) ?? backgrounds[0])
</script>

<template>
  <div class="bg-layer">
    <component :is="active.component" :image-url="imageUrl" :blur="blur" :opacity="opacity" />
  </div>
</template>

<style scoped>
.bg-layer {
  position: fixed;
  inset: 0;
  z-index: -2;
  overflow: hidden;
  pointer-events: none;
}
</style>
