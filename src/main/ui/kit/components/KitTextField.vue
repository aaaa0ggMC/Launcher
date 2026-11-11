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

defineOptions({ inheritAttrs: false })

defineProps<{
  modelValue?: string | number | null
  /** 等宽数值框（居中 + tabular-nums） */
  numeric?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()
const attrs = useAttrs()
useKitSurface()

const { target, content, scale } = useFitBox()
const rootStyle = computed(() => ({ '--kit-fit-scale': String(scale.value) }))
// target/content 在模板里绑到元素上（80% 内容率量容器与内容）；显式引用避免未使用告警
void target
void content

function onInput(v: unknown): void {
  emit('update:modelValue', v)
}
</script>

<template>
  <div ref="target" class="kit-control" :class="{ 'kit-control--num': numeric }" :style="rootStyle">
    <v-text-field
      :model-value="modelValue"
      density="compact"
      variant="outlined"
      hide-details
      v-bind="attrs"
      @update:model-value="onInput"
    >
      <template v-for="(_, n) in $slots as Record<string, unknown>" :key="n" #[n]="slotProps">
        <slot :name="n" v-bind="slotProps ?? {}" />
      </template>
    </v-text-field>
  </div>
</template>
