<script setup lang="ts">
/**
 * KitSettingRow —— 设置行 `[名字] [控件] [数值]`，KitSmartRow 的设置页特化。
 *
 * 仓里这个模式有 140 处 `justify-space-between`、同一份模板在同一个文件里抄 4 遍
 * （settings/items/WindowSection.vue），这里是唯一一份。
 *
 * 两条内置硬禁令（都来自 bili 已踩过的坑）：
 *   1. **设置页禁止通栏 v-slider**（可见宽度 >320px 即违规）——默认渲染 KitNumberStepper，
 *      slider 要显式 `slider` opt-in，且只在宽屏出现；
 *   2. 移动端默认给步进器不给滑块——窄屏下即使 opt-in 也回落成步进器。
 *
 * 直接挂进现有设置页网格（components/SettingsCategoryView.vue 的 v-row/v-col md=6），
 * 不需要改 settings/View.vue：行根就是普通的块级盒子。
 *
 * `secondary`：整行标 secondary，窄屏下可被 KitSmartRow 整体隐藏（收进行尾「更多」）。
 */
import { computed, toValue, useSlots } from 'vue'
import type { Ref } from 'vue'
import { useAdaptive } from '../composables/useAdaptive'
import KitSlider from './KitSlider.vue'
import KitSmartRow from '../layout/KitSmartRow.vue'
import KitRowItem from '../layout/KitRowItem.vue'
import KitNumberStepper from './KitNumberStepper.vue'

const props = defineProps<{
  /** 设置项名字 */
  label: string
  /** 右侧数值（等宽字体）；数值型行会自动拼上 unit */
  value?: string | number
  /** 名字下方的副标题说明 */
  desc?: string
  /** 行说明（KitSmartRow 的 hint） */
  hint?: string
  /** 控件固定宽度（px） */
  controlWidth?: number
  /** 整行标 secondary：窄屏可整行隐藏 */
  secondary?: boolean
  /** 数值型行：v-model */
  modelValue?: number
  min?: number
  max?: number
  step?: number
  unit?: string
  /** 显式 opt-in 滑块（仅宽屏；窄屏仍回落步进器） */
  slider?: boolean
  /** 隐藏右侧数值（数值型行默认显示） */
  hideValue?: boolean
  /** 控件密度档（缺省 inline = 设置行行内档；独立大表单可传 'input'） */
  controlSize?: 'input' | 'inline'
  /**
   * 窄屏判定的外部覆盖：传 true 强制按手机档渲染（步进器、隐藏数值框）。
   * 缺省跟视口断点（useAdaptive 的 720）；容器比视口窄的场景（画廊宽度模拟器、
   * 侧栏里的面板）传一个容器断点 Ref 进来。
   */
  narrow?: boolean | Ref<boolean>
}>()

defineEmits<{
  'update:modelValue': [number]
}>()

const viewportNarrow = useAdaptive().narrow
const slots = useSlots()
/** 窄屏判定：外部覆盖优先（容器断点），否则跟视口断点 */
const narrow = computed(() =>
  props.narrow === undefined ? viewportNarrow.value : toValue(props.narrow)
)

const priority = computed(() => (props.secondary ? 'secondary' : 'primary'))
const controlSize = computed(() => props.controlSize ?? 'inline')
const showSlider = computed(() => props.slider === true && !narrow.value)
const hasControl = computed(() => slots.default !== undefined)
const valueText = computed<string | undefined>(() => {
  if (props.value !== undefined) return String(props.value)
  if (props.modelValue === undefined) return undefined
  return props.unit ? `${props.modelValue}${props.unit}` : String(props.modelValue)
})
</script>

<template>
  <KitSmartRow class="kit-setting-row" :hint="hint">
    <!-- 名字：可省略号、可生长（吃掉控件剩下的空间），永远可见 -->
    <KitRowItem kind="label" :text="label" :priority="priority" truncate grow>
      <div class="kit-setting-row__name" :title="label">
        <span class="kit-setting-row__label">{{ label }}</span>
        <span v-if="desc" class="kit-setting-row__desc text-caption on-surface-variant">
          {{ desc }}
        </span>
      </div>
    </KitRowItem>

    <!-- 控件：调用方给插槽；没给插槽时按数值型行渲染步进器 / 滑块 -->
    <KitRowItem v-if="hasControl" :priority="priority" :min-width="controlWidth ?? 160">
      <!-- 行内档：设置行不该出现 44px 的方块（SPEC「密度阶」）。调用方可用 control-size 覆盖 -->
      <slot :size="controlSize" />
    </KitRowItem>
    <KitRowItem
      v-else-if="modelValue !== undefined"
      :priority="priority"
      :min-width="controlWidth ?? 120"
    >
      <KitSlider
        v-if="showSlider"
        size="inline"
        :model-value="modelValue"
        :min="min ?? 0"
        :max="max ?? 100"
        :step="step ?? 1"
        :aria-label="label"
        @update:model-value="$emit('update:modelValue', Number($event))"
      />
      <KitNumberStepper
        v-else
        size="inline"
        :model-value="modelValue"
        :min="min ?? 0"
        :max="max ?? 100"
        :step="step ?? 1"
        :label="label"
        :unit="unit"
      />
    </KitRowItem>

    <!-- 右侧数值：secondary，窄屏自动隐藏（收进行尾「更多」） -->
    <KitRowItem
      v-if="valueText !== undefined && !hideValue"
      kind="number"
      priority="secondary"
      :min-width="48"
      :text="valueText"
    >
      <span class="kit-setting-row__value" :title="valueText">{{ valueText }}</span>
    </KitRowItem>
  </KitSmartRow>
</template>

<style scoped>
.kit-setting-row {
  width: 100%;
}

.kit-setting-row__name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.kit-setting-row__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kit-setting-row__desc {
  min-width: 0;
}

/* 数值等宽右对齐，读起来不跳 */
.kit-setting-row__value {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
