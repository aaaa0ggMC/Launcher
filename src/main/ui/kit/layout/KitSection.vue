<script setup lang="ts">
/**
 * KitSection —— 分区卡片：标题 + 操作插槽 + 默认插槽。
 *
 * 统一 py-3（DESIGN §3：区块间距 py-3 起步，避免按钮紧贴分隔线 / 卡片顶）；
 * 操作区 `flex-wrap` 兜底（DESIGN §4.2：空间不足换行，不压缩按钮）；
 * 文字按钮默认密度、图标按钮才允许 size="small"（DESIGN §1.3，由调用方遵守）。
 *
 * `scroll`：把本区变成内部滚动区。在 `<KitPage mode="app">` 里 `flex-grow-1` 吃满剩余
 * 高度（页面级零滚动）；在 `mode="canvas"` 里按内容高度排、超出自行内滚；
 * `document` 模式下不内滚（正常文档流）。
 */
defineProps<{
  /** 分区标题 */
  title?: string
  /** 标题旁图标（mdi） */
  icon?: string
  /** 标题下的说明小字 */
  hint?: string
  /** 内部滚动区（配合 KitPage 的 app / canvas 模式） */
  scroll?: boolean
  /** 去掉内边距（全幅内容，如表格 / 画布） */
  flush?: boolean
  /** 无标题行（标题由外层给） */
  bare?: boolean
}>()
</script>

<template>
  <section
    class="kit-section"
    :class="{
      'kit-section--scroll': scroll,
      'kit-section--flush': flush,
      'kit-section--bare': bare
    }"
  >
    <header v-if="!bare && (title || icon || $slots.actions)" class="kit-section__head">
      <div class="kit-section__title">
        <v-icon v-if="icon" class="kit-section__icon" :size="18">{{ icon }}</v-icon>
        <span v-if="title" class="text-subtitle-2 font-weight-medium">{{ title }}</span>
        <span v-if="hint" class="kit-section__hint text-caption on-surface-variant">{{
          hint
        }}</span>
      </div>
      <div v-if="$slots.actions" class="kit-section__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="kit-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.kit-section {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding-block: 12px; /* py-3 */
  padding-inline: 16px;
}

.kit-section--flush {
  padding: 0;
}

.kit-section--bare .kit-section__head {
  display: none;
}

.kit-section__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
}

.kit-section__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.kit-section__icon {
  opacity: 0.8;
}

.kit-section__hint {
  min-width: 0;
}

/* 操作区：图标工具 / 文字操作分组由调用方用 ga-1 / ga-2 表达，这里保证换行兜底 */
.kit-section__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.kit-section__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* ── 内部滚动区：随 KitPage 的模式切换（CSS 后代选择器，不需要 JS 接线） ── */

/* document：正常文档流，不内滚 */
.kit-section--scroll {
  overflow: visible;
}

/* app：吃满剩余高度，外壳零滚动 */
.kit-page--app .kit-section--scroll {
  flex: 1 1 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* canvas：按内容高度排，最多占到外壳一半，超出自行内滚；
   真有更多内容时外壳滚（两个滚动条都在） */
.kit-page--canvas .kit-section--scroll {
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
