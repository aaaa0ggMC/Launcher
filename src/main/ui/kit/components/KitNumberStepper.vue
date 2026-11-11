<script setup lang="ts">
/**
 * KitNumberStepper —— 紧凑数字步进器（− [ 42 % ] +）。
 *
 * 语义照 bili/components/settings/DutySection.vue 的 makeStepper：**文本框只当草稿**，
 * 打字中途不夹取（否则打 "60" 会被 "6"→min 的钳制吃掉），失焦 / 回车 / ± 才夹取落值
 * ——下发的补丁因此永远合法。仓里已有五份逐字重复的实现，这是唯一一份。
 *
 * 尺寸（SPEC「3）：± 是图标按钮，允许 size="small"；输入框 compact 密度；
 * ± 按钮触控热区 ≥40px（v-btn size="small" 默认 32px，用内边距补足）。
 */
import { inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { translateTemplate } from '../../i18n'
import KitTextField from './KitTextField.vue'

const props = defineProps<{
  modelValue: number
  min: number
  max: number
  step?: number
  /** 语义名（aria-label 用） */
  label: string
  /** 单位后缀（% / px / ms…） */
  unit?: string
  /** 输入框宽度（px） */
  width?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [number]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const draft = ref(String(props.modelValue))

watch(
  () => props.modelValue,
  (v) => {
    draft.value = String(v)
  }
)

/** 草稿 → 合法值：空 / 非数字回落当前值，其余夹到 [min, max] 并取整 */
function clampInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return props.modelValue
  return Math.min(props.max, Math.max(props.min, Math.round(n)))
}

/** 草稿里的当前值（草稿为空时用已落账的值） */
function current(): number {
  const raw = draft.value.trim()
  if (raw === '') return props.modelValue
  const n = Number(raw)
  return Number.isFinite(n) ? n : props.modelValue
}

function commit(): void {
  const next = clampInt(current())
  draft.value = String(next)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function stepBy(dir: 1 | -1): void {
  const next = clampInt(current() + dir * (props.step ?? 1))
  draft.value = String(next)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

const decLabel = (): string =>
  translateTemplate(uiLang.value, 'kit.stepper.decrease', { label: props.label }, '减少 {label}')
const incLabel = (): string =>
  translateTemplate(uiLang.value, 'kit.stepper.increase', { label: props.label }, '增加 {label}')
</script>

<template>
  <div class="kit-stepper" :style="width ? { width: `${width}px` } : undefined">
    <v-btn
      class="kit-stepper__btn"
      size="small"
      variant="text"
      icon
      :disabled="modelValue <= min"
      :aria-label="decLabel"
      :title="decLabel"
      @click="stepBy(-1)"
    >
      <v-icon>mdi-minus</v-icon>
    </v-btn>
    <KitTextField
      v-model="draft"
      class="kit-stepper__field"
      numeric
      inputmode="numeric"
      :suffix="unit"
      :aria-label="label"
      @blur="commit"
      @keydown.enter="commit"
    />
    <v-btn
      class="kit-stepper__btn"
      size="small"
      variant="text"
      icon
      :disabled="modelValue >= max"
      :aria-label="incLabel"
      :title="incLabel"
      @click="stepBy(1)"
    >
      <v-icon>mdi-plus</v-icon>
    </v-btn>
  </div>
</template>

<style scoped>
.kit-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* ± 触控热区 = 输入档 40px（v-btn size="small" 只有 ~32px），整行与输入框同高 */
.kit-stepper__btn {
  min-width: 40px;
  min-height: 40px;
}

.kit-stepper {
  min-height: 40px;
}

/* 框宽按「3 位数字 + 单位后缀」的量级收窄（80% 内容率：文字占输入区 80%，
   整体不再比内容大一圈）；高度 / 圆角 / 表面由 KitTextField 统一 */
.kit-stepper__field {
  flex: 0 0 auto;
  width: 72px;
}
</style>
