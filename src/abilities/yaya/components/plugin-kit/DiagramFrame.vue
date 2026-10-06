<script setup lang="ts">
/**
 * 图类插件（mermaid / svg …）的公共外框：工具栏（图 / 源码切换、复制源码、导出 SVG / PNG、
 * 放大）+ 图区 / 源码区 + 错误回退（源码 + 一行弱化红错误信息）。
 *
 * 图一律用 data URL 的 <img> 显示：模型输出是不可信内容，不 v-html 插入 SVG。
 * 容器 < 520px（窄消息气泡）时工具栏收进「⋯」菜单。
 */
import '../pop.css'
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import { downloadUrlToLocal, downloadTextToLocal } from '@ui/composables/download'
import { svgToPngDataUrl } from './image-utils'
import ZoomDialog from './ZoomDialog.vue'

const props = withDefaults(
  defineProps<{
    /** 原始代码（源码视图 / 复制 / 兜底显示） */
    source: string
    /** 渲染出的 SVG 文本（导出 SVG 用）；没有 = 当前只有源码 */
    svgText?: string | null
    /** 图的 data URL（显示 / 放大 / 导出 PNG 用） */
    imageSrc?: string | null
    /** 渲染错误（显示弱化红条 + 回退源码） */
    error?: string | null
    /** 渲染中 */
    busy?: boolean
    /** 导出文件名（不含扩展名） */
    exportName?: string
    /** 工具栏旁边的状态说明（如「生成中，代码块闭合成图」） */
    hint?: string
    /** 图区最大高度（px） */
    maxImageHeight?: number
  }>(),
  {
    svgText: null,
    imageSrc: null,
    error: null,
    busy: false,
    exportName: 'diagram',
    hint: '',
    maxImageHeight: 420
  }
)

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 有图且没报错才显示图；出错时永远回到源码 */
const showImage = computed(() => Boolean(props.imageSrc) && !props.error)
const asSource = ref(false)
const zoom = ref(false)

const note = ref('')
let noteTimer = 0
function flash(text: string): void {
  note.value = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => (note.value = ''), 2400)
}
onBeforeUnmount(() => window.clearTimeout(noteTimer))

/** 网页模式没有原生保存对话框（file.save: none）→ 导出退回复制源码 */
const canSave = computed(() => window.cockpit.hasCap('file.save'))

async function copySource(): Promise<void> {
  try {
    await window.cockpit.copyText(props.source)
    flash(t('yaya.diagram.copied', '已复制'))
  } catch {
    flash(t('yaya.diagram.copy_failed', '复制失败'))
  }
}

async function fallbackCopy(): Promise<void> {
  try {
    await window.cockpit.copyText(props.source)
  } catch {
    /* 复制也失败就只能什么都不做 */
  }
  flash(t('yaya.diagram.save_unavailable', '当前环境不能保存文件，已改为复制源码'))
}

async function exportSvg(): Promise<void> {
  if (!props.svgText) {
    flash(t('yaya.diagram.no_image', '没有可导出的图'))
    return
  }
  if (!canSave.value) {
    await fallbackCopy()
    return
  }
  const done = await downloadTextToLocal(
    props.svgText,
    `${props.exportName}.svg`,
    t('yaya.diagram.export_svg', '导出 SVG'),
    [{ name: 'SVG', extensions: ['svg'] }]
  )
  flash(
    done === 'clipboard'
      ? t('yaya.diagram.copied', '已复制')
      : done
        ? t('yaya.diagram.exported', '已导出')
        : t('yaya.diagram.export_failed', '导出失败')
  )
}

async function exportPng(): Promise<void> {
  if (!props.imageSrc) {
    flash(t('yaya.diagram.no_image', '没有可导出的图'))
    return
  }
  if (!canSave.value) {
    await fallbackCopy()
    return
  }
  const url = await svgToPngDataUrl(props.imageSrc)
  if (!url) {
    flash(t('yaya.diagram.export_failed', '导出失败'))
    return
  }
  const ok = await downloadUrlToLocal(url, { mime: 'image/png', name: props.exportName })
  flash(ok ? t('yaya.diagram.exported', '已导出') : t('yaya.diagram.export_failed', '导出失败'))
}

// ---- 容器 < 520px：工具栏收进「⋯」菜单（按容器宽度，不按窗口断点）----
const rootEl = ref<HTMLElement>()
const narrow = ref(false)
let ro: ResizeObserver | null = null
function measure(): void {
  narrow.value = (rootEl.value?.clientWidth ?? 0) < 520
}
onMounted(() => {
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(measure)
    ro.observe(rootEl.value)
  }
  measure()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <div ref="rootEl" class="diagram-frame">
    <!-- 工具栏：pb-3 起步，不贴着上面的分隔线；flex-wrap 兜底 -->
    <div class="d-flex align-center flex-wrap ga-2 pb-3">
      <v-btn
        icon
        size="small"
        variant="text"
        density="comfortable"
        :disabled="!showImage"
        :title="
          asSource
            ? t('yaya.diagram.show_image', '查看图')
            : t('yaya.diagram.show_source', '查看源码')
        "
        :aria-label="
          asSource
            ? t('yaya.diagram.show_image', '查看图')
            : t('yaya.diagram.show_source', '查看源码')
        "
        @click="asSource = !asSource"
      >
        <v-icon :icon="asSource ? 'mdi-image-outline' : 'mdi-code-tags'" size="20" />
      </v-btn>

      <template v-if="!narrow">
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.diagram.copy_source', '复制源码')"
          :aria-label="t('yaya.diagram.copy_source', '复制源码')"
          @click="copySource"
        >
          <v-icon icon="mdi-content-copy" size="18" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :disabled="!svgText"
          :title="t('yaya.diagram.export_svg', '导出 SVG')"
          :aria-label="t('yaya.diagram.export_svg', '导出 SVG')"
          @click="exportSvg"
        >
          <v-icon icon="mdi-export" size="18" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :disabled="!showImage || asSource"
          :title="t('yaya.diagram.export_png', '导出 PNG')"
          :aria-label="t('yaya.diagram.export_png', '导出 PNG')"
          @click="exportPng"
        >
          <v-icon icon="mdi-image-move" size="18" />
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :disabled="!showImage || asSource"
          :title="t('yaya.diagram.zoom', '放大查看')"
          :aria-label="t('yaya.diagram.zoom', '放大查看')"
          @click="zoom = true"
        >
          <v-icon icon="mdi-magnify-plus-outline" size="18" />
        </v-btn>
      </template>
      <v-menu v-else location="bottom end">
        <template #activator="{ props: menuProps }">
          <v-btn
            icon
            size="small"
            variant="text"
            density="comfortable"
            v-bind="menuProps"
            :title="t('yaya.diagram.more', '更多操作')"
            :aria-label="t('yaya.diagram.more', '更多操作')"
          >
            <v-icon icon="mdi-dots-horizontal" size="18" />
          </v-btn>
        </template>
        <v-list density="default" min-width="180" class="yaya-pop">
          <v-list-item
            :title="t('yaya.diagram.copy_source', '复制源码')"
            :aria-label="t('yaya.diagram.copy_source', '复制源码')"
            prepend-icon="mdi-content-copy"
            @click="copySource"
          />
          <v-list-item
            :title="t('yaya.diagram.export_svg', '导出 SVG')"
            :aria-label="t('yaya.diagram.export_svg', '导出 SVG')"
            :disabled="!svgText"
            prepend-icon="mdi-export"
            @click="exportSvg"
          />
          <v-list-item
            :title="t('yaya.diagram.export_png', '导出 PNG')"
            :aria-label="t('yaya.diagram.export_png', '导出 PNG')"
            :disabled="!showImage || asSource"
            prepend-icon="mdi-image-move"
            @click="exportPng"
          />
          <v-list-item
            :title="t('yaya.diagram.zoom', '放大查看')"
            :aria-label="t('yaya.diagram.zoom', '放大查看')"
            :disabled="!showImage || asSource"
            prepend-icon="mdi-magnify-plus-outline"
            @click="zoom = true"
          />
        </v-list>
      </v-menu>

      <v-spacer />
      <span v-if="note" class="text-caption text-success">{{ note }}</span>
      <span v-else-if="hint" class="text-caption text-medium-emphasis">{{ hint }}</span>
      <span v-else-if="busy" class="text-caption text-medium-emphasis">{{
        t('yaya.diagram.rendering', '渲染中…')
      }}</span>
    </div>

    <!-- 错误回退：一行弱化红错误信息 + 源码 -->
    <div v-if="error" class="diagram-err">
      <v-icon icon="mdi-alert-circle-outline" size="16" />
      <span>{{ error }}</span>
    </div>

    <button
      v-else-if="showImage && !asSource"
      type="button"
      class="diagram-img-box"
      :title="t('yaya.diagram.zoom', '放大查看')"
      :aria-label="t('yaya.diagram.zoom', '放大查看')"
      @click="zoom = true"
    >
      <img
        :src="imageSrc ?? ''"
        :alt="t('yaya.diagram.image_alt', '渲染出的图表')"
        :style="{ maxHeight: `${maxImageHeight}px` }"
      />
    </button>

    <pre v-else class="diagram-src">{{ source }}</pre>

    <ZoomDialog
      v-model="zoom"
      :src="imageSrc ?? ''"
      :alt="t('yaya.diagram.image_alt', '渲染出的图表')"
    />
  </div>
</template>

<style scoped>
.diagram-frame {
  display: flex;
  flex-direction: column;
}
.diagram-err {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-error), 0.08);
  border: 1px solid rgba(var(--v-theme-error), 0.22);
  color: rgb(var(--v-theme-error));
  font-size: 0.8rem;
  line-height: 1.5;
}
.diagram-img-box {
  display: block;
  width: 100%;
  padding: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  cursor: zoom-in;
}
.diagram-img-box img {
  display: block;
  max-width: 100%;
  max-height: 420px;
  width: auto;
  height: auto;
  margin: 0 auto;
}
.diagram-src {
  max-height: 360px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre;
  tab-size: 2;
}
</style>
