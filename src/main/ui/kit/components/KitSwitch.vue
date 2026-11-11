<script setup lang="ts">
/**
 * KitSwitch —— 开关（v-switch 的 kit 封装）。整控件高度对齐 36px，
 * 触控热区 40px（触屏按下不偏）。
 */
import { computed, useAttrs } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'

defineOptions({ inheritAttrs: false })

defineProps<{
  /** 密度档：input = 输入档（44px outlined，独立表单/对话框用）；inline = 行内档（32px underlined，设置行用） */
  size?: 'input' | 'inline'
  modelValue?: boolean | null
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
const attrs = useAttrs()
useKitSurface()

const rootStyle = computed(() => ({ '--kit-fit-scale': '1' }))
</script>

<template>
  <div
    class="kit-control"
    :class="size === 'inline' ? 'kit-control--inline' : undefined"
    :style="rootStyle"
  >
    <v-switch
      :model-value="modelValue"
      density="compact"
      hide-details
      color="primary"
      v-bind="attrs"
      @update:model-value="emit('update:modelValue', Boolean($event))"
    />
  </div>
</template>
