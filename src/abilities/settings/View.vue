<script setup lang="ts">
defineOptions({ name: 'cockpit-settings' })

import {
  computed,
  inject,
  nextTick,
  ref,
  watch,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount
} from 'vue'
import type { Ref, ComponentPublicInstance } from 'vue'
import type { SettingsCategory, SettingsItem } from '@ui/ability-registry'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import SettingsCategoryView from '@ui/components/SettingsCategoryView.vue'
import { translate, translateTemplate } from '@ui/i18n'
import { scoreFields, type SearchField } from '@ui/composables/search'
import { settingsSessionMemory } from './session-memory'

/**
 * Settings page — consumes the injection list built & provided by App.vue
 * (`cockpit:settings`), so it never re-scans ability modules.
 *
 * Master-detail layout (AGENTS §11.8): a grouped, searchable category nav on
 * the left (「通用」= the settings ability's own sections, then one group per
 * ability sidebar category) and the active category on the right. Below
 * NARROW_PX of container width the nav collapses into a picker on top — no
 * horizontal scrolling. Search filters the nav and shows matching items inline.
 *
 * Other abilities open their own category via `useSettings().open(id)`, which
 * navigates here and calls `onActivate({ category, item })`.
 */

const NARROW_PX = 620

const injected = inject<Ref<SettingsCategory[]>>('cockpit:settings', ref([]))
const sections = computed<SettingsCategory[]>(() => injected.value)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// ---------------------------------------------------------------------------
// Single-launch memory (module-level, survives remounts — page isn't cached)
// ---------------------------------------------------------------------------
const mem = settingsSessionMemory
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null

const query = ref('')
const activeCategoryId = ref<string | null>(mem.category)
const highlight = ref<string | null>(null)

/** 右侧内容区自己滚动（页面本身不滚动，见 .settings-view）。 */
const contentEl = ref<HTMLElement | null>(null)
function findScroller(): HTMLElement | null {
  return contentEl.value
}
function saveScroll(el: HTMLElement): void {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  const id = activeCategoryId.value
  scrollSaveTimer = setTimeout(() => {
    if (id && id === activeCategoryId.value) mem.scrolls[id] = el.scrollTop
  }, 200)
}
function restoreScroll(): void {
  const el = findScroller()
  const top = activeCategoryId.value ? (mem.scrolls[activeCategoryId.value] ?? 0) : 0
  if (el && top > 0) el.scrollTop = top
}

function isMdiIcon(icon: string): boolean {
  return icon.startsWith('mdi')
}

watch(
  sections,
  (list) => {
    if (list.length && !list.some((c) => c.id === activeCategoryId.value)) {
      activeCategoryId.value = list[0].id
    }
  },
  { immediate: true }
)

watch(activeCategoryId, (id) => {
  if (id) mem.category = id
})

const trimmed = computed(() => query.value.trim().toLowerCase())
const searching = computed(() => trimmed.value.length > 0)

const activeCategory = computed<SettingsCategory | null>(() => {
  if (!sections.value.length) return null
  return sections.value.find((c) => c.id === activeCategoryId.value) ?? sections.value[0]
})

function catLabel(cat: SettingsCategory): string {
  return t('label.' + cat.label, cat.label)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function catFields(cat: SettingsCategory): SearchField[] {
  return [
    { text: catLabel(cat).toLowerCase(), weight: 3 },
    { text: cat.label.toLowerCase(), weight: 3 },
    { text: cat.abilityName.toLowerCase(), weight: 2 },
    { text: cat.description.toLowerCase(), weight: 2 },
    { text: cat.keywords.join(' ').toLowerCase(), weight: 1 }
  ].filter((f) => f.text)
}

function itemFields(item: SettingsItem): SearchField[] {
  return [
    { text: t('label.' + item.label, item.label).toLowerCase(), weight: 3 },
    { text: item.label.toLowerCase(), weight: 3 },
    { text: item.description.toLowerCase(), weight: 2 },
    { text: item.keywords.join(' ').toLowerCase(), weight: 1 }
  ].filter((f) => f.text)
}

/** Items to show for a category during search: matches, else all when the
 *  category itself matched. */
function itemsForSearch(cat: SettingsCategory, q: string): SettingsItem[] {
  const matched = cat.items.filter((i) => scoreFields(q, itemFields(i)) > 0)
  if (matched.length) return matched
  return scoreFields(q, catFields(cat)) > 0 ? cat.items : []
}

const resultGroups = computed(() => {
  const q = trimmed.value
  if (!q) return []
  return sections.value
    .map((cat) => ({ category: cat, items: itemsForSearch(cat, q) }))
    .filter((g) => g.items.length)
})

const resultCount = computed(() => resultGroups.value.reduce((n, g) => n + g.items.length, 0))

// ---------------------------------------------------------------------------
// Grouped nav: 「通用」(settings' own) first, then ability categories A→Z
// ---------------------------------------------------------------------------
interface NavGroup {
  label: string
  categories: SettingsCategory[]
}

const navGroups = computed<NavGroup[]>(() => {
  const visible = searching.value ? resultGroups.value.map((g) => g.category) : sections.value
  const general: SettingsCategory[] = []
  const byGroup = new Map<string, SettingsCategory[]>()
  for (const cat of visible) {
    if (cat.abilityId === 'settings') {
      general.push(cat)
      continue
    }
    const g = cat.abilityCategory || t('settings.group.other', '其他')
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(cat)
  }
  const lang = uiLang.value
  const groups: NavGroup[] = [...byGroup]
    .sort(([a], [b]) => a.localeCompare(b, lang))
    .map(([label, cats]) => ({
      label,
      categories: cats.sort((a, b) => catLabel(a).localeCompare(catLabel(b), lang))
    }))
  if (general.length)
    groups.unshift({ label: t('settings.group.general', '通用'), categories: general })
  return groups
})

/** Narrow-mode picker items (grouped via subheaders). */
const pickerItems = computed(() =>
  navGroups.value.flatMap((g) => [
    { type: 'subheader' as const, title: g.label },
    ...g.categories.map((c) => ({ title: catLabel(c), value: c.id }))
  ])
)

function selectCategory(id: string): void {
  const el = findScroller()
  const prev = activeCategoryId.value
  if (el && prev && !searching.value) mem.scrolls[prev] = el.scrollTop
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  activeCategoryId.value = id
  highlight.value = null
  query.value = ''
  // 每个分类回到自己上次的位置（没来过 = 顶部），渲染后再定位
  void nextTick(() => {
    const target = findScroller()
    if (target) target.scrollTop = mem.scrolls[id] ?? 0
  })
}

/**
 * Called by the shell when another ability opens its settings
 * (`useSettings().open(...)` → `activate('settings', { category, item })`).
 */
function onActivate(target: unknown): void {
  const tgt = (target ?? {}) as { category?: unknown; item?: unknown }
  const id = typeof tgt.category === 'string' ? tgt.category : null
  if (!id || !sections.value.some((c) => c.id === id)) return
  selectCategory(id)
  highlight.value = typeof tgt.item === 'string' ? tgt.item : null
}

// ---------------------------------------------------------------------------
// Responsive: container width, not window breakpoints (AGENTS §11.8)
// ---------------------------------------------------------------------------
const rootEl = ref<HTMLElement | null>(null)
const narrow = ref(false)
let ro: ResizeObserver | null = null

/**
 * 铺满宿主可视区、左右各自滚动（同 campusinfo / AIDJ）：根元素绝对定位，
 * 宿主包裹层的 min-height 临时置 0，避免外层再出一条滚动条；离开页面时还原。
 */
function holdHost(): void {
  const wrap = rootEl.value?.parentElement
  if (wrap) wrap.style.minHeight = '0px'
}
function releaseHost(): void {
  const wrap = rootEl.value?.parentElement
  if (wrap) wrap.style.minHeight = ''
}

// -- single-launch memory lifecycle -------------------------------------------
function captureScroll(): void {
  const el = findScroller()
  if (el) saveScroll(el)
}
function bindScroll(on: boolean): void {
  const el = findScroller()
  if (!el) return
  if (on) el.addEventListener('scroll', captureScroll)
  else el.removeEventListener('scroll', captureScroll)
}
onMounted(() => {
  holdHost()
  restoreScroll()
  bindScroll(true)
  if (rootEl.value) {
    ro = new ResizeObserver(([entry]) => {
      narrow.value = entry.contentRect.width < NARROW_PX
    })
    ro.observe(rootEl.value)
  }
})
onActivated(() => {
  holdHost()
  restoreScroll()
  bindScroll(true)
})
onDeactivated(() => {
  captureScroll()
  bindScroll(false)
  releaseHost()
})
onBeforeUnmount(() => {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = null
  bindScroll(false)
  releaseHost()
  ro?.disconnect()
})

/** 每个设置项组件的实例（ref 收集），用于 toMarkdown 深入导出当前配置值。 */
const itemRefs = new Map<string, ComponentPublicInstance | null>()
function setItemRef(id: string, inst: ComponentPublicInstance | null): void {
  itemRefs.set(id, inst)
}

/** 分类 / 设置项的描述（走 desc.<id> 翻译，回退原文）。 */
function catDesc(cat: SettingsCategory): string {
  return translate(uiLang.value, 'desc.' + cat.id, cat.description)
}
function itemDesc(item: SettingsItem): string {
  return translate(uiLang.value, 'desc.' + item.id, item.description)
}

/** 设置项组件可选的深入导出钩子：返回当前配置值的 markdown 文本。 */
type MarkdownExport = { toMarkdown?: () => string }

/** Export all injected settings sections as markdown: labels + descriptions
 *  (localized), and — when an item component exposes `toMarkdown()` — the
 *  actual current configuration values. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'settings.mdHeading')]
  if (sections.value.length === 0) {
    lines.push(`- ${translate(uiLang.value, 'settings.empty')}`)
    return lines.join('\n')
  }
  for (const cat of sections.value) {
    const desc = catDesc(cat)
    lines.push('', `### ${catLabel(cat)}${desc ? ` — ${desc}` : ''}`)
    for (const item of cat.items) {
      const ilabel = translate(uiLang.value, 'label.' + item.label, item.label)
      const idesc = itemDesc(item)
      const inst = itemRefs.get(item.id)
      const detail =
        inst && typeof (inst as MarkdownExport).toMarkdown === 'function'
          ? (inst as MarkdownExport).toMarkdown!()
          : ''
      const head = `- **${ilabel}**${idesc ? ` — ${idesc}` : ''}`
      lines.push(detail ? `${head}\n  ${detail}` : head)
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown, onActivate })
</script>

<template>
  <div ref="rootEl" class="settings-view d-flex flex-column">
    <!-- 窄模式不显示页头：app-bar 已有标题，把高度留给内容 -->
    <div v-if="!narrow" class="flex-shrink-0 pb-4">
      <div class="text-h6 font-weight-medium pb-1">
        {{ translate(uiLang, 'ability.settings.name') }}
      </div>
      <div class="text-body-2 on-surface-variant">
        {{ translate(uiLang, 'settings.caption') }}
      </div>
    </div>

    <div
      v-if="sections.length"
      class="settings-layout flex-grow-1 min-h-0 d-flex"
      :class="narrow ? 'flex-column' : 'ga-4'"
    >
      <!-- 宽：左侧分组导航（自己滚动）；窄：顶部搜索 + 分类下拉（固定） -->
      <aside v-if="!narrow" class="settings-nav d-flex flex-column min-h-0 flex-shrink-0">
        <v-text-field
          v-model="query"
          prepend-inner-icon="mdi-magnify"
          :placeholder="translate(uiLang, 'settings.searchPlaceholder')"
          variant="solo-filled"
          flat
          hide-details
          clearable
          rounded="lg"
          class="flex-shrink-0 pb-2"
          @click:clear="query = ''"
        />
        <v-list nav class="settings-nav-list pa-0 min-h-0" bg-color="transparent">
          <template v-for="g in navGroups" :key="g.label">
            <v-list-subheader class="settings-nav-group">{{ g.label }}</v-list-subheader>
            <v-list-item
              v-for="cat in g.categories"
              :key="cat.id"
              :active="!searching && activeCategory?.id === cat.id"
              rounded="lg"
              color="primary"
              density="compact"
              class="settings-nav-item"
              @click="selectCategory(cat.id)"
            >
              <template #prepend>
                <v-icon v-if="isMdiIcon(cat.icon)" size="18">{{ cat.icon }}</v-icon>
                <AbilityIcon v-else :icon="cat.icon" :size="18" />
              </template>
              <v-list-item-title>{{ catLabel(cat) }}</v-list-item-title>
            </v-list-item>
          </template>
          <div
            v-if="searching && !navGroups.length"
            class="text-body-2 on-surface-variant px-3 py-2"
          >
            {{ translate(uiLang, 'settings.searchEmpty') }}
          </div>
        </v-list>
      </aside>

      <div v-else class="settings-narrow-bar d-flex flex-wrap ga-2 pb-3 flex-shrink-0">
        <v-text-field
          v-model="query"
          prepend-inner-icon="mdi-magnify"
          :placeholder="translate(uiLang, 'settings.searchPlaceholder')"
          variant="solo-filled"
          flat
          hide-details
          clearable
          rounded="lg"
          @click:clear="query = ''"
        />
        <v-select
          v-if="!searching"
          :model-value="activeCategory?.id"
          :items="pickerItems"
          :aria-label="t('settings.jumpTo', '设置分类')"
          variant="solo-filled"
          flat
          rounded="lg"
          hide-details
          @update:model-value="(id: string) => selectCategory(id)"
        />
      </div>

      <!-- 内容：自己滚动 -->
      <section ref="contentEl" class="settings-content flex-grow-1 min-w-0 min-h-0">
        <template v-if="searching">
          <template v-if="resultGroups.length">
            <div class="text-body-2 on-surface-variant pb-3">
              {{ translateTemplate(uiLang, 'settings.resultCount', { n: String(resultCount) }) }}
            </div>
            <SettingsCategoryView
              v-for="g in resultGroups"
              :key="g.category.id"
              :category="g.category"
              :items="g.items"
              compact-header
              class="pb-6"
              @item-ref="setItemRef"
            />
          </template>
          <v-empty-state
            v-else
            icon="mdi-magnify-close"
            :title="translate(uiLang, 'settings.searchEmpty')"
            :text="translate(uiLang, 'settings.searchEmptyText')"
          />
        </template>
        <SettingsCategoryView
          v-else-if="activeCategory"
          :key="activeCategory.id"
          :category="activeCategory"
          :highlight="highlight"
          :compact-header="narrow"
          @item-ref="setItemRef"
        />
      </section>
    </div>

    <v-empty-state
      v-else
      icon="mdi-tune"
      :title="translate(uiLang, 'settings.empty')"
      :text="translate(uiLang, 'settings.emptyText')"
    />
  </div>
</template>

<style scoped>
/* 铺满宿主滚动容器的可视区；inset 16px 对应宿主 v-container 的 pa-4（同 campusinfo） */
.settings-view {
  position: absolute;
  inset: 16px;
  overflow: hidden;
  min-width: 0;
}
.settings-nav {
  width: 200px;
}
.settings-nav-list {
  overflow-y: auto;
  flex: 1 1 auto;
}
.settings-nav-group {
  min-height: 32px;
  padding-top: 8px;
}
.settings-nav-item {
  min-height: 36px;
  margin-bottom: 2px !important;
}
.settings-narrow-bar > * {
  flex: 1 1 180px;
  min-width: 0;
}
.settings-content {
  overflow-y: auto;
  /* 给滚动条留出空间，内容不贴着滚动条 */
  padding-right: 8px;
}
</style>
