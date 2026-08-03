<script setup lang="ts">
import { computed } from 'vue'
import GameIcon from './GameIcon.vue'
import { parseIcon, fileIconUrl } from '../icon'

/**
 * Renders an icon from the unified `icon` contract:
 *  - `default/<name>[/padding]` → game-icon-pack SVG
 *  - `emoji/<emoji>` / bare emoji → emoji text
 *  - `file/<path>` / absolute path → <img> via cockpit-icon://
 *  - empty / `auto` → fallback cool emoji
 */
const props = withDefaults(defineProps<{ icon: string | null | undefined; size?: number }>(), {
  size: 20
})

const parsed = computed(() => parseIcon(props.icon))
</script>

<template>
  <GameIcon
    v-if="parsed.kind === 'game'"
    :name="parsed.name"
    :padding="parsed.padding"
    :size="size"
    fallback="😎"
  />
  <img
    v-else-if="parsed.kind === 'file'"
    :src="fileIconUrl(parsed.path)"
    alt=""
    :style="{ width: `${size}px`, height: `${size}px`, objectFit: 'contain' }"
  />
  <span v-else class="emoji-icon" :style="{ fontSize: `${size - 2}px` }">{{ parsed.emoji }}</span>
</template>

<style scoped>
.emoji-icon {
  line-height: 1;
  width: 24px;
  text-align: center;
  display: inline-block;
}
</style>
