<script setup lang="ts">
import { computed } from 'vue'

/**
 * Fuse layer — the tinted sheet ABOVE the Background. It carries the app's
 * theme background color at a configurable alpha. At 100% it fully hides the
 * background (classic solid look); lower it to reveal the Background through
 * the tint. Image visibility = backgroundOpacity × (1 − fuseAlpha).
 */
const props = defineProps<{ alpha: number }>()

const style = computed(() => ({
  background: `rgba(var(--v-theme-background), ${props.alpha})`
}))
</script>

<template>
  <div class="fuse-layer" :style="style" />
</template>

<style scoped>
.fuse-layer {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
</style>
