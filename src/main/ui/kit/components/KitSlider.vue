<script setup lang="ts">
/**
 * KitSlider —— 滑块（v-slider 的 kit 封装）。高度对齐输入框（36px），
 * 轨道 4px、圆点 16px 都从网格令牌算。
 */
import { computed, useAttrs } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'

defineOptions({ inheritAttrs: false })

defineProps<{ modelValue?: number | null }>()
const emit = defineEmits<{ 'update:modelValue': [number] }>()
const attrs = useAttrs()
useKitSurface()

const rootStyle = computed(() => ({ '--kit-fit-scale': '1' }))
</script>

<template>
  <div class="kit-control" :style="rootStyle">
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
