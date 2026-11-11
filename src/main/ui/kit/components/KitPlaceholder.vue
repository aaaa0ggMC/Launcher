<script setup lang="ts">
/**
 * KitPlaceholder —— 占位积木：代表「这里是一块全幅内容区」。
 *
 * 用户在画廊里问「image2 的条条是啥」——那是 canvas 模式的占位图案。做成正式积木：
 * 三种 pattern（stripe 斜纹 / dots 点阵 / plain 纯文本），颜色全部走主题变量，
 * 跟着 10 套主题切换；可带 caption 说明这块区域在真实页面里放什么。
 * 同样吃玻璃变量与网格令牌。
 */
import { computed } from 'vue'
import { GRID } from '../layout/tokens'

const props = withDefaults(
  defineProps<{
    /** 斜纹 / 点阵 / 纯文本 */
    pattern?: 'stripe' | 'dots' | 'plain'
    /** 占位高度（px） */
    height?: number
    /** 说明文字（这块区域在真实页面里放什么） */
    caption?: string
    /** 图标（可选，放在说明上方） */
    icon?: string
  }>(),
  { pattern: 'stripe', height: 96, caption: '', icon: '' }
)

const patternStyle = computed<Record<string, string>>(() => {
  const line = 'rgba(var(--v-theme-on-surface), 0.07)'
  const dot = 'rgba(var(--v-theme-primary), 0.16)'
  const style: Record<string, string> = {}
  if (props.pattern === 'dots') {
    style.backgroundImage = `radial-gradient(${dot} 1.5px, transparent 1.5px)`
    style.backgroundSize = '12px 12px'
  } else if (props.pattern === 'stripe') {
    style.backgroundImage = `repeating-linear-gradient(45deg, ${line} 0 10px, transparent 10px 20px)`
  }
  return style
})
</script>

<template>
  <div
    class="kit-placeholder"
    :style="{
      ...patternStyle,
      height: `${height}px`,
      borderRadius: `${GRID.radius}px`,
      padding: `${GRID.pad}px`
    }"
  >
    <v-icon v-if="icon" class="kit-placeholder__icon" :size="22">{{ icon }}</v-icon>
    <span v-if="caption" class="kit-placeholder__caption">{{ caption }}</span>
    <slot />
  </div>
</template>

<style scoped>
.kit-placeholder {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  min-width: 0;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.16);
  color: rgba(var(--v-theme-on-surface-variant), 0.85);
  text-align: center;
}

.kit-placeholder__icon {
  opacity: 0.7;
}

.kit-placeholder__caption {
  font-size: 0.8125rem;
  line-height: 1.5;
  max-width: 32em;
}
</style>
