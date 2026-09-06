<script setup lang="ts">
import { ref, inject, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'

defineProps<{
  visibleStatus: string[]
  lastTokens: { prompt: number; completion: number }
  lastContext: { prompt: number; completion: number }
  tracks: number | null
  memory: number
  volbal: { enabled: boolean; method: string }
  recordFreq: boolean
  listening: boolean
  backgrounds: number
}>()

const emit = defineEmits<{
  (e: 'toggleVolbal'): void
  (e: 'toggleRecordFreq'): void
  (e: 'toggleListening'): void
  (e: 'clearMemory'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const memoryConfirm = ref(false)

function formatTokens(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k'
  }
  return n.toLocaleString()
}

function onClearMemoryConfirm(): void {
  memoryConfirm.value = false
  emit('clearMemory')
}
</script>

<template>
  <div class="aidj-status-bar">
    <template v-for="key in visibleStatus" :key="key">
      <template v-if="key === 'tokens'">
        <v-chip
          variant="flat"
          size="small"
          class="status-chip is-on"
          :title="t('aidj.chat.title_tokens_total', '累计所有请求的 tokens 总和')"
        >
          <span class="status-label">Tokens</span
          ><span class="status-value">{{
            formatTokens(lastTokens.prompt + lastTokens.completion)
          }}</span>
        </v-chip>
      </template>

      <template v-else-if="key === 'context'">
        <v-chip
          variant="flat"
          size="small"
          class="status-chip is-on"
          :title="t('aidj.chat.title_context', '单次请求的上下文输入 tokens')"
        >
          <span class="status-label">Context</span
          ><span class="status-value">{{ formatTokens(lastContext.prompt) }}</span>
        </v-chip>
        <v-chip
          variant="flat"
          size="small"
          class="status-chip is-on"
          :title="t('aidj.chat.title_output_tokens', '单次请求的输出 tokens')"
        >
          <span class="status-label">Completion</span
          ><span class="status-value">{{ formatTokens(lastContext.completion) }}</span>
        </v-chip>
      </template>

      <v-chip v-else-if="key === 'tracks'" variant="flat" size="small" class="status-chip is-on">
        <span class="status-label">Tracks</span
        ><span class="status-value">{{ tracks === null ? '…' : tracks.toLocaleString() }}</span>
      </v-chip>

      <v-chip
        v-else-if="key === 'memory'"
        variant="flat"
        size="small"
        class="status-chip clickable is-on"
        :title="t('aidj.chat.title_clear_memory', '点击清空已播记忆')"
        @click="memoryConfirm = true"
      >
        <span class="status-label">Memory</span
        ><span class="status-value">{{ memory.toLocaleString() }}</span>
      </v-chip>

      <v-chip
        v-else-if="key === 'volbal'"
        variant="flat"
        size="small"
        class="status-chip clickable"
        :class="{ 'is-on': volbal.enabled }"
        :title="
          volbal.enabled
            ? t('aidj.chat.volbal_off', '点击关闭响度平衡')
            : t('aidj.chat.volbal_on', '点击开启响度平衡')
        "
        @click="emit('toggleVolbal')"
      >
        <span class="status-label">Volbal</span
        ><span class="status-value">{{ volbal.enabled ? volbal.method : 'off' }}</span>
      </v-chip>

      <v-chip
        v-else-if="key === 'record_freq'"
        variant="flat"
        size="small"
        class="status-chip clickable"
        :class="{ 'is-on': recordFreq }"
        :title="
          recordFreq
            ? t('aidj.chat.freq_off', '点击关闭频率记录')
            : t('aidj.chat.freq_on', '点击开启频率记录')
        "
        @click="emit('toggleRecordFreq')"
      >
        <span class="status-label">RecordFreq</span
        ><span class="status-value">{{ recordFreq ? 'on' : 'off' }}</span>
      </v-chip>

      <v-chip
        v-else-if="key === 'listening'"
        variant="flat"
        size="small"
        class="status-chip clickable"
        :class="{ 'is-on': listening }"
        :title="
          listening
            ? t('aidj.chat.listening_off', '点击关闭听歌时长统计')
            : t('aidj.chat.listening_on', '点击开启听歌时长统计')
        "
        @click="emit('toggleListening')"
      >
        <span class="status-label">Listen</span
        ><span class="status-value">{{ listening ? 'on' : 'off' }}</span>
      </v-chip>

      <v-chip
        v-else-if="key === 'backgrounds'"
        variant="flat"
        size="small"
        class="status-chip"
        :class="{ 'is-on': backgrounds > 0 }"
        :title="t('aidj.chat.title_bg_count', '运行中的后台任务数量')"
      >
        <span class="status-label">Backgrounds</span
        ><span class="status-value">{{ backgrounds }}</span>
      </v-chip>
    </template>

    <v-dialog v-model="memoryConfirm" width="420">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1">
          <v-icon start>mdi-delete-sweep</v-icon>
          {{ t('aidj.clear_memory_title', '清空已播记忆') }}
        </v-card-title>
        <v-card-text class="text-body-2">
          {{ t('aidj.clear_memory_text', '确定要清空已播放歌曲的记忆吗？AI 将不再回避这些歌曲。') }}
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="memoryConfirm = false">
            {{ t('aidj.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" @click="onClearMemoryConfirm">
            {{ t('aidj.clear', '清空') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.aidj-status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  padding: 6px 16px 10px;
  flex-shrink: 0;
}
.status-chip {
  padding-block: 4px;
  min-height: 24px;
}
.status-chip.clickable {
  cursor: pointer;
}
.status-chip.clickable:hover {
  filter: brightness(1.15);
}
.status-chip.is-on {
  background: rgba(var(--v-theme-success-container), 0.9);
  color: rgb(var(--v-theme-on-success-container));
}
.status-chip .status-label {
  opacity: 0.6;
  margin-right: 5px;
}
.status-chip .status-value {
  font-family: monospace;
  font-weight: 600;
}
</style>
