<script setup lang="ts">
/**
 * ```mermaid 代码块 → 图（显示类插件 mermaid 的 fence 视图）。
 *
 * - 流式输出中（代码块可能还没写完）只显示源码，闭合成图后才渲染；
 * - mermaid 引擎按需动态 import（代码分割，不进首屏）；
 * - securityLevel 'strict' + htmlLabels false：产出物不含 foreignObject / 脚本，
 *   再用 data URL 的 <img> 显示（图片上下文里脚本本来就不执行）；
 * - 配色跟随当前主题（读 --v-theme-* CSS 变量换算 themeVariables，主题切换重渲染）；
 * - 按「源码 + 主题」哈希缓存渲染结果（模块级 Map，限 100 条），切分支 / 重渲染不重复计算；
 * - 渲染可取消：source 变化或组件卸载时丢弃旧结果（单调递增的 seq）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { FenceViewProps } from '../../components/plugin-ui'
import DiagramFrame from '../../components/plugin-kit/DiagramFrame.vue'
import { svgToDataUrl } from '../../components/plugin-kit/image-utils'

const props = defineProps<FenceViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

// ---------------------------------------------------------------------------
// mermaid 引擎：按需加载（渲染端动态 import，独立 chunk）
// ---------------------------------------------------------------------------

type Mermaid = typeof import('mermaid').default

let engine: Mermaid | null = null
let engineLoading: Promise<Mermaid | null> | null = null

function loadEngine(): Promise<Mermaid | null> {
  if (engine) return Promise.resolve(engine)
  if (!engineLoading)
    engineLoading = import('mermaid')
      .then((m) => {
        engine = m.default
        return engine
      })
      .catch(() => null)
  return engineLoading
}

// ---------------------------------------------------------------------------
// 主题：--v-theme-* CSS 变量 → mermaid themeVariables；主题切换重渲染
// ---------------------------------------------------------------------------

/** CSS 变量名 → mermaid themeVariables 键（一个 CSS 变量可映射到多个键） */
const THEME_VARS: [cssVar: string, mermaidKey: string, fallback: string][] = [
  ['--v-theme-surface', 'background', '#151b24'],
  ['--v-theme-surface-variant', 'mainBkg', '#1c242f'],
  ['--v-theme-surface-bright', 'secondBkg', '#283340'],
  ['--v-theme-secondary-container', 'primaryColor', '#2c3640'],
  ['--v-theme-secondary-container', 'secondaryColor', '#2c3640'],
  ['--v-theme-surface-bright', 'tertiaryColor', '#283340'],
  ['--v-theme-primary', 'primaryBorderColor', '#4cc4d6'],
  ['--v-theme-primary', 'nodeBorder', '#4cc4d6'],
  ['--v-theme-primary', 'actorBorder', '#4cc4d6'],
  ['--v-theme-primary', 'noteBorderColor', '#4cc4d6'],
  ['--v-theme-primary', 'activationBorderColor', '#4cc4d6'],
  ['--v-theme-on-surface', 'primaryTextColor', '#e6edf3'],
  ['--v-theme-on-surface', 'textColor', '#e6edf3'],
  ['--v-theme-on-surface', 'actorTextColor', '#e6edf3'],
  ['--v-theme-on-surface', 'signalTextColor', '#e6edf3'],
  ['--v-theme-on-surface', 'noteTextColor', '#e6edf3'],
  ['--v-theme-on-surface-variant', 'secondaryTextColor', '#8b97a5'],
  ['--v-theme-on-surface-variant', 'tertiaryTextColor', '#8b97a5'],
  ['--v-theme-on-surface-variant', 'lineColor', '#8b97a5'],
  ['--v-theme-on-surface-variant', 'signalColor', '#8b97a5'],
  ['--v-theme-on-surface-variant', 'sequenceNumberColor', '#8b97a5'],
  ['--v-theme-surface-variant', 'actorBkg', '#1c242f'],
  ['--v-theme-primary-container', 'activationBkgColor', '#0a4d58'],
  ['--v-theme-surface-bright', 'noteBkgColor', '#283340'],
  ['--v-theme-error', 'errorBkgColor', '#ff6b6b'],
  ['--v-theme-error', 'errBackgroundColor', '#ff6b6b'],
  ['--v-theme-on-surface-variant', 'labelBackground', '#8b97a5'],
  // 饼图 / gitGraph 的循环色
  ['--v-theme-primary', 'git0', '#4cc4d6'],
  ['--v-theme-secondary', 'git1', '#8b9aa8'],
  ['--v-theme-surface-bright', 'git2', '#283340'],
  ['--v-theme-error', 'git3', '#ff6b6b'],
  ['--v-theme-success', 'git4', '#5cb88a'],
  ['--v-theme-warning', 'git5', '#e8a848'],
  ['--v-theme-primary', 'pie1', '#4cc4d6'],
  ['--v-theme-secondary', 'pie2', '#8b9aa8'],
  ['--v-theme-surface-bright', 'pie3', '#283340'],
  ['--v-theme-error', 'pie4', '#ff6b6b'],
  ['--v-theme-success', 'pie5', '#5cb88a'],
  ['--v-theme-warning', 'pie6', '#e8a848']
]

const THEME_SRC_VARS = [...new Set(THEME_VARS.map(([v]) => v))]

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Vuetify 的 --v-theme-* 是 "r, g, b" 三元组；少数变量可能是 hex，都兼容 */
function cssColor(name: string, fallback: string): string {
  const raw = cssVar(name)
  if (!raw) return fallback
  if (raw.startsWith('#')) return raw
  const m = raw.match(/^(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/)
  if (!m) return fallback
  const hex = (v: string): string =>
    Math.round(Math.min(255, Math.max(0, Number(v))))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}

function themeVariables(): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [src, key, fallback] of THEME_VARS) vars[key] = cssColor(src, fallback)
  return vars
}

function themeSignature(): string {
  return THEME_SRC_VARS.map((v) => cssVar(v)).join('|')
}

const themeEpoch = ref(0)
let lastThemeSig = ''

function checkTheme(): void {
  const sig = themeSignature()
  if (sig !== lastThemeSig) {
    lastThemeSig = sig
    themeEpoch.value++
  }
}

onMounted(() => {
  lastThemeSig = themeSignature()
  // 主题切换走 config 广播；CSS 变量可能晚一帧应用，下一帧再比一次
  const off = window.cockpit.on('cockpit:config-changed', () => requestAnimationFrame(checkTheme))
  onBeforeUnmount(off)
})

// ---------------------------------------------------------------------------
// 渲染：按「源码 + 主题」缓存；可取消（seq）
// ---------------------------------------------------------------------------

interface RenderEntry {
  svg: string
  url: string
}

const CACHE_MAX = 100
const cache = new Map<string, RenderEntry>()

function cacheGet(key: string): RenderEntry | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  // 最近使用的移到末尾（Map 按插入顺序淘汰）
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key: string, entry: RenderEntry): void {
  cache.set(key, entry)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

const imageSrc = ref<string | null>(null)
const svgText = ref<string | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

function reset(): void {
  imageSrc.value = null
  svgText.value = null
  error.value = null
  // 流式中 / 被更新的渲染取代时，旧的那次可能还挂在 busy 上
  busy.value = false
}

let seq = 0

function applyEntry(entry: RenderEntry): void {
  imageSrc.value = entry.url
  svgText.value = entry.svg
  error.value = null
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // mermaid 的报错可能带 HTML，剥掉标签再截断
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 240) || t('yaya.diagram.render_failed', '图表渲染失败')
}

async function renderNow(): Promise<void> {
  const source = props.source
  // 流式中只显示源码（代码块可能还没写完）；空代码块也直接回退
  if (props.streaming || !source.trim()) {
    seq++
    reset()
    return
  }
  const key = `${themeSignature()}\n${source}`
  const hit = cacheGet(key)
  if (hit) {
    seq++
    applyEntry(hit)
    return
  }
  const mine = ++seq
  busy.value = true
  error.value = null
  const m = await loadEngine()
  if (mine !== seq) return // source 变了 / 组件卸载：丢弃这次结果
  if (!m) {
    busy.value = false
    error.value = t('yaya.diagram.mermaid_load_failed', '图表引擎加载失败')
    imageSrc.value = null
    svgText.value = null
    return
  }
  try {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      htmlLabels: false,
      themeVariables: themeVariables()
    })
    const out = await m.render(`yaya-mermaid-${mine}-${Date.now().toString(36)}`, source)
    if (mine !== seq) return
    const entry: RenderEntry = { svg: out.svg, url: svgToDataUrl(out.svg) }
    cacheSet(key, entry)
    applyEntry(entry)
    busy.value = false
  } catch (e) {
    if (mine !== seq) return
    busy.value = false
    error.value = errorText(e)
    imageSrc.value = null
    svgText.value = null
  }
}

watch(
  () => [props.source, props.streaming, themeEpoch.value] as const,
  () => void renderNow(),
  { immediate: true }
)

onBeforeUnmount(() => {
  seq++
})

const hint = computed(() =>
  props.streaming ? t('yaya.diagram.streaming', '生成中，代码块闭合成图') : ''
)
</script>

<template>
  <DiagramFrame
    :source="source"
    :image-src="imageSrc"
    :svg-text="svgText"
    :error="error"
    :busy="busy"
    :hint="hint"
    export-name="mermaid"
  />
</template>
