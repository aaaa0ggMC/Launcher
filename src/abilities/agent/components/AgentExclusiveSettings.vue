<script setup lang="ts">
/** A2：独占设置（空闲释放时间）。占位，待实现。 */
defineOptions({ name: 'cockpit-settings-agent-exclusive' })
defineProps<{ cfg: { exclusive?: { idleMin?: number } } }>()
defineEmits<{ patch: [patch: { exclusive: { idleMin?: number } }] }>()
</script>

<template>
  <div />
</template>
