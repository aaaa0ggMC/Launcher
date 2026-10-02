<script setup lang="ts">
/**
 * 设置 →「AI 与远程」→「独占」：空闲多久自动释放租约。
 * 只负责自己的表单：失焦 / 回车时夹紧到合法范围并 emit('patch')，写盘由父组件统一做。
 */
defineOptions({ name: 'cockpit-settings-agent-exclusive' })

import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '@ui/i18n'

const props = defineProps<{ cfg: { exclusive?: { idleMin?: number } } }>()
const emit = defineEmits<{ patch: [patch: { exclusive: { idleMin?: number } }] }>()

const MIN = 1
const MAX = 60
const FALLBACK = 5

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)
const tt = (k: string, v: Record<string, string>, f?: string): string =>
  translateTemplate(uiLang.value, k, v, f)

const current = computed(() => {
  const n = Number(props.cfg.exclusive?.idleMin)
  return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, Math.round(n))) : FALLBACK
})

const text = ref(String(current.value))
const note = ref('')

// 父组件写盘后 cfg 变化（或语言切换）时同步输入框
watch(current, (v) => {
  if (String(v) !== text.value.trim()) text.value = String(v)
})

/** 失焦 / 回车：夹紧到 1–60，超范围给提示并回写夹紧后的值，有变化才 emit。 */
function save(): void {
  const raw = text.value.trim()
  const n = Number(raw)
  const clamped =
    Number.isFinite(n) && raw !== '' ? Math.min(MAX, Math.max(MIN, Math.round(n))) : FALLBACK
  const fixed = String(clamped) !== raw
  text.value = String(clamped)
  note.value = fixed
    ? tt(
        'agent.excl.idle_fixed',
        { min: String(MIN), max: String(MAX), n: String(clamped) },
        `已调整为 ${clamped}（取值范围 ${MIN}–${MAX} 分钟）`
      )
    : ''
  if (clamped !== current.value) emit('patch', { exclusive: { idleMin: clamped } })
}
</script>

<template>
  <v-card v-agent-forbidden rounded="lg" variant="tonal">
    <v-card-title class="pt-4">{{ t('agent.excl.title', '独占') }}</v-card-title>
    <v-card-subtitle class="excl-wrap">
      {{
        t(
          'agent.excl.desc',
          '同一份存档 / 资源同一时刻只让一个玩家使用。多个 AI 之间冲突会被直接拒绝（不排队、不抢占），你可以随时一键接管。'
        )
      }}
    </v-card-subtitle>
    <v-card-text class="pt-4 pb-6">
      <v-text-field
        v-model="text"
        :label="t('agent.excl.idle', '空闲多久自动释放（分钟）')"
        :hint="
          note || t('agent.excl.idle_hint', 'AI 不再操作后多久释放它占用的资源，会话结束会立即释放')
        "
        :error="!!note"
        persistent-hint
        suffix="min"
        type="number"
        :min="MIN"
        :max="MAX"
        variant="outlined"
        class="excl-field"
        @blur="save"
        @keydown.enter="save"
      />
    </v-card-text>
  </v-card>
</template>

<style scoped>
.excl-wrap {
  white-space: normal;
}
/* 数值输入行：留出呼吸，不要贴着卡片边 */
.excl-field {
  max-width: 280px;
  min-width: 0;
}
</style>
