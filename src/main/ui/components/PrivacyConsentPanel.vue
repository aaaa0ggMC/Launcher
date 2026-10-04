<script lang="ts">
export interface ScopeView {
  id: string
  ability: string
  level: 'public' | 'personal' | 'sensitive' | 'secret'
  capability?: 'exec' | 'control'
  label?: string
  description?: string
}
export interface RequestView {
  id: string
  scopes: ScopeView[]
  reason: string
  origin: { kind: string; session?: string; client?: string }
  createdAt: number
  expiresAt: number
}
export type ConsentDecision = 'deny' | 'once' | 'agent' | 'session'
</script>

<script setup lang="ts">
/**
 * 隐私授权面板（授权请求的展示 + 决定按钮）。两处共用：
 *  - Electron：独立子窗口 `windows/PrivacyConsent.vue`（主进程校验 sender）；
 *  - 无头网页：外壳悬浮窗 `PrivacyConsentPopup.vue`（Outsider SDK，模态 + AI 禁区，只认真实手势）。
 *
 * 防误触 / 防注入：按钮出现后延迟 800ms 才可用，默认焦点在「拒绝」上。
 * 理由文本由 AI 提供，原样以纯文本展示（不用 v-html），并标注「未经验证」。
 * 本组件只负责展示，决定经 `decide` / `denyAll` 交给宿主（宿主决定怎么提交、要不要校验手势）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { translate, translateTemplate } from '@ui/i18n'

const props = defineProps<{
  requests: RequestView[]
  lang: string
  decide: (req: RequestView, decision: ConsentDecision, ev: Event) => Promise<void>
  denyAll: (ev: Event) => Promise<void>
}>()

const t = (key: string, fallback?: string): string => translate(props.lang, key, fallback)
const tt = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(props.lang, key, vars, fallback)

const current = computed(() => props.requests[0] ?? null)
const isExec = computed(() => !!current.value?.scopes.some((s) => s.capability === 'exec'))

// 800ms 解锁延迟：每次切换到新请求都重新计时
const armed = ref(false)
let armTimer: ReturnType<typeof setTimeout> | undefined
const denyBtn = ref<{ $el?: HTMLElement } | null>(null)
watch(
  () => current.value?.id,
  async (id) => {
    armed.value = false
    if (armTimer) clearTimeout(armTimer)
    if (!id) return
    armTimer = setTimeout(() => (armed.value = true), 800)
    await nextTick()
    denyBtn.value?.$el?.focus()
  },
  { immediate: true }
)

// 倒计时
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 1000)
const secondsLeft = computed(() =>
  current.value ? Math.max(0, Math.ceil((current.value.expiresAt - now.value) / 1000)) : 0
)

function scopeLabel(s: ScopeView): string {
  return s.label ? t(s.label, s.id) : s.id
}
function scopeAbility(s: ScopeView): string {
  return s.ability === 'system' ? '' : t(`ability.${s.ability}.name`, s.ability)
}
function levelColor(s: ScopeView): string {
  if (s.capability === 'exec') return 'error'
  if (s.level === 'sensitive') return 'warning'
  return 'info'
}

const busy = ref(false)
async function onDecide(decision: ConsentDecision, ev: Event): Promise<void> {
  const req = current.value
  if (!req || busy.value || (!armed.value && decision !== 'deny')) return
  busy.value = true
  try {
    await props.decide(req, decision, ev)
  } finally {
    busy.value = false
  }
}
async function onDenyAll(ev: Event): Promise<void> {
  await props.denyAll(ev)
}

onBeforeUnmount(() => {
  clearInterval(tick)
  if (armTimer) clearTimeout(armTimer)
})
</script>

<template>
  <div class="consent-panel">
    <template v-if="current">
      <div class="d-flex align-start ga-4 pb-4">
        <v-icon size="40" :color="isExec ? 'error' : 'warning'">mdi-shield-lock-outline</v-icon>
        <div class="min-w-0">
          <div class="text-h6">{{ t('privacy.consent.title') }}</div>
          <div class="text-body-2 text-medium-emphasis mt-1">
            {{ t('privacy.consent.subtitle') }}
          </div>
        </div>
      </div>

      <v-alert v-if="isExec" type="error" variant="tonal" class="mb-4">
        {{ t('privacy.consent.exec_warning') }}
      </v-alert>

      <div class="consent-section">
        <div class="consent-label">{{ t('privacy.consent.client') }}</div>
        <div class="text-body-1">
          {{ current.origin.client || t('privacy.consent.client_unknown') }}
          <span class="text-medium-emphasis">· {{ current.origin.kind }}</span>
        </div>
      </div>

      <div class="consent-section">
        <div class="consent-label">{{ t('privacy.consent.scopes') }}</div>
        <div class="d-flex flex-column ga-2">
          <div v-for="s in current.scopes" :key="s.id" class="scope-row">
            <v-chip class="consent-chip" :color="levelColor(s)" variant="tonal">
              {{
                s.capability === 'exec'
                  ? t('privacy.level.exec')
                  : t(`privacy.level.${s.level}`, s.level)
              }}
            </v-chip>
            <div class="min-w-0">
              <div class="text-body-1">
                <span v-if="scopeAbility(s)" class="text-medium-emphasis"
                  >{{ scopeAbility(s) }} ·
                </span>
                {{ scopeLabel(s) }}
              </div>
              <div v-if="s.description" class="text-body-2 text-medium-emphasis">
                {{ t(s.description, '') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="consent-section">
        <div class="consent-label">
          {{ t('privacy.consent.reason') }}
          <span class="text-medium-emphasis">{{ t('privacy.consent.reason_note') }}</span>
        </div>
        <blockquote class="consent-reason">
          {{ current.reason || t('privacy.consent.no_reason') }}
        </blockquote>
      </div>

      <v-spacer />

      <div class="d-flex align-center flex-wrap ga-2 pt-4">
        <span class="text-body-2 text-medium-emphasis">
          {{ tt('privacy.consent.expires', { s: String(secondsLeft) }) }}
        </span>
        <span v-if="requests.length > 1" class="text-body-2 text-medium-emphasis">
          · {{ tt('privacy.consent.queue', { n: String(requests.length - 1) }) }}
        </span>
        <v-spacer />
        <v-btn v-if="requests.length > 1" variant="text" @click="onDenyAll($event)">
          {{ t('privacy.consent.deny_all') }}
        </v-btn>
      </div>
      <!--
        按钮层级：主按钮是「允许本次」（授权范围最小的同意）；「本次执行都允许」（这个 AI 会话结束即撤销）次之；
        「关闭 Cockpit 前都允许」范围最大，降为文字按钮单独放左侧，不做视觉引导。
      -->
      <div class="d-flex align-center flex-wrap ga-2 pt-3">
        <v-btn
          variant="text"
          :color="isExec ? 'error' : undefined"
          :disabled="!armed || busy"
          @click="onDecide('session', $event)"
        >
          {{ t('privacy.consent.session') }}
        </v-btn>
        <v-spacer />
        <div class="d-flex flex-wrap justify-end ga-2">
          <v-btn
            ref="denyBtn"
            variant="tonal"
            prepend-icon="mdi-close"
            @click="onDecide('deny', $event)"
          >
            {{ t('privacy.consent.deny') }}
          </v-btn>
          <v-btn
            variant="tonal"
            :color="isExec ? 'error' : 'primary'"
            :disabled="!armed || busy"
            prepend-icon="mdi-check-all"
            @click="onDecide('agent', $event)"
          >
            {{
              current.origin.kind === 'local-agent'
                ? t('privacy.consent.agent_run', '本次执行都允许')
                : t('privacy.consent.agent_conn', '本次连接都允许')
            }}
          </v-btn>
          <v-btn
            variant="flat"
            :color="isExec ? 'error' : 'primary'"
            :disabled="!armed || busy"
            prepend-icon="mdi-check"
            @click="onDecide('once', $event)"
          >
            {{ t('privacy.consent.once') }}
          </v-btn>
        </div>
      </div>
    </template>
    <div v-else class="d-flex align-center justify-center flex-grow-1 text-medium-emphasis">
      {{ t('privacy.consent.empty') }}
    </div>
  </div>
</template>

<style scoped>
.consent-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
}
.consent-section {
  padding-bottom: 16px;
}
.consent-label {
  font-size: 0.8125rem;
  font-weight: 600;
  opacity: 0.8;
  padding-bottom: 8px;
}
.scope-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.consent-chip {
  padding-block: 4px;
  min-height: 24px;
  flex-shrink: 0;
}
.consent-reason {
  margin: 0;
  padding: 12px 16px;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.3);
  background: rgba(var(--v-theme-on-surface), 0.05);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
