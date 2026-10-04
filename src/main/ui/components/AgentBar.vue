<script lang="ts">
// 模块级：App 一导入就登记（即使图标条被隐藏），设置 → 快捷键 里随时可见
import { registerShortcut } from '../shortcuts'

// 人和 AI 共用界面时的紧急叫停：默认不绑定（所有快捷键都由用户自己启用），可设为全局
registerShortcut({
  id: 'shell.agent-pause-all',
  label: 'agent.pauseAll',
  fallback: '暂停所有 AI 操作',
  group: 'shell',
  command: { name: 'agent.pause-all' }
})
</script>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { translate, translateTemplate } from '../i18n'
import AgentAvatar from './AgentAvatar.vue'
import AgentSessionDialog from './AgentSessionDialog.vue'
import type { AgentUiConfig } from '../composables/agentUi'
import { useExclusive } from '../composables/exclusive'

/**
 * 标题栏中间的 AI 图标条：每个在线 agent 会话一个圆形字母图标。
 * - 4 秒内有调用 = 忙碌（脉冲环），否则变暗
 * - 悬停显示：名称、传输方式、正在操作的页面、最近一次工具
 * - 放不下时横向滚动（滚轮竖向 → 横向），溢出的一侧边缘羽化渐隐，不出滚动条
 * 页面信息目前是 agent 调用那一刻主窗口的当前页（agent 与用户共用一个视图）。
 */
const props = defineProps<{
  lang: string
  ui: AgentUiConfig
  currentId: string | null
  abilityName: (id: string | null) => string
}>()

interface Session {
  id: string
  transport: string
  client: string
  startedAt: number
  lastSeen: number
  calls: number
  avatar?: string
  icon?: string
  view?: 'hidden' | 'shown'
  page?: string
  status?: { text: string; progress?: number; at: number }
  /** 登记了控制器（如 YAYA 的一次运行）：点头像弹出暂停 / 继续 / 停止 */
  controls?: { pause: boolean; stop: boolean }
  paused?: boolean
  openAbility?: string
  openTarget?: Record<string, unknown>
}
interface Live {
  at: number
  tool: string
  pageId: string | null
}

const sessions = ref<Session[]>([])
const live = ref<Record<string, Live>>({})
const now = ref(Date.now())
const host = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
/** 左右各让出多少 px 给标题 / 窗口按钮（量出来的，保证图标条始终在标题栏正中且不压到它们） */
const reserve = ref(160)
/** 图标条可用宽度；放不下 2 个头像时收成一个计数徽标 */
const availW = ref(1000)
const SLOT = 40 // 头像 32 + 间距 8
const compact = computed(() => visibleSessions.value.length > 1 && availW.value < SLOT * 2)
/** 两侧是否还有被滚出去的内容 → 决定哪边羽化 */
const moreLeft = ref(false)
const moreRight = ref(false)
let offSessions: (() => void) | null = null
let offActivity: (() => void) | null = null
let tick: ReturnType<typeof setInterval> | null = null
let ro: ResizeObserver | null = null

const tr = (k: string, f: string): string => translate(props.lang, k, f)

/** 独占租约（模块级单例，与外壳窄条共用一份订阅）；用于悬停提示里的「占用」行。 */
const { forSession } = useExclusive()

async function refresh(): Promise<void> {
  try {
    const r = (await window.cockpit.command('agent.sessions')) as { sessions: Session[] }
    sessions.value = [...r.sessions].sort((a, b) => a.startedAt - b.startedAt)
    const alive = new Set(sessions.value.map((s) => s.id))
    for (const id of Object.keys(live.value)) {
      if (!alive.has(id)) delete live.value[id]
    }
  } catch {
    sessions.value = []
    live.value = {}
  }
}

/** 空闲超过 hideIdleAfterMin 的会话从图标条隐藏（0 = 不隐藏）；忙碌的一定显示。 */
const visibleSessions = computed(() => {
  const limit = props.ui.hideIdleAfterMin * 60000
  if (!limit) return sessions.value
  return sessions.value.filter(
    (s) => busy(s.id) || now.value - Math.max(live.value[s.id]?.at ?? 0, s.lastSeen) < limit
  )
})

function busy(id: string): boolean {
  const l = live.value[id]
  return !!l && now.value - l.at < props.ui.busyTimeoutSec * 1000
}
function name(s: Session): string {
  return s.client || tr('agent.unknownClient', 'AI client')
}
function initial(s: Session): string {
  return (name(s).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}
const isNarrow = ref(false)
let narrowMql: MediaQueryList | null = null

function updateNarrow(): void {
  isNarrow.value = narrowMql ? narrowMql.matches : window.innerWidth <= 720
}

const dialogOpen = ref(false)

function openDialog(): void {
  dialogOpen.value = true
}

// ---- 可控会话（YAYA 等进程内 agent）：暂停 / 继续 / 停止 ----
const abilitiesApi = inject<{
  activate: (id: string, target: Record<string, unknown>) => void
} | null>('cockpit:abilities', null)
const controlMenu = ref<{ id: string; x: number; y: number } | null>(null)
const controlSession = computed(() =>
  controlMenu.value ? (sessions.value.find((x) => x.id === controlMenu.value!.id) ?? null) : null
)
const controlMenuOpen = computed({
  get: () => controlMenu.value !== null,
  set: (v: boolean) => {
    if (!v) controlMenu.value = null
  }
})
function openControls(s: Session, ev?: Event): void {
  const el = ev?.currentTarget as HTMLElement | undefined
  const r = el?.getBoundingClientRect()
  controlMenu.value = {
    id: s.id,
    x: r ? r.left + r.width / 2 : window.innerWidth / 2,
    y: r ? r.bottom + 4 : 48
  }
}
function control(action: 'pause' | 'resume' | 'stop'): void {
  const s = controlSession.value
  controlMenu.value = null
  if (s) void window.cockpit.command('agent.control', { id: s.id, action })
}
function openOwner(): void {
  const s = controlSession.value
  controlMenu.value = null
  if (s?.openAbility) abilitiesApi?.activate(s.openAbility, s.openTarget ?? {})
}

function onAvatarClick(s: Session, ev?: Event): void {
  if (s.controls) {
    openControls(s, ev)
    return
  }
  // 窄屏 / 移动端或无头 Web 模式（无 Electron 宿主窗口）：弹出会话子窗口；宽屏桌面端：直接触发 follow 跟随视图
  if (isNarrow.value || !window.cockpit.hasCap('window.frame')) {
    openDialog()
  } else {
    follow(s)
  }
}

/** 点头像：打开 / 聚焦该 agent 的独立视图（没有就先建）。 */
function follow(s: Session): void {
  void window.cockpit.command('agent.follow', { id: s.id })
}

function tip(s: Session): string[] {
  const l = live.value[s.id]
  const kind =
    s.transport === 'mcp' ? 'MCP' : s.transport === 'local' ? tr('agent.local', '内置') : 'Remote'
  const lines = [`${name(s)} · ${kind}`]
  if (s.paused) lines.push(tr('agent.paused', '已暂停 · 点击继续'))
  else if (s.controls) lines.push(tr('agent.clickToPause', '点击可暂停 / 停止'))
  if (!props.ui.tooltipDetail) return lines
  if (busy(s.id)) {
    lines.push(
      translateTemplate(
        props.lang,
        'agent.onPage',
        { page: props.abilityName(s.page ?? l?.pageId ?? null) },
        '{page}'
      )
    )
  } else {
    lines.push(tr('agent.idle', '空闲'))
  }
  const st = s.status
  if (st && now.value - st.at < props.ui.statusTtlSec * 1000) {
    lines.push(`${st.text}${st.progress != null ? ` (${st.progress}%)` : ''}`)
  }
  const held = forSession(s.id)
  if (held.length) {
    lines.push(
      `${tr('agent.excl.held', '占用')}: ${held
        .slice(0, 2)
        .map((l) => `${tr(l.label, l.scope)} · ${l.key}`)
        .join('、')}${
        held.length > 2
          ? translateTemplate(
              props.lang,
              'agent.excl.more',
              { n: String(held.length - 2) },
              `等 ${held.length - 2} 项`
            )
          : ''
      }`
    )
  }
  if (l?.tool) lines.push(`${tr('agent.lastTool', '最近操作')}: ${l.tool}`)
  lines.push(
    s.view === 'shown'
      ? tr('agent.view_shown', '视图已打开')
      : tr('agent.follow_hint', '点击查看它的视图')
  )
  return lines
}

/** 量标题文字右缘与窗口按钮左缘，取较大者做对称留白；按钮 / 标题宽度变化（语言、无边框开关）都会重算。 */
function relayout(): void {
  const bar = host.value?.parentElement
  if (!bar) return
  const tb = bar.getBoundingClientRect()
  const title = bar.querySelector('.v-app-bar-title span')?.getBoundingClientRect()
  const btns = [...bar.querySelectorAll(':scope > .v-btn')].map(
    (b) => b.getBoundingClientRect().left
  )
  const left = title ? title.right - tb.left + 16 : 0
  const right = btns.length ? tb.right - Math.min(...btns) + 16 : 0
  reserve.value = Math.max(left, right, 16)
  availW.value = Math.max(0, tb.width - reserve.value * 2)
  void nextTick(updateEdges)
}

function updateEdges(): void {
  const el = scroller.value
  if (!el) return
  const overflow = el.scrollWidth - el.clientWidth
  if (overflow <= 2) {
    moreLeft.value = false
    moreRight.value = false
    return
  }
  moreLeft.value = el.scrollLeft > 2
  moreRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

/** 滚轮竖向滚动换算成横向；内容放得下时不拦截。 */
function onWheel(e: WheelEvent): void {
  const el = scroller.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
  el.scrollLeft += d
  e.preventDefault()
}

onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  updateNarrow()
  narrowMql.addEventListener('change', updateNarrow)

  void refresh()
  offSessions = window.cockpit.on('cockpit:agent-sessions', () => void refresh())
  offActivity = window.cockpit.on('cockpit:agent-activity', (raw) => {
    const a = raw as { id?: string; tool?: string; at?: number }
    if (typeof a?.id !== 'string') return
    live.value = {
      ...live.value,
      [a.id]: { at: Date.now(), tool: a.tool ?? '', pageId: props.currentId }
    }
  })
  tick = setInterval(() => (now.value = Date.now()), 500)
  const bar = host.value?.parentElement
  if (bar) {
    ro = new ResizeObserver(relayout)
    ro.observe(bar)
    bar.querySelectorAll(':scope > .v-btn, .v-app-bar-title span').forEach((e) => ro?.observe(e))
  }
  relayout()
})
onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', updateNarrow)
  offSessions?.()
  offActivity?.()
  if (tick) clearInterval(tick)
  ro?.disconnect()
})

// 会话增减后内容宽度变了，重算两侧是否溢出
watch(
  () => visibleSessions.value.length,
  () => void nextTick(relayout)
)
</script>

<template>
  <div ref="host" class="agent-bar" :style="{ left: `${reserve}px`, right: `${reserve}px` }">
    <v-tooltip v-if="compact" location="bottom">
      <template #activator="{ props: tp }">
        <span
          v-bind="tp"
          class="agent-bar__avatar agent-bar__avatar--btn"
          :class="{ busy: visibleSessions.some((s) => busy(s.id)) }"
          role="button"
          tabindex="0"
          :aria-label="visibleSessions.map(name).join(', ')"
          @click="openDialog"
          @keydown.enter="openDialog"
          @keydown.space.prevent="openDialog"
          >{{ visibleSessions.length }}</span
        >
      </template>
      <div v-for="s in visibleSessions" :key="s.id">{{ tip(s).join(' · ') }}</div>
    </v-tooltip>
    <div
      v-else-if="visibleSessions.length"
      ref="scroller"
      class="agent-bar__scroll"
      :style="{
        '--fl': moreLeft ? '28px' : '0px',
        '--fr': moreRight ? '28px' : '0px',
        maskImage:
          moreLeft || moreRight
            ? 'linear-gradient(to right, transparent 0, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent 100%)'
            : 'none'
      }"
      @wheel="onWheel"
      @scroll.passive="updateEdges"
    >
      <v-tooltip v-for="s in visibleSessions" :key="s.id" location="bottom">
        <template #activator="{ props: tp }">
          <span
            v-bind="tp"
            class="agent-bar__avatar agent-bar__avatar--btn"
            :class="{
              busy: busy(s.id) && !s.paused,
              'has-view': !!s.view,
              shown: s.view === 'shown',
              paused: s.paused
            }"
            role="button"
            tabindex="0"
            :aria-label="tip(s).join(' · ')"
            @click="(e: MouseEvent) => onAvatarClick(s, e)"
            @contextmenu.prevent="openDialog"
            @keydown.enter="(e: KeyboardEvent) => onAvatarClick(s, e)"
            @keydown.space.prevent="(e: KeyboardEvent) => onAvatarClick(s, e)"
            ><AgentAvatar
              :avatar="ui.allowAvatar ? s.avatar : undefined"
              :icon="ui.defaultIcon === 'icon' ? s.icon : undefined"
              :initial="initial(s)" /><span
              v-if="s.paused"
              class="agent-bar__paused"
              aria-hidden="true"
              ><v-icon icon="mdi-pause" size="12" /></span
          ></span>
        </template>
        <div v-for="(l, i) in tip(s)" :key="i">{{ l }}</div>
      </v-tooltip>
    </div>

    <!-- 可控会话的操作菜单（暂停 / 继续 / 停止 / 打开） -->
    <v-menu
      v-model="controlMenuOpen"
      :target="[controlMenu?.x ?? 0, controlMenu?.y ?? 0]"
      location="bottom center"
    >
      <v-list v-if="controlSession" density="compact" min-width="180" class="agent-bar__menu">
        <v-list-subheader>{{ name(controlSession) }}</v-list-subheader>
        <v-list-item
          v-if="controlSession.controls?.pause && !controlSession.paused"
          prepend-icon="mdi-pause"
          :title="tr('agent.pause', '暂停')"
          @click="control('pause')"
        />
        <v-list-item
          v-if="controlSession.controls?.pause && controlSession.paused"
          prepend-icon="mdi-play"
          :title="tr('agent.resume', '继续')"
          @click="control('resume')"
        />
        <v-list-item
          v-if="controlSession.controls?.stop"
          prepend-icon="mdi-stop"
          base-color="error"
          :title="tr('agent.stop', '停止')"
          @click="control('stop')"
        />
        <v-list-item
          v-if="controlSession.openAbility"
          prepend-icon="mdi-open-in-app"
          :title="tr('agent.openOwner', '打开对话')"
          @click="openOwner"
        />
      </v-list>
    </v-menu>

    <!-- AI 会话详情与移动端弹窗 -->
    <AgentSessionDialog
      v-model="dialogOpen"
      :sessions="sessions"
      :live="live"
      :ui="ui"
      :lang="lang"
      :current-id="currentId"
      :ability-name="abilityName"
      @follow="follow"
    />
  </div>
</template>

<style scoped>
.agent-bar {
  /* 相对整条标题栏居中（而不是夹在标题与右侧按钮之间的剩余空间里）；
     左右留白由 relayout() 按标题 / 按钮的实际位置量出来（内联 left / right） */
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.agent-bar__scroll {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 6px;
  overflow-x: auto;
  overflow-y: hidden;
  pointer-events: auto;
  /* 无边框窗口里标题栏是拖拽区（-webkit-app-region: drag），会吞掉真实鼠标的悬停 / 滚轮；
     CDP 合成事件绕过它，所以必须在真实鼠标下验证 */
  -webkit-app-region: no-drag;
}
/* 隐藏滚动条（不用 scrollbar-width：它会让 Chromium 弃用全局 ::-webkit-scrollbar 样式） */
.agent-bar__scroll::-webkit-scrollbar {
  display: none;
}
.agent-bar__avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  /* 只用主题色：空闲 = 中性底 + 淡字；忙碌 = 主色淡底 + 主色字 + 内描边。环全在 32px 内，不溢出 */
  background: rgb(var(--v-theme-surface-variant));
  color: rgba(var(--v-theme-on-surface), 0.6);
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.12);
  transition:
    background-color 0.4s ease,
    color 0.4s ease,
    box-shadow 0.4s ease;
  cursor: default;
}
.agent-bar__avatar--btn {
  position: relative;
  cursor: pointer;
}
.agent-bar__avatar--btn:hover,
.agent-bar__avatar--btn:focus-visible {
  color: rgb(var(--v-theme-on-surface));
  outline: none;
}
/* 右下角小点：该 agent 有独立视图（空心 = 后台，实心 = 窗口已打开） */
.agent-bar__avatar.has-view::after {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-sizing: border-box;
  border: 1.5px solid rgba(var(--v-theme-on-surface), 0.55);
  background: rgb(var(--v-theme-surface));
}
.agent-bar__avatar.has-view.shown::after {
  border-color: rgb(var(--v-theme-primary));
  background: rgb(var(--v-theme-primary));
}
.agent-bar__avatar.busy {
  background: rgba(var(--v-theme-primary), 0.18);
  color: rgb(var(--v-theme-primary));
  box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary));
  animation: agent-bar-pulse 1.4s ease-in-out infinite;
}
@keyframes agent-bar-pulse {
  50% {
    box-shadow: inset 0 0 0 2px rgba(var(--v-theme-primary), 0.35);
  }
}

/* 已暂停：头像变灰 + 右下角暂停角标 */
.agent-bar__avatar.paused {
  position: relative;
  filter: grayscale(0.7);
  opacity: 0.85;
}
.agent-bar__paused {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgb(var(--v-theme-warning));
  color: rgb(var(--v-theme-on-warning));
  box-shadow: 0 0 0 2px rgb(var(--v-theme-surface));
}
.agent-bar__menu :deep(.v-list-item) {
  min-height: 40px;
}
</style>
