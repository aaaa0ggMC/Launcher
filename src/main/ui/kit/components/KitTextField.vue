<script setup lang="ts">
/**
 * KitTextField —— 文本 / 数值输入（v-text-field 的 kit 封装）。
 *
 * 统一口径（SPEC「控件尺寸表 / 密度阶」）：高度 36px（网格令牌）、圆角 8px、
 * 表面吃玻璃变量、输入文字占输入区 80%（useFitBox 超了自动降字号）、
 * 窄屏降到 32px。透传 v-model / aria-label / v-privacy / v-agent-forbidden。
 */
import { computed, useAttrs } from 'vue'
import { useFitBox } from '../composables/useFitBox'
import { useKitSurface } from '../composables/useKitSurface'
import { resolveDensity, useKitDensity } from '../layout/density'
import type { KitAlign } from '../layout/align'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 密度档：input = 输入档（44px outlined，独立表单/对话框用）；inline = 行内档（32px underlined，设置行用） */
  size?: 'input' | 'inline'
  modelValue?: string | number | null
  /** 控件内部对齐（SPEC「行内对齐」）：缺省 center */
  align?: KitAlign
  /** 等宽数值框（右对齐 + tabular-nums） */
  numeric?: boolean
  /** 单位后缀（自绘，紧贴文字；不走 Vuetify 的 suffix prop——那个被 flex 推到输入区
   *  右缘，和数字之间空一截，用户看来就是「漂」。见 kit.css 的 .kit-unit） */
  suffix?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()
const attrs = useAttrs()
useKitSurface()
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

const { target, content, scale } = useFitBox()
const rootStyle = computed(() => ({
  '--kit-fit-scale': String(scale.value),
  '--kit-field-align': props.align ?? 'center'
}))
// target/content 在模板里绑到元素上（80% 内容率量容器与内容）；显式引用避免未使用告警
void target
void content

function onInput(v: unknown): void {
  emit('update:modelValue', v)
}
</script>

<template>
  <div
    ref="target"
    class="kit-control"
    :class="[
      density === 'inline' ? 'kit-control--inline' : undefined,
      numeric ? 'kit-control--num' : undefined
    ]"
    :style="rootStyle"
  >
    <v-text-field
      :model-value="modelValue"
      density="compact"
      :variant="density === 'inline' ? 'underlined' : 'outlined'"
      hide-details
      v-bind="attrs"
      @update:model-value="onInput"
    >
      <template v-if="suffix" #append-inner>
        <span class="kit-unit">{{ suffix }}</span>
      </template>
      <template v-for="(_, n) in $slots as Record<string, unknown>" :key="n" #[n]="slotProps">
        <slot :name="n" v-bind="slotProps ?? {}" />
      </template>
    </v-text-field>
  </div>
</template>
