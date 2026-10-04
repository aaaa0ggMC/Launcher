<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import MarkdownIt from 'markdown-it'
import type { MessageNode } from '../types'

const props = defineProps<{
  message: MessageNode
  sessionId: string
}>()

const emit = defineEmits<{
  (e: 'switchBranch', targetMessageId: string): void
  (e: 'approveTool', approved: boolean): void
  (e: 'resumeWorkflow'): void
}>()

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true
})

const renderedHtml = computed(() => {
  return md.render(props.message.content || '')
})

const showThinking = ref(false)
const expandedTools = ref<Record<string, boolean>>({})

function toggleTool(id: string): void {
  expandedTools.value[id] = !expandedTools.value[id]
}

// 分支导航状态
const siblings = ref<string[]>([])
const currentIndex = ref(0)

async function loadSiblings(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yaya.message-siblings', {
      id: props.message.id
    })) as { siblings: string[]; index: number }
    if (res && res.siblings) {
      siblings.value = res.siblings
      currentIndex.value = res.index
    }
  } catch {
    // 忽略获取失败
  }
}

function prevBranch(): void {
  if (currentIndex.value > 0) {
    const targetId = siblings.value[currentIndex.value - 1]
    emit('switchBranch', targetId)
  }
}

function nextBranch(): void {
  if (currentIndex.value < siblings.value.length - 1) {
    const targetId = siblings.value[currentIndex.value + 1]
    emit('switchBranch', targetId)
  }
}

onMounted(() => {
  loadSiblings()
})
</script>

<template>
  <div
    class="chat-message-row d-flex flex-column py-2"
    :class="message.role === 'user' ? 'align-end' : 'align-start'"
  >
    <!-- 头部信息行：角色 + 分支导航 -->
    <div
      class="d-flex align-center ga-2 px-1 mb-1 text-caption text-medium-emphasis"
      :class="message.role === 'user' ? 'flex-row-reverse' : 'flex-row'"
    >
      <div class="d-flex align-center ga-1">
        <v-icon :icon="message.role === 'user' ? 'mdi-account-circle' : 'mdi-robot'" size="14" />
        <span class="font-weight-medium">
          {{ message.role === 'user' ? '你' : 'YAYA' }}
        </span>
      </div>

      <!-- 树状分支切换器 < 1/3 > -->
      <div v-if="siblings.length > 1" class="d-flex align-center ga-1 mx-2 branch-switcher">
        <v-btn
          icon="mdi-chevron-left"
          size="small"
          variant="text"
          density="comfortable"
          :disabled="currentIndex <= 0"
          title="上一条分支"
          aria-label="上一条分支"
          @click="prevBranch"
        />
        <span class="branch-indicator">{{ currentIndex + 1 }}/{{ siblings.length }}</span>
        <v-btn
          icon="mdi-chevron-right"
          size="small"
          variant="text"
          density="comfortable"
          :disabled="currentIndex >= siblings.length - 1"
          title="下一条分支"
          aria-label="下一条分支"
          @click="nextBranch"
        />
      </div>

      <span v-if="message.status === 'streaming'" class="d-flex align-center ga-1 text-primary">
        <v-progress-circular indeterminate size="12" width="2" />
        <span>生成中...</span>
      </span>
    </div>

    <!-- 用户气泡 (仿 AIDJ 经典设计) -->
    <div v-if="message.role === 'user'" class="msg-bubble msg-bubble-user pa-3">
      <div class="text-body-1 text-pre-wrap">{{ message.content }}</div>

      <!-- 附件展示 -->
      <div
        v-if="message.attachments?.length"
        class="d-flex flex-wrap ga-2 mt-2 pt-2 border-t-subtle"
      >
        <v-chip
          v-for="att in message.attachments"
          :key="att.id"
          size="small"
          prepend-icon="mdi-paperclip"
          variant="tonal"
          class="attachment-chip"
        >
          {{ att.name }}
        </v-chip>
      </div>
    </div>

    <!-- Assistant 气泡 (磨砂玻璃与自然布局) -->
    <div v-else-if="message.role === 'assistant'" class="msg-bubble msg-bubble-ai pa-4 w-100">
      <!-- 思考过程折叠区 (Reasoning / Thinking) -->
      <div v-if="message.reasoningContent" class="mb-3">
        <button
          type="button"
          class="thinking-toggle-btn d-flex align-center ga-1 text-caption text-medium-emphasis"
          @click="showThinking = !showThinking"
        >
          <v-icon icon="mdi-brain" size="14" color="primary" />
          <span>{{ showThinking ? '收起思考过程' : '查看思考过程' }}</span>
          <v-icon :icon="showThinking ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="14" />
        </button>

        <v-expand-transition>
          <div v-show="showThinking" class="thinking-box mt-2 pa-3 rounded">
            <div class="text-body-2 text-medium-emphasis text-pre-wrap font-monospace">
              {{ message.reasoningContent }}
            </div>
          </div>
        </v-expand-transition>
      </div>

      <!-- 工具调用展示区 (Tool Calls) -->
      <div v-if="message.toolCalls?.length" class="d-flex flex-column ga-2 mb-3">
        <div
          v-for="tc in message.toolCalls"
          :key="tc.id"
          class="tool-call-card rounded border pa-2"
        >
          <div class="d-flex align-center ga-2 cursor-pointer" @click="toggleTool(tc.id)">
            <v-icon
              v-if="tc.status === 'executing'"
              icon="mdi-loading"
              class="mdi-spin text-primary"
              size="small"
            />
            <v-icon
              v-else-if="tc.status === 'success'"
              icon="mdi-check-circle-outline"
              color="success"
              size="small"
            />
            <v-icon
              v-else-if="tc.status === 'failed'"
              icon="mdi-alert-circle-outline"
              color="error"
              size="small"
            />
            <v-icon v-else icon="mdi-tools" size="small" />

            <span class="text-caption font-weight-bold">{{ tc.name }}</span>
            <span v-if="tc.ms" class="text-caption text-disabled">({{ tc.ms }}ms)</span>

            <v-spacer />
            <v-btn
              icon="mdi-chevron-down"
              size="small"
              variant="text"
              density="comfortable"
              :class="{ 'rotate-180': expandedTools[tc.id] }"
            />
          </div>

          <!-- 工具展开参数与返回值 -->
          <v-expand-transition>
            <div
              v-show="expandedTools[tc.id]"
              class="tool-details mt-2 pa-2 rounded bg-surface-variant"
            >
              <div class="text-caption font-weight-bold text-disabled mb-1">入参 (Arguments):</div>
              <pre class="text-caption font-monospace overflow-x-auto">{{
                JSON.stringify(tc.args, null, 2)
              }}</pre>

              <div v-if="tc.result" class="text-caption font-weight-bold text-disabled mt-2 mb-1">
                返回结果 (Result):
              </div>
              <pre v-if="tc.result" class="text-caption font-monospace overflow-x-auto">{{
                JSON.stringify(tc.result, null, 2)
              }}</pre>

              <div v-if="tc.error" class="text-caption text-error font-monospace mt-2">
                错误: {{ tc.error }}
              </div>
            </div>
          </v-expand-transition>
        </div>
      </div>

      <!-- 等待首个 Token 生成中的微光占位效果 -->
      <div
        v-if="
          message.status === 'streaming' &&
          !message.content &&
          !message.reasoningContent &&
          !message.toolCalls?.length
        "
        class="d-flex align-center ga-2 py-2 text-medium-emphasis"
      >
        <v-progress-circular indeterminate size="16" width="2" color="primary" />
        <span class="text-body-2">YAYA 正在思考并建立连接...</span>
      </div>

      <!-- 正文内容 Markdown 渲染 -->
      <div v-if="message.content" class="markdown-body text-body-1" v-html="renderedHtml" />

      <!-- 等待人类审批状态条 (Human-in-the-loop: 符合 DESIGN.md 规范) -->
      <div
        v-if="message.status === 'waiting_approval'"
        class="approval-banner rounded-lg pa-3 mt-3 d-flex flex-column ga-2"
      >
        <div class="d-flex align-center ga-2 text-warning font-weight-medium">
          <v-icon icon="mdi-shield-alert-outline" size="18" color="warning" />
          <span class="text-body-2 font-weight-bold">等待执行授权</span>
        </div>
        <div class="text-caption text-medium-emphasis pl-6">
          智能体请求执行具有副作用的本地系统操作，请核对参数后确认是否允许。
        </div>
        <div class="d-flex align-center ga-2 pl-6 pt-1">
          <v-btn
            color="primary"
            variant="elevated"
            density="default"
            prepend-icon="mdi-check"
            @click="emit('approveTool', true)"
          >
            允许执行
          </v-btn>
          <v-btn
            variant="outlined"
            density="default"
            prepend-icon="mdi-close"
            @click="emit('approveTool', false)"
          >
            拒绝
          </v-btn>
        </div>
      </div>

      <!-- 异常中断状态条 (Interrupted Recovery) -->
      <div
        v-if="message.status === 'interrupted'"
        class="interrupted-banner rounded-lg pa-3 mt-3 d-flex flex-column ga-2"
      >
        <div class="d-flex align-center ga-2 text-info font-weight-medium">
          <v-icon icon="mdi-pause-circle-outline" size="18" color="info" />
          <span class="text-body-2 font-weight-bold">工作流已中断</span>
        </div>
        <div class="text-caption text-medium-emphasis pl-6">
          {{ message.error || '因主进程重启或网络中断，当前任务已暂停。' }}
        </div>
        <div class="d-flex align-center ga-2 pl-6 pt-1">
          <v-btn
            color="primary"
            variant="tonal"
            density="default"
            prepend-icon="mdi-play"
            @click="emit('resumeWorkflow')"
          >
            恢复执行
          </v-btn>
        </div>
      </div>

      <!-- 错误状态优雅提示条 (符合 DESIGN.md: 沉浸式轻量卡片 + 呼吸留白 + 默认密度重试按钮) -->
      <div
        v-if="
          message.status === 'error' ||
          (message.status !== 'streaming' &&
            message.status !== 'pending' &&
            !message.content &&
            !message.reasoningContent &&
            !message.toolCalls?.length)
        "
        class="error-banner rounded-lg pa-3 mt-3 d-flex flex-column ga-2"
      >
        <div class="d-flex align-center ga-2 text-error font-weight-medium">
          <v-icon icon="mdi-alert-circle-outline" size="18" color="error" />
          <span class="text-body-2 font-weight-bold">生成未完成</span>
        </div>
        <div class="text-caption text-medium-emphasis pl-6">
          {{
            message.error ||
            '模型连接或生成过程中断，请检查服务商端点配置、网络连通性或当前选中的模型。'
          }}
        </div>
        <div class="d-flex align-center ga-2 pl-6 pt-1">
          <v-btn
            color="error"
            variant="tonal"
            density="default"
            prepend-icon="mdi-refresh"
            @click="emit('resumeWorkflow')"
          >
            重新生成
          </v-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-message-row {
  width: 100%;
}

.msg-bubble {
  position: relative;
  border-radius: 14px;
  word-break: break-word;
}

.msg-bubble-user {
  max-width: 82%;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border-bottom-right-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.msg-bubble-ai {
  background: rgba(var(--v-theme-surface), 0.72);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.24);
  border-bottom-left-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.thinking-toggle-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.thinking-toggle-btn:hover {
  background: rgba(var(--v-theme-primary), 0.08);
}

.thinking-box {
  background: rgba(var(--v-theme-surface-variant), 0.25);
  border-left: 3px solid rgb(var(--v-theme-primary));
}

.tool-call-card {
  background: rgba(var(--v-theme-surface-variant), 0.2);
  border-color: rgba(var(--v-theme-surface-bright), 0.18) !important;
}

.attachment-chip {
  padding-block: 2px;
  min-height: 22px;
}

.border-t-subtle {
  border-top: 1px solid rgba(255, 255, 255, 0.15);
}

.rotate-180 {
  transform: rotate(180deg);
}

.markdown-body :deep(p) {
  margin-bottom: 0.6em;
  line-height: 1.6;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  background: rgba(0, 0, 0, 0.25);
  padding: 10px 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin-block: 8px;
}

.markdown-body :deep(code) {
  font-family: monospace;
}

.error-banner {
  background: rgba(var(--v-theme-error), 0.08);
  border: 1px solid rgba(var(--v-theme-error), 0.22);
}

.approval-banner {
  background: rgba(var(--v-theme-warning), 0.08);
  border: 1px solid rgba(var(--v-theme-warning), 0.22);
}

.interrupted-banner {
  background: rgba(var(--v-theme-info), 0.08);
  border: 1px solid rgba(var(--v-theme-info), 0.22);
}

@media (max-width: 720px) {
  .msg-bubble-user {
    max-width: 90%;
  }
}
</style>
