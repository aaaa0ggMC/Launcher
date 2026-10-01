<script setup lang="ts">
/**
 * 隐私授权窗口（framework child window, view = PrivacyConsent）。
 *
 * 安全约束（docs/agent-access-design.md §5.4）：
 *  - 窗口 id / view 由主进程保留，渲染端无法创建或替换；决定只经 `privacy:decide`，
 *    主进程校验 sender 必须是本窗口。
 *  - 按钮出现后延迟 800ms 才可用，默认焦点在「拒绝」上——防误触 / 防注入回车。
 *  - 理由文本由 AI 提供，原样以纯文本展示（不用 v-html），并标注「未经验证」。
 */
defineOptions({ name: 'cockpit-privacy-consent' })

import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useTheme } from 'vuetify'
import { translate, translateTemplate } from '@ui/i18n'
import { resolveSchemeId } from '@ui/color_schemes'
import { applyUiScale, applyFont } from '@ui/appearance'

interface ScopeView {
  id: string
  ability: string
  level: 'public' | 'personal' | 'sensitive' | 'secret'
  capability?: 'exec' | 'control'
  label?: string
  description?: string
}
interface RequestView {
  id: string
  scopes: ScopeView[]
  reason: string
  origin: { kind: string; session?: string; client?: string }
  createdAt: number
  expiresAt: number
}

const uiLang = ref('zh')
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const theme = useTheme()
const requests = ref<RequestView[]>([])
const current = computed(() => requests.value[0] ?? null)
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
async function decide(decision: 'deny' | 'once' | 'session'): Promise<void> {
  const req = current.value
  if (!req || busy.value || (!armed.value && decision !== 'deny')) return
  busy.value = true
  try {
    await window.cockpit.privacyDecide(req.id, decision)
    requests.value = requests.value.filter((r) => r.id !== req.id)
  } finally {
    busy.value = false
  }
}
async function denyAll(): Promise<void> {
  await window.cockpit.privacyDenyAll()
  requests.value = []
}

interface AppearanceConfig {
  language?: string
  theme?: string
  uiScale?: unknown
  font?: unknown
}

/** 独立渲染进程：语言 / 主题 / UI 缩放 / 字体都要自己从配置应用，并跟随设置变化。 */
function applyConfig(cfg: AppearanceConfig | null): void {
  if (cfg?.language) uiLang.value = cfg.language
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  theme.global.name.value = resolveSchemeId(cfg?.theme, dark)
  applyUiScale(cfg?.uiScale)
  applyFont(cfg?.font)
}

let off: (() => void) | undefined
let offConfig: (() => void) | undefined
onMounted(async () => {
  try {
    applyConfig((await window.cockpit.getConfig()) as AppearanceConfig | null)
  } catch {
    /* defaults are fine */
  }
  offConfig = window.cockpit.on('cockpit:config-changed', (cfg) =>
    applyConfig(cfg as AppearanceConfig | null)
  )
  off = window.cockpit.on('privacy:pending', (list) => {
    requests.value = (list as RequestView[]) ?? []
  })
  requests.value = ((await window.cockpit.privacyPending()) as RequestView[]) ?? []
})
onBeforeUnmount(() => {
  off?.()
  offConfig?.()
  clearInterval(tick)
  if (armTimer) clearTimeout(armTimer)
})
</script>

<template>
  <v-app class="consent-app">
    <div class="consent-shell">
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
          <v-btn v-if="requests.length > 1" variant="text" @click="denyAll">
            {{ t('privacy.consent.deny_all') }}
          </v-btn>
        </div>
        <!--
          按钮层级：主按钮是「允许本次」（授权范围最小的同意）；
          「本次运行始终允许」范围更大，降为文字按钮单独放左侧，不做视觉引导。
        -->
        <div class="d-flex align-center flex-wrap ga-2 pt-3">
          <v-btn
            variant="text"
            :color="isExec ? 'error' : undefined"
            :disabled="!armed || busy"
            @click="decide('session')"
          >
            {{ t('privacy.consent.session') }}
          </v-btn>
          <v-spacer />
          <div class="d-flex flex-wrap justify-end ga-2">
            <v-btn ref="denyBtn" variant="tonal" prepend-icon="mdi-close" @click="decide('deny')">
              {{ t('privacy.consent.deny') }}
            </v-btn>
            <v-btn
              variant="flat"
              :color="isExec ? 'error' : 'primary'"
              :disabled="!armed || busy"
              prepend-icon="mdi-check"
              @click="decide('once')"
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
  </v-app>
</template>

<style scoped>
.consent-app {
  background: rgb(var(--v-theme-surface));
}
.consent-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 24px;
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
