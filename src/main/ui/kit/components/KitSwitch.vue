<script setup lang="ts">
/**
 * KitSwitch —— 开关（v-switch 的 kit 封装）。整控件高度对齐 36px，
 * 触控热区 40px（触屏按下不偏）。
 */
import { computed, useAttrs } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'
import { resolveDensity, useKitDensity } from '../layout/density'
import type { KitAlign } from '../layout/align'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 密度档：input = 输入档（44px outlined，独立表单/对话框用）；inline = 行内档（32px underlined，设置行用） */
  size?: 'input' | 'inline'
  modelValue?: boolean | null
  /** 控件内部对齐（SPEC「行内对齐」）：缺省 center */
  align?: KitAlign
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
const attrs = useAttrs()
useKitSurface()
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

const rootStyle = computed(() => ({
  '--kit-fit-scale': '1',
  '--kit-field-align': props.align ?? 'center'
}))
</script>

<template>
  <div
    class="kit-control"
    :class="density === 'inline' ? 'kit-control--inline' : undefined"
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
