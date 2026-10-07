<script setup lang="ts">
/**
 * 模型自带搜索（Gemini google_search / Claude web_search …）的查询词与引用来源。
 * 来自 assistant 节点的 `meta.search`；默认收起成一行，点开列出来源链接（在外部浏览器打开）。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { BuiltinSearchInfo } from '../services/providers/types'

const props = defineProps<{ search: BuiltinSearchInfo }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const open = ref(false)

const summary = computed(() => {
  const n = props.search.sources.length
  return n
    ? te('yaya.search_sources.count', { n: String(n) }, '模型内置搜索 · {n} 个来源')
    : t('yaya.search_sources.none', '模型内置搜索')
})

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function openLink(url: string): void {
  void window.cockpit.openExternal(url)
}
</script>

<template>
  <div class="search-sources">
    <button
      type="button"
      class="ss-head"
      :aria-expanded="open"
      :disabled="!search.sources.length && !search.queries.length"
      @click="open = !open"
    >
      <v-icon icon="mdi-web" size="16" color="primary" />
      <span class="ss-summary">{{ summary }}</span>
      <span v-if="search.queries.length && !open" class="ss-queries">
        {{ search.queries.join(' · ') }}
      </span>
      <v-icon
        v-if="search.sources.length || search.queries.length"
        :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        size="16"
        class="ss-chev"
      />
    </button>
    <div v-if="open" class="ss-body">
      <div v-if="search.queries.length" class="ss-query-list">
        <span class="ss-label">{{ t('yaya.search_sources.queries', '搜索了') }}</span>
        <span v-for="q in search.queries" :key="q" class="ss-query">{{ q }}</span>
      </div>
      <ol v-if="search.sources.length" class="ss-list">
        <li v-for="(s, i) in search.sources" :key="s.url">
          <a :href="s.url" :title="s.url" @click.prevent="openLink(s.url)">
            <span class="ss-index">{{ i + 1 }}</span>
            <span class="ss-title">{{ s.title || host(s.url) }}</span>
            <span class="ss-host">{{ host(s.url) }}</span>
          </a>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.search-sources {
  margin-top: 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  overflow: hidden;
}
.ss-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}
.ss-head:disabled {
  cursor: default;
}
.ss-summary {
  flex-shrink: 0;
  font-weight: 500;
}
.ss-queries {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.ss-chev {
  margin-left: auto;
  flex-shrink: 0;
  opacity: 0.7;
}
.ss-body {
  padding: 4px 12px 12px;
}
.ss-query-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 0.8125rem;
}
.ss-label {
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.ss-query {
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(var(--v-theme-primary), 0.1);
  overflow-wrap: anywhere;
}
.ss-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss-list a {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  font-size: 0.875rem;
  min-width: 0;
}
.ss-list a:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.ss-index {
  flex-shrink: 0;
  min-width: 18px;
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-variant-numeric: tabular-nums;
}
.ss-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: rgb(var(--v-theme-primary));
}
.ss-host {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.5);
}
</style>
