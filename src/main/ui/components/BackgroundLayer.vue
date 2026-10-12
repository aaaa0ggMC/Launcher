<script setup lang="ts">
import { computed } from 'vue'
import { backgrounds } from '../../../background'

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
  top: 0;
  left: 0;
  right: 0;
  /* 高度与外壳同源（--app-vh）+ 同缓动：之前 inset:0 让背景钉在布局视口上，
     键盘一弹/一收就瞬移，而外壳还有 ~60ms 的更新窗口——两者错拍就是 B8「背景跳变」 */
  height: var(--app-vh);
  transition: height 90ms linear;
  z-index: -2;
  overflow: hidden;
  pointer-events: none;
}
</style>
