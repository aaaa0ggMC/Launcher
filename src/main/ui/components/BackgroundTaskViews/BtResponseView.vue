<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BtOutputMessage, BtTaskInfo } from '@shared/types'
import type { TransformResult } from '@abilities/playground/parser/variableParser'
import { downloadTextToLocal, downloadUrlToLocal } from '@ui/composables/download'

/**
 * Structured response view for background tasks — renders transform results
 * (text / images / audio / video / nested children) that the task pushed as
 * structured messages. While the task is still running with no results yet,
 * shows a native three-dot loading indicator.
 * Registered as the `response` bt-view; also reused by the playground page
 * directly.
 */
const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
  /** playground direct use: pass results straight through */
  results?: TransformResult[]
}>()

const emit = defineEmits<{ retry: [label: string] }>()

/** Collect TransformResult[] from either `results` or structured messages. */
const results = computed<TransformResult[]>(() => {
  if (props.results) return props.results
  const out: TransformResult[] = []
  for (const m of props.messages ?? []) {
    if (m.data === undefined) continue
    // The task pushes data as TransformResult[] — flatten arrays; tolerate
    // single items too (older callers / individual pushes).
    if (Array.isArray(m.data)) out.push(...(m.data as TransformResult[]))
    else out.push(m.data as TransformResult)
  }
  return out
})

const running = computed(() => props.task?.status === 'running')
const progress = computed(() => props.task?.progress)

/** Long text blocks collapse until expanded; keyed by result path. */
const expanded = ref<Record<string, boolean>>({})
function textExpanded(key: string): boolean {
  return expanded.value[key] ?? false
}
function toggleText(key: string): void {
  expanded.value = { ...expanded.value, [key]: !textExpanded(key) }
}

const TEXT_COLLAPSE_LEN = 400

const downloadText = (text: string): void => {
  void downloadTextToLocal(text)
}
const downloadMedia = (url: string): void => {
  void downloadUrlToLocal(url)
}
</script>

<template>
  <!-- Running & nothing yet → native three-dot loading indicator -->
  <div v-if="running && results.length === 0" class="btv-progress">
    <div class="btv-dots">
      <span class="btv-dot" />
      <span class="btv-dot" />
      <span class="btv-dot" />
    </div>
    <v-progress-linear
      v-if="progress !== undefined"
      :model-value="progress"
      color="primary"
      height="6"
      rounded
      class="btv-progress__bar"
    />
    <span class="text-caption on-surface-variant">任务轮询中…</span>
  </div>

  <div v-else-if="results.length" class="btv-response" style="height: 100%">
    <div class="btv-response__scroll">
      <div v-for="(r, i) in results" :key="i" class="btv-result">
        <div class="d-flex align-center ga-2 btv-result__head">
          <span class="text-body-2 font-weight-medium">{{ r.label }}</span>
          <v-spacer />
          <v-btn
            v-if="r.label === 'Raw Response' && !r.children?.length"
            size="small"
            variant="flat"
            icon
            title="下载响应"
            @click="r.value && downloadText(r.value)"
          >
            <v-icon size="small">mdi-download</v-icon>
          </v-btn>
          <v-btn
            v-if="r.children?.length"
            size="small"
            variant="flat"
            icon
            title="重试任务"
            @click="emit('retry', r.label)"
          >
            <v-icon size="small">mdi-refresh</v-icon>
          </v-btn>
        </div>

        <div v-if="!r.children?.length && r.kind === 'text'" class="btv-result__text-wrap">
          <div
            class="btv-result__text"
            :class="{
              'btv-result__text--collapsed':
                r.value.length > TEXT_COLLAPSE_LEN && !textExpanded(`t${i}`)
            }"
          >
            {{ r.value }}
          </div>
          <v-btn
            v-if="r.value.length > TEXT_COLLAPSE_LEN"
            variant="text"
            class="mt-1"
            @click="toggleText(`t${i}`)"
          >
            {{ textExpanded(`t${i}`) ? '收起' : '展开全部' }}
          </v-btn>
        </div>
        <div
          v-if="!r.children?.length && r.kind === 'img' && r.images"
          class="d-flex flex-wrap gap-2 mt-1"
        >
          <div v-for="(url, j) in r.images" :key="j" class="d-flex flex-column align-center ga-1">
            <img :src="url" :alt="`${r.label || 'Image'} ${j + 1}`" class="btv-result__img" />
            <v-btn
              variant="tonal"
              prepend-icon="mdi-download"
              class="text-none"
              @click="downloadMedia(url)"
            >
              下载
            </v-btn>
          </div>
        </div>
        <div v-if="!r.children?.length && r.kind === 'audio' && r.audioSrc" class="mt-1">
          <audio controls :src="r.audioSrc" style="max-width: 100%" />
        </div>
        <div v-if="!r.children?.length && r.kind === 'video' && r.videoSrc" class="mt-1">
          <video controls :src="r.videoSrc" style="max-width: 100%; border-radius: 6px" />
        </div>

        <div v-if="r.children?.length" class="pl-3 mt-1 d-flex flex-column ga-1">
          <div
            v-for="(c, ci) in r.children"
            :key="ci"
            class="btv-result"
            :class="{ 'btv-result--error': c.label === 'Error' }"
          >
            <div class="text-caption font-weight-medium">{{ c.label }}</div>
            <div v-if="c.kind === 'text'" class="btv-result__text-wrap">
              <div
                class="btv-result__text"
                :class="{
                  'btv-result__text--collapsed':
                    c.value.length > TEXT_COLLAPSE_LEN && !textExpanded(`t${i}c${ci}`)
                }"
              >
                {{ c.value }}
              </div>
              <v-btn
                v-if="c.value.length > TEXT_COLLAPSE_LEN"
                variant="text"
                class="mt-1"
                @click="toggleText(`t${i}c${ci}`)"
              >
                {{ textExpanded(`t${i}c${ci}`) ? '收起' : '展开全部' }}
              </v-btn>
            </div>
            <div v-if="c.kind === 'img' && c.images" class="d-flex flex-wrap gap-2 mt-1">
              <div
                v-for="(url, j) in c.images"
                :key="j"
                class="d-flex flex-column align-center ga-1"
              >
                <img :src="url" :alt="`${c.label || 'Image'} ${j + 1}`" class="btv-result__img" />
                <v-btn
                  variant="tonal"
                  prepend-icon="mdi-download"
                  class="text-none"
                  @click="downloadMedia(url)"
                >
                  下载
                </v-btn>
              </div>
            </div>
            <audio
              v-if="c.kind === 'audio' && c.audioSrc"
              controls
              :src="c.audioSrc"
              style="max-width: 100%"
            />
            <video
              v-if="c.kind === 'video' && c.videoSrc"
              controls
              :src="c.videoSrc"
              style="max-width: 100%"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="on-surface-variant text-caption pa-3">等待响应…</div>
</template>

<style scoped>
.btv-progress {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
}
.btv-progress__icon {
  width: 44px;
  height: 44px;
  color: rgb(var(--v-theme-primary));
}
.btv-progress__bar {
  width: 220px;
}
/* native three-dot loading indicator: dots light up left→right, looping */
.btv-dots {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btv-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.18);
  animation: btv-dot 1.2s ease-in-out infinite;
}
.btv-dot:nth-child(2) {
  animation-delay: 0.2s;
}
.btv-dot:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes btv-dot {
  0%,
  60%,
  100% {
    background: rgba(var(--v-theme-on-surface), 0.18);
    transform: translateY(0);
  }
  30% {
    background: rgb(var(--v-theme-primary));
    transform: translateY(-3px);
  }
}
.btv-response {
  display: flex;
  flex-direction: column;
}
.btv-response__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 16px;
}
.btv-result {
  border-left: 2px solid rgba(var(--v-theme-primary), 0.3);
  padding-left: 8px;
  padding-block: 2px;
}
.btv-result__head {
  margin-bottom: 2px;
}
.btv-result__text {
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: rgba(var(--v-theme-on-surface), 0.9);
}
/* long text collapses to a few lines with a fade + expand toggle */
.btv-result__text--collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  position: relative;
}
.btv-result__text--collapsed::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.5em;
  background: linear-gradient(to bottom, transparent, rgba(var(--v-theme-surface), 0.9));
  pointer-events: none;
}
/* error children (label 'Error') get a red accent so failures stand out */
.btv-result--error {
  border-left-color: rgb(var(--v-theme-error));
}
.btv-result--error .btv-result__text {
  color: rgb(var(--v-theme-error));
}
.btv-result__img {
  max-width: 200px;
  max-height: 150px;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
}
</style>
