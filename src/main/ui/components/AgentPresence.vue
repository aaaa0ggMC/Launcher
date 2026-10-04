<script lang="ts">
export interface PresenceSession {
  id: string
  client: string
  avatar?: string
  icon?: string
  status?: { text: string; at: number }
  controls?: { pause: boolean; stop: boolean; approve: boolean }
  paused?: boolean
  openAbility?: string
  openTarget?: Record<string, unknown>
  focus?: string
  attention?: { kind: 'approval'; tool: string }
}
export interface PresenceFinished {
  id: string
  client: string
  avatar?: string
  icon?: string
  openAbility?: string
  openTarget?: Record<string, unknown>
}
</script>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { translate, translateTemplate } from '../i18n'
import AgentAvatar from './AgentAvatar.vue'

/**
 * 「AI 在场」悬浮窗（Outsider SDK 的外壳悬浮窗 `shell.agent-presence`）：
 * 进程内 agent（YAYA，transport `local`）和用户共用这个界面。App.vue 只把「对话页不在眼前」的
 * 会话传进来（人就在对话页时悬浮窗是多余的），这里提供：暂停 / 继续 / 停止、跳到 AI 正在操作的
 * 页面、等待批准时直接批准 / 拒绝（强制展开），以及跑完之后的「回到对话」提示。
 * 点头像收起成一个小圆点（像桌宠），再点展开。
 */
const props = defineProps<{
  sessions: PresenceSession[]
  finished: PresenceFinished[]
  currentId: string | null
  abilityNames: Record<string, string>
  busyTimeoutSec?: number
  statusTtlSec?: number
  dismiss: (id: string) => void
}>()

const lang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (k: string, f: string): string => translate(lang.value, k, f)
const tt = (k: string, v: Record<string, string>, f: string): string =>
  translateTemplate(lang.value, k, v, f)
const abilitiesApi = inject<{
  activate: (id: string, target: Record<string, unknown>) => void
} | null>('cockpit:abilities', null)

const COLLAPSE_KEY = 'cockpit-agent-presence-collapsed'
const lastCall = ref<Record<string, { at: number; tool: string }>>({})
const now = ref(Date.now())
const collapsedPref = ref(readCollapsed())
const needsAttention = computed(
  () => props.sessions.some((s) => s.attention) || props.finished.length > 0
)
/** 有需要处理的事（批准 / 跑完）时强制展开 */
const collapsed = computed(() => collapsedPref.value && !needsAttention.value)

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}
function toggleCollapsed(): void {
  collapsedPref.value = !collapsed.value
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsedPref.value ? '1' : '0')
  } catch {
    /* 只在本次有效 */
  }
}

const busyMs = computed(() => (props.busyTimeoutSec ?? 60) * 1000)
const statusMs = computed(() => (props.statusTtlSec ?? 120) * 1000)

function busy(s: PresenceSession): boolean {
  const l = lastCall.value[s.id]
  return !s.paused && !!l && now.value - l.at < Math.min(busyMs.value, 8000)
}
function name(s: { client: string }): string {
  return s.client || t('agent.unknownClient', 'AI 客户端')
}
function initial(s: { client: string }): string {
  return (name(s).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}
function line(s: PresenceSession): string {
  if (s.attention?.kind === 'approval')
    return tt(
      'agent.presence.approval',
      { tool: s.attention.tool },
      `等待批准：${s.attention.tool}`
    )
  if (s.paused) return t('agent.presence.paused', '已暂停')
  if (s.status?.text && now.value - s.status.at < statusMs.value) return s.status.text
  const l = lastCall.value[s.id]
  if (l && now.value - l.at < busyMs.value)
    return `${t('agent.presence.working', '正在操作')} · ${l.tool}`
  return t('agent.presence.thinking', '思考中…')
}
/** AI 最近操作的能力页（有名字、且不是当前页才给跳转） */
function focusName(s: PresenceSession): string {
  if (!s.focus || s.focus === props.currentId) return ''
  return props.abilityNames[s.focus] ?? ''
}

// ---- 等待批准：展开查看工具参数（详情经用户专属命令读取，不在广播的会话列表里） ----
const expandedId = ref<string | null>(null)
const detail = ref<{ name: string; fields: { key: string; text: string; code: boolean }[] } | null>(
  null
)
async function toggleDetail(s: PresenceSession): Promise<void> {
  if (expandedId.value === s.id) {
    expandedId.value = null
    return
  }
  expandedId.value = s.id
  detail.value = null
  try {
    const r = (await window.cockpit.command('agent.attention-detail', { id: s.id })) as {
      detail?: { args?: unknown } | null
    }
    const args = r.detail?.args
    const fields =
      args && typeof args === 'object' && !Array.isArray(args)
        ? Object.entries(args as Record<string, unknown>).map(([key, v]) => ({
            key,
            text: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
            code: typeof v !== 'string' || v.includes('\n')
          }))
        : [{ key: '', text: JSON.stringify(args ?? null, null, 2), code: true }]
    if (expandedId.value === s.id) detail.value = { name: s.attention?.tool ?? '', fields }
  } catch {
    if (expandedId.value === s.id) detail.value = { name: s.attention?.tool ?? '', fields: [] }
  }
}
// 批准请求处理掉了就收起
watch(
  () => props.sessions.find((x) => x.id === expandedId.value)?.attention,
  (a) => {
    if (!a) expandedId.value = null
  }
)

function control(
  s: PresenceSession,
  action: 'pause' | 'resume' | 'stop' | 'approve' | 'reject',
  scope?: 'once' | 'run' | 'session'
): void {
  void window.cockpit.command('agent.control', { id: s.id, action, ...(scope ? { scope } : {}) })
  if (action === 'approve' || action === 'reject') moreApproveId.value = null
}
/** 「批准」旁的下拉：更大范围的批准（本次执行 / 本对话）。在悬浮窗里展开一行，不用弹出菜单——
 *  菜单会挂到 body 上，跑出悬浮层的 AI 禁区 */
const moreApproveId = ref<string | null>(null)
function open(s: { openAbility?: string; openTarget?: Record<string, unknown> }): void {
  if (s.openAbility) abilitiesApi?.activate(s.openAbility, s.openTarget ?? {})
}
function goFocus(s: PresenceSession): void {
  if (s.focus) abilitiesApi?.activate(s.focus, {})
}
function backToChat(f: PresenceFinished): void {
  open(f)
  props.dismiss(f.id)
}

const first = computed(() => props.sessions[0] ?? props.finished[0])
const anyBusy = computed(() => props.sessions.some(busy))
const anyPaused = computed(() => props.sessions.some((s) => s.paused))

// 新的批准请求到来：即使用户收起过也展开（collapsed 已按 needsAttention 计算），这里只负责轻微提示
const flash = ref(false)
watch(
  () => props.sessions.filter((s) => s.attention).length + props.finished.length,
  (n, old) => {
    if (n > (old ?? 0)) {
      flash.value = true
      setTimeout(() => (flash.value = false), 1200)
    }
  }
)

let offActivity: (() => void) | null = null
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  offActivity = window.cockpit.on('cockpit:agent-activity', (raw) => {
    const a = raw as { id?: string; tool?: string }
    if (typeof a?.id !== 'string') return
    lastCall.value = { ...lastCall.value, [a.id]: { at: Date.now(), tool: a.tool ?? '' } }
  })
  tick = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  offActivity?.()
  if (tick) clearInterval(tick)
})
</script>

<template>
  <div
    v-if="first"
    class="presence"
    :class="{ 'presence--collapsed': collapsed, 'presence--flash': flash }"
  >
    <template v-if="collapsed">
      <button
        type="button"
        class="presence__avatar"
        :class="{ 'is-busy': anyBusy, 'is-paused': anyPaused }"
        :title="t('agent.presence.expand', '展开')"
        :aria-label="t('agent.presence.expand', '展开')"
        @click="toggleCollapsed"
      >
        <AgentAvatar :avatar="first.avatar" :icon="first.icon" :initial="initial(first)" />
        <span v-if="anyPaused" class="presence__badge">
          <v-icon icon="mdi-pause" size="12" />
        </span>
      </button>
    </template>
    <template v-else>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="presence__item"
        :class="{ 'presence__item--attention': !!s.attention }"
      >
        <div class="presence__row">
          <button
            type="button"
            class="presence__avatar"
            :class="{ 'is-busy': busy(s), 'is-paused': s.paused }"
            :title="t('agent.presence.collapse', '收起')"
            :aria-label="t('agent.presence.collapse', '收起')"
            @click="toggleCollapsed"
          >
            <AgentAvatar :avatar="s.avatar" :icon="s.icon" :initial="initial(s)" />
          </button>
          <div class="presence__text">
            <div class="presence__name text-truncate">{{ name(s) }}</div>
            <button
              v-if="s.attention?.kind === 'approval'"
              type="button"
              class="presence__line presence__line--btn"
              :aria-expanded="expandedId === s.id"
              :title="t('agent.presence.show_args', '查看参数')"
              @click="toggleDetail(s)"
            >
              <span class="text-truncate">{{ line(s) }}</span>
              <v-icon
                :icon="expandedId === s.id ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                size="14"
              />
            </button>
            <div v-else class="presence__line text-truncate">{{ line(s) }}</div>
          </div>
          <div class="presence__actions">
            <v-btn
              v-if="focusName(s)"
              size="small"
              variant="text"
              icon="mdi-crosshairs-gps"
              :title="
                tt(
                  'agent.presence.go_focus',
                  { page: focusName(s) },
                  `跳到 AI 正在操作的页面：${focusName(s)}`
                )
              "
              :aria-label="
                tt(
                  'agent.presence.go_focus',
                  { page: focusName(s) },
                  `跳到 AI 正在操作的页面：${focusName(s)}`
                )
              "
              @click="goFocus(s)"
            />
            <v-btn
              v-if="s.controls?.pause && !s.attention"
              size="small"
              variant="tonal"
              :color="s.paused ? 'primary' : undefined"
              :icon="s.paused ? 'mdi-play' : 'mdi-pause'"
              :title="s.paused ? t('agent.resume', '继续') : t('agent.pause', '暂停')"
              :aria-label="s.paused ? t('agent.resume', '继续') : t('agent.pause', '暂停')"
              @click="control(s, s.paused ? 'resume' : 'pause')"
            />
            <v-btn
              v-if="s.controls?.stop"
              size="small"
              variant="text"
              icon="mdi-stop"
              :title="t('agent.stop', '停止')"
              :aria-label="t('agent.stop', '停止')"
              @click="control(s, 'stop')"
            />
            <v-btn
              v-if="s.openAbility"
              size="small"
              variant="text"
              icon="mdi-message-text-outline"
              :title="t('agent.openOwner', '打开对话')"
              :aria-label="t('agent.openOwner', '打开对话')"
              @click="open(s)"
            />
          </div>
        </div>
        <div v-if="expandedId === s.id" class="presence__detail" data-outsider-nodrag>
          <div v-if="!detail" class="d-flex justify-center py-2">
            <v-progress-circular indeterminate size="18" width="2" color="primary" />
          </div>
          <template v-else>
            <div v-if="!detail.fields.length" class="text-caption text-medium-emphasis">
              {{ t('agent.presence.no_args', '拿不到参数（请求可能已经处理）') }}
            </div>
            <div v-for="f in detail.fields" :key="f.key" class="presence__field">
              <div v-if="f.key" class="presence__field-key">{{ f.key }}</div>
              <pre v-if="f.code" class="presence__code">{{ f.text }}</pre>
              <div v-else class="presence__value">{{ f.text }}</div>
            </div>
          </template>
        </div>
        <div v-if="s.attention?.kind === 'approval' && s.controls?.approve" class="presence__ask">
          <!-- 「去对话里看」= 标题行右侧的「打开对话」按钮；这里只放决定，窄宽度下也排得下一行 -->
          <v-btn variant="tonal" prepend-icon="mdi-close" @click="control(s, 'reject')">
            {{ t('agent.presence.reject', '拒绝') }}
          </v-btn>
          <div class="presence__split">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-check"
              class="presence__split-main"
              @click="control(s, 'approve', 'once')"
            >
              {{ t('agent.presence.approve', '批准') }}
            </v-btn>
            <!-- 不用 icon 按钮：图标按钮在触屏下会被放大成圆形，和左半边高度对不齐 -->
            <v-btn
              color="primary"
              variant="flat"
              class="presence__split-more"
              :title="t('agent.presence.approve_more', '更多批准方式')"
              :aria-label="t('agent.presence.approve_more', '更多批准方式')"
              :aria-expanded="moreApproveId === s.id"
              @click="moreApproveId = moreApproveId === s.id ? null : s.id"
            >
              <v-icon :icon="moreApproveId === s.id ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
            </v-btn>
          </div>
        </div>
        <div v-if="moreApproveId === s.id" class="presence__ask presence__ask--more">
          <v-spacer />
          <v-btn
            variant="tonal"
            color="primary"
            prepend-icon="mdi-check-all"
            @click="control(s, 'approve', 'run')"
          >
            {{ t('agent.presence.approve_run', '本次执行都允许') }}
          </v-btn>
          <v-btn
            variant="text"
            prepend-icon="mdi-shield-check-outline"
            @click="control(s, 'approve', 'session')"
          >
            {{ t('agent.presence.approve_session', '本对话都允许') }}
          </v-btn>
        </div>
      </div>
      <div v-for="f in finished" :key="f.id" class="presence__item">
        <div class="presence__row">
          <div class="presence__avatar presence__avatar--static">
            <AgentAvatar :avatar="f.avatar" :icon="f.icon" :initial="initial(f)" />
          </div>
          <div class="presence__text">
            <div class="presence__name text-truncate">{{ name(f) }}</div>
            <div class="presence__line text-truncate">
              {{ t('agent.presence.done', '已回答完毕，回到对话继续聊吧') }}
            </div>
          </div>
          <div class="presence__actions">
            <v-btn
              size="small"
              variant="text"
              icon="mdi-close"
              :title="t('agent.presence.dismiss', '关闭')"
              :aria-label="t('agent.presence.dismiss', '关闭')"
              @click="dismiss(f.id)"
            />
          </div>
        </div>
        <div v-if="f.openAbility" class="presence__ask">
          <v-spacer />
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-message-reply-text-outline"
            @click="backToChat(f)"
          >
            {{ t('agent.presence.back', '回到对话') }}
          </v-btn>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.presence {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 320px;
  max-width: 100%;
  padding: 10px 10px 10px 12px;
  border-radius: 18px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.9));
  backdrop-filter: blur(16px);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  color: rgb(var(--v-theme-on-surface));
  transition: box-shadow 0.3s ease;
}
.presence:has(.presence__detail) {
  width: 480px;
}
.presence__split {
  display: inline-flex;
}
.presence__split-main {
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.presence__split-more {
  min-width: 40px !important;
  padding: 0 8px !important;
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
  border-left: 1px solid rgba(var(--v-theme-on-primary), 0.3);
}
.presence__line--btn {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.presence__line--btn:hover {
  opacity: 1;
  text-decoration: underline;
}
.presence__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(var(--app-vh, 100vh) * 0.48);
  overflow: auto;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  cursor: auto;
  user-select: text;
  touch-action: pan-y;
}
.presence__field-key {
  font-size: 0.72rem;
  font-weight: 600;
  opacity: 0.7;
  padding-bottom: 2px;
}
.presence__value {
  font-size: 0.8rem;
  line-height: 1.5;
  word-break: break-word;
}
.presence__code {
  margin: 0;
  font-family: var(--cockpit-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.presence--flash {
  box-shadow:
    0 0 0 3px rgba(var(--v-theme-primary), 0.55),
    0 8px 28px rgba(0, 0, 0, 0.22);
}
.presence--collapsed {
  width: auto;
  padding: 6px;
  border-radius: 999px;
}
.presence__item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.presence__item + .presence__item {
  padding-top: 8px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.presence__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.presence__ask {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.presence__avatar {
  position: relative;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
}
.presence__avatar--static {
  cursor: default;
}
.presence__item--attention .presence__avatar {
  background: rgba(var(--v-theme-warning), 0.2);
  color: rgb(var(--v-theme-warning));
}
.presence__avatar.is-busy::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 2px solid rgb(var(--v-theme-primary));
  animation: presence-pulse 1.4s ease-out infinite;
}
.presence__avatar.is-paused {
  opacity: 0.7;
}
.presence__badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(var(--v-theme-warning));
  color: rgb(var(--v-theme-on-warning));
}
.presence__text {
  flex: 1 1 auto;
  min-width: 0;
}
.presence__name {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
}
.presence__line {
  font-size: 0.75rem;
  line-height: 1.4;
  opacity: 0.72;
}
.presence__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
@keyframes presence-pulse {
  from {
    opacity: 0.9;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(1.35);
  }
}
html.motion-off .presence__avatar.is-busy::after {
  animation: none;
}
</style>
