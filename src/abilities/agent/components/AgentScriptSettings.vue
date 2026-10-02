<script setup lang="ts">
/** B2：command_script 设置（总开关与限额）。占位，待实现。 */
defineOptions({ name: 'cockpit-settings-agent-script' })
defineProps<{
  cfg: {
    script?: {
      enabled?: boolean
      maxCalls?: number
      cpuMs?: number
      wallSec?: number
      memoryMB?: number
    }
  }
}>()
defineEmits<{
  patch: [
    patch: {
      script: {
        enabled?: boolean
        maxCalls?: number
        cpuMs?: number
        wallSec?: number
        memoryMB?: number
      }
    }
  ]
}>()
</script>

<template>
  <div />
</template>
