<script setup lang="ts">
import { ref, computed, onMounted, inject, watch } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import EqCurveCanvas from './EqCurveCanvas.vue'
import type { EqProfile } from '../types'
import { EQ_BAND_COUNT } from '../types'

/**
 * EQ editor dialog — the curve itself is the editor (drag control points),
 * plus an overall-offset slider that shifts every band together (no apply
 * button: it reshapes the curve live, same as dragging a point).
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** Profile being edited, or null → create a new one. */
    profile: EqProfile | null
    /** Live-preview hook (fires gains → engine, no persistence). */
    preview?: (gains: number[]) => void
    /** Max ±dB gain range for the editor (default 20). */
    range?: number
  }>(),
  { range: 20 }
)
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  save: [profile: { id?: string; name: string; gains: number[] }]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const name = ref('')
const gains = ref<number[]>(Array(EQ_BAND_COUNT).fill(0))
/** Overall offset currently being dragged (applied into gains live). */
const offset = ref(0)

/** Responsive editor-canvas height: shrinks on small screens, ~28vh max. */
const editorHeight = computed(() =>
  Math.round(Math.min(160, Math.max(96, window.innerHeight * 0.28)))
)

function clamp(v: number): number {
  return Math.max(-props.range, Math.min(props.range, Math.round(v * 2) / 2))
}
function onCurveUpdate(next: number[]): void {
  gains.value = next
  props.preview?.(next)
}
function onOffsetInput(v: number): void {
  const delta = v - offset.value
  offset.value = v
  const next = gains.value.map((g) => clamp(g + delta))
  gains.value = next
  props.preview?.(next)
}
function reset(): void {
  offset.value = 0
  gains.value = props.profile ? [...props.profile.gains] : Array(EQ_BAND_COUNT).fill(0)
  name.value = props.profile?.name ?? ''
}
function save(): void {
  const trimmed = name.value.trim() || t('aidj.player.eq_untitled', '未命名 EQ')
  emit('save', { id: props.profile?.id, name: trimmed, gains: [...gains.value] })
  emit('update:modelValue', false)
}
function close(): void {
  emit('update:modelValue', false)
}

// The dialog is a reused component — reset from the current profile EVERY time
// it opens (onMounted alone would only run once, leaving stale gains for later
// profiles).
watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  }
)
onMounted(() => {
  reset()
})
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="560"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card rounded="lg" class="eq-dialog-card">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon start>mdi-chart-bell-curve-cumulative</v-icon>
        {{ profile ? t('aidj.player.eq_edit', '编辑 EQ') : t('aidj.player.eq_new', '新建 EQ') }}
        <v-spacer />
        <v-text-field
          v-model="name"
          density="compact"
          variant="outlined"
          hide-details
          class="eq-name-input"
          :placeholder="t('aidj.player.eq_name', '名称')"
        />
      </v-card-title>

      <v-divider />

      <v-card-text class="pa-4 d-flex flex-column ga-3">
        <EqCurveCanvas
          :gains="gains"
          :interactive="true"
          :height="editorHeight"
          :range="range"
          class="eq-editor-canvas"
          @update="onCurveUpdate"
        />

        <v-divider />

        <div class="d-flex align-center ga-3">
          <span class="text-body-2">{{ t('aidj.player.eq_offset', '整体偏移') }}</span>
          <v-slider
            :model-value="offset"
            :min="-range"
            :max="range"
            :step="1"
            hide-details
            color="primary"
            class="flex-grow-1"
            @update:model-value="onOffsetInput($event as number)"
          />
          <span class="text-body-2 tabular-nums">{{ offset > 0 ? `+${offset}` : offset }} dB</span>
        </div>
      </v-card-text>

      <v-card-actions class="px-4 pb-4 pt-0">
        <v-spacer />
        <v-btn variant="text" @click="close">
          {{ t('aidj.player.eq_cancel', '取消') }}
        </v-btn>
        <v-btn variant="tonal" color="primary" @click="save">
          {{ t('aidj.player.eq_save', '保存') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.eq-name-input {
  max-width: 220px;
}
/* Translucent frosted card — the EQ editor floats over the player page. */
.eq-dialog-card {
  background: rgba(var(--v-theme-surface), 0.72) !important;
  backdrop-filter: blur(28px) saturate(1.2);
  -webkit-backdrop-filter: blur(28px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.eq-editor-canvas {
  width: 100%;
}
</style>
