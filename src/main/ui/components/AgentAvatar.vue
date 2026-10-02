<script setup lang="ts">
import { computed } from 'vue'
import GameIcon from './GameIcon.vue'

/** agent 头像内容：自带头像 data: 图 > 默认图标（gi:/mdi:）> 名字首字母。 */
const props = defineProps<{ avatar?: string; icon?: string; initial: string }>()

const mdi = computed(() => (props.icon?.startsWith('mdi:') ? `mdi-${props.icon.slice(4)}` : ''))
const gi = computed(() => (props.icon?.startsWith('gi:') ? props.icon.slice(3) : ''))
</script>

<template>
  <img v-if="avatar" :src="avatar" alt="" class="agent-avatar__img" />
  <v-icon v-else-if="mdi" :icon="mdi" :size="22" />
  <GameIcon v-else-if="gi" :name="gi" padding :size="20" />
  <template v-else>{{ initial }}</template>
</template>

<style scoped>
.agent-avatar__img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
</style>
