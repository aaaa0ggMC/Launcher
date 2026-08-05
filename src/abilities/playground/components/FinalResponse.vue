<script setup lang="ts">
import { ref } from 'vue'
import type { TransformResult } from '../parser/variableParser'
import { downloadTextToLocal, downloadUrlToLocal } from '../../../main/ui/composables/download'

defineProps<{
  results: TransformResult[]
}>()

const emit = defineEmits<{
  retry: [label: string]
}>()

const collapsed = ref(false)

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
  <div v-if="results.length" class="pg-final">
    <div class="d-flex align-center ga-2 pa-2 pg-final-heading" @click="collapsed = !collapsed">
      <v-icon>{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down' }}</v-icon>
      <span class="text-subtitle-2 font-weight-medium">最终响应</span>
    </div>

    <div v-if="!collapsed" class="pg-final-body pa-2 d-flex flex-column ga-1">
      <template v-for="(r, i) in results" :key="i">
        <div class="pg-result-item">
          <div class="d-flex align-center ga-2 pg-result-header">
            <span class="text-body-2 font-weight-medium">{{ r.label }}</span>
            <v-spacer />
            <v-btn
              v-if="r.label === 'Raw Response' && !r.children?.length"
              size="small"
              variant="flat"
              icon
              :title="'下载响应'"
              @click="r.value && downloadText(r.value)"
            >
              <v-icon>mdi-download</v-icon>
            </v-btn>
            <v-btn
              v-if="r.children?.length"
              size="small"
              variant="flat"
              icon
              :title="'重试任务'"
              @click="emit('retry', r.label)"
            >
              <v-icon>mdi-refresh</v-icon>
            </v-btn>
          </div>

          <div v-if="!r.children?.length && r.kind === 'text'" class="pg-result-text-wrap">
            <div
              class="pg-result-text"
              :class="{
                'pg-result-text--collapsed':
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
              <img :src="url" :alt="`${r.label || 'Image'} ${j + 1}`" class="pg-result-img" />
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
            <template v-for="(c, ci) in r.children" :key="ci">
              <div class="pg-result-item" :class="{ 'pg-result-item--error': c.label === 'Error' }">
                <div class="text-caption font-weight-medium">{{ c.label }}</div>
                <div v-if="c.kind === 'text'" class="pg-result-text-wrap">
                  <div
                    class="pg-result-text"
                    :class="{
                      'pg-result-text--collapsed':
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
                    <img :src="url" :alt="`${c.label || 'Image'} ${j + 1}`" class="pg-result-img" />
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
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pg-final-heading {
  cursor: pointer;
  user-select: none;
}
.pg-final-heading:hover {
  background: rgba(var(--v-theme-surface-bright), 0.08);
  border-radius: 8px;
}
.pg-result-item {
  border-left: 2px solid rgba(var(--v-theme-primary), 0.3);
  padding-left: 8px;
  padding-block: 2px;
}
.pg-result-item--error {
  border-left-color: rgb(var(--v-theme-error));
}
.pg-result-item--error .pg-result-text {
  color: rgb(var(--v-theme-error));
}
.pg-result-text {
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: rgba(var(--v-theme-on-surface), 0.9);
}
/* long text collapses to a few lines with a fade + expand toggle */
.pg-result-text--collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  position: relative;
}
.pg-result-text--collapsed::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.5em;
  background: linear-gradient(to bottom, transparent, rgba(var(--v-theme-surface), 0.9));
  pointer-events: none;
}
.pg-result-img {
  max-width: 200px;
  max-height: 150px;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
}
</style>
