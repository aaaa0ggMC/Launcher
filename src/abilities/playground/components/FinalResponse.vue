<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { TransformResult } from '../parser/variableParser'
import { translate, translateTemplate } from '@ui/i18n'
import { downloadTextToLocal, downloadUrlToLocal } from '../../../main/ui/composables/download'
import { fence } from '../markdown'

const props = defineProps<{
  results: TransformResult[]
}>()

const emit = defineEmits<{
  retry: [label: string]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

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

/**
 * Incremental render — reveal results in chunks so 200+ items never block
 * typing. `limit` grows as a sentinel enters the viewport (IntersectionObserver),
 * the Vue analogue of React's memo + useDeferredValue for this list.
 */
const CHUNK = 40
const limit = ref(CHUNK)
const shown = computed(() => props.results.slice(0, limit.value))
let observer: IntersectionObserver | null = null
const sentinel = ref<HTMLElement | null>(null)
function revealMore(): void {
  limit.value = Math.min(props.results.length, limit.value + CHUNK)
}
watch(
  () => props.results.length,
  () => {
    limit.value = Math.min(props.results.length, limit.value)
  }
)
watch(sentinel, (el) => {
  observer?.disconnect()
  observer = null
  if (el && props.results.length > limit.value) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          revealMore()
          observer?.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
  }
})
onBeforeUnmount(() => observer?.disconnect())

const downloadText = (text: string): void => {
  void downloadTextToLocal(text, undefined, t('pg.saveLocal'))
}
const downloadMedia = (url: string, mime?: string): void => {
  void downloadUrlToLocal(url, { mime, title: t('pg.saveLocal') })
}

/** Truncate a long (possibly data:) URL to a readable inline hint. */
function shortenUrl(u: string): string {
  return u.length > 80 ? u.slice(0, 80) + '…' : u
}

/** Render one transform result as markdown, recursing into children. */
function resultToMd(r: TransformResult, level: number): string[] {
  const out: string[] = []
  out.push(`${'#'.repeat(Math.min(level + 2, 6))} ${r.label || t('pg.untitled')}`)
  if (r.children?.length) {
    for (const c of r.children) out.push('', ...resultToMd(c, level + 1))
    return out
  }
  if (r.kind === 'text' && r.value) {
    out.push('', fence(r.value))
  } else if (r.kind === 'img') {
    const urls = r.images ?? []
    if (urls.length) {
      out.push(translateTemplate(uiLang.value, 'pg.mdImages', { n: String(urls.length) }))
      for (const u of urls) {
        out.push(u.startsWith('data:') ? `- \`data:\` · ${shortenUrl(u)}` : `- ![${r.label}](${u})`)
      }
    }
  } else if (r.kind === 'audio') {
    out.push(translateTemplate(uiLang.value, 'pg.mdAudio', { n: '1' }))
    if (r.value && !r.value.startsWith('data:')) out.push(`- ${shortenUrl(r.value)}`)
  } else if (r.kind === 'video') {
    out.push(translateTemplate(uiLang.value, 'pg.mdVideo', { n: '1' }))
    if (r.value && !r.value.startsWith('data:')) out.push(`- ${shortenUrl(r.value)}`)
  }
  return out
}

/** Export the transformed final results as markdown. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdFinal')]
  if (props.results.length === 0) {
    lines.push(`- ${t('pg.mdEmpty')}`)
    return lines.join('\n')
  }
  for (const r of props.results) lines.push('', ...resultToMd(r, 0))
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div v-if="results.length" class="pg-final">
    <div class="d-flex align-center ga-2 pa-2 pg-final-heading" @click="collapsed = !collapsed">
      <v-icon>{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down' }}</v-icon>
      <span class="text-subtitle-2 font-weight-medium">{{ t('pg.finalResponse') }}</span>
    </div>

    <div v-if="!collapsed" class="pg-final-body pa-2 d-flex flex-column ga-1">
      <template v-for="(r, i) in shown" :key="i">
        <div class="pg-result-item">
          <div class="d-flex align-center ga-2 pg-result-header">
            <span class="text-body-2 font-weight-medium">{{ r.label }}</span>
            <v-spacer />
            <v-btn
              v-if="r.label === 'Raw Response' && !r.children?.length"
              size="small"
              variant="flat"
              icon
              :title="t('pg.downloadResponse')"
              @click="r.value && downloadText(r.value)"
            >
              <v-icon>mdi-download</v-icon>
            </v-btn>
            <v-btn
              v-if="r.children?.length"
              size="small"
              variant="flat"
              icon
              :title="t('pg.retryTask')"
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
              {{ textExpanded(`t${i}`) ? t('pg.collapse') : t('pg.expandAll') }}
            </v-btn>
          </div>
          <div
            v-if="!r.children?.length && r.kind === 'img' && r.images"
            class="d-flex flex-wrap gap-2 mt-1"
          >
            <div
              v-for="(url, j) in r.images"
              :key="j"
              class="d-flex flex-column align-center ga-1 pg-img-cell"
            >
              <img :src="url" :alt="`${r.label || 'Image'} ${j + 1}`" class="pg-result-img" />
              <v-btn
                variant="tonal"
                prepend-icon="mdi-download"
                class="text-none"
                @click="downloadMedia(url, 'image/jpeg')"
              >
                {{ t('pg.download') }}
              </v-btn>
            </div>
          </div>
          <div
            v-if="!r.children?.length && r.kind === 'audio' && r.audioSrc"
            class="mt-1 d-flex align-center ga-2 flex-wrap"
          >
            <audio controls :src="r.audioSrc" class="pg-media" />
            <v-btn
              variant="tonal"
              prepend-icon="mdi-download"
              class="text-none"
              @click="downloadMedia(r.value, r.audioType)"
            >
              {{ t('pg.download') }}
            </v-btn>
          </div>
          <div
            v-if="!r.children?.length && r.kind === 'video' && r.videoSrc"
            class="mt-1 d-flex align-center ga-2 flex-wrap"
          >
            <video controls :src="r.videoSrc" class="pg-media" />
            <v-btn
              variant="tonal"
              prepend-icon="mdi-download"
              class="text-none"
              @click="downloadMedia(r.value, r.videoType)"
            >
              {{ t('pg.download') }}
            </v-btn>
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
                    {{ textExpanded(`t${i}c${ci}`) ? t('pg.collapse') : t('pg.expandAll') }}
                  </v-btn>
                </div>
                <div v-if="c.kind === 'img' && c.images" class="d-flex flex-wrap gap-2 mt-1">
                  <div
                    v-for="(url, j) in c.images"
                    :key="j"
                    class="d-flex flex-column align-center ga-1 pg-img-cell"
                  >
                    <img :src="url" :alt="`${c.label || 'Image'} ${j + 1}`" class="pg-result-img" />
                    <v-btn
                      variant="tonal"
                      prepend-icon="mdi-download"
                      class="text-none"
                      @click="downloadMedia(url, 'image/jpeg')"
                    >
                      {{ t('pg.download') }}
                    </v-btn>
                  </div>
                </div>
                <div
                  v-if="c.kind === 'audio' && c.audioSrc"
                  class="mt-1 d-flex align-center ga-2 flex-wrap"
                >
                  <audio controls :src="c.audioSrc" class="pg-media" />
                  <v-btn
                    variant="tonal"
                    prepend-icon="mdi-download"
                    class="text-none"
                    @click="downloadMedia(c.value, c.audioType)"
                  >
                    {{ t('pg.download') }}
                  </v-btn>
                </div>
                <div
                  v-if="c.kind === 'video' && c.videoSrc"
                  class="mt-1 d-flex align-center ga-2 flex-wrap"
                >
                  <video controls :src="c.videoSrc" class="pg-media" />
                  <v-btn
                    variant="tonal"
                    prepend-icon="mdi-download"
                    class="text-none"
                    @click="downloadMedia(c.value, c.videoType)"
                  >
                    {{ t('pg.download') }}
                  </v-btn>
                </div>
              </div>
            </template>
          </div>
        </div>
      </template>
      <!-- reveal more when scrolled near the end -->
      <div
        v-if="shown.length < results.length"
        ref="sentinel"
        class="text-caption on-surface-variant pa-2 text-center"
      >
        {{ t('pg.loadingMore') }}
      </div>
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
  width: 100%;
  max-width: 640px;
  height: auto;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
}
/* image cell takes a full row so media fills the response width */
.pg-img-cell {
  width: 100%;
  flex: 1 1 100%;
}
/* audio/video fill the response width too (height grows naturally) */
.pg-media {
  width: 100%;
  border-radius: 6px;
}
</style>
