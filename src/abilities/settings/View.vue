<script setup lang="ts">
defineOptions({ name: 'CockpitSettings' })

import {
  computed,
  inject,
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
import { translate, translateTemplate } from '@ui/i18n'
import { scoreFields, type SearchField } from '@ui/composables/search'
import { settingsSessionMemory } from './session-memory'

/**
 * Settings page — consumes the injection list built & provided by App.vue
 * (`cockpit:settings`), so it never re-scans ability modules. Layout:
 *
 *   level 1  top row: search box + horizontally scrollable category chips
 *   level 2  the active category's items rendered inline (grid) — no drilling
 *
 * Search matches category labels AND item-level content; matched items are
 * shown inline under their category. All mutations stay CLI-first: they go
 * through `window.cockpit.command` / its command-backed wrappers.
 */

const injected = inject<Ref<SettingsCategory[]>>('cockpit:settings', ref([]))
const sections = computed<SettingsCategory[]>(() => injected.value)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

// ---------------------------------------------------------------------------
// Single-launch memory: module-level (see settingsSessionMemory above) so it
// survives remounts — this page is NOT keep-alive'd, so component state would
// reset every time you leave and come back.
// ---------------------------------------------------------------------------
const mem = settingsSessionMemory
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null

const query = ref('')
const activeCategoryId = ref<string | null>(mem.category)

function findScroller(): HTMLElement | null {
  // The scroller is the shared `v-main scrollable` → `.v-main__scroller` in
  // App.vue. Fall back to the window if not found.
  const main = document.querySelector<HTMLElement>('.v-main__scroller')
  if (main) return main
  return document.documentElement
}
function saveScroll(el: HTMLElement): void {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(() => {
    mem.scroll = el.scrollTop
  }, 200)
}
function restoreScroll(): void {
  const el = findScroller()
  if (el && mem.scroll > 0) el.scrollTop = mem.scroll
}

function isMdiIcon(icon: string): boolean {
  return icon.startsWith('mdi')
}

watch(sections, (list) => {
  if (list.length && !activeCategoryId.value) activeCategoryId.value = list[0].id
})

watch(activeCategoryId, (id) => {
  if (id) mem.category = id
})

const trimmed = computed(() => query.value.trim())
const searching = computed(() => trimmed.value.length > 0)

const activeCategory = computed<SettingsCategory | null>(() => {
  if (!sections.value.length) return null
  return sections.value.find((c) => c.id === activeCategoryId.value) ?? sections.value[0]
})

function catFields(cat: SettingsCategory): SearchField[] {
  const kw = [...cat.keywords].join(' ')
  const f: SearchField[] = [
    { text: cat.label.toLowerCase(), weight: 3 },
    { text: cat.description.toLowerCase(), weight: 2 }
  ]
  if (kw) f.push({ text: kw.toLowerCase(), weight: 1 })
  return f
}

function itemFields(item: SettingsItem): SearchField[] {
  const kw = [...item.keywords].join(' ')
  const f: SearchField[] = [
    { text: item.label.toLowerCase(), weight: 3 },
    { text: item.description.toLowerCase(), weight: 2 }
  ]
  if (kw) f.push({ text: kw.toLowerCase(), weight: 1 })
  return f
}

function catMatches(cat: SettingsCategory, q: string): boolean {
  return (
    scoreFields(q, catFields(cat)) > 0 ||
    cat.items.some((i) => itemFields(i).length && scoreFields(q, itemFields(i)) > 0)
  )
}

/** Categories that survive the query — drives the top chips. */
const filteredCategories = computed(() => {
  const q = trimmed.value
  if (!q) return sections.value
  return sections.value.filter((c) => catMatches(c, q))
})

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

function selectCategory(id: string): void {
  activeCategoryId.value = id
  query.value = ''
}

// -- single-launch memory lifecycle -------------------------------------------
function captureScroll(): void {
  const el = findScroller()
  if (el) saveScroll(el)
}
// Persist the scroll offset when leaving the page (keep-alive deactivate) and
// when the window itself is closing; restore it on return.
function bindScroll(on: boolean): void {
  const el = findScroller()
  if (!el) return
  if (on) el.addEventListener('scroll', captureScroll)
  else el.removeEventListener('scroll', captureScroll)
}
onMounted(() => {
  restoreScroll()
  bindScroll(true)
})
onActivated(() => {
  restoreScroll()
  bindScroll(true)
})
onDeactivated(() => {
  captureScroll()
  bindScroll(false)
})
onBeforeUnmount(() => {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = null
  bindScroll(false)
})

/** 每个设置项组件的实例（ref 收集），用于 toMarkdown 深入导出当前配置值。 */
const itemRefs = new Map<string, ComponentPublicInstance | null>()

function setItemRef(el: unknown, itemId: string): void {
  itemRefs.set(itemId, (el as ComponentPublicInstance | null) ?? null)
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
    const label = translate(uiLang.value, 'label.' + cat.label, cat.label)
    const desc = catDesc(cat)
    lines.push('', `### ${label}${desc ? ` — ${desc}` : ''}`)
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

defineExpose({ toMarkdown })
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">
      {{ translate(uiLang, 'ability.settings.name') }}
    </div>
    <div class="text-caption on-surface-variant mb-4">
      {{ translate(uiLang, 'settings.caption') }}
    </div>

    <!-- Level 1: top row — search box + horizontally scrollable category chips -->
    <div class="settings-topbar d-flex align-center ga-3 mb-4">
      <v-text-field
        v-model="query"
        prepend-inner-icon="mdi-magnify"
        :placeholder="translate(uiLang, 'settings.searchPlaceholder')"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        clearable
        rounded="lg"
        class="settings-search"
        @click:clear="query = ''"
      />
      <v-slide-group
        v-if="sections.length > 1 || searching"
        show-arrows
        class="settings-chips flex-grow-1"
      >
        <v-slide-group-item v-for="cat in filteredCategories" :key="cat.id">
          <v-chip
            :active="!searching && activeCategoryId === cat.id"
            variant="flat"
            rounded="lg"
            class="mx-1"
            @click="selectCategory(cat.id)"
          >
            <v-icon v-if="isMdiIcon(cat.icon)" start size="18">{{ cat.icon }}</v-icon>
            <AbilityIcon v-else :icon="cat.icon" :size="18" class="mr-1" />
            {{ translate(uiLang, 'label.' + cat.label, cat.label) }}
          </v-chip>
        </v-slide-group-item>
      </v-slide-group>
    </div>

    <!-- Search mode: matched categories, matched items rendered inline -->
    <template v-if="searching">
      <div v-if="resultGroups.length">
        <div class="text-caption on-surface-variant mb-3">
          {{ translateTemplate(uiLang, 'settings.resultCount', { n: String(resultCount) }) }}
        </div>
        <div v-for="g in resultGroups" :key="g.category.id" class="mb-4">
          <div class="d-flex align-center ga-2 mb-2">
            <v-icon v-if="isMdiIcon(g.category.icon)" size="16">{{ g.category.icon }}</v-icon>
            <AbilityIcon v-else :icon="g.category.icon" :size="16" />
            <span class="text-caption font-weight-medium">{{
              translate(uiLang, 'label.' + g.category.label, g.category.label)
            }}</span>
            <span class="text-caption on-surface-variant">·</span>
            <span class="text-caption on-surface-variant">{{ g.category.abilityName }}</span>
          </div>
          <v-row dense>
            <v-col v-for="item in g.items" :key="item.id" cols="12" :md="item.fullWidth ? 12 : 6">
              <component :is="item.component" :ref="(el) => setItemRef(el, item.id)" />
            </v-col>
          </v-row>
        </div>
      </div>
      <v-empty-state
        v-else
        icon="mdi-magnify-close"
        :title="translate(uiLang, 'settings.searchEmpty')"
        :text="translate(uiLang, 'settings.searchEmptyText')"
      />
    </template>

    <!-- Level 2: active category's items, all rendered inline -->
    <template v-else-if="activeCategory">
      <div class="d-flex align-center ga-2 mb-3">
        <v-icon v-if="isMdiIcon(activeCategory.icon)" size="20">{{ activeCategory.icon }}</v-icon>
        <AbilityIcon v-else :icon="activeCategory.icon" :size="20" />
        <span class="text-subtitle-1 font-weight-medium">{{
          translate(uiLang, 'label.' + activeCategory.label, activeCategory.label)
        }}</span>
        <span v-if="activeCategory.description" class="text-caption on-surface-variant ml-2">
          {{ translate(uiLang, 'desc.' + activeCategory.id, activeCategory.description) }}
        </span>
      </div>
      <v-row dense>
        <v-col
          v-for="item in activeCategory.items"
          :key="item.id"
          cols="12"
          :md="item.fullWidth ? 12 : 6"
        >
          <component :is="item.component" :ref="(el) => setItemRef(el, item.id)" />
        </v-col>
      </v-row>
    </template>

    <v-empty-state
      v-else
      icon="mdi-tune"
      :title="translate(uiLang, 'settings.empty')"
      :text="translate(uiLang, 'settings.emptyText')"
    />
  </div>
</template>

<style scoped>
.settings-search {
  max-width: 320px;
  flex-shrink: 0;
}

.settings-chips {
  min-width: 0;
}
</style>
