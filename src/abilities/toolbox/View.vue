<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../main/ui/i18n'
import { filterByQuery, fields } from '../../main/ui/composables/search'
import { tools, toolById } from './registry'
import type { ToolCategory, ToolDefinition } from './types'
import ToolRunner from './components/ToolRunner.vue'
import ToolIcon from './components/ToolIcon.vue'
const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)
const english = computed(() => lang.value !== 'zh')
const query = ref('')
const category = ref<ToolCategory | 'all' | 'favorites'>('all')
const selected = ref<string | null>(null)
const favoriteIds = ref<string[]>(readIds('cockpit-toolbox-favorites'))
const recentIds = ref<string[]>(readIds('cockpit-toolbox-recent'))
const active = computed(() => (selected.value ? toolById.get(selected.value) : undefined))
const categories: (ToolCategory | 'all' | 'favorites')[] = [
  'all',
  'favorites',
  'time',
  'developer',
  'text',
  'image',
  'files',
  'leisure'
]
const icons: Record<string, string> = {
  all: 'mdi-view-grid-outline',
  favorites: 'mdi-star-outline',
  time: 'mdi-clock-outline',
  developer: 'mdi-code-braces',
  text: 'mdi-text',
  image: 'mdi-image-outline',
  files: 'mdi-file-document-outline',
  leisure: 'mdi-timer-outline'
}
function readIds(key: string): string[] {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(data)
      ? data.filter((id) => typeof id === 'string' && toolById.has(id))
      : []
  } catch {
    return []
  }
}
function persist(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    /* Favorites remain available this session. */
  }
}
function title(tool: ToolDefinition): string {
  return english.value ? tool.titleEn : tool.title
}
const visible = computed(() =>
  filterByQuery(
    tools.filter(
      (tool) =>
        category.value === 'all' ||
        (category.value === 'favorites'
          ? favoriteIds.value.includes(tool.id)
          : tool.category === category.value)
    ),
    query.value,
    (tool) =>
      fields(
        tool.title,
        [
          tool.id,
          tool.title.replace(/\s+/g, ''),
          tool.titleEn,
          tool.titleEn.replace(/\s+/g, ''),
          ...tool.keywords
        ].join(' '),
        tool.description
      )
  )
)
const recent = computed(() =>
  recentIds.value
    .map((id) => toolById.get(id))
    .filter((tool): tool is ToolDefinition => !!tool)
    .slice(0, 6)
)
function open(id: string): void {
  if (!toolById.has(id)) return
  selected.value = id
  recentIds.value = [id, ...recentIds.value.filter((v) => v !== id)].slice(0, 12)
  persist('cockpit-toolbox-recent', recentIds.value)
}
function toggleFavorite(id: string): void {
  favoriteIds.value = favoriteIds.value.includes(id)
    ? favoriteIds.value.filter((v) => v !== id)
    : [...favoriteIds.value, id]
  persist('cockpit-toolbox-favorites', favoriteIds.value)
}
function onActivate(target: unknown): void {
  if (target && typeof target === 'object' && 'tool' in target && typeof target.tool === 'string')
    open(target.tool)
}
defineExpose({ onActivate })
</script>

<template>
  <div class="toolbox-page">
    <template v-if="active">
      <div class="tool-heading">
        <v-btn
          density="default"
          variant="text"
          prepend-icon="mdi-arrow-left"
          @click="selected = null"
          >{{ t('toolbox.back') }}</v-btn
        >
        <v-spacer />
        <v-btn
          density="default"
          :variant="favoriteIds.includes(active.id) ? 'tonal' : 'text'"
          :prepend-icon="favoriteIds.includes(active.id) ? 'mdi-star' : 'mdi-star-outline'"
          @click="toggleFavorite(active.id)"
          >{{
            favoriteIds.includes(active.id) ? t('toolbox.favorited') : t('toolbox.favorite')
          }}</v-btn
        >
      </div>
      <div class="mb-6">
        <div class="d-flex align-center ga-3 mb-3">
          <ToolIcon :icon="active.icon" :size="32" />
          <h1 class="text-h5 font-weight-bold">{{ title(active) }}</h1>
        </div>
        <p class="text-body-1 text-medium-emphasis">
          {{ english ? (active.descriptionEn ?? active.description) : active.description }}
        </p>
      </div>
      <ToolRunner :key="active.id" :tool="active" />
    </template>
    <template v-else>
      <div class="directory-heading">
        <div>
          <h1 class="text-h4 font-weight-bold mb-3">{{ t('toolbox.title') }}</h1>
          <p class="text-body-1 text-medium-emphasis">{{ t('toolbox.subtitle') }}</p>
        </div>
        <v-chip
          density="default"
          prepend-icon="mdi-shield-check-outline"
          color="success"
          variant="tonal"
          >{{ t('toolbox.offline') }}</v-chip
        >
      </div>
      <v-text-field
        v-model="query"
        :label="t('toolbox.search')"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        clearable
        hide-details
        @keydown.enter="visible[0] && open(visible[0].id)"
      />
      <div class="category-buttons">
        <v-btn
          v-for="item in categories"
          :key="item"
          density="default"
          :variant="category === item ? 'tonal' : 'text'"
          :color="category === item ? 'primary' : undefined"
          :prepend-icon="icons[item]"
          @click="category = item"
          >{{ t(`toolbox.category.${item}`) }}</v-btn
        >
      </div>
      <div v-if="recent.length && !query && category === 'all'" class="recent-section">
        <h2 class="text-subtitle-1 font-weight-bold mb-3">{{ t('toolbox.recent') }}</h2>
        <div class="d-flex flex-wrap ga-3">
          <v-btn
            v-for="tool in recent"
            :key="tool.id"
            density="default"
            variant="tonal"
            @click="open(tool.id)"
            ><template #prepend><ToolIcon :icon="tool.icon" :size="20" /></template
            >{{ title(tool) }}</v-btn
          >
        </div>
      </div>
      <div class="d-flex align-center flex-wrap ga-3 mb-4">
        <h2 class="text-h6">{{ t(`toolbox.category.${category}`) }}</h2>
        <span class="text-body-2 text-medium-emphasis"
          >{{ visible.length }} {{ t('toolbox.tools') }}</span
        >
      </div>
      <div class="tool-grid">
        <v-card
          v-for="tool in visible"
          :key="tool.id"
          variant="outlined"
          class="tool-card pa-5"
          role="button"
          tabindex="0"
          @click="open(tool.id)"
          @keydown.enter.prevent="open(tool.id)"
          @keydown.space.prevent="open(tool.id)"
        >
          <div class="d-flex align-center ga-3 mb-4">
            <ToolIcon :icon="tool.icon" :size="28" /><v-spacer /><v-btn
              density="default"
              :icon="favoriteIds.includes(tool.id) ? 'mdi-star' : 'mdi-star-outline'"
              variant="text"
              size="small"
              :aria-label="`${t('toolbox.favorite')}: ${title(tool)}`"
              @click.stop="toggleFavorite(tool.id)"
              @keydown.stop
            />
          </div>
          <h3 class="text-subtitle-1 font-weight-bold mb-2">{{ title(tool) }}</h3>
          <p class="text-body-2 text-medium-emphasis tool-description">
            {{ english ? (tool.descriptionEn ?? tool.description) : tool.description }}
          </p>
          <div class="text-caption text-medium-emphasis mt-4">
            {{ t(`toolbox.category.${tool.category}`)
            }}<span v-if="tool.dependency"> · {{ tool.dependency }}</span
            ><span v-if="tool.network"> · {{ t('toolbox.network') }}</span>
          </div>
        </v-card>
      </div>
      <v-alert v-if="!visible.length" type="info" variant="tonal" :text="t('toolbox.empty')" />
      <p class="text-caption text-medium-emphasis mt-6">{{ t('toolbox.privacyNote') }}</p>
    </template>
  </div>
</template>

<style scoped>
.toolbox-page {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: 8px 8px 24px;
}
.directory-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 20px;
  margin-bottom: 28px;
}
.directory-heading .v-chip {
  padding-block: 4px;
  min-height: 32px;
}
.category-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 20px 0 28px;
}
.recent-section {
  margin-bottom: 32px;
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 20px;
}
.tool-card {
  cursor: pointer;
  min-height: 208px;
  transition: border-color 0.18s;
}
.tool-card:hover,
.tool-card:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: 2px solid rgba(var(--v-theme-primary), 0.3);
  outline-offset: 2px;
}
.tool-description {
  line-height: 1.65;
}
.tool-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
</style>
