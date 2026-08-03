<script setup lang="ts">
import { computed } from 'vue'

/**
 * Renders a game-icon-pack SVG by name. SVGs live in ../assets/icons/ and use
 * `fill="currentColor"` — color is inherited from the surrounding text color,
 * so active/inactive states work automatically via Vuetify's list-item theming.
 *
 * Usage: <GameIcon name="dashboard" :size="20" />
 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 20
})

const icons = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

const raw = computed(() => {
  const key = Object.keys(icons).find((k) => k.endsWith(`/${props.name}.svg`))
  return key ? icons[key] : ''
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- static build-time SVG imports, not user input -->
  <span class="game-icon" :style="{ width: `${size}px`, height: `${size}px` }" v-html="raw" />
</template>

<style scoped>
.game-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 0;
}

.game-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
