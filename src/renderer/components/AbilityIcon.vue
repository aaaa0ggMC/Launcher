<script setup lang="ts">
import { computed } from 'vue'
import GameIcon from './GameIcon.vue'
import { FALLBACK_ICON } from '../abilities/types'

/**
 * Renders an ability/app icon from the `icon` contract:
 *  - `gi:<name>` → <GameIcon>
 *  - anything else → emoji text (legacy / app entries)
 *  - null/empty   → fallback emoji
 */
const props = withDefaults(defineProps<{ icon: string | null | undefined; size?: number }>(), {
  size: 20
})

const isGameIcon = computed(() => (props.icon ?? '').startsWith('gi:'))
const gameName = computed(() => (props.icon ?? '').slice(3))
const emoji = computed(() => {
  const v = props.icon
  if (!v || v.startsWith('gi:')) return FALLBACK_ICON
  return v
})
</script>

<template>
  <GameIcon v-if="isGameIcon" :name="gameName" :size="size" />
  <span v-else class="emoji-icon" :style="{ fontSize: `${size - 2}px` }">{{ emoji }}</span>
</template>

<style scoped>
.emoji-icon {
  line-height: 1;
  width: 24px;
  text-align: center;
  display: inline-block;
}
</style>
