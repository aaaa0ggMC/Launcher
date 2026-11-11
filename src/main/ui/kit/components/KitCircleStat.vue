<script setup lang="ts">
/**
 * KitCircleStat —— 圆形数据卡（80% 内容率的样板实现）。
 *
 * 规则（kit 正式规则，见 layout/fit.ts）：**内容占容器 80%，余下 20% 做呼吸**。
 * 圆形的推导：文字占直径的 80% → 直径 = 文本宽高 × 1.25，再夹在 min/max 之间。
 * 所以「圆被裁切、文字塞满整个圆」这类问题从公式上就不成立：
 * `aspect-ratio:1` 保证是圆、`overflow:visible` 保证圆环不被裁、内盒固定 80%。
 */
import { computed } from 'vue'
import { circleDiameter } from '../layout/fit'
import { estimateTextWidth } from '../layout/engine'

const props = withDefaults(
  defineProps<{
    /** 主数值（字符串，方便带单位） */
    value: string
    /** 数值下方的标签 */
    label?: string
    /** 直径下限 / 上限（px） */
    min?: number
    max?: number
    /** 主数值字号（rem） */
    valueSize?: number
    /** 标签字号（rem） */
    labelSize?: number
    /** 语义色（主题变量名，缺省 primary） */
    color?: string
    /** 环形进度 0-1（不给就不画环） */
    progress?: number
  }>(),
  {
    label: '',
    min: 44,
    max: 132,
    valueSize: 1.125,
    labelSize: 0.6875,
    color: 'primary',
    progress: undefined
  }
)

/** 文本盒子估算（值一行 + 标签一行）→ 直径 */
const diameter = computed(() => {
  const valueW = estimateTextWidth(props.value, props.valueSize * 16)
  const labelW = props.label ? estimateTextWidth(props.label, props.labelSize * 16) : 0
  const textH = props.valueSize * 16 * 1.3 + (props.label ? props.labelSize * 16 * 1.3 : 0)
  return circleDiameter({ width: Math.max(valueW, labelW), height: textH }, props.min, props.max)
})

const ringStyle = computed(() => {
  const p = Math.max(0, Math.min(1, props.progress ?? 0))
  return {
    background: `conic-gradient(rgb(var(--v-theme-${props.color})) ${p * 360}deg, rgba(var(--v-theme-on-surface), 0.1) 0)`
  }
})
</script>

<template>
  <div
    class="kit-circle"
    :style="{
      width: `${diameter}px`,
      height: `${diameter}px`,
      '--kit-circle-color': `var(--v-theme-${color})`
    }"
  >
    <div v-if="progress !== undefined" class="kit-circle__ring" :style="ringStyle" />
    <!-- 内盒固定 80%：文字永远在安全区里 -->
    <div class="kit-circle__inner">
      <span class="kit-circle__value kit-num" :style="{ fontSize: `${valueSize}rem` }">{{
        value
      }}</span>
      <span v-if="label" class="kit-circle__label" :style="{ fontSize: `${labelSize}rem` }">{{
        label
      }}</span>
    </div>
  </div>
</template>

<style scoped>
.kit-circle {
  position: relative;
  aspect-ratio: 1;
  /* 圆环 / 圆点超出边界也不能被裁 */
  overflow: visible;
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex: none;
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.kit-circle__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  mask: radial-gradient(circle, transparent 0 calc(100% - 4px), #000 calc(100% - 4px));
  -webkit-mask: radial-gradient(circle, transparent 0 calc(100% - 4px), #000 calc(100% - 4px));
}

.kit-circle__inner {
  /* 80% 内容率：内盒永远只占直径的 80% */
  width: 80%;
  height: 80%;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 1px;
  text-align: center;
  min-width: 0;
}

.kit-circle__value {
  font-weight: 600;
  line-height: 1.15;
  color: var(--kit-circle-color);
  white-space: nowrap;
}

.kit-circle__label {
  line-height: 1.2;
  color: rgba(var(--v-theme-on-surface-variant), 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
</style>
