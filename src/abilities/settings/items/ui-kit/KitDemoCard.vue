<script setup lang="ts">
/**
 * 画廊 demo 的统一外壳：标题 + 活示例 + 「什么时候用 / 不要用什么」+ 导入行。
 * 全部由 kit 积木拼（KitTitle / KitImport / KitHint / KitProse），不允许裸文本。
 */
import { KitHint, KitImport, KitTitle } from '@ui/kit'

defineProps<{
  /** 积木名（标题） */
  title: string
  /** 导入路径提示，如 `@ui/kit` */
  importPath?: string
  /** 导入的名字（拼成 import { … } from '…'） */
  importNames?: string[]
  /** 什么时候用 */
  use?: string
  /** 不要用什么 */
  avoid?: string
}>()
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill kit-demo">
    <v-card-text class="kit-demo__body">
      <KitTitle :icon="'mdi-puzzle-outline'">{{ title }}</KitTitle>
      <KitImport v-if="importPath" :from="importPath" :names="importNames" />
      <slot />
      <div v-if="use || avoid" class="kit-demo__note">
        <KitHint v-if="use" tone="ok">{{ use }}</KitHint>
        <KitHint v-if="avoid" tone="warn">{{ avoid }}</KitHint>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.kit-demo__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kit-demo__note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
</style>
