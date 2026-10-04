<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Session } from '../types'

const props = defineProps<{
  sessions: Session[]
  activeSessionId: string | null
}>()

const emit = defineEmits<{
  (e: 'selectSession', id: string): void
  (e: 'createSession'): void
  (e: 'deleteSession', id: string): void
  (e: 'importOpenAi', jsonText: string): void
}>()

const search = ref('')
const deleteDialog = ref(false)
const sessionToDelete = ref<string | null>(null)
const importDialog = ref(false)
const importJsonText = ref('')

const filteredSessions = computed(() => {
  if (!search.value.trim()) return props.sessions
  const q = search.value.toLowerCase()
  return props.sessions.filter((s) => s.title.toLowerCase().includes(q))
})

function confirmDelete(id: string, ev: Event): void {
  ev.stopPropagation()
  sessionToDelete.value = id
  deleteDialog.value = true
}

function doDelete(): void {
  if (sessionToDelete.value) {
    emit('deleteSession', sessionToDelete.value)
    sessionToDelete.value = null
  }
  deleteDialog.value = false
}

function doImport(): void {
  if (importJsonText.value.trim()) {
    emit('importOpenAi', importJsonText.value)
    importJsonText.value = ''
  }
  importDialog.value = false
}

function formatTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<template>
  <div class="session-drawer-content d-flex flex-column h-100 pa-3">
    <!-- 头部：标题与操作 -->
    <div class="d-flex align-center justify-space-between mb-3 flex-shrink-0">
      <div class="d-flex align-center ga-2">
        <v-icon icon="mdi-chat-processing-outline" color="primary" size="20" />
        <span class="text-subtitle-2 font-weight-bold">对话记录</span>
      </div>

      <div class="d-flex ga-1">
        <v-btn
          icon="mdi-import"
          size="small"
          variant="text"
          title="导入 ChatGPT 历史会话"
          aria-label="导入 ChatGPT 历史会话"
          @click="importDialog = true"
        />
        <v-btn
          color="primary"
          size="small"
          variant="tonal"
          prepend-icon="mdi-plus"
          @click="emit('createSession')"
        >
          新建
        </v-btn>
      </div>
    </div>

    <!-- 搜索框 (明确限制高度与 flex) -->
    <div class="search-box-wrap mb-3 flex-shrink-0">
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="搜索对话..."
        density="compact"
        variant="outlined"
        hide-details
        clearable
        class="session-search-input"
      />
    </div>

    <!-- 会话列表滚动区 -->
    <div class="session-scroll-list flex-grow-1 overflow-y-auto">
      <v-list density="comfortable" nav class="pa-0 bg-transparent">
        <v-list-item
          v-for="s in filteredSessions"
          :key="s.id"
          :active="s.id === activeSessionId"
          color="primary"
          rounded="lg"
          class="mb-1 session-item"
          @click="emit('selectSession', s.id)"
        >
          <template #prepend>
            <v-icon
              :icon="s.id === activeSessionId ? 'mdi-message-text' : 'mdi-message-text-outline'"
              size="18"
              class="mr-2"
            />
          </template>

          <v-list-item-title class="text-body-2 font-weight-medium text-truncate">
            {{ s.title }}
          </v-list-item-title>

          <v-list-item-subtitle class="text-caption text-medium-emphasis">
            {{ formatTime(s.updatedAt) }}
          </v-list-item-subtitle>

          <template #append>
            <v-btn
              icon="mdi-delete-outline"
              size="small"
              variant="text"
              density="comfortable"
              class="delete-btn opacity-0"
              title="删除会话"
              aria-label="删除会话"
              @click="(ev) => confirmDelete(s.id, ev)"
            />
          </template>
        </v-list-item>

        <div
          v-if="filteredSessions.length === 0"
          class="text-center py-8 text-caption text-medium-emphasis"
        >
          暂无对话记录
        </div>
      </v-list>
    </div>

    <!-- 删除确认对话框 -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card class="pa-4">
        <v-card-title class="px-0 pt-0 text-h6">删除会话</v-card-title>
        <v-card-text class="px-0 py-3 text-body-2 text-medium-emphasis">
          确定要彻底删除该会话及其所有分支吗？此操作不可恢复。
        </v-card-text>
        <v-card-actions class="px-0 pb-0 ga-2 justify-end">
          <v-btn variant="text" @click="deleteDialog = false">取消</v-btn>
          <v-btn color="error" variant="elevated" @click="doDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 导入 ChatGPT 对话框 -->
    <v-dialog v-model="importDialog" max-width="500">
      <v-card class="pa-4">
        <v-card-title class="px-0 pt-0 text-h6">导入 ChatGPT 对话记录</v-card-title>
        <v-card-text class="px-0 py-3">
          <div class="text-body-2 text-medium-emphasis mb-2">
            请粘贴导出的 conversations.json 文件内容：
          </div>
          <v-textarea
            v-model="importJsonText"
            rows="6"
            variant="outlined"
            placeholder="[{ id: '...', mapping: { ... } }]"
            hide-details
            font-monospace
          />
        </v-card-text>
        <v-card-actions class="px-0 pb-0 ga-2 justify-end">
          <v-btn variant="text" @click="importDialog = false">取消</v-btn>
          <v-btn color="primary" variant="elevated" @click="doImport">开始导入</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.session-drawer-content {
  background: rgba(var(--v-theme-surface), 0.95);
  backdrop-filter: blur(16px);
}

.search-box-wrap {
  height: 40px;
}

.session-search-input :deep(.v-field) {
  border-radius: 8px;
}

.session-item:hover .delete-btn {
  opacity: 1 !important;
}

.session-scroll-list {
  min-height: 0;
}
</style>
