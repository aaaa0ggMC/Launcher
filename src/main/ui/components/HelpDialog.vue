<script setup lang="ts">
/**
 * 帮助浮窗 — 渲染当前能力 `help/` 目录的 Markdown。
 *
 * 左侧是按目录层级展开的导航（`help/Video/guide.md` → `Video` 分组），右侧是
 * 正文。正文里的相对 `*.md` 链接会在浮窗内跳转，`#锚点` 滚动，外部链接交给
 * 系统浏览器。目录结构与正文均由主进程命令提供（`help.tree` / `help.read`），
 * Markdown 在构建期就以原文内联，无需磁盘路径。
 *
 * 渲染：markdown-it（`html:false` → 原始 HTML 一律转义，天然安全）+ 标题锚点
 * 插件；代码高亮用 highlight.js，首次打开时按需加载（独立 chunk），高亮配色
 * 全部取自 Vuetify 主题变量，10 套配色下都协调一致。
 */
import { computed, inject, ref, watch, type Ref } from 'vue'
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import type { HLJSApi } from 'highlight.js'
import type { HelpMessageResult, HelpNode, HelpTreeResult } from '@shared/types'
import AbilityIcon from './AbilityIcon.vue'
import { translate } from '../i18n'

interface HelpAbilityRef {
  id: string
  name: string
  /** source folder under abilities/ — the help namespace. */
  folder: string
  icon?: string | null
}

const props = defineProps<{
  ability: HelpAbilityRef | null
  tree: HelpTreeResult | null
}>()

const open = defineModel<boolean>({ default: false })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------
/** CJK-friendly slug so `#中文标题` anchors resolve. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
}

let hljs: HLJSApi | null = null
let hljsLoading: Promise<void> | null = null
const hljsReady = ref(false)

/** Lazy-load highlight.js the first time help opens (keeps the shell chunk slim). */
async function ensureHljs(): Promise<void> {
  if (hljs) return
  if (!hljsLoading) {
    hljsLoading = import('highlight.js')
      .then((m) => {
        hljs = m.default
        hljsReady.value = true
      })
      .catch(() => {
        /* highlight.js unavailable → plain <pre> still renders */
      })
  }
  await hljsLoading
}

const md = new MarkdownIt({
  html: false, // never trust raw HTML inside help docs
  linkify: true,
  breaks: false,
  highlight: (str, lang) => {
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* fall through to escaped plain text */
      }
    }
    return ''
  }
})
md.use(anchor, { slugify })

// ---------------------------------------------------------------------------
// Navigation rows — flatten the tree so indentation encodes depth.
// ---------------------------------------------------------------------------
interface NavRow {
  key: string
  title: string
  path?: string
  depth: number
  group: boolean
}

function flatten(nodes: HelpNode[], depth: number, prefix: string): NavRow[] {
  const rows: NavRow[] = []
  nodes.forEach((n, i) => {
    const key = `${prefix}/${i}:${n.group ? n.title : n.path}`
    if (n.group) {
      rows.push({ key, title: n.title, depth, group: true })
      rows.push(...flatten(n.children ?? [], depth + 1, key))
    } else if (n.path) {
      rows.push({ key, title: n.title, path: n.path, depth, group: false })
    }
  })
  return rows
}

const navRows = computed<NavRow[]>(() => flatten(props.tree?.tree ?? [], 0, ''))

/** All navigable page paths — used to validate in-dialog link targets. */
const pagePaths = computed<Set<string>>(() => {
  const set = new Set<string>()
  const walk = (nodes: HelpNode[]): void => {
    for (const n of nodes) {
      if (n.path) set.add(n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(props.tree?.tree ?? [])
  return set
})

function displayTitle(row: NavRow): string {
  return row.title === 'main' ? t('help.overview', '概览') : row.title
}

// ---------------------------------------------------------------------------
// Content loading
// ---------------------------------------------------------------------------
const currentPath = ref('')
const content = ref('')
const loading = ref(false)
const error = ref('')
const bodyEl = ref<HTMLElement | null>(null)

async function load(path: string): Promise<void> {
  const folder = props.ability?.folder
  if (!folder || !path) return
  loading.value = true
  error.value = ''
  try {
    const r = (await window.cockpit.command('help.read', {
      ability: folder,
      path
    })) as HelpMessageResult | null
    if (r?.ok) {
      content.value = r.content
      currentPath.value = r.path
      requestAnimationFrame(() => bodyEl.value?.scrollTo({ top: 0 }))
    } else {
      content.value = ''
      error.value = r?.error ?? t('help.loadFailed', '无法加载帮助内容')
    }
  } catch (e) {
    content.value = ''
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** (Re)load the root page whenever the dialog opens or the ability changes. */
watch(
  () => (open.value ? (props.ability?.folder ?? null) : null),
  (folder) => {
    if (!folder) return
    currentPath.value = ''
    content.value = ''
    void ensureHljs()
    void load(props.tree?.root ?? 'main.md')
  },
  { immediate: true }
)

function go(path: string): void {
  if (path === currentPath.value) return
  void load(path)
}

// ---------------------------------------------------------------------------
// Rendered HTML + link interception
// ---------------------------------------------------------------------------
const rendered = computed(() => {
  // hljsReady is a dependency so code recolors once the lazy chunk lands.
  void hljsReady.value
  if (!content.value) return ''
  try {
    return md.render(content.value)
  } catch {
    return ''
  }
})

/** Resolve a relative link against the current page path. */
function resolveRel(base: string, href: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const parts = (dir ? dir.split('/') : []).concat(href.split('/'))
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

function onContentClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest('a')
  if (!el) return
  const rawHref = el.getAttribute('href') ?? ''
  e.preventDefault()
  if (!rawHref) return

  if (/^(https?:)?\/\//i.test(rawHref) || rawHref.startsWith('mailto:')) {
    void window.cockpit.openExternal(rawHref)
    return
  }
  // Internal paths may be percent-encoded by markdown-it (non-ASCII folders).
  let href = rawHref
  try {
    href = decodeURIComponent(rawHref)
  } catch {
    /* keep raw href if it isn't valid percent-encoding */
  }
  if (href.startsWith('#')) {
    bodyEl.value?.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  const target = resolveRel(currentPath.value, href.split('#')[0])
  if (target.endsWith('.md') && pagePaths.value.has(target)) go(target)
}
</script>

<template>
  <v-dialog v-model="open" max-width="1080">
    <v-card rounded="lg" class="help-card">
      <v-card-title class="d-flex align-center ga-3 px-6 pt-5 pb-3">
        <AbilityIcon v-if="ability" :icon="ability.icon ?? null" :size="24" class="flex-shrink-0" />
        <span class="text-subtitle-1 font-weight-medium text-truncate">
          {{ ability?.name }}
        </span>
        <v-chip size="small" variant="tonal" class="help-chip">
          {{ t('help.title', '使用帮助') }}
        </v-chip>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          :aria-label="t('bt.tooltip', '关闭')"
          @click="open = false"
        />
      </v-card-title>
      <v-divider />

      <div class="help-body">
        <nav class="help-nav">
          <v-list density="compact" nav class="py-2">
            <template v-for="row in navRows" :key="row.key">
              <v-list-subheader
                v-if="row.group"
                class="help-nav-group"
                :style="{ paddingInlineStart: `${12 + row.depth * 14}px` }"
              >
                <v-icon size="14" class="mr-1">mdi-folder-outline</v-icon>
                {{ row.title }}
              </v-list-subheader>
              <v-list-item
                v-else
                rounded="lg"
                :title="displayTitle(row)"
                :aria-label="displayTitle(row)"
                :active="row.path === currentPath"
                class="text-body-2"
                :style="{ paddingInlineStart: `${8 + row.depth * 14}px` }"
                @click="go(row.path!)"
              />
            </template>
          </v-list>
        </nav>

        <div ref="bodyEl" class="help-content">
          <div v-if="loading" class="help-center">
            <v-progress-circular indeterminate size="28" color="primary" />
          </div>
          <v-alert
            v-else-if="error"
            type="error"
            variant="tonal"
            density="comfortable"
            class="ma-4"
          >
            {{ error }}
          </v-alert>
          <article v-else class="help-markdown" @click="onContentClick" v-html="rendered" />
        </div>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.help-card {
  overflow: hidden;
}
.help-chip {
  padding-block: 4px;
  min-height: 24px;
}
.help-body {
  display: flex;
  align-items: stretch;
  height: min(calc(var(--app-vh, 100vh) * 0.74), 720px);
}
.help-nav {
  width: 248px;
  flex-shrink: 0;
  overflow-y: auto;
  border-inline-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding-inline: 8px;
}
.help-nav-group {
  opacity: 0.85;
}
.help-content {
  flex-grow: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 24px 32px 40px;
}
/* 窄屏：左侧导航树 248px + 正文放不下（正文会被挤成一列竖排字），改成上下堆叠 */
@media (max-width: 720px) {
  .help-body {
    flex-direction: column;
    height: calc(var(--app-vh, 100vh) - 160px);
  }
  .help-nav {
    width: 100%;
    max-height: 30%;
    flex-shrink: 0;
    border-inline-end: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }
  .help-content {
    padding: 16px 16px 32px;
  }
}
.help-center {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* ----------------------------------------------------------------------- */
/* Markdown typography — reads like the rest of Cockpit (Vuetify Material) */
/* ----------------------------------------------------------------------- */
.help-markdown {
  font-size: 0.94rem;
  line-height: 1.75;
  color: rgb(var(--v-theme-on-surface));
}
.help-markdown :deep(> :first-child) {
  margin-top: 0;
}
.help-markdown :deep(h1) {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  margin: 0 0 18px;
}
.help-markdown :deep(h2) {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.008em;
  margin: 30px 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.help-markdown :deep(h3) {
  font-size: 1.04rem;
  font-weight: 600;
  margin: 22px 0 10px;
}
.help-markdown :deep(h4) {
  font-size: 0.96rem;
  font-weight: 600;
  margin: 18px 0 8px;
}
.help-markdown :deep(h1 code),
.help-markdown :deep(h2 code),
.help-markdown :deep(h3 code) {
  font-size: 0.9em;
}
.help-markdown :deep(p) {
  margin: 0 0 14px;
}
.help-markdown :deep(ul),
.help-markdown :deep(ol) {
  margin: 0 0 14px;
  padding-inline-start: 26px;
}
.help-markdown :deep(li) {
  margin: 5px 0;
}
.help-markdown :deep(li > p) {
  margin: 0 0 6px;
}
.help-markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  border-bottom: 1px solid rgba(var(--v-theme-primary), 0.35);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.help-markdown :deep(a:hover) {
  border-bottom-color: rgb(var(--v-theme-primary));
}
.help-markdown :deep(strong) {
  font-weight: 700;
}
.help-markdown :deep(code) {
  font-size: 0.85em;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(var(--v-theme-surface-variant), 0.65);
  color: rgb(var(--v-theme-on-surface));
}
.help-markdown :deep(pre) {
  position: relative;
  margin: 0 0 18px;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(var(--v-theme-surface-variant), 0.55);
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  overflow-x: auto;
}
.help-markdown :deep(pre code) {
  display: block;
  padding: 0;
  background: transparent;
  font-size: 0.85rem;
  line-height: 1.65;
}
.help-markdown :deep(blockquote) {
  margin: 0 0 18px;
  padding: 10px 18px;
  border-inline-start: 3px solid rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.07);
  border-radius: 0 10px 10px 0;
  color: rgba(var(--v-theme-on-surface), 0.86);
}
.help-markdown :deep(blockquote > :last-child) {
  margin-bottom: 0;
}
.help-markdown :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 18px;
  font-size: 0.9rem;
}
.help-markdown :deep(th),
.help-markdown :deep(td) {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 9px 14px;
  text-align: start;
  vertical-align: top;
}
.help-markdown :deep(th) {
  background: rgba(var(--v-theme-surface-variant), 0.55);
  font-weight: 600;
}
.help-markdown :deep(tbody tr:nth-child(even)) {
  background: rgba(var(--v-theme-surface-variant), 0.18);
}
.help-markdown :deep(img) {
  max-width: 100%;
  border-radius: 10px;
}
.help-markdown :deep(hr) {
  border: none;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  margin: 26px 0;
}
.help-markdown :deep(kbd) {
  display: inline-block;
  padding: 1px 7px;
  font-size: 0.8em;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.5);
}

/* highlight.js tokens — derived from the active Vuetify theme, so the code
   block stays cohesive across all 10 color schemes. */
.help-markdown :deep(.hljs-comment),
.help-markdown :deep(.hljs-quote) {
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-style: italic;
}
.help-markdown :deep(.hljs-keyword),
.help-markdown :deep(.hljs-selector-tag),
.help-markdown :deep(.hljs-doctag),
.help-markdown :deep(.hljs-meta) {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.help-markdown :deep(.hljs-string),
.help-markdown :deep(.hljs-regexp),
.help-markdown :deep(.hljs-addition) {
  color: rgb(var(--v-theme-success));
}
.help-markdown :deep(.hljs-number),
.help-markdown :deep(.hljs-literal),
.help-markdown :deep(.hljs-symbol),
.help-markdown :deep(.hljs-bullet) {
  color: rgb(var(--v-theme-warning));
}
.help-markdown :deep(.hljs-title),
.help-markdown :deep(.hljs-section),
.help-markdown :deep(.hljs-function .hljs-title),
.help-markdown :deep(.hljs-title.function_) {
  color: rgb(var(--v-theme-secondary));
}
.help-markdown :deep(.hljs-attr),
.help-markdown :deep(.hljs-attribute),
.help-markdown :deep(.hljs-variable),
.help-markdown :deep(.hljs-template-variable) {
  color: rgb(var(--v-theme-tertiary));
}
.help-markdown :deep(.hljs-type),
.help-markdown :deep(.hljs-built_in),
.help-markdown :deep(.hljs-class .hljs-title) {
  color: rgb(var(--v-theme-info));
}
.help-markdown :deep(.hljs-tag),
.help-markdown :deep(.hljs-name),
.help-markdown :deep(.hljs-selector-id),
.help-markdown :deep(.hljs-selector-class) {
  color: rgb(var(--v-theme-primary));
}
.help-markdown :deep(.hljs-deletion) {
  color: rgb(var(--v-theme-error));
}
.help-markdown :deep(.hljs-emphasis) {
  font-style: italic;
}
.help-markdown :deep(.hljs-strong) {
  font-weight: 700;
}
</style>
