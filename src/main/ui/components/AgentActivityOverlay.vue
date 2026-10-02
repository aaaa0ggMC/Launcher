<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * AI 操作描边：agent（MCP / Remote）每调用一次工具，主进程广播
 * `cockpit:agent-activity`；这里给整个窗口画一圈描边，静默 idleMs（设置里的「Agent 过期时间」）后渐隐。
 * 「谁在操作」由标题栏的 AgentBar 负责。纯展示层，pointer-events 全关，不进无障碍树。
 */
const props = defineProps<{ idleMs: number }>()
const visible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let unsub: (() => void) | null = null

onMounted(() => {
  unsub = window.cockpit.on('cockpit:agent-activity', () => {
    visible.value = true
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (visible.value = false), props.idleMs)
  })
})
onBeforeUnmount(() => {
  unsub?.()
  if (hideTimer) clearTimeout(hideTimer)
})
</script>

<template>
  <div class="agent-overlay" :class="{ on: visible }" aria-hidden="true"></div>
</template>

<style scoped>
.agent-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  pointer-events: none;
  opacity: 0;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 2px rgb(var(--v-theme-primary)),
    inset 0 0 28px 2px rgba(var(--v-theme-primary), 0.45);
  /* 渐隐慢一点；出现时快 */
  transition: opacity 1.4s ease-out;
}
.agent-overlay.on {
  opacity: 1;
  transition: opacity 0.2s ease-out;
}
</style>
