<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolViewProps } from '../../components/plugin-ui'
import { assetUrl } from '../../components/asset-url'

defineOptions({ name: 'cockpit-yaya-tool-image-result' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 会话资产 URI → data URL（>4MB / 非图片时主进程返回 null，界面退回占位） */
const previews = ref<Record<string, string>>({})
const uris = computed<string[]>(() =>
  Array.isArray(props.call.images)
    ? props.call.images.filter((u): u is string => typeof u === 'string')
    : []
)

/** `ui_input_timeline` 这类多图结果会带 label（"frame t=150ms"），拿它当图注 */
function frameLabels(): string[] {
  const r = props.call.result as { images?: unknown; frames?: unknown } | undefined
  const arr = r?.images ?? r?.frames
  if (!Array.isArray(arr)) return []
  return arr.map((x) => {
    const label = (x as { label?: unknown } | null)?.label
    return typeof label === 'string' ? label : ''
  })
}

function labelOf(i: number): string {
  return frameLabels()[i] || te('yaya.plugin.cockpit.image_n', { n: String(i + 1) }, '图片 {n}')
}

/** 加载失败（文件已删等）：退回占位图标 */
function dropPreview(uri: string): void {
  delete previews.value[uri]
}

function loadPreviews(): void {
  for (const uri of uris.value) {
    if (!previews.value[uri]) previews.value[uri] = assetUrl(uri)
  }
}

onMounted(loadPreviews)
watch(uris, loadPreviews)

// ---- 放大 ----
const zoom = ref<number | null>(null)
const zoomOpen = computed({
  get: () => zoom.value !== null,
  set: (v: boolean) => {
    if (!v) zoom.value = null
  }
})
const canPrev = computed(() => (zoom.value ?? 0) > 0)
const canNext = computed(() => (zoom.value ?? -1) < uris.value.length - 1)
const closeZoom = (): void => {
  zoom.value = null
}
const stepZoom = (delta: number): void => {
  if (zoom.value === null) return
  const next = zoom.value + delta
  if (next >= 0 && next < uris.value.length) zoom.value = next
}

/** 窄屏（手机）对话框全屏；与全站断点一致，用 matchMedia 而非 useDisplay */
const narrow = ref(false)
let narrowMql: MediaQueryList | null = null
function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}
onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  narrow.value = narrowMql.matches
  narrowMql.addEventListener('change', onNarrowChange)
})
onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', onNarrowChange)
  narrowMql = null
})
</script>

<template>
  <div class="img-result">
    <div class="img-head">
      <v-icon icon="mdi-image-multiple-outline" size="16" class="text-medium-emphasis" />
      <span class="text-caption text-medium-emphasis">
        {{ te('yaya.plugin.cockpit.images_count', { n: String(uris.length) }, '共 {n} 张图片') }}
      </span>
    </div>

    <div v-if="uris.length" class="img-grid">
      <button
        v-for="(uri, i) in uris"
        :key="uri"
        type="button"
        class="img-cell"
        :title="labelOf(i)"
        :aria-label="
          te('yaya.plugin.cockpit.image_zoom', { n: String(i + 1) }, '放大第 {n} 张图片')
        "
        @click="zoom = i"
      >
        <img
          v-if="previews[uri]"
          :src="previews[uri]"
          :alt="labelOf(i)"
          class="img-thumb"
          loading="lazy"
          @error="dropPreview(uri)"
        />
        <span v-else class="img-missing">
          <v-icon icon="mdi-image-off-outline" size="20" />
        </span>
        <span class="img-badge">{{ i + 1 }}</span>
      </button>
    </div>
    <div v-else class="img-empty text-caption text-medium-emphasis">
      <v-icon icon="mdi-image-off-outline" size="16" />
      {{ t('yaya.plugin.cockpit.images_empty', '没有图片') }}
    </div>

    <v-dialog v-model="zoomOpen" :fullscreen="narrow" max-width="960" scrollable>
      <v-card class="img-zoom">
        <div class="img-zoom-bar">
          <span class="img-zoom-label">{{ labelOf(zoom ?? 0) }}</span>
          <span v-if="uris.length > 1" class="text-caption text-medium-emphasis">
            {{ (zoom ?? 0) + 1 }} / {{ uris.length }}
          </span>
          <v-spacer />
          <div class="d-flex align-center ga-1">
            <v-btn
              v-if="uris.length > 1"
              icon
              size="small"
              variant="text"
              density="comfortable"
              :disabled="!canPrev"
              :title="t('yaya.plugin.cockpit.image_prev', '上一张')"
              :aria-label="t('yaya.plugin.cockpit.image_prev', '上一张')"
              @click="stepZoom(-1)"
            >
              <v-icon icon="mdi-chevron-left" size="20" />
            </v-btn>
            <v-btn
              v-if="uris.length > 1"
              icon
              size="small"
              variant="text"
              density="comfortable"
              :disabled="!canNext"
              :title="t('yaya.plugin.cockpit.image_next', '下一张')"
              :aria-label="t('yaya.plugin.cockpit.image_next', '下一张')"
              @click="stepZoom(1)"
            >
              <v-icon icon="mdi-chevron-right" size="20" />
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="text"
              density="comfortable"
              :title="t('yaya.close', '关闭')"
              :aria-label="t('yaya.close', '关闭')"
              @click="closeZoom"
            >
              <v-icon icon="mdi-close" size="20" />
            </v-btn>
          </div>
        </div>
        <div class="img-zoom-body">
          <img
            v-if="zoom !== null && previews[uris[zoom] ?? '']"
            :src="previews[uris[zoom] ?? '']"
            :alt="labelOf(zoom ?? 0)"
            class="img-zoom-img"
          />
          <span v-else class="text-caption text-medium-emphasis">
            {{ t('yaya.plugin.cockpit.image_failed', '图片预览不可用') }}
          </span>
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.img-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.img-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 8px;
}
.img-cell {
  position: relative;
  display: block;
  padding: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  overflow: hidden;
  background: rgba(var(--v-theme-on-surface), 0.06);
  aspect-ratio: 16 / 10;
  cursor: zoom-in;
}
.img-cell:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}
.img-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.img-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: rgba(var(--v-theme-on-surface), 0.45);
}
.img-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.88);
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.7rem;
  line-height: 1.4;
  text-align: center;
}
.img-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-block: 4px;
}
.img-zoom-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
}
.img-zoom-label {
  font-size: 0.8rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.img-zoom-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 0 8px 8px;
}
.img-zoom-img {
  max-width: 100%;
  max-height: 80vh;
  border-radius: 8px;
  object-fit: contain;
}
/* 窄屏（手机）：网格更密、对话框全屏 */
@media (max-width: 720px) {
  .img-grid {
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }
  .img-zoom-body {
    min-height: 50vh;
  }
  .img-zoom-img {
    max-height: none;
    height: auto;
  }
}
</style>
