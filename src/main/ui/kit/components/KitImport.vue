<script setup lang="ts">
/**
 * KitImport —— 带图标的 import 行：`import { KitPage, KitSmartRow } from '@ui/kit'`。
 * 纯展示（不可点），等宽 + 主色描边，窄屏降一档字号。
 */
defineProps<{
  /** 从哪个模块导入 */
  from: string
  /** 导入哪些名字 */
  names?: string[]
}>()
</script>

<template>
  <span class="kit-import">
    <v-icon class="kit-import__icon" :size="14">mdi-package-variant-closed</v-icon>
    <span v-if="names?.length">import { {{ names.join(', ') }} } from '{{ from }}'</span>
    <span v-else>import '{{ from }}'</span>
  </span>
</template>
