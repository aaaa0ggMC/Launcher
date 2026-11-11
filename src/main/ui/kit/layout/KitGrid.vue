<script setup lang="ts">
/**
 * KitGrid —— 网格容器积木（用户：「所有的组件都采用的是网格式计算&布局」）。
 *
 * - 等宽栏（`cols`）/ 自适应栏（`minCol`）/ 显式模板（`cols="1.6fr 1.1fr 0.8fr"`）三种用法；
 * - `align-stretch`：同一行等高（修「三档并排底部不齐」的关键）；
 * - 统一 gutter（栏距 + 行距都走网格令牌，不写裸数字）；
 * - 窄屏默认收成单列（`stack-on-narrow`）。
 */
import { computed } from 'vue'
import { GRID } from './tokens'

const props = withDefaults(
  defineProps<{
    /** 栏数（等宽）或直接给 grid-template-columns 字符串 */
    cols?: number | string
    /** 自适应栏的最小栏宽（px）；给了就忽略 cols */
    minCol?: number
    /** 栏距（px），缺省网格令牌的 8px */
    gap?: number
    /** 行距（px），缺省同栏距 */
    rowGap?: number
    /** 交叉轴对齐 */
    align?: 'stretch' | 'start' | 'center' | 'end'
    /** 窄屏收成单列（默认开） */
    stackOnNarrow?: boolean
  }>(),
  { gap: GRID.gutter, align: 'stretch', stackOnNarrow: true }
)

const template = computed<string>(() => {
  if (props.minCol) return `repeat(auto-fit, minmax(${props.minCol}px, 1fr))`
  if (typeof props.cols === 'number') return `repeat(${props.cols}, minmax(0, 1fr))`
  return props.cols ?? 'repeat(auto-fit, minmax(240px, 1fr))'
})
</script>

<template>
  <div
    class="kit-grid"
    :class="{ 'kit-grid--stack': stackOnNarrow }"
    :style="{
      'grid-template-columns': template,
      gap: `${rowGap ?? gap}px ${gap}px`,
      'align-items': align
    }"
  >
    <slot />
  </div>
</template>

<style scoped>
.kit-grid {
  display: grid;
  min-width: 0;
}

/* 窄屏收成单列：不再横向挤（容器自身有边距时由调用方决定） */
@media (max-width: 720px) {
  .kit-grid--stack {
    grid-template-columns: minmax(0, 1fr) !important;
  }
}
</style>
