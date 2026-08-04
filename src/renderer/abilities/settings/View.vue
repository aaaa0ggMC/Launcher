<script setup lang="ts">
defineOptions({ name: 'cockpit-settings' })

import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { SettingsCategory, SettingsItem } from './registry'
import AbilityIcon from '../../components/AbilityIcon.vue'

/**
 * Settings page — consumes the injection list built & provided by App.vue
 * (`cockpit:settings`), so it never re-scans ability modules or re-reads the
 * manifest. Layout:
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

const query = ref('')
const activeCategoryId = ref<string | null>(null)

function isMdiIcon(icon: string): boolean {
  return icon.startsWith('mdi')
}

watch(sections, (list) => {
  if (list.length && !activeCategoryId.value) activeCategoryId.value = list[0].id
})

const trimmed = computed(() => query.value.trim())
const searching = computed(() => trimmed.value.length > 0)

const activeCategory = computed<SettingsCategory | null>(() => {
  if (!sections.value.length) return null
  return sections.value.find((c) => c.id === activeCategoryId.value) ?? sections.value[0]
})

function catMatches(cat: SettingsCategory, q: string): boolean {
  return cat.haystack.includes(q) || cat.items.some((i) => i.haystack.includes(q))
}

/** Categories that survive the query — drives the top chips. */
const filteredCategories = computed(() => {
  const q = trimmed.value.toLowerCase()
  if (!q) return sections.value
  return sections.value.filter((c) => catMatches(c, q))
})

/** Items to show for a category during search: matches, else all when the
 *  category itself matched. */
function itemsForSearch(cat: SettingsCategory, q: string): SettingsItem[] {
  const matched = cat.items.filter((i) => i.haystack.includes(q))
  if (matched.length) return matched
  return cat.haystack.includes(q) ? cat.items : []
}

const resultGroups = computed(() => {
  const q = trimmed.value.toLowerCase()
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
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">设置</div>
    <div class="text-caption on-surface-variant mb-4">
      设置由各能力注入 · 搜索可匹配分类与具体设置内容
    </div>

    <!-- Level 1: top row — search box + horizontally scrollable category chips -->
    <div class="settings-topbar d-flex align-center ga-3 mb-4">
      <v-text-field
        v-model="query"
        prepend-inner-icon="mdi-magnify"
        placeholder="搜索设置…"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        clearable
        rounded="lg"
        class="settings-search"
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
            {{ cat.label }}
          </v-chip>
        </v-slide-group-item>
      </v-slide-group>
    </div>

    <!-- Search mode: matched categories, matched items rendered inline -->
    <template v-if="searching">
      <div v-if="resultGroups.length">
        <div class="text-caption on-surface-variant mb-3">匹配 {{ resultCount }} 项设置</div>
        <div v-for="g in resultGroups" :key="g.category.id" class="mb-4">
          <div class="d-flex align-center ga-2 mb-2">
            <v-icon v-if="isMdiIcon(g.category.icon)" size="16">{{ g.category.icon }}</v-icon>
            <AbilityIcon v-else :icon="g.category.icon" :size="16" />
            <span class="text-caption font-weight-medium">{{ g.category.label }}</span>
            <span class="text-caption on-surface-variant">·</span>
            <span class="text-caption on-surface-variant">{{ g.category.abilityName }}</span>
          </div>
          <v-row dense>
            <v-col v-for="item in g.items" :key="item.id" cols="12" :md="item.fullWidth ? 12 : 6">
              <component :is="item.component" />
            </v-col>
          </v-row>
        </div>
      </div>
      <v-empty-state
        v-else
        icon="mdi-magnify-close"
        title="没有匹配的设置"
        text="换个关键词试试，可搜索分类名或具体设置内容"
      />
    </template>

    <!-- Level 2: active category's items, all rendered inline -->
    <template v-else-if="activeCategory">
      <div class="d-flex align-center ga-2 mb-3">
        <v-icon v-if="isMdiIcon(activeCategory.icon)" size="20">{{ activeCategory.icon }}</v-icon>
        <AbilityIcon v-else :icon="activeCategory.icon" :size="20" />
        <span class="text-subtitle-1 font-weight-medium">{{ activeCategory.label }}</span>
        <span v-if="activeCategory.description" class="text-caption on-surface-variant ml-2">
          {{ activeCategory.description }}
        </span>
      </div>
      <v-row dense>
        <v-col
          v-for="item in activeCategory.items"
          :key="item.id"
          cols="12"
          :md="item.fullWidth ? 12 : 6"
        >
          <component :is="item.component" />
        </v-col>
      </v-row>
    </template>

    <v-empty-state v-else icon="mdi-tune" title="暂无可配置项" text="当前没有能力注入设置选项" />
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
