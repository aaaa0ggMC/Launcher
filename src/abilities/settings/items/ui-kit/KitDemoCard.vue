<script setup lang="ts">
/**
 * 画廊demo 的统一外壳：标题 + 活示例 + 一句「什么时候用 / 不要用什么」。
 * 每个积木一节，外观与设置页其他分区一致（v-card tonal + card-fill）。
 */
defineProps<{
  /** 积木名（标题） */
  title: string
  /** 导入路径提示，如 `import { KitSmartRow } from '@ui/kit'` */
  importPath?: string
  /** 什么时候用 */
  use?: string
  /** 不要用什么 */
  avoid?: string
  /** 通栏（宽度模拟器等需要整行的 demo） */
  full?: boolean
}>()
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill kit-demo">
    <v-card-title class="d-flex align-center flex-wrap ga-2 text-subtitle-2">
      <span>{{ title }}</span>
      <span v-if="importPath" class="kit-demo__path text-caption on-surface-variant">
        {{ importPath }}
      </span>
    </v-card-title>
    <v-card-text class="kit-demo__body">
      <slot />
      <div v-if="use || avoid" class="kit-demo__note">
        <div v-if="use" class="kit-demo__use">
          <v-icon icon="mdi-check-circle-outline" size="16" color="success" />
          <span>{{ use }}</span>
        </div>
        <div v-if="avoid" class="kit-demo__avoid">
          <v-icon icon="mdi-close-circle-outline" size="16" color="error" />
          <span>{{ avoid }}</span>
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.kit-demo__path {
  font-family: var(--v-font-code, monospace);
  overflow-wrap: anywhere;
}

.kit-demo__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kit-demo__note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface-variant), 0.9);
}

.kit-demo__use,
.kit-demo__avoid {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.kit-demo__use .v-icon,
.kit-demo__avoid .v-icon {
  margin-top: 2px;
  flex: none;
}
</style>
