<script setup lang="ts">
/**
 * ask_user 的提问卡片。三种形态：
 * - 等待回答（本轮在运行、调用还在执行）：选项可点、可写「其他」，提交 / 不回答；
 * - 已回答：每题显示选中的选项与补充，跳过的题标「已跳过」；
 * - 已失效：调用没有结果但运行已经结束（停止 / 应用重启），只读显示问题。
 * 同一组件也作为过程卡片里这次调用的结果视图（没有 live / sessionId，只读）。
 */
import { computed, inject, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolCallItem } from '../../types'
import { normalizeQuestions, type AskDisplay, type AskQuestion } from './ask'

const props = defineProps<{
  call: ToolCallItem
  pluginId?: string
  toolName?: string
  sessionId?: string
  /** 本轮正在运行；undefined = 作为过程卡片里的结果视图 */
  live?: boolean
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const display = computed(() => {
  const r = props.call.result as Partial<AskDisplay> | undefined
  return r && Array.isArray(r.questions) && Array.isArray(r.answers) ? (r as AskDisplay) : null
})

const questions = computed<AskQuestion[]>(() => {
  if (display.value) return display.value.questions
  try {
    const args =
      typeof props.call.args === 'string' ? JSON.parse(props.call.args || '{}') : props.call.args
    return normalizeQuestions((args ?? {}) as Record<string, unknown>)
  } catch {
    return []
  }
})

const embedded = computed(() => props.live === undefined)
const submitted = ref(false)
const expired = ref(false)
const state = computed<'answered' | 'asking' | 'waiting' | 'expired' | 'failed'>(() => {
  if (display.value) return 'answered'
  if (props.call.status === 'failed') return 'failed'
  if (props.call.status === 'executing' || props.call.status === 'pending') {
    if (embedded.value) return 'waiting'
    if (props.live && !expired.value) return submitted.value ? 'waiting' : 'asking'
  }
  return 'expired'
})

// ---- 作答 ----
interface Draft {
  selected: string[]
  note: string
}
const drafts = reactive<Draft[]>([])
watch(
  questions,
  (qs) => {
    drafts.splice(0, drafts.length, ...qs.map(() => ({ selected: [], note: '' })))
  },
  { immediate: true }
)

function toggle(qi: number, label: string): void {
  const q = questions.value[qi]
  const d = drafts[qi]
  if (!q || !d || state.value !== 'asking') return
  const has = d.selected.includes(label)
  if (q.multiSelect)
    d.selected = has ? d.selected.filter((l) => l !== label) : [...d.selected, label]
  else d.selected = has ? [] : [label]
}

const answeredCount = computed(
  () => drafts.filter((d) => d.selected.length > 0 || d.note.trim()).length
)
const busy = ref(false)
const error = ref('')

async function send(dismissed: boolean): Promise<void> {
  if (busy.value || state.value !== 'asking' || !props.sessionId) return
  busy.value = true
  error.value = ''
  try {
    const r = (await window.cockpit.command('yaya.ask-answer', {
      session: props.sessionId,
      call: props.call.id,
      ...(dismissed
        ? { dismissed: true }
        : {
            answers: drafts.map((d) => ({ selected: [...d.selected], note: d.note.trim() }))
          })
    })) as { ok?: boolean }
    if (r?.ok) submitted.value = true
    else expired.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function onNoteKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && answeredCount.value > 0) void send(false)
}

const headIcon = computed(() => {
  switch (state.value) {
    case 'answered':
      return display.value?.dismissed ? 'mdi-help-circle-outline' : 'mdi-check-circle-outline'
    case 'failed':
    case 'expired':
      return 'mdi-help-circle-outline'
    default:
      return 'mdi-chat-question-outline'
  }
})
const headText = computed(() => {
  switch (state.value) {
    case 'asking':
      return t('yaya.ask.title', '想问你几个问题')
    case 'waiting':
      return t('yaya.ask.waiting', '已提交，正在继续…')
    case 'answered':
      return display.value?.dismissed
        ? t('yaya.ask.dismissed', '没有回答')
        : t('yaya.ask.answered', '你的回答')
    case 'failed':
      return t('yaya.ask.failed', '提问已中止')
    default:
      return t('yaya.ask.expired', '提问已失效')
  }
})
</script>

<template>
  <div
    v-if="questions.length"
    class="ask-card"
    :class="[`is-${state}`, { 'is-embedded': embedded }]"
    role="group"
    :aria-label="headText"
  >
    <div v-if="!embedded" class="ask-head">
      <v-icon :icon="headIcon" size="20" class="ask-head-icon" />
      <span class="ask-head-text">{{ headText }}</span>
      <v-progress-circular
        v-if="state === 'waiting'"
        indeterminate
        size="14"
        width="2"
        class="ml-1"
      />
    </div>

    <div v-for="(q, qi) in questions" :key="qi" class="ask-q" :class="{ 'has-divider': qi > 0 }">
      <div class="ask-q-title">
        <span v-if="q.header" class="ask-chip">{{ q.header }}</span>
        <span class="ask-q-text">{{ q.question }}</span>
        <span v-if="q.multiSelect && state === 'asking'" class="ask-q-hint">
          {{ t('yaya.ask.multi', '可多选') }}
        </span>
      </div>

      <!-- 作答中：选项卡片 + 其他 -->
      <template v-if="state === 'asking'">
        <div v-if="q.options.length" class="ask-options">
          <button
            v-for="o in q.options"
            :key="o.label"
            type="button"
            class="ask-option"
            :class="{ 'is-on': drafts[qi]?.selected.includes(o.label) }"
            :aria-pressed="drafts[qi]?.selected.includes(o.label)"
            @click="toggle(qi, o.label)"
          >
            <v-icon
              :icon="
                q.multiSelect
                  ? drafts[qi]?.selected.includes(o.label)
                    ? 'mdi-checkbox-marked'
                    : 'mdi-checkbox-blank-outline'
                  : drafts[qi]?.selected.includes(o.label)
                    ? 'mdi-radiobox-marked'
                    : 'mdi-radiobox-blank'
              "
              size="20"
              class="ask-option-mark"
            />
            <span class="ask-option-body">
              <span class="ask-option-label">{{ o.label }}</span>
              <span v-if="o.description" class="ask-option-desc">{{ o.description }}</span>
            </span>
          </button>
        </div>
        <v-textarea
          v-if="drafts[qi]"
          v-model="drafts[qi].note"
          :placeholder="
            q.options.length
              ? t('yaya.ask.other', '其他想法 / 补充（可选）')
              : t('yaya.ask.free', '写下你的回答')
          "
          variant="outlined"
          rows="1"
          auto-grow
          max-rows="6"
          hide-details
          class="ask-note"
          @keydown="onNoteKey"
        />
      </template>

      <!-- 已回答：选中的选项 + 补充 -->
      <template v-else-if="state === 'answered' && display">
        <div v-if="display.answers[qi]?.skipped" class="ask-skipped">
          {{ t('yaya.ask.skipped', '已跳过') }}
        </div>
        <template v-else>
          <div v-if="display.answers[qi]?.selected.length" class="ask-picked">
            <span v-for="l in display.answers[qi].selected" :key="l" class="ask-picked-item">
              <v-icon icon="mdi-check" size="16" />
              {{ l }}
            </span>
          </div>
          <div v-if="display.answers[qi]?.note" class="ask-note-text">
            {{ display.answers[qi].note }}
          </div>
        </template>
      </template>

      <!-- 等待 / 失效：只读列出选项 -->
      <ul v-else-if="q.options.length" class="ask-readonly">
        <li v-for="o in q.options" :key="o.label">{{ o.label }}</li>
      </ul>
    </div>

    <div v-if="state === 'asking'" class="ask-actions">
      <span v-if="questions.length > 1" class="ask-progress">
        {{
          te(
            'yaya.ask.progress',
            { n: String(answeredCount), total: String(questions.length) },
            '已答 {n}/{total}'
          )
        }}
      </span>
      <v-spacer />
      <v-btn variant="text" :disabled="busy" @click="send(true)">
        {{ t('yaya.ask.dismiss', '不回答') }}
      </v-btn>
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-send"
        :loading="busy"
        :disabled="answeredCount === 0"
        @click="send(false)"
      >
        {{ t('yaya.ask.submit', '提交') }}
      </v-btn>
    </div>
    <div v-if="error" class="ask-error text-error">{{ error }}</div>
    <div v-if="(state === 'expired' || state === 'failed') && !embedded" class="ask-foot">
      {{ t('yaya.ask.expired_hint', '这次运行已经结束，可以直接发消息回答。') }}
    </div>
  </div>
</template>

<style scoped>
.ask-card {
  margin: 6px 0 12px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid rgba(var(--v-theme-primary), 0.35);
  background: rgba(var(--v-theme-primary), 0.05);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.ask-card.is-answered,
.ask-card.is-expired,
.ask-card.is-failed {
  border-color: rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.ask-card.is-embedded {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
}
.ask-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  font-weight: 600;
  font-size: 0.9375rem;
}
.ask-head-icon {
  color: rgb(var(--v-theme-primary));
}
.is-answered .ask-head-icon {
  color: rgb(var(--v-theme-success));
}
.is-expired .ask-head-icon,
.is-failed .ask-head-icon {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-q {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ask-q.has-divider {
  padding-top: 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.ask-q-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 8px;
  line-height: 1.55;
  min-width: 0;
}
.ask-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.14);
  flex-shrink: 0;
}
.ask-q-text {
  font-size: 0.9375rem;
  overflow-wrap: anywhere;
  min-width: 0;
}
.ask-q-hint {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.ask-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 48px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.6));
  background: rgb(var(--v-theme-surface));
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
  min-width: 0;
}
.ask-option:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}
.ask-option:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}
.ask-option.is-on {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}
.ask-option-mark {
  flex-shrink: 0;
  margin-top: 1px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-option.is-on .ask-option-mark {
  color: rgb(var(--v-theme-primary));
}
.ask-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ask-option-label {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.ask-option-desc {
  font-size: 0.8125rem;
  line-height: 1.45;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  overflow-wrap: anywhere;
}
.ask-note :deep(textarea) {
  font-size: 0.875rem;
}
.ask-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 2px;
}
.ask-progress {
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-picked {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-picked-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 4px 12px 4px 8px;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
  overflow-wrap: anywhere;
}
.ask-note-text {
  font-size: 0.875rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding-left: 10px;
  border-left: 3px solid rgba(var(--v-theme-primary), 0.4);
}
.ask-skipped,
.ask-foot {
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-readonly {
  margin: 0;
  padding-left: 20px;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ask-error {
  font-size: 0.8125rem;
}
@media (max-width: 600px) {
  .ask-card {
    padding: 12px;
  }
  .ask-options {
    grid-template-columns: 1fr;
  }
}
</style>
