<script setup lang="ts">
/** KitProse —— 正文（一句话说明 / 段落）。窄屏自动降到 0.8125rem。 */
defineProps<{
  /** 次要正文（再弱一档） */
  muted?: boolean
}>()
</script>

<template>
  <p class="kit-prose" :class="{ 'kit-prose--muted': muted }"><slot /></p>
</template>

<style scoped>
.kit-prose {
  margin: 0;
}

.kit-prose--muted {
  opacity: 0.75;
}
</style>
