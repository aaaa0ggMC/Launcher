<script setup lang="ts">
/** KitCodeInline —— 行内代码（import 路径、prop 名、命令名）。 */
defineProps<{ text?: string }>()
</script>

<template>
  <code class="kit-code"
    ><slot>{{ text }}</slot></code
  >
</template>
