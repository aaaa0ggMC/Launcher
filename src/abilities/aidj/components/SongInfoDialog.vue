<script setup lang="ts">
import { ref, computed, inject, watch } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { SongMeta, SongFileInfo } from '../types'

/**
 * 歌曲信息 — opened by right-click (desktop) or long-press (phone) on a song.
 * Cover, title / artist / album / length from the file's own tags, the
 * technical bits (format, bitrate, size) and whatever the library metadata
 * (language, genre, emotion, loudness, review) knows about it.
 */
defineOptions({ name: 'AidjSongInfoDialog' })

const props = defineProps<{
  modelValue: boolean
  /** File to describe; the dialog (re)loads whenever it opens on a new path. */
  path: string
  /** Display name to show while loading (usually the file name). */
  name?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const loading = ref(false)
const cover = ref('')
const info = ref<SongFileInfo | null>(null)
const meta = ref<SongMeta | null>(null)
const hasLyrics = ref<boolean | null>(null)
let loadedPath = ''
let seq = 0

async function load(path: string): Promise<void> {
  const my = ++seq
  loading.value = true
  cover.value = ''
  info.value = null
  meta.value = null
  hasLyrics.value = null
  try {
    const [c, r] = (await Promise.all([
      window.cockpit.command('aidj.get-cover', { path }).catch(() => null),
      window.cockpit.command('aidj.song-info', { path }).catch(() => null)
    ])) as [Record<string, unknown> | null, Record<string, unknown> | null]
    if (my !== seq) return
    cover.value = c?.ok && typeof c.url === 'string' ? c.url : ''
    if (r?.ok) {
      info.value = (r.info as SongFileInfo) ?? null
      meta.value = (r.meta as SongMeta | null) ?? null
      hasLyrics.value = typeof r.hasLyrics === 'boolean' ? r.hasLyrics : null
    }
    loadedPath = path
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(
  () => [props.modelValue, props.path] as const,
  ([open, path]) => {
    if (open && path && path !== loadedPath) void load(path)
  },
  { immediate: true }
)

function close(): void {
  emit('update:modelValue', false)
}

function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}
function fmtSize(b: number | null | undefined): string {
  if (b == null) return ''
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
const list = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean)

const title = computed(() => info.value?.tags.title || info.value?.name || props.name || '')
const artist = computed(() => info.value?.tags.artist || '')

/** 标签 rows (left label, right value), only the ones that exist. */
const tagRows = computed(() => {
  const i = info.value
  if (!i) return []
  const rows: [string, string][] = [
    [t('aidj.songinfo.album', '专辑'), i.tags.album ?? ''],
    [t('aidj.songinfo.album_artist', '专辑艺术家'), i.tags.album_artist ?? ''],
    [t('aidj.songinfo.date', '年份'), i.tags.date ?? ''],
    [t('aidj.songinfo.genre_tag', '流派（标签）'), i.tags.genre ?? ''],
    [t('aidj.songinfo.track', '音轨'), i.tags.track ?? ''],
    [t('aidj.songinfo.composer', '作曲'), i.tags.composer ?? '']
  ]
  return rows.filter(([, v]) => v)
})

const techRows = computed(() => {
  const i = info.value
  if (!i) return []
  const fmt = [i.codec, i.format && i.format !== i.codec ? i.format.split(',')[0] : '']
    .filter(Boolean)
    .join(' / ')
  const rows: [string, string][] = [
    [t('aidj.songinfo.format', '格式'), fmt],
    [t('aidj.songinfo.bitrate', '码率'), i.bitRate ? `${Math.round(i.bitRate / 1000)} kbps` : ''],
    [
      t('aidj.songinfo.sample', '采样'),
      [
        i.sampleRate ? `${(i.sampleRate / 1000).toFixed(1)} kHz` : '',
        i.channels ? `${i.channels} ch` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    ],
    [t('aidj.songinfo.size', '大小'), fmtSize(i.size)]
  ]
  return rows.filter(([, v]) => v)
})

/** Library metadata as chip groups. */
const metaChips = computed(() => {
  const m = meta.value
  if (!m) return []
  const groups: { label: string; values: string[] }[] = [
    { label: t('aidj.songinfo.language', '语言'), values: list(m.language) },
    { label: t('aidj.songinfo.genre', '流派'), values: list(m.genre) },
    { label: t('aidj.songinfo.emotion', '情绪'), values: list(m.emotion) },
    { label: t('aidj.songinfo.loudness', '响度'), values: list(m.loudness) },
    {
      label: 'LUFS',
      values: m.loudness_lufs != null ? [`${m.loudness_lufs.toFixed(1)} LUFS`] : []
    }
  ]
  return groups.filter((g) => g.values.length)
})
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    width="460"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card rounded="lg" class="song-info-card">
      <v-card-text class="pa-4">
        <div class="si-head d-flex ga-4">
          <div class="si-cover d-flex align-center justify-center flex-shrink-0">
            <img v-if="cover" :src="cover" alt="" />
            <v-icon v-else size="36">mdi-music-note</v-icon>
          </div>
          <div class="si-titles min-w-0">
            <div class="text-subtitle-1 font-weight-medium si-title">{{ title }}</div>
            <div v-if="artist" class="text-body-2 text-medium-emphasis si-wrap">{{ artist }}</div>
            <div v-if="info?.duration" class="text-caption text-medium-emphasis mt-1">
              {{ fmtDuration(info.duration) }}
            </div>
          </div>
        </div>

        <v-progress-linear v-if="loading" indeterminate color="primary" class="mt-4" />

        <template v-if="info">
          <dl v-if="tagRows.length" class="si-rows mt-4">
            <template v-for="[k, v] in tagRows" :key="k">
              <dt>{{ k }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </dl>

          <div v-if="metaChips.length || meta?.review || hasLyrics != null" class="mt-4">
            <div class="text-caption text-medium-emphasis mb-2">
              {{ t('aidj.songinfo.library', '曲库元数据') }}
            </div>
            <div v-for="g in metaChips" :key="g.label" class="si-chiprow d-flex align-center ga-1">
              <span class="text-caption text-medium-emphasis si-chiplabel">{{ g.label }}</span>
              <v-chip v-for="v in g.values" :key="v" size="x-small" variant="tonal">{{ v }}</v-chip>
            </div>
            <div v-if="hasLyrics != null" class="si-chiprow d-flex align-center ga-1">
              <span class="text-caption text-medium-emphasis si-chiplabel">
                {{ t('aidj.songinfo.lyrics', '歌词') }}
              </span>
              <v-chip size="x-small" variant="tonal" :color="hasLyrics ? 'success' : undefined">
                {{
                  hasLyrics
                    ? t('aidj.songinfo.lyrics_yes', '有')
                    : t('aidj.songinfo.lyrics_no', '无')
                }}
              </v-chip>
            </div>
            <div v-if="meta?.review" class="text-body-2 si-review mt-2">{{ meta.review }}</div>
          </div>

          <dl v-if="techRows.length" class="si-rows mt-4">
            <template v-for="[k, v] in techRows" :key="k">
              <dt>{{ k }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </dl>
          <div class="text-caption text-medium-emphasis si-path mt-3">{{ info.path }}</div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close">{{ t('aidj.songinfo.close', '关闭') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.si-cover {
  width: 96px;
  height: 96px;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(var(--v-theme-surface-variant), 0.4);
}
.si-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.si-titles {
  flex: 1 1 0;
  align-self: center;
}
.si-title,
.si-wrap,
.si-path,
.si-review {
  overflow-wrap: anywhere;
}
.si-path {
  user-select: text;
}
.si-review {
  white-space: pre-wrap;
}
.si-rows {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 16px;
  row-gap: 4px;
  margin: 0;
  font-size: 0.875rem;
}
.si-rows dt {
  color: rgb(var(--v-theme-on-surface-variant));
  white-space: nowrap;
}
.si-rows dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.si-chiprow {
  flex-wrap: wrap;
  min-height: 24px;
}
.si-chiplabel {
  min-width: 3em;
}
</style>
