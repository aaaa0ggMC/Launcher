<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * AI 操作描边：agent（MCP / Remote）每调用一次工具，主进程广播
 * `cockpit:agent-activity`；这里给整个窗口画一圈描边，静默 idleMs（设置里的「Agent 过期时间」）后渐隐。
 * 当会话断开或在线会话清空时立即熄灭，不等待 idleMs。
 * 「谁在操作」由标题栏的 AgentBar 负责。纯展示层，pointer-events 全关，不进无障碍树。
 */
const props = defineProps<{ idleMs: number }>()
const visible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let unsubActivity: (() => void) | null = null
let unsubSessions: (() => void) | null = null

// 记录当前产生活跃的会话 ID
const activeSessions = new Set<string>()

function clearOverlay(): void {
  visible.value = false
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  activeSessions.clear()
}

onMounted(() => {
  unsubActivity = window.cockpit.on('cockpit:agent-activity', (raw) => {
    const ev = raw as { id?: string } | undefined
    if (ev?.id) {
      activeSessions.add(ev.id)
    }
    visible.value = true
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      clearOverlay()
    }, props.idleMs)
  })

  unsubSessions = window.cockpit.on('cockpit:agent-sessions', (raw) => {
    let list: { id: string }[] = []
    if (Array.isArray(raw)) {
      list = raw as { id: string }[]
    } else if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { sessions?: unknown[] }).sessions)
    ) {
      list = (raw as { sessions: { id: string }[] }).sessions
    }

    if (list.length === 0) {
      // 当前没有任何在线 Agent 会话，立即熄灭描边
      clearOverlay()
      return
    }

    // 若之前有特定会话触发了描边，检查产生活跃的会话是否都已断开
    if (activeSessions.size > 0) {
      const currentIds = new Set(list.map((s) => s.id))
      for (const id of activeSessions) {
        if (!currentIds.has(id)) {
          activeSessions.delete(id)
        }
      }
      if (activeSessions.size === 0) {
        clearOverlay()
      }
    }
  })
})

onBeforeUnmount(() => {
  unsubActivity?.()
  unsubSessions?.()
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
