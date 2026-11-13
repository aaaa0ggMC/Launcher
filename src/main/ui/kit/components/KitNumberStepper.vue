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
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { translateTemplate } from '../../i18n'
import KitTextField from './KitTextField.vue'
import { resolveDensity, useKitDensity } from '../layout/density'

const props = defineProps<{
  /** 密度档：input = 输入档（44px）；inline = 行内档（32px，设置行用） */
  size?: 'input' | 'inline'
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
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

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
  <div
    class="kit-stepper kit-control"
    :class="density === 'inline' ? 'kit-control--inline' : undefined"
    :style="width ? { width: `${width}px` } : undefined"
  >
    <button
      type="button"
      class="kit-stepper__btn"
      :disabled="modelValue <= min"
      :aria-label="decLabel()"
      :title="decLabel()"
      @click="stepBy(-1)"
    >
      <v-icon size="small">mdi-minus</v-icon>
    </button>
    <!-- inline 档：kit 自建 input + 自绘单位（盒模型归我们，单位紧贴数字不漂） -->
    <div v-if="density === 'inline'" class="kit-inline-row kit-stepper__field">
      <input
        class="kit-inline-input kit-inline-input--num"
        :value="draft"
        inputmode="numeric"
        :aria-label="label"
        @input="draft = ($event.target as HTMLInputElement).value"
        @blur="commit"
        @keydown.enter="commit"
      />
      <span v-if="unit" class="kit-unit">{{ unit }}</span>
    </div>
    <!-- input 档：Vuetify 原装外观 -->
    <KitTextField
      v-else
      v-model="draft"
      class="kit-stepper__field"
      numeric
      inputmode="numeric"
      :suffix="unit"
      :aria-label="label"
      @blur="commit"
      @keydown.enter="commit"
    />
    <button
      type="button"
      class="kit-stepper__btn"
      :disabled="modelValue >= max"
      :aria-label="incLabel()"
      :title="incLabel()"
      @click="stepBy(1)"
    >
      <v-icon size="small">mdi-plus</v-icon>
    </button>
  </div>
</template>

<style scoped>
/* ± 触控热区 ≥40px 宽（v-btn size="small" 只有 ~32px）；高度 / 表面 / 对齐由 kit.css
   的 .kit-stepper__btn 与 .kit-control 统一给，这里只留步进器特有的间距。 */
.kit-stepper__field {
  flex: 0 0 auto;
}
</style>
