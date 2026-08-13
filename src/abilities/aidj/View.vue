<script setup lang="ts">
import { ref, inject, type Ref, computed, watch, nextTick, onMounted, onDeactivated } from 'vue'
import { translate } from '../../main/ui/i18n'
import ChatView from './components/ChatView.vue'
import FreqList from './components/FreqList.vue'

defineOptions({ name: 'cockpit-aidj' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const openBt = inject('cockpit:open-bt', null) as (() => void) | null

const menuOpen = ref(false)
const menuStep = ref<'main' | 'sessions' | 'freq'>('main')
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
    void refreshLyricsOpen()
  }
}

function enterSessions(): void {
  menuStep.value = 'sessions'
  search.value = ''
  refreshSessions()
}

/** 更新元数据：没有运行中的同步任务则启动后台作业；已有则直接跳到后台面板。 */
async function updateMetadata(): Promise<void> {
  try {
    const runningTasks = (await window.cockpit.btList()) as {
      name?: string
      status?: string
    }[]
    const alreadyRunning = (runningTasks ?? []).some(
      (tk) => tk.status === 'running' && tk.name === 'AIDJ 元数据同步'
    )
    if (alreadyRunning) {
      openBt?.()
      return
    }
    const r = (await window.cockpit.btJob('aidj.metadata-sync', {
      name: 'AIDJ 元数据同步',
      description: t('aidj.metadata_sync_desc', '扫描曲库并更新缺失歌曲元数据')
    })) as { ok?: boolean; task?: { id?: string }; error?: string; alreadyRunning?: boolean }
    if (r?.ok && r.task?.id) {
      showSnack(t('aidj.metadata_sync_started', '已开始同步元数据…'))
    } else if (r?.alreadyRunning) {
      openBt?.()
    } else {
      showSnack(r?.error || t('aidj.metadata_sync_failed', '元数据同步失败'), 'error')
    }
  } catch (e) {
    showSnack(`元数据同步失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

/** Page-menu 「新建会话」— clears the current conversation in the chat view
 *  and resets the backend session so the next message starts fresh. */
function newChat(): void {
  menuOpen.value = false
  menuStep.value = 'main'
  void chatRef.value?.newChat?.()
}

// -- 桌面歌词：绑定当前设置的 DBus，窗口单例（已存在则聚焦，不重复启动） -----
const lyricsOpen = ref(false)

async function toggleLyricsWindow(): Promise<void> {
  const res = (await window.cockpit.command('aidj.lyrics-toggle').catch(() => null)) as {
    open?: boolean
  } | null
  if (res && typeof res.open === 'boolean') lyricsOpen.value = res.open
  menuOpen.value = false
}

async function refreshLyricsOpen(): Promise<void> {
  const res = (await window.cockpit.command('aidj.lyrics-state').catch(() => null)) as {
    open?: boolean
  } | null
  // 状态绑定「当前 DBus 播放器」自己的歌词窗口，而不是任意一个（每个播放器独立实例）
  lyricsOpen.value = res?.open === true
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
      showSnack(r?.error || t('aidj.sessions.title_failed', '设置标题失败'), 'error')
    }
  } catch (e) {
    showSnack(
      `${t('aidj.sessions.title_failed', '设置标题失败')}: ${e instanceof Error ? e.message : String(e)}`,
      'error'
    )
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

const pageMenuRef = ref<HTMLElement | null>(null)
let menuCleanup: (() => void) | null = null

function menuClose(): void {
  menuOpen.value = false
  menuStep.value = 'main'
}

/** Close the page dropdown when clicking/right-clicking outside of it.
 *  Only closes when the target is still attached to the document AND outside
 *  the menu — a click that triggers a re-render (e.g. switching subpages) can
 *  detach its own target before the document listener runs, which would
 *  otherwise falsely look like an outside click. */
function onMenuDocClick(e: MouseEvent): void {
  const el = pageMenuRef.value
  const t = e.target as Node | null
  if (!el || !t || !t.isConnected) return
  if (el.contains(t)) return
  menuClose()
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuClose()
}

watch(menuOpen, (open) => {
  menuCleanup?.()
  menuCleanup = null
  if (open) {
    document.addEventListener('click', onMenuDocClick)
    document.addEventListener('contextmenu', onMenuDocClick)
    document.addEventListener('keydown', onMenuKey)
    menuCleanup = (): void => {
      document.removeEventListener('click', onMenuDocClick)
      document.removeEventListener('contextmenu', onMenuDocClick)
      document.removeEventListener('keydown', onMenuKey)
    }
  }
})

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
  menuCleanup?.()
  menuCleanup = null
})

onMounted(() => {
  if (window.cockpit?.on) {
    btUnsub = window.cockpit.on('cockpit:bt', (event: unknown) => {
      const ev = event as Record<string, unknown>
      if (ev?.type === 'output') {
        const msgs = (ev.messages ?? []) as Record<string, unknown>[]
        for (const msg of msgs) {
          const data = msg.data as Record<string, unknown> | undefined
          if (!data || typeof data !== 'object') continue
          if (data.type === 'title') {
            const sid = String(data.sessionId ?? '')
            const title = String(data.title ?? '')
            if (sid && title) {
              const target = sessions.value.find((x) => x.id === sid)
              if (target) target.title = title.slice(0, 60)
              sessions.value = [...sessions.value]
              showSnack(t('aidj.sessions.title_generated', '标题已生成'))
            }
          } else if (data.type === 'metadata_sync_done') {
            const synced = Number(data.synced ?? 0)
            showSnack(
              synced > 0
                ? `${t('aidj.metadata_sync_done', '元数据同步完成')}：${synced}`
                : t('aidj.metadata_sync_none', '没有写入新的元数据'),
              synced > 0 ? 'success' : 'warning'
            )
          }
        }
      }
      if (menuStep.value === 'sessions') refreshSessions()
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

    <div ref="pageMenuRef" class="page-menu" :class="{ 'is-open': menuOpen }" @click.stop>
      <button class="page-menu-handle" @click="toggleMenu">
        <v-icon size="16">{{ menuOpen ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
      </button>

      <Transition name="menu-pop">
        <div v-if="menuOpen" class="page-menu-pop" :class="{ 'is-wide': menuStep === 'freq' }">
          <template v-if="menuStep === 'main'">
            <div class="menu-item" @click="newChat">
              <v-icon size="18">mdi-message-plus-outline</v-icon>
              <span>{{ t('aidj.subpage.newchat', '新建会话') }}</span>
            </div>
            <div class="menu-item" @click="enterSessions">
              <v-icon size="18">mdi-history</v-icon>
              <span>{{ t('aidj.subpage.sessions', '会话记录') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'freq'">
              <v-icon size="18">mdi-poll</v-icon>
              <span>{{ t('aidj.subpage.freq', '歌曲频率') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="updateMetadata">
              <v-icon size="18">mdi-database-sync-outline</v-icon>
              <span>{{ t('aidj.metadata_sync', '更新 MetaData') }}</span>
            </div>
            <div class="menu-item" @click="toggleLyricsWindow">
              <v-icon size="18">mdi-music-note-plus</v-icon>
              <span>{{
                lyricsOpen
                  ? t('aidj.lyrics_close', '关闭桌面歌词')
                  : t('aidj.lyrics_open', '桌面歌词')
              }}</span>
              <v-icon v-if="lyricsOpen" size="14" class="ml-auto">mdi-check</v-icon>
            </div>
          </template>

          <template v-else-if="menuStep === 'sessions'">
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

          <template v-else-if="menuStep === 'freq'">
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
                t('aidj.subpage.freq', '歌曲频率')
              }}</span>
            </div>
            <FreqList />
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
.page-menu-pop.is-wide {
  width: 460px;
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
