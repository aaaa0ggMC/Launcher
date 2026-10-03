<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import UsageBreakdownView from './UsageBreakdown.vue'
import type { UsageBreakdown } from '../loop/usage'

const props = defineProps<{
  visibleStatus: string[]
  lastTokens: {
    prompt: number
    completion: number
    cached?: number
    byAgent?: UsageBreakdown['byAgent']
  }
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

/**
 * 紧凑模式（按本组件自身宽度，而不是窗口断点——页面可能被缩放或嵌在别处，见 AGENTS §11.8）：
 * 宽度不够时 12 个小标签会占好几行，改成「一行显示前 N 项 + 其余收进弹层」。弹层里每项都有
 * 说明文字，开关类直接变成开关，Tokens 明细（宽屏下是悬停提示，触屏看不到）也直接展开。
 */
const COMPACT_BELOW = 520
const COMPACT_SHOWN = 3
const rootEl = ref<HTMLElement | null>(null)
const compact = ref(false)
const sheetOpen = ref(false)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!rootEl.value) return
  compact.value = rootEl.value.clientWidth < COMPACT_BELOW
  ro = new ResizeObserver(() => {
    compact.value = (rootEl.value?.clientWidth ?? COMPACT_BELOW) < COMPACT_BELOW
  })
  ro.observe(rootEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

interface Entry {
  key: string
  label: string
  value: string
  on: boolean
  desc: string
  /** info：只读；toggle：开关；action：按钮（清空记忆） */
  kind: 'info' | 'toggle' | 'action'
}

/** 按用户配置的顺序展开成条目（context 一项对应 Context + Completion 两个标签） */
const entries = computed<Entry[]>(() => {
  const out: Entry[] = []
  for (const key of props.visibleStatus) {
    switch (key) {
      case 'tokens':
        out.push({
          key,
          label: 'Tokens',
          value: formatTokens(props.lastTokens.prompt + props.lastTokens.completion),
          on: true,
          desc: t('aidj.chat.title_tokens_total', '累计所有请求的 tokens 总和'),
          kind: 'info'
        })
        break
      case 'context':
        out.push(
          {
            key: 'context',
            label: 'Context',
            value: formatTokens(props.lastContext.prompt),
            on: true,
            desc: t('aidj.chat.title_context', '单次请求的上下文输入 tokens'),
            kind: 'info'
          },
          {
            key: 'completion',
            label: 'Completion',
            value: formatTokens(props.lastContext.completion),
            on: true,
            desc: t('aidj.chat.title_output_tokens', '单次请求的输出 tokens'),
            kind: 'info'
          }
        )
        break
      case 'tracks':
        out.push({
          key,
          label: 'Tracks',
          value: props.tracks === null ? '…' : props.tracks.toLocaleString(),
          on: true,
          desc: t('aidj.status.desc_tracks', '曲库里的歌曲总数'),
          kind: 'info'
        })
        break
      case 'memory':
        out.push({
          key,
          label: 'Memory',
          value: props.memory.toLocaleString(),
          on: true,
          desc: t('aidj.status.desc_memory', '已播放歌曲的记忆条数；AI 会据此避开重复'),
          kind: 'action'
        })
        break
      case 'volbal':
        out.push({
          key,
          label: 'Volbal',
          value: props.volbal.enabled ? props.volbal.method : 'off',
          on: props.volbal.enabled,
          desc: t('aidj.status.desc_volbal', '响度平衡：按曲目响度动态调整音量'),
          kind: 'toggle'
        })
        break
      case 'record_freq':
        out.push({
          key,
          label: 'RecordFreq',
          value: props.recordFreq ? 'on' : 'off',
          on: props.recordFreq,
          desc: t('aidj.status.desc_freq', '记录每首歌的播放次数'),
          kind: 'toggle'
        })
        break
      case 'listening':
        out.push({
          key,
          label: 'Listen',
          value: props.listening ? 'on' : 'off',
          on: props.listening,
          desc: t('aidj.status.desc_listen', '统计听歌时长'),
          kind: 'toggle'
        })
        break
      case 'backgrounds':
        out.push({
          key,
          label: 'Backgrounds',
          value: String(props.backgrounds),
          on: props.backgrounds > 0,
          desc: t('aidj.chat.title_bg_count', '运行中的后台任务数量'),
          kind: 'info'
        })
        break
    }
  }
  return out
})
const shownEntries = computed(() => entries.value.slice(0, COMPACT_SHOWN))
const hiddenCount = computed(() => Math.max(0, entries.value.length - COMPACT_SHOWN))

function toggleEntry(e: Entry): void {
  if (e.key === 'volbal') emit('toggleVolbal')
  else if (e.key === 'record_freq') emit('toggleRecordFreq')
  else if (e.key === 'listening') emit('toggleListening')
}

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
  <div ref="rootEl" class="aidj-status-bar" :class="{ compact }">
    <!-- 紧凑：一行前 N 项 + 「+N」，整条可点，点开底部弹层看全部 -->
    <button
      v-if="compact"
      type="button"
      class="compact-strip"
      :aria-label="t('aidj.status.open', '查看全部状态')"
      :title="t('aidj.status.open', '查看全部状态')"
      @click="sheetOpen = true"
    >
      <v-chip
        v-for="e in shownEntries"
        :key="e.key"
        variant="flat"
        size="small"
        class="status-chip"
        :class="{ 'is-on': e.on }"
      >
        <span class="status-label">{{ e.label }}</span
        ><span class="status-value">{{ e.value }}</span>
      </v-chip>
      <v-chip variant="tonal" size="small" class="status-chip more-chip">
        <v-icon size="16" start>mdi-chevron-up</v-icon>
        {{ hiddenCount > 0 ? `+${hiddenCount}` : t('aidj.status.title', '状态') }}
      </v-chip>
    </button>

    <template v-else>
      <template v-for="key in visibleStatus" :key="key">
        <template v-if="key === 'tokens'">
          <v-tooltip location="top" :open-delay="150">
            <template #activator="{ props: tip }">
              <v-chip
                v-bind="tip"
                variant="flat"
                size="small"
                class="status-chip is-on"
                :aria-label="t('aidj.chat.title_tokens_total', '累计所有请求的 tokens 总和')"
              >
                <span class="status-label">Tokens</span
                ><span class="status-value">{{
                  formatTokens(lastTokens.prompt + lastTokens.completion)
                }}</span>
              </v-chip>
            </template>
            <UsageBreakdownView
              :usage="{
                prompt: lastTokens.prompt,
                completion: lastTokens.completion,
                cached: lastTokens.cached ?? 0,
                byAgent: lastTokens.byAgent ?? {}
              }"
            />
          </v-tooltip>
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
    </template>

    <!-- 全部状态弹层（紧凑模式）：比标签自由——有说明、开关、完整的 Tokens 明细 -->
    <v-bottom-sheet v-model="sheetOpen" inset max-width="560">
      <v-card rounded="t-xl" class="status-sheet">
        <v-card-title class="px-5 pt-5 pb-2 d-flex align-center">
          <span class="text-subtitle-1 font-weight-bold">{{ t('aidj.status.title', '状态') }}</span>
          <v-spacer />
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            :aria-label="t('aidj.cancel', '取消')"
            @click="sheetOpen = false"
          />
        </v-card-title>
        <v-card-text class="px-2 pb-5 pt-0 sheet-body">
          <div v-for="e in entries" :key="e.key" class="sheet-row">
            <div class="sheet-main">
              <div class="d-flex align-center ga-2">
                <span class="sheet-label">{{ e.label }}</span>
                <v-chip
                  v-if="e.kind !== 'toggle'"
                  variant="flat"
                  size="small"
                  class="status-chip"
                  :class="{ 'is-on': e.on }"
                  ><span class="status-value">{{ e.value }}</span></v-chip
                >
              </div>
              <div class="sheet-desc">{{ e.desc }}</div>
              <div v-if="e.key === 'tokens'" class="mt-2">
                <UsageBreakdownView
                  :usage="{
                    prompt: lastTokens.prompt,
                    completion: lastTokens.completion,
                    cached: lastTokens.cached ?? 0,
                    byAgent: lastTokens.byAgent ?? {}
                  }"
                />
              </div>
            </div>
            <div v-if="e.kind === 'toggle'" class="sheet-side">
              <v-switch
                :model-value="e.on"
                color="primary"
                density="compact"
                hide-details
                inset
                :aria-label="e.label"
                @update:model-value="toggleEntry(e)"
              />
              <span class="text-caption sheet-switch-val">{{ e.value }}</span>
            </div>
            <div v-else-if="e.kind === 'action'" class="sheet-side">
              <v-btn variant="tonal" color="error" @click="memoryConfirm = true">
                {{ t('aidj.clear', '清空') }}
              </v-btn>
            </div>
          </div>
        </v-card-text>
      </v-card>
    </v-bottom-sheet>

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
.aidj-status-bar.compact {
  padding: 6px 12px 8px;
}
.compact-strip {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  width: 100%;
  min-height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-x: auto;
  /* 单行放不下时可横向滑动；点按任意位置都打开弹层 */
}
.compact-strip > * {
  flex-shrink: 0;
}
.more-chip {
  margin-left: auto;
}
.sheet-body {
  max-height: 70vh;
  max-height: calc(var(--app-vh, 100vh) * 0.7);
  overflow-y: auto;
}
.sheet-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
}
.sheet-row + .sheet-row {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.sheet-main {
  flex: 1 1 auto;
  min-width: 0;
}
.sheet-label {
  font-weight: 600;
}
.sheet-desc {
  margin-top: 2px;
  font-size: 0.8125rem;
  white-space: normal;
  opacity: 0.7;
}
.sheet-side {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sheet-switch-val {
  font-family: monospace;
  opacity: 0.7;
  min-width: 2.5em;
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
