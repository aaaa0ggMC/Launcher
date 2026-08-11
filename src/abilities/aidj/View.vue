<script setup lang="ts">
import { ref, inject, type Ref, computed, watch, nextTick, onMounted, onDeactivated } from 'vue'
import { translate } from '../../main/ui/i18n'
import ChatView from './components/ChatView.vue'

defineOptions({ name: 'cockpit-aidj' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const menuOpen = ref(false)
const menuStep = ref<'main' | 'sessions'>('main')
const chatRef = ref<InstanceType<typeof ChatView> | null>(null)

interface SessionItem {
  id: string
  title: string
  type: 'chat' | 'generate'
  initialPrompt?: string
  created_at: number
  updated_at: number
  messageCount?: number
  preview?: string
  pinned?: boolean
}

const sessions = ref<SessionItem[]>([])
const sessionsLoading = ref(false)
const search = ref('')
const currentId = ref('')
let btUnsub: (() => void) | null = null

const ctxMenuOpen = ref(false)
const ctxPos = ref({ x: 0, y: 0 })
const ctxTarget = ref<SessionItem | null>(null)

const titleDialogOpen = ref(false)
const titleTarget = ref<SessionItem | null>(null)
const titleInput = ref('')
const genTitleBusy = ref(false)
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

const filteredSessions = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return sessions.value
  return sessions.value.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      (s.initialPrompt || '').toLowerCase().includes(q) ||
      (s.preview || '').toLowerCase().includes(q)
  )
})

function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayLabel(ts: number): string {
  const now = new Date()
  const today = dayKey(now.getTime())
  const yest = dayKey(now.getTime() - 86_400_000)
  const k = dayKey(ts)
  if (k === today) return t('aidj.sessions.today', 'Today')
  if (k === yest) return t('aidj.sessions.yesterday', 'Yesterday')
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`
}

const sessionGroups = computed(() => {
  const groups: { label: string; sessions: SessionItem[] }[] = []
  for (const s of filteredSessions.value) {
    const label = dayLabel(s.updated_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) {
      last.sessions.push(s)
    } else {
      groups.push({ label, sessions: [s] })
    }
  }
  return groups
})

async function refreshSessions(): Promise<void> {
  sessionsLoading.value = true
  try {
    const result = (await window.cockpit.command('aidj.sessions.list')) as {
      ok?: boolean
      sessions?: SessionItem[]
    }
    if (result?.ok && Array.isArray(result.sessions)) {
      sessions.value = result.sessions
    }
  } catch {
    /* noop */
  } finally {
    sessionsLoading.value = false
  }
}

function toggleMenu(): void {
  if (menuOpen.value) {
    menuOpen.value = false
    menuStep.value = 'main'
  } else {
    menuOpen.value = true
    menuStep.value = 'main'
    refreshSessions()
  }
}

function enterSessions(): void {
  menuStep.value = 'sessions'
  search.value = ''
  refreshSessions()
}

function selectChat(): void {
  menuOpen.value = false
  menuStep.value = 'main'
}

async function openSession(sessionId: string): Promise<void> {
  currentId.value = sessionId
  menuOpen.value = false
  menuStep.value = 'main'
  await nextTick()
  chatRef.value?.loadSession(sessionId)
}

function openSessionCtx(e: MouseEvent, s: SessionItem): void {
  e.preventDefault()
  e.stopPropagation()
  ctxTarget.value = s
  ctxPos.value = { x: e.clientX + 8, y: e.clientY + 8 }
  ctxMenuOpen.value = true
}

async function deleteSession(s: SessionItem): Promise<void> {
  ctxMenuOpen.value = false
  try {
    const r = (await window.cockpit.command('aidj.sessions.delete', {
      id: s.id
    })) as { ok?: boolean; error?: string }
    if (r?.ok) {
      sessions.value = sessions.value.filter((x) => x.id !== s.id)
      if (currentId.value === s.id) currentId.value = ''
    } else {
      window.alert(r?.error || '删除失败')
    }
  } catch (e) {
    window.alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function pinSession(s: SessionItem): Promise<void> {
  ctxMenuOpen.value = false
  try {
    const r = (await window.cockpit.command('aidj.sessions.pin', {
      id: s.id
    })) as { ok?: boolean; pinned?: boolean }
    if (r?.ok && typeof r.pinned === 'boolean') {
      const target = sessions.value.find((x) => x.id === s.id)
      if (target) target.pinned = r.pinned
      sessions.value = [...sessions.value]
    }
  } catch {
    /* noop */
  }
}

function openTitleDialog(s: SessionItem): void {
  ctxMenuOpen.value = false
  titleTarget.value = s
  titleInput.value = s.title
  titleDialogOpen.value = true
}

async function saveTitle(): Promise<void> {
  const s = titleTarget.value
  if (!s) return
  titleDialogOpen.value = false
  const title = titleInput.value
  if (!title.trim()) {
    showSnack(t('aidj.sessions.title_empty', '标题为空，保持不变'), 'info')
    return
  }
  try {
    const r = (await window.cockpit.command('aidj.sessions.rename', {
      id: s.id,
      title
    })) as { ok?: boolean; changed?: boolean; error?: string }
    if (r?.ok) {
      if (r.changed) {
        const target = sessions.value.find((x) => x.id === s.id)
        if (target) target.title = title.trim().slice(0, 60)
        sessions.value = [...sessions.value]
        showSnack(t('aidj.sessions.title_saved', '标题已更新'))
      } else {
        showSnack(t('aidj.sessions.title_empty', '标题为空，保持不变'), 'info')
      }
    } else {
      showSnack(r?.error || '设置标题失败', 'error')
    }
  } catch (e) {
    showSnack(`设置标题失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

async function autoTitleSession(s: SessionItem): Promise<void> {
  if (genTitleBusy.value) return
  ctxMenuOpen.value = false
  genTitleBusy.value = true
  try {
    const runningTasks = (await window.cockpit.btList()) as {
      name?: string
      description?: string
      status?: string
    }[]
    const alreadyRunning = (runningTasks ?? []).some(
      (tk) =>
        tk.status === 'running' &&
        tk.name === 'AIDJ 标题生成' &&
        (tk.description ?? '').includes(s.id)
    )
    if (alreadyRunning) {
      showSnack(t('aidj.sessions.title_running', '该会话的标题生成任务正在运行中'), 'info')
      return
    }
    const r = (await window.cockpit.btJob('aidj.title', {
      sessionId: s.id,
      name: 'AIDJ 标题生成',
      description: `${s.id} · ${t('aidj.sessions.title_gen_desc', '自动生成会话标题')}`
    })) as { ok?: boolean; task?: { id?: string }; error?: string; alreadyRunning?: boolean }
    if (r?.ok && r.task?.id) {
      showSnack(t('aidj.sessions.title_started', '已开始生成标题…'))
    } else if (r?.alreadyRunning) {
      showSnack(t('aidj.sessions.title_running', '该会话的标题生成任务正在运行中'), 'info')
    } else {
      showSnack(r?.error || t('aidj.sessions.title_gen_failed', '标题生成失败'), 'error')
    }
  } catch (e) {
    showSnack(`标题生成失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    genTitleBusy.value = false
  }
}

function toMarkdown(): string {
  return chatRef.value?.toMarkdown?.() ?? ''
}

let ctxCleanup: (() => void) | null = null

function ctxClose(): void {
  ctxMenuOpen.value = false
}

function onCtxKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') ctxClose()
}

watch(ctxMenuOpen, (open) => {
  ctxCleanup?.()
  ctxCleanup = null
  if (open) {
    document.addEventListener('click', ctxClose)
    document.addEventListener('contextmenu', ctxClose)
    document.addEventListener('keydown', onCtxKey)
    ctxCleanup = (): void => {
      document.removeEventListener('click', ctxClose)
      document.removeEventListener('contextmenu', ctxClose)
      document.removeEventListener('keydown', onCtxKey)
    }
  }
})

onDeactivated(() => {
  ctxCleanup?.()
  ctxCleanup = null
})

onMounted(() => {
  if (window.cockpit?.on) {
    btUnsub = window.cockpit.on('cockpit:bt', (event: unknown) => {
      if (menuStep.value !== 'sessions') return
      const ev = event as Record<string, unknown>
      if (ev?.type === 'output') {
        const msgs = (ev.messages ?? []) as Record<string, unknown>[]
        for (const msg of msgs) {
          const data = msg.data as Record<string, unknown> | undefined
          if (data && typeof data === 'object' && data.type === 'title') {
            const sid = String(data.sessionId ?? '')
            const title = String(data.title ?? '')
            if (sid && title) {
              const target = sessions.value.find((x) => x.id === sid)
              if (target) target.title = title.slice(0, 60)
              sessions.value = [...sessions.value]
              showSnack(t('aidj.sessions.title_generated', '标题已生成'))
            }
          }
        }
      }
      refreshSessions()
    })
  }
})

onDeactivated(() => {
  if (btUnsub) {
    btUnsub()
    btUnsub = null
  }
})

defineExpose({ toMarkdown })
</script>

<template>
  <div class="aidj-shell">
    <ChatView ref="chatRef" />

    <div class="page-menu" :class="{ 'is-open': menuOpen }">
      <button class="page-menu-handle" @click="toggleMenu">
        <v-icon size="16">{{ menuOpen ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
      </button>

      <Transition name="menu-pop">
        <div v-if="menuOpen" class="page-menu-pop">
          <template v-if="menuStep === 'main'">
            <div class="menu-item" @click="selectChat">
              <v-icon size="18">mdi-comment-text-multiple-outline</v-icon>
              <span>{{ t('aidj.subpage.chat', 'Chat') }}</span>
              <v-icon size="14" class="ml-auto">mdi-check</v-icon>
            </div>
            <div class="menu-item" @click="enterSessions">
              <v-icon size="18">mdi-history</v-icon>
              <span>{{ t('aidj.subpage.sessions', 'Chat Sessions') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
          </template>

          <template v-else>
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('aidj.sessions.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('aidj.subpage.sessions', 'Chat Sessions')
              }}</span>
              <v-spacer />
              <v-btn
                icon
                size="small"
                variant="text"
                :loading="sessionsLoading"
                :title="t('aidj.sessions.refresh', '刷新')"
                @click="refreshSessions"
              >
                <v-icon size="18">mdi-refresh</v-icon>
              </v-btn>
            </div>

            <div class="px-1 pt-1">
              <v-text-field
                v-model="search"
                density="compact"
                variant="outlined"
                hide-details
                :placeholder="t('aidj.sessions.search', '搜索会话…')"
                prepend-inner-icon="mdi-magnify"
                clearable
              />
            </div>

            <div class="session-count d-flex align-center ga-2 px-1 pt-2 pb-1">
              <span class="text-caption text-medium-emphasis">{{
                t('aidj.sessions.count', '会话')
              }}</span>
              <v-chip size="x-small" variant="flat">{{ filteredSessions.length }}</v-chip>
            </div>

            <div class="sessions-scroll">
              <v-empty-state
                v-if="!sessionsLoading && filteredSessions.length === 0"
                icon="mdi-account-search-outline"
                :title="t('aidj.sessions.empty', '没有会话')"
                :text="t('aidj.sessions.empty_hint', '在 Chat 中对话后会在这里出现')"
              />
              <div v-else class="px-1 pb-1">
                <template v-for="g in sessionGroups" :key="g.label">
                  <div class="session-group-label">{{ g.label }}</div>
                  <div
                    v-for="s in g.sessions"
                    :key="s.id"
                    class="session-item"
                    :class="{ 'is-active': s.id === currentId }"
                    @click="openSession(s.id)"
                    @contextmenu="openSessionCtx($event, s)"
                  >
                    <v-icon
                      size="18"
                      :icon="
                        s.pinned
                          ? 'mdi-pin'
                          : s.type === 'chat'
                            ? 'mdi-message-text-outline'
                            : 'mdi-music-note-outline'
                      "
                    />
                    <div class="min-w-0 flex-grow-1">
                      <div class="session-title text-truncate">{{ s.title }}</div>
                      <div class="session-meta">{{ s.messageCount ?? 0 }} 条</div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="ctxMenuOpen && ctxTarget"
          class="aidj-session-ctx"
          :style="{ left: ctxPos.x + 'px', top: ctxPos.y + 'px' }"
          @click.stop
        >
          <button class="aidj-session-ctx-item" @click="ctxTarget && pinSession(ctxTarget)">
            <v-icon :icon="ctxTarget?.pinned ? 'mdi-pin-off' : 'mdi-pin'" size="14" />
            <span>{{
              ctxTarget?.pinned
                ? t('aidj.sessions.unpin', '取消置顶')
                : t('aidj.sessions.pin', '置顶')
            }}</span>
          </button>
          <button
            class="aidj-session-ctx-item"
            :disabled="genTitleBusy"
            @click="ctxTarget && autoTitleSession(ctxTarget)"
          >
            <v-icon
              :icon="genTitleBusy ? 'mdi-loading' : 'mdi-auto-fix'"
              size="14"
              :class="{ 'mdi-spin': genTitleBusy }"
            />
            <span>{{ t('aidj.sessions.auto_title', '自动生成标题') }}</span>
          </button>
          <button class="aidj-session-ctx-item" @click="ctxTarget && openTitleDialog(ctxTarget)">
            <v-icon icon="mdi-rename-box-outline" size="14" />
            <span>{{ t('aidj.sessions.set_title', '设置标题') }}</span>
          </button>
          <button
            class="aidj-session-ctx-item is-danger"
            @click="ctxTarget && deleteSession(ctxTarget)"
          >
            <v-icon icon="mdi-delete-outline" size="14" />
            <span>{{ t('aidj.sessions.delete', '删除') }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>

    <v-dialog v-model="titleDialogOpen" width="440">
      <v-card>
        <v-card-title>{{ t('aidj.sessions.set_title_dialog_title', '设置标题') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="titleInput"
            :label="t('aidj.sessions.title_placeholder', '输入会话标题…')"
            variant="outlined"
            density="compact"
            hide-details
            autofocus
            @keyup.enter="saveTitle"
          />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="titleDialogOpen = false">{{
            t('aidj.cancel', '取消')
          }}</v-btn>
          <v-btn color="primary" @click="saveTitle">{{ t('aidj.sessions.save', '保存') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="2500">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.aidj-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.page-menu {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.page-menu-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 24px;
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-top: none;
  border-radius: 0 0 24px 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: color 0.15s ease;
}
.page-menu-handle:hover {
  color: rgb(var(--v-theme-primary));
}
.page-menu.is-open .page-menu-handle {
  color: rgb(var(--v-theme-primary));
}

.page-menu-pop {
  margin-top: 4px;
  width: 340px;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
  overflow: hidden;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.menu-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}

.sessions-head {
  padding: 2px 4px 6px;
}
.sessions-scroll {
  max-height: 320px;
  overflow-y: auto;
  min-height: 0;
}
.sessions-scroll::-webkit-scrollbar {
  width: 6px;
}
.sessions-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  margin-block: 1px;
  transition: background-color 0.15s ease;
}
.session-group-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
  padding: 10px 10px 4px;
}
.session-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.session-item.is-active {
  background: rgba(var(--v-theme-primary), 0.14);
}
.session-title {
  font-size: 0.85rem;
}
.session-meta {
  font-size: 0.72rem;
  opacity: 0.6;
}

.menu-pop-enter-active,
.menu-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>

<style>
.aidj-session-ctx {
  position: fixed;
  z-index: 3000;
  min-width: 130px;
  padding: 4px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.aidj-session-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8rem;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.aidj-session-ctx-item:hover {
  background: rgba(var(--v-theme-primary), 0.15);
}
.aidj-session-ctx-item:disabled {
  opacity: 0.5;
  cursor: default;
}
.aidj-session-ctx-item.is-danger:hover {
  background: rgba(var(--v-theme-error), 0.18);
  color: rgb(var(--v-theme-error));
}
.ctx-enter-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
.ctx-leave-active {
  transition: opacity 0.1s ease;
}
.ctx-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}
.ctx-enter-to {
  opacity: 1;
  transform: scale(1) translateY(0);
}
.ctx-leave-to {
  opacity: 0;
}
</style>
