<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { translate, translateTemplate } from '../i18n'
import AgentAvatar from './AgentAvatar.vue'
import type { AgentUiConfig } from '../composables/agentUi'
import { useExclusive } from '../composables/exclusive'
import { fmtUptime } from '../composables/format'

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
}

interface Live {
  at: number
  tool: string
  pageId: string | null
}

const props = defineProps<{
  modelValue: boolean
  sessions: Session[]
  live: Record<string, Live>
  ui: AgentUiConfig
  lang: string
  currentId: string | null
  abilityName: (id: string | null) => string
}>()

const emit = defineEmits<{
  'update:modelValue': [val: boolean]
  follow: [session: Session]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const { forSession } = useExclusive()
const disconnecting = ref<Record<string, boolean>>({})

// 跨能力激活（跳转至日志等）
const abilitiesCtx = inject<{ activate: (id: string) => void }>('cockpit:abilities', {
  activate: () => {}
})

const tr = (k: string, f: string): string => translate(props.lang, k, f)
const te = (k: string, v: Record<string, string>, f: string): string =>
  translateTemplate(props.lang, k, v, f)

function isBusy(id: string): boolean {
  const l = props.live[id]
  return !!l && Date.now() - l.at < props.ui.busyTimeoutSec * 1000
}

function clientName(s: Session): string {
  return s.client || tr('agent.unknownClient', 'AI client')
}

function initial(s: Session): string {
  return (clientName(s).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}

// 是否支持 Electron 独立视图跟随
const canFollow = computed(() => window.cockpit.hasCap('window.frame'))

async function disconnect(s: Session): Promise<void> {
  disconnecting.value[s.id] = true
  try {
    await window.cockpit.command('agent.disconnect', { id: s.id })
  } catch (err) {
    console.error('Failed to disconnect agent session:', err)
  } finally {
    disconnecting.value[s.id] = false
  }
}

function goToLogs(): void {
  visible.value = false
  abilitiesCtx.activate('logs')
}

function followSession(s: Session): void {
  visible.value = false
  emit('follow', s)
}
</script>

<template>
  <v-dialog v-model="visible" max-width="560" scrollable transition="dialog-bottom-transition">
    <v-card class="agent-dialog-card rounded-xl">
      <!-- 弹窗标题栏 -->
      <v-card-item class="px-5 pt-4 pb-2">
        <div class="d-flex align-center justify-space-between">
          <div class="d-flex align-center ga-3">
            <v-icon icon="mdi-robot-happy" color="primary" size="28" />
            <div>
              <div class="text-subtitle-1 font-weight-bold">
                {{ tr('agent.dialog.title', 'AI 会话与客户端') }}
              </div>
              <div class="text-caption text-medium-emphasis">
                {{
                  te(
                    'agent.dialog.online',
                    { n: String(sessions.length) },
                    `${sessions.length} 个在线会话`
                  )
                }}
              </div>
            </div>
          </div>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            :title="tr('hostpick.cancel', '关闭')"
            :aria-label="tr('hostpick.cancel', '关闭')"
            @click="visible = false"
          />
        </div>
      </v-card-item>

      <v-divider />

      <!-- 会话卡片列表 -->
      <v-card-text class="px-4 py-4" style="max-height: 70vh">
        <div v-if="sessions.length === 0" class="py-12 text-center text-medium-emphasis">
          <v-icon icon="mdi-robot-off-outline" size="48" class="mb-3 opacity-60" />
          <div class="text-body-1">{{ tr('agent.dialog.empty', '当前没有活跃的 AI 会话') }}</div>
        </div>

        <div v-else class="d-flex flex-column ga-3">
          <v-card
            v-for="s in sessions"
            :key="s.id"
            variant="outlined"
            class="agent-session-item rounded-lg pa-4"
            :class="{ 'agent-session-item--busy': isBusy(s.id) }"
          >
            <!-- 头部：头像、名字、徽章 -->
            <div class="d-flex align-center ga-3 mb-3">
              <div class="agent-avatar-wrap" :class="{ busy: isBusy(s.id) }">
                <AgentAvatar
                  :avatar="ui.allowAvatar ? s.avatar : undefined"
                  :icon="ui.defaultIcon === 'icon' ? s.icon : undefined"
                  :initial="initial(s)"
                />
              </div>

              <div class="flex-grow-1 overflow-hidden">
                <div class="d-flex align-center ga-2 flex-wrap">
                  <span class="text-subtitle-2 font-weight-bold text-truncate">{{
                    clientName(s)
                  }}</span>
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    color="primary"
                    class="font-weight-medium px-2"
                  >
                    {{ s.transport === 'mcp' ? 'MCP' : 'Remote' }}
                  </v-chip>
                  <v-chip
                    v-if="isBusy(s.id)"
                    size="x-small"
                    color="primary"
                    variant="flat"
                    class="font-weight-medium px-2"
                  >
                    {{ tr('agent.dialog.executing', '执行中') }}
                  </v-chip>
                </div>
                <div class="text-caption text-medium-emphasis mt-1">
                  ID: <span class="font-mono">{{ s.id.slice(0, 12) }}</span> ·
                  {{
                    te(
                      'agent.dialog.startedAt',
                      {
                        time: fmtUptime(
                          Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)),
                          lang
                        )
                      },
                      `已连接 ${fmtUptime(Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)), lang)}`
                    )
                  }}
                </div>
              </div>
            </div>

            <!-- 活动指示 UI Hint -->
            <div class="agent-activity-box rounded-lg px-3 py-2 mb-3">
              <div class="d-flex align-center justify-space-between mb-1">
                <div class="d-flex align-center ga-2">
                  <span
                    class="status-indicator-dot"
                    :class="{ 'status-indicator-dot--active': isBusy(s.id) }"
                  />
                  <span class="text-caption font-weight-medium">
                    <template v-if="isBusy(s.id)">
                      {{ tr('agent.dialog.lastTool', '正在执行') }}:
                      <span class="font-mono text-primary font-weight-bold">{{
                        live[s.id]?.tool || 'tool'
                      }}</span>
                    </template>
                    <template v-else-if="live[s.id]?.tool">
                      {{ tr('agent.lastTool', '最近操作') }}:
                      <span class="font-mono text-medium-emphasis">{{ live[s.id]?.tool }}</span>
                    </template>
                    <template v-else>
                      {{ tr('agent.idle', '空闲') }}
                    </template>
                  </span>
                </div>
                <div class="text-caption text-medium-emphasis">
                  {{ te('agent.dialog.calls', { n: String(s.calls) }, `调用 ${s.calls} 次`) }}
                </div>
              </div>

              <!-- 自报 status 文本与进度 -->
              <div v-if="s.status" class="mt-2 pt-2 border-t">
                <div class="text-caption font-weight-medium mb-1">
                  {{ s.status.text }}
                  <span v-if="s.status.progress != null">({{ s.status.progress }}%)</span>
                </div>
                <v-progress-linear
                  v-if="s.status.progress != null"
                  :model-value="s.status.progress"
                  color="primary"
                  height="4"
                  rounded
                />
              </div>

              <!-- 独占资源占用提示 -->
              <div
                v-if="forSession(s.id).length"
                class="mt-2 pt-2 border-t d-flex align-center ga-1 flex-wrap"
              >
                <span class="text-caption text-medium-emphasis mr-1"
                  >{{ tr('agent.dialog.heldLease', '占用资源') }}:</span
                >
                <v-chip
                  v-for="held in forSession(s.id)"
                  :key="`${held.scope}-${held.key}`"
                  size="x-small"
                  variant="outlined"
                  color="warning"
                >
                  {{ tr(held.label, held.scope) }} · {{ held.key }}
                </v-chip>
              </div>
            </div>

            <!-- 操作按钮组 -->
            <v-card-actions class="px-0 pb-0 pt-1 ga-2">
              <v-btn
                v-if="canFollow"
                variant="tonal"
                color="primary"
                prepend-icon="mdi-eye-outline"
                @click="followSession(s)"
              >
                {{ tr('agent.dialog.follow', '跟随视图') }}
              </v-btn>
              <v-btn variant="tonal" prepend-icon="mdi-text-box-outline" @click="goToLogs">
                {{ tr('agent.dialog.viewLogs', '查看日志') }}
              </v-btn>
              <v-spacer />
              <v-btn
                variant="text"
                color="error"
                prepend-icon="mdi-power"
                :loading="disconnecting[s.id]"
                @click="disconnect(s)"
              >
                {{ tr('agent.dialog.disconnect', '断开') }}
              </v-btn>
            </v-card-actions>
          </v-card>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.agent-dialog-card {
  background: rgb(var(--v-theme-surface));
}

.agent-session-item {
  border-color: rgba(var(--v-theme-on-surface), 0.12);
  background: rgba(var(--v-theme-surface-variant), 0.25);
  transition:
    border-color 0.3s ease,
    background-color 0.3s ease;
}

.agent-session-item--busy {
  border-color: rgba(var(--v-theme-primary), 0.5);
  background: rgba(var(--v-theme-primary), 0.05);
}

.agent-avatar-wrap {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(var(--v-theme-surface-variant));
  color: rgba(var(--v-theme-on-surface), 0.7);
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.15);
  flex-shrink: 0;
  transition: all 0.3s ease;
}

.agent-avatar-wrap.busy {
  background: rgba(var(--v-theme-primary), 0.18);
  color: rgb(var(--v-theme-primary));
  box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary));
  animation: pulse-ring 1.4s ease-in-out infinite;
}

@keyframes pulse-ring {
  50% {
    box-shadow: inset 0 0 0 2px rgba(var(--v-theme-primary), 0.35);
  }
}

.agent-activity-box {
  background: rgba(var(--v-theme-surface-variant), 0.35);
}

.status-indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.3);
  display: inline-block;
  transition: background-color 0.3s ease;
}

.status-indicator-dot--active {
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 8px rgb(var(--v-theme-primary));
}

.border-t {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
</style>
