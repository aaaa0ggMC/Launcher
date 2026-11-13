<script setup lang="ts">
/**
 * KitSelect —— 下拉选择（v-select 的 kit 封装）。尺寸 / 表面 / 80% 内容率同 KitTextField。
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
  modelValue?: unknown
  /** 控件内部对齐（SPEC「行内对齐」）：缺省 center */
  align?: KitAlign
  items?: readonly unknown[]
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()
const attrs = useAttrs()
useKitSurface()
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

const { target, scale } = useFitBox()
const rootStyle = computed(() => ({
  '--kit-fit-scale': String(scale.value),
  '--kit-field-align': props.align ?? 'center'
}))
void target
</script>

<template>
  <div
    ref="target"
    class="kit-control"
    :class="density === 'inline' ? 'kit-control--inline' : undefined"
    :style="rootStyle"
  >
    <v-select
      :model-value="modelValue"
      :items="items"
      density="compact"
      :variant="density === 'inline' ? 'underlined' : 'outlined'"
      hide-details
      v-bind="attrs"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <template v-for="(_, n) in $slots as Record<string, unknown>" :key="n" #[n]="slotProps">
        <slot :name="n" v-bind="slotProps ?? {}" />
      </template>
    </v-select>
  </div>
</template>
