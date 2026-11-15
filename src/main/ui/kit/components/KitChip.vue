<script setup lang="ts">
/**
 * KitChip —— 行内胶囊（chip）。
 *
 * 为什么必须有这个积木：gallery demo 里手写过 `.kit-demo-chip`
 * （display:inline-block + padding + border-radius），没有 nowrap、没有高度兜底——
 * 行内空间一紧 flex 项被压窄，文字折行、胶囊随之变高，于是一行里「延迟 12ms」两行高、
 * 「60 FPS」一行高（用户：「你这一行内胶囊大小不一致」）。这同时违反 gallery 必须 100%
 * 由 kit 组成、以及 SPEC「行内同类元素同尺寸」。
 *
 * 口径（全部从令牌算）：
 * - 高度走密度阶：inline 档固定 24px（布局）= 视觉 26px（zoom 1.1），**不随内容变**；
 * - 文字不折行：white-space:nowrap + 超长省略号；
 * - 内边距 / 圆角 / 字号从网格与字号阶令牌算，表面吃玻璃变量；
 * - `priority` 交给行的引擎：secondary / tertiary 装不下时被自动隐藏、收进行尾「更多」。
 */
import { computed, useAttrs } from 'vue'
import KitTruncated from './KitTruncated.vue'
import { useKitSurface } from '../composables/useKitSurface'
import { resolveDensity, useKitDensity } from '../layout/density'
import { GRID } from '../layout/tokens'
import type { KitAlign } from '../layout/align'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** 胶囊文字 */
    text?: string
    /** 密度档：input = 输入档（32px 布局）；inline = 行内档（24px 布局，设置行用） */
    size?: 'input' | 'inline'
    /** 控件内部对齐（SPEC「行内对齐」）：缺省 center */
    align?: KitAlign
    /** 语义色：neutral（默认）/ primary / success / warning / error */
    tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'error'
    /** 前置图标（mdi） */
    icon?: string
  }>(),
  { tone: 'neutral' }
)

const emit = defineEmits<{ click: [MouseEvent] }>()

const attrs = useAttrs()
useKitSurface()
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

/** 高度 = 密度阶令牌（布局像素；zoom 1.1 下视觉再乘 1.1） */
const chipHeight = computed(() => (density.value === 'inline' ? GRID.unit * 6 : GRID.unit * 8))

const rootStyle = computed(() => ({
  '--kit-chip-height': `${chipHeight.value}px`,
  '--kit-field-align': props.align ?? 'center'
}))
</script>

<template>
  <span
    class="kit-chip"
    :class="`kit-chip--${tone}`"
    :style="rootStyle"
    v-bind="attrs"
    @click="emit('click', $event)"
  >
    <v-icon v-if="icon" class="kit-chip__icon" size="x-small">{{ icon }}</v-icon>
    <KitTruncated class="kit-chip__text" :text="text">{{ text }}</KitTruncated>
  </span>
</template>

<style scoped>
/* 高度固定 = 密度阶令牌，不随内容变（SPEC「行内同类元素同尺寸」） */
.kit-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--kit-chip-height);
  /* 内边距从令牌算：inline 档左右 2 单位（8px） */
  padding: 0 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1;
  white-space: nowrap;
  background: rgba(var(--v-theme-on-surface), 0.08);
  color: rgb(var(--v-theme-on-surface));
  max-width: 100%;
  box-sizing: border-box;
  vertical-align: middle;
}

/* 文字截断与揭示交给 KitTruncated（SPEC「信息降级链」档 1） */

.kit-chip__icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.kit-chip--primary {
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
}

.kit-chip--success {
  background: rgba(var(--v-theme-success), 0.16);
  color: rgb(var(--v-theme-success));
}

.kit-chip--warning {
  background: rgba(var(--v-theme-warning), 0.16);
  color: rgb(var(--v-theme-warning));
}

.kit-chip--error {
  background: rgba(var(--v-theme-error), 0.16);
  color: rgb(var(--v-theme-error));
}

.kit-chip--neutral {
  background: rgba(var(--v-theme-on-surface), 0.08);
}
</style>
