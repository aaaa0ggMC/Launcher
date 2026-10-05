<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { Session } from '../types'

const props = defineProps<{
  /** 已按 updatedAt 倒序，分组只切段不重新排序 */
  sessions: Session[]
  activeSessionId: string | null
  /** 正在生成的会话 id，条目上显示脉冲点 */
  runningSessionIds: string[]
}>()

const emit = defineEmits<{
  (e: 'selectSession', id: string): void
  (e: 'createSession'): void
  (e: 'deleteSession', id: string): void
  (e: 'renameSession', id: string, title: string): void
  (e: 'import'): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const search = ref('')
const deleteDialog = ref(false)
const sessionToDelete = ref<string | null>(null)

// 行内重命名：editingId = 正在编辑的会话 id（空 = 无编辑）
const editingId = ref<string | null>(null)
const editingTitle = ref('')

// 相对时间依赖时钟，列表存活期间定时刷新 now
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (tickTimer !== null) clearInterval(tickTimer)
})

// v-text-field 聚焦后全选，方便直接覆盖输入
const vFocus = {
  mounted(el: HTMLElement): void {
    const input = el.querySelector('input')
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }
}

// ---- 搜索：标题本地过滤 + 消息正文由主进程检索（防抖，≥ 2 个字符才查） ----
interface ContentHit {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  matches: number
}
const contentHits = ref<Map<string, ContentHit>>(new Map())
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0
watch(search, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const q = (value ?? '').trim()
  if (q.length < 2) {
    contentHits.value = new Map()
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq
    try {
      const hits = (await window.cockpit.command('yaya.sessions-search', {
        query: q,
        limit: 50
      })) as ContentHit[]
      if (seq === searchSeq) contentHits.value = new Map(hits.map((h) => [h.sessionId, h]))
    } catch {
      if (seq === searchSeq) contentHits.value = new Map()
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }, 250)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

const filteredSessions = computed(() => {
  const q = (search.value ?? '').trim().toLowerCase()
  if (!q) return props.sessions
  return props.sessions.filter(
    (s) => s.title.toLowerCase().includes(q) || contentHits.value.has(s.id)
  )
})

/** 片段按关键词切开，命中部分用 <mark>（纯文本拼接，不用 v-html） */
function highlight(text: string): { text: string; hit: boolean }[] {
  const q = (search.value ?? '').trim()
  if (!q) return [{ text, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at < 0) break
    if (at > i) out.push({ text: text.slice(i, at), hit: false })
    out.push({ text: text.slice(at, at + q.length), hit: true })
    i = at + q.length
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

interface SessionGroup {
  label: string
  items: Session[]
}

const sessionGroups = computed<SessionGroup[]>(() => {
  const buckets: SessionGroup[] = [
    { label: t('yaya.sessions.group.today', '今天'), items: [] },
    { label: t('yaya.sessions.group.yesterday', '昨天'), items: [] },
    { label: t('yaya.sessions.group.week', '7 天内'), items: [] },
    { label: t('yaya.sessions.group.month', '30 天内'), items: [] },
    { label: t('yaya.sessions.group.earlier', '更早'), items: [] }
  ]
  const day = 86_400_000
  const today = startOfDay(now.value)
  const yesterday = today - day
  const week = today - 6 * day
  const month = today - 29 * day
  for (const s of filteredSessions.value) {
    const d = startOfDay(s.updatedAt)
    if (d >= today) buckets[0].items.push(s)
    else if (d >= yesterday) buckets[1].items.push(s)
    else if (d >= week) buckets[2].items.push(s)
    else if (d >= month) buckets[3].items.push(s)
    else buckets[4].items.push(s)
  }
  return buckets.filter((b) => b.items.length > 0)
})

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, now.value - ts)
  if (diff < 60_000) return t('yaya.sessions.time.now', '刚刚')
  if (diff < 3_600_000) {
    return te('yaya.sessions.time.minutes', { n: String(Math.floor(diff / 60_000)) }, '{n} 分钟前')
  }
  if (diff < 86_400_000) {
    return te('yaya.sessions.time.hours', { n: String(Math.floor(diff / 3_600_000)) }, '{n} 小时前')
  }
  const d = new Date(ts)
  return te(
    'yaya.sessions.time.date',
    { m: String(d.getMonth() + 1), d: String(d.getDate()) },
    '{m}/{d}'
  )
}

function isRunning(id: string): boolean {
  return props.runningSessionIds.includes(id)
}

function onItemClick(s: Session): void {
  if (editingId.value === s.id) return
  if (editingId.value) commitRename()
  emit('selectSession', s.id)
}

function startRename(s: Session): void {
  editingId.value = s.id
  editingTitle.value = s.title
}

function commitRename(): void {
  const id = editingId.value
  const title = editingTitle.value.trim()
  editingId.value = null
  if (!id || !title) return
  if (props.sessions.find((s) => s.id === id)?.title === title) return
  emit('renameSession', id, title)
}

function cancelRename(): void {
  editingId.value = null
}

function confirmDelete(id: string): void {
  sessionToDelete.value = id
  deleteDialog.value = true
}

function doDelete(): void {
  const id = sessionToDelete.value
  sessionToDelete.value = null
  deleteDialog.value = false
  if (id) emit('deleteSession', id)
}
</script>

<template>
  <div class="session-drawer-content d-flex flex-column h-100 pa-3">
    <!-- 头部：标题 + 导入 / 新建 -->
    <div class="d-flex align-center ga-2 flex-shrink-0 pb-3">
      <v-icon icon="mdi-chat-processing-outline" color="primary" size="20" />
      <span class="text-subtitle-2 font-weight-bold">{{ t('yaya.sessions.title', '会话') }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-import"
        variant="text"
        density="comfortable"
        :title="
          t('yaya.sessions.import_any', '导入聊天记录（ChatGPT / Claude / DeepSeek / Rikkahub）')
        "
        :aria-label="
          t('yaya.sessions.import_any', '导入聊天记录（ChatGPT / Claude / DeepSeek / Rikkahub）')
        "
        @click="emit('import')"
      />
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="emit('createSession')">
        {{ t('yaya.sessions.new', '新建') }}
      </v-btn>
    </div>

    <!-- 搜索框 -->
    <v-text-field
      v-model="search"
      class="session-search flex-shrink-0 mb-2"
      prepend-inner-icon="mdi-magnify"
      :placeholder="t('yaya.sessions.search_content', '搜索标题或内容…')"
      :loading="searching"
      density="compact"
      variant="outlined"
      hide-details
      clearable
    />

    <!-- 按时间分组的会话列表，只有这一区滚动 -->
    <div class="session-scroll-list flex-grow-1 overflow-y-auto">
      <v-list nav density="comfortable" class="session-list pa-0 bg-transparent">
        <template v-for="(group, gi) in sessionGroups" :key="group.label">
          <div
            class="session-group-label text-caption font-weight-medium text-medium-emphasis"
            :class="{ 'session-group-first': gi === 0 }"
          >
            {{ group.label }}
          </div>

          <v-list-item
            v-for="s in group.items"
            :key="s.id"
            :active="s.id === activeSessionId"
            color="primary"
            rounded="lg"
            class="session-item"
            @click="onItemClick(s)"
          >
            <template #prepend>
              <span
                v-if="isRunning(s.id)"
                class="session-running-dot mr-3"
                :title="t('yaya.sessions.running', '生成中')"
                :aria-label="t('yaya.sessions.running', '生成中')"
              />
              <v-icon
                v-else
                :icon="s.id === activeSessionId ? 'mdi-message-text' : 'mdi-message-text-outline'"
                size="18"
                class="mr-2"
              />
            </template>

            <template v-if="editingId === s.id">
              <v-text-field
                v-model="editingTitle"
                v-focus
                class="session-rename-field"
                density="compact"
                variant="outlined"
                hide-details
                :placeholder="t('yaya.sessions.renamePlaceholder', '会话标题')"
                @keyup.enter="commitRename"
                @keyup.esc="cancelRename"
                @blur="commitRename"
                @click.stop
              />
            </template>
            <template v-else>
              <v-list-item-title class="text-body-2 font-weight-medium text-truncate">
                {{ s.title }}
              </v-list-item-title>
              <div v-if="contentHits.get(s.id)" class="session-hit text-medium-emphasis">
                <span
                  v-for="(part, pi) in highlight(contentHits.get(s.id)!.snippet)"
                  :key="pi"
                  :class="{ 'hit-mark': part.hit }"
                  >{{ part.text }}</span
                >
              </div>
              <v-list-item-subtitle
                class="text-caption text-medium-emphasis d-flex align-center ga-1"
              >
                <span>{{ formatRelative(s.updatedAt) }}</span>
                <span v-if="isRunning(s.id)">{{ t('yaya.sessions.running', '生成中') }}</span>
                <span v-if="(contentHits.get(s.id)?.matches ?? 0) > 1">
                  ·
                  {{
                    te(
                      'yaya.sessions.matches',
                      { n: String(contentHits.get(s.id)!.matches) },
                      '{n} 处匹配'
                    )
                  }}
                </span>
              </v-list-item-subtitle>
            </template>

            <template #append>
              <v-menu
                v-if="editingId !== s.id"
                location="bottom end"
                :close-on-content-click="true"
              >
                <template #activator="{ props: menuProps }">
                  <v-btn
                    v-bind="menuProps"
                    icon="mdi-dots-vertical"
                    size="small"
                    variant="text"
                    density="comfortable"
                    class="session-menu-btn"
                    :title="t('yaya.sessions.menu', '会话操作')"
                    :aria-label="t('yaya.sessions.menu', '会话操作')"
                    @click.stop
                  />
                </template>
                <v-list density="compact" min-width="176" class="py-1">
                  <v-list-item
                    prepend-icon="mdi-pencil-outline"
                    :title="t('yaya.sessions.rename', '重命名')"
                    @click="startRename(s)"
                  />
                  <v-list-item
                    prepend-icon="mdi-delete-outline"
                    base-color="error"
                    :title="t('yaya.sessions.delete', '删除')"
                    @click="confirmDelete(s.id)"
                  />
                </v-list>
              </v-menu>
            </template>
          </v-list-item>
        </template>
      </v-list>

      <!-- 空状态：整个列表为空 / 搜索无结果 -->
      <div
        v-if="sessions.length === 0"
        class="session-empty text-caption text-medium-emphasis text-center"
      >
        <v-icon icon="mdi-chat-plus-outline" size="28" class="mb-2" />
        <div>{{ t('yaya.sessions.empty', '暂无会话，点右上角「新建」开始对话') }}</div>
      </div>
      <div
        v-else-if="sessionGroups.length === 0"
        class="session-empty text-caption text-medium-emphasis text-center"
      >
        <v-icon icon="mdi-magnify" size="28" class="mb-2" />
        <div>{{ t('yaya.sessions.emptySearch', '没有匹配的会话') }}</div>
      </div>
    </div>

    <!-- 删除确认 -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card class="pa-4">
        <v-card-title class="px-0 pt-0 text-h6">
          {{ t('yaya.sessions.deleteTitle', '删除会话') }}
        </v-card-title>
        <v-card-text class="px-0 py-3 text-body-2 text-medium-emphasis">
          {{
            t('yaya.sessions.deleteBody', '确定要彻底删除该会话及其所有分支吗？此操作不可恢复。')
          }}
        </v-card-text>
        <v-card-actions class="px-0 pb-0 ga-2 justify-end">
          <v-btn variant="text" @click="deleteDialog = false">
            {{ t('yaya.sessions.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" variant="elevated" @click="doDelete">
            {{ t('yaya.sessions.delete', '删除') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.session-drawer-content {
  /* 底色由外层抽屉提供，这里保持全透明 */
  background: transparent;
}

/* Vuetify 的 .v-input 自带 flex: 1 1 auto，放在纵向 flex 列里会被撑满整列 */
.session-search {
  flex: 0 0 auto !important;
}
.session-hit {
  font-size: 0.78rem;
  line-height: 1.4;
  margin: 2px 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.hit-mark {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.session-search :deep(.v-field) {
  border-radius: 8px;
}

.session-scroll-list {
  min-height: 0;
}

.session-group-label {
  padding: 14px 4px 4px;
}

.session-group-first {
  padding-top: 2px;
}

/* 生成中会话的脉冲指示点 */
.session-running-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  animation: session-dot-pulse 1.4s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes session-dot-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .session-running-dot {
    animation: none;
    opacity: 1;
  }
}

/* 手机抽屉约 85vw：加大行高与菜单热区，别挤 */
@media (max-width: 720px) {
  .session-item {
    min-height: 56px;
  }

  .session-menu-btn {
    width: 40px !important;
    height: 40px !important;
  }
}
</style>
