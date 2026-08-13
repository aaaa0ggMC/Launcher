<script setup lang="ts">
import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'

interface FreqRowData {
  name: string
  times: number
  path: string
}

defineOptions({ name: 'AidjFreqRow' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const props = defineProps<{ data: FreqRowData; index: number }>()

const emit = defineEmits<{ play: [path: string] }>()

const coverUrl = ref('')

// Module-level cover cache shared across every FreqRow instance, so each file's
// cover is fetched once per session (covers are expensive to build).
const coverCache = new Map<string, string>()
const loadingCovers = new Set<string>()

onMounted(async () => {
  const path = props.data.path
  if (!path) return
  if (coverCache.has(path)) {
    coverUrl.value = coverCache.get(path) ?? ''
    return
  }
  if (loadingCovers.has(path)) return
  loadingCovers.add(path)
  try {
    const r = (await window.cockpit.command('aidj.get-cover', { path })) as {
      ok?: boolean
      url?: string
    }
    const url = r?.ok && r.url ? r.url : ''
    coverCache.set(path, url)
    coverUrl.value = url
  } catch {
    coverCache.set(path, '')
  } finally {
    loadingCovers.delete(path)
  }
})
</script>

<template>
  <div class="freq-row d-flex align-center ga-2 px-2">
    <span class="freq-idx text-caption text-medium-emphasis flex-shrink-0">{{ index + 1 }}</span>
    <div
      class="freq-cover d-flex align-center justify-center flex-shrink-0"
      :title="data.path ? t('aidj.freq.play_hint', '点击播放') : ''"
      @click.stop="data.path && emit('play', data.path)"
    >
      <img v-if="coverUrl" :src="coverUrl" class="freq-cover-img" alt="" />
      <v-icon v-else icon="mdi-music" size="16" class="opacity-50" />
      <div v-if="data.path" class="freq-cover-overlay d-flex align-center justify-center">
        <v-icon icon="mdi-play-circle" size="20" class="freq-cover-play" />
      </div>
    </div>
    <span class="freq-name text-body-2 text-truncate flex-grow-1" :title="data.name">{{
      data.name
    }}</span>
    <span class="freq-times text-caption flex-shrink-0">x{{ data.times }}</span>
  </div>
</template>

<style scoped>
.freq-row {
  height: 52px;
  border-radius: 8px;
  transition: background 0.15s;
  overflow: hidden;
}
.freq-row:hover {
  background: rgba(var(--v-theme-surface-variant), 0.3);
}
.freq-idx {
  min-width: 3ch;
  text-align: right;
}
.freq-cover {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  flex-shrink: 0;
  cursor: pointer;
}
.freq-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.freq-cover-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.15s;
}
.freq-cover:hover .freq-cover-overlay {
  opacity: 1;
}
.freq-cover-play {
  color: #fff;
}
.freq-name {
  display: block;
  min-width: 0;
  line-height: 1.3;
}
.freq-times {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
</style>
