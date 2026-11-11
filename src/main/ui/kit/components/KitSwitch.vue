<script setup lang="ts">
/**
 * KitSwitch —— 开关（v-switch 的 kit 封装）。整控件高度对齐 36px，
 * 触控热区 40px（触屏按下不偏）。
 */
import { computed, useAttrs } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'

defineOptions({ inheritAttrs: false })

defineProps<{ modelValue?: boolean | null }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
const attrs = useAttrs()
useKitSurface()

const rootStyle = computed(() => ({ '--kit-fit-scale': '1' }))
</script>

<template>
  <div class="kit-control" :style="rootStyle">
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
