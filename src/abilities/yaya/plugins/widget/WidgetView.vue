<script setup lang="ts">
/**
 * ```widget 代码块 → 沙箱里运行的 HTML 小部件（显示类插件 widget 的 fence 视图）。
 *
 * 模型输出是不可信内容：默认只显示源码，用户点「运行」才加载。运行时放进
 * `sandbox="allow-scripts"` 的 iframe（不透明 origin），外壳页由主进程提供并带严格 CSP
 * （无网络，见 frame.ts）；内容经 postMessage 交给外壳页，只接受来自本 iframe 的高度消息。
 * 流式中、超过 500KB 时只显示源码。
 */
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useTheme } from 'vuetify'
import { useI18n } from '@ui/i18n'
import type { FenceViewProps } from '../../components/plugin-ui'
import { WIDGET_FRAME_URI } from './frame'

const props = defineProps<FenceViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)
const theme = useTheme()

const MAX_BYTES = 500 * 1024
const MIN_H = 48
const MAX_H = 800

const tooLarge = computed(() => props.source.length > MAX_BYTES)
const canRun = computed(() => !props.streaming && !tooLarge.value && !!props.source.trim())

const running = ref(false)
/** 每次运行换一个 key，强制重建 iframe（重新运行 = 全新的文档） */
const runKey = ref(0)
const height = ref(160)
const frame = ref<HTMLIFrameElement>()
const frameUrl = window.cockpit.hostUrl(WIDGET_FRAME_URI)

const note = ref('')
let noteTimer = 0
function flash(text: string): void {
  note.value = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => (note.value = ''), 2400)
}

function run(): void {
  if (!canRun.value) return
  height.value = 160
  runKey.value++
  running.value = true
}

function stop(): void {
  running.value = false
}

// 代码块内容变了（重新生成 / 切分支）就回到源码，免得运行的是旧内容
watch(
  () => [props.source, props.streaming] as const,
  () => {
    running.value = false
  }
)

function themeColor(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--v-theme-${name}`).trim()
  return /^\d+,\s*\d+,\s*\d+$/.test(v) ? `rgb(${v})` : ''
}

function onMessage(e: MessageEvent): void {
  const win = frame.value?.contentWindow
  if (!win || e.source !== win) return
  const data = e.data as { type?: string; height?: unknown } | null
  if (data?.type === 'yaya-widget:ready') {
    win.postMessage(
      {
        type: 'yaya-widget:render',
        html: props.source,
        scheme: theme.current.value.dark ? 'dark' : 'light',
        fg: themeColor('on-surface'),
        bg: themeColor('surface'),
        primary: themeColor('primary')
      },
      '*'
    )
  } else if (data?.type === 'yaya-widget:size') {
    const h = Number(data.height)
    if (Number.isFinite(h)) height.value = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(h)))
  }
}
window.addEventListener('message', onMessage)
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  window.clearTimeout(noteTimer)
})

async function copySource(): Promise<void> {
  try {
    await window.cockpit.copyText(props.source)
    flash(t('yaya.diagram.copied', '已复制'))
  } catch {
    flash(t('yaya.diagram.copy_failed', '复制失败'))
  }
}

const hint = computed(() => {
  if (props.streaming) return t('yaya.widget.streaming', '生成中，代码块闭合后可以运行')
  if (tooLarge.value) return t('yaya.widget.too_large', '小部件超过 500KB，仅显示源码')
  if (!running.value)
    return t('yaya.widget.sandbox_hint', '在隔离沙箱里运行：没有网络，无法访问 Cockpit')
  return ''
})
</script>

<template>
  <div class="widget-frame">
    <div class="d-flex align-center flex-wrap ga-2 pb-3">
      <v-btn
        v-if="!running"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-play"
        :disabled="!canRun"
        @click="run"
      >
        {{ t('yaya.widget.run', '运行小部件') }}
      </v-btn>
      <template v-else>
        <v-btn variant="tonal" prepend-icon="mdi-code-tags" @click="stop">
          {{ t('yaya.widget.show_source', '停止并查看源码') }}
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          density="comfortable"
          :title="t('yaya.widget.rerun', '重新运行')"
          :aria-label="t('yaya.widget.rerun', '重新运行')"
          @click="run"
        >
          <v-icon icon="mdi-restart" size="20" />
        </v-btn>
      </template>
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
      <v-spacer />
      <span v-if="note" class="text-caption text-success">{{ note }}</span>
      <span v-else-if="hint" class="text-caption text-medium-emphasis">{{ hint }}</span>
    </div>

    <iframe
      v-if="running"
      :key="runKey"
      ref="frame"
      class="widget-box"
      :src="frameUrl"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      :title="t('yaya.widget.frame_title', 'HTML 小部件')"
      :style="{ height: `${height}px` }"
    />
    <pre v-else class="widget-src">{{ source }}</pre>
  </div>
</template>

<style scoped>
.widget-frame {
  display: flex;
  flex-direction: column;
}
.widget-box {
  display: block;
  width: 100%;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: transparent;
}
.widget-src {
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
