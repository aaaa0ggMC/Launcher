<script setup lang="ts">
/**
 * KitSlider —— 滑块（v-slider 的 kit 封装）。高度对齐输入框（36px），
 * 轨道 4px、圆点 16px 都从网格令牌算。
 */
import { computed, useAttrs } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    /** 密度档：input = 输入档（44px outlined，独立表单/对话框用）；inline = 行内档（32px underlined，设置行用） */
    size?: 'input' | 'inline'
    /** 吃满控件槽（滑块默认要；关掉用于只想要一小段的场景）。
     *  注意：Vue 会把缺席的 Boolean prop 铸成 false，所以默认值必须写在 withDefaults 里 */
    fill?: boolean
    modelValue?: number | null
  }>(),
  { fill: true }
)
const emit = defineEmits<{ 'update:modelValue': [number] }>()
const attrs = useAttrs()
useKitSurface()

const rootStyle = computed(() => ({ '--kit-fit-scale': '1' }))
</script>

<template>
  <div
    class="kit-control"
    :class="[
      size === 'inline' ? 'kit-control--inline' : undefined,
      fill ? 'kit-control--fill' : undefined
    ]"
    :style="rootStyle"
  >
    <v-slider
      :model-value="modelValue ?? undefined"
      density="compact"
      hide-details
      color="primary"
      v-bind="attrs"
      @update:model-value="emit('update:modelValue', Number($event))"
    />
  </div>
</template>
