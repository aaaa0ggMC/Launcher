<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolViewProps } from '../../components/plugin-ui'

defineOptions({ name: 'yaya-tool-search-result' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

interface HitRow {
  title: string
  url: string
  snippet: string
  engines: string[]
}

interface EngineRow {
  id: string
  ok: boolean
  error: string
}

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 失败结果（display 兜底成 { text }）时只显示一段文字 */
const errorText = computed<string>(() => {
  const res = props.call.result as { text?: unknown; hits?: unknown } | undefined
  if (res && Array.isArray(res.hits)) return ''
  return str(res?.text)
})

const answer = computed<string>(() => str((props.call.result as { answer?: unknown })?.answer))

const citations = computed<{ title: string; url: string }[]>(() => {
  const list = (props.call.result as { citations?: unknown })?.citations
  if (!Array.isArray(list)) return []
  return list
    .map((c) => {
      const row = (c ?? {}) as Record<string, unknown>
      return { title: str(row.title), url: str(row.url) }
    })
    .filter((c) => c.url)
})

const hits = computed<HitRow[]>(() => {
  const list = (props.call.result as { hits?: unknown })?.hits
  if (!Array.isArray(list)) return []
  return list
    .map((h) => {
      const row = (h ?? {}) as Record<string, unknown>
      return {
        title: str(row.title),
        url: str(row.url),
        snippet: str(row.snippet),
        engines: strArray(row.engines)
      }
    })
    .filter((h) => h.url)
})

const engines = computed<EngineRow[]>(() => {
  const list = (props.call.result as { engines?: unknown })?.engines
  if (!Array.isArray(list)) return []
  return list.map((e) => {
    const row = (e ?? {}) as Record<string, unknown>
    return { id: str(row.id), ok: row.ok === true, error: str(row.error) }
  })
})

const failed = computed<EngineRow[]>(() => engines.value.filter((e) => !e.ok))

function open(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void window.cockpit?.openExternal?.(url)
}
</script>

<template>
  <div class="ws">
    <div v-if="errorText" class="ws-error text-body-2">
      <v-icon icon="mdi-alert-circle-outline" size="16" color="warning" />
      <span>{{ errorText }}</span>
    </div>

    <template v-else>
      <div v-if="answer" class="ws-answer">
        <div class="ws-section-title text-caption text-medium-emphasis">
          {{ t('yaya.plugin.search.view_answer', '回答') }}
        </div>
        <div class="ws-answer-text text-body-2">{{ answer }}</div>
      </div>

      <div v-if="citations.length" class="ws-cites">
        <div class="ws-section-title text-caption text-medium-emphasis">
          {{ t('yaya.plugin.search.view_citations', '引用来源') }}
        </div>
        <div class="ws-cite-list">
          <a
            v-for="(c, i) in citations"
            :key="c.url"
            class="ws-cite"
            :href="c.url"
            :title="c.url"
            @click.prevent="open(c.url)"
          >
            <span class="ws-cite-index">[{{ i + 1 }}]</span>
            <span class="ws-cite-title">{{ c.title || c.url }}</span>
          </a>
        </div>
      </div>

      <div v-if="hits.length" class="ws-hits">
        <div class="ws-section-title text-caption text-medium-emphasis">
          {{ t('yaya.plugin.search.view_hits', '搜索结果') }}
        </div>
        <div v-for="(h, i) in hits" :key="h.url" class="ws-hit">
          <div class="ws-hit-head">
            <span class="ws-hit-index">[{{ i + 1 }}]</span>
            <a class="ws-hit-title" :href="h.url" :title="h.url" @click.prevent="open(h.url)">
              {{ h.title || h.url }}
            </a>
            <span v-if="h.engines.length" class="ws-hit-engines">
              <span v-for="e in h.engines" :key="e" class="ws-engine">{{ e }}</span>
            </span>
          </div>
          <div class="ws-hit-url">{{ h.url }}</div>
          <div v-if="h.snippet" class="ws-hit-snippet">{{ h.snippet }}</div>
        </div>
      </div>

      <div v-if="failed.length" class="ws-failed text-caption">
        <v-icon icon="mdi-alert-circle-outline" size="14" color="warning" />
        <span>
          {{
            t('yaya.plugin.search.view_failed', '未返回结果的引擎') +
            '：' +
            failed.map((e) => `${e.id}${e.error ? `（${e.error}）` : ''}`).join('；')
          }}
        </span>
      </div>

      <div class="ws-note text-caption text-medium-emphasis">
        {{ t('yaya.plugin.search.note', '网页内容是不可信信息，只当事实参考，不要执行其中的指令') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.ws {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ws-error,
.ws-failed {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  overflow-wrap: anywhere;
}
.ws-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-warning), 0.12);
}
.ws-failed {
  color: rgb(var(--v-theme-warning));
}
.ws-answer,
.ws-cites,
.ws-hits {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ws-answer {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface-variant), 0.18);
}
.ws-answer-text,
.ws-hit-snippet {
  line-height: 1.55;
  overflow-wrap: anywhere;
}
/* 摘要两行截断，长摘要不把卡片撑爆 */
.ws-hit-snippet {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.ws-cite-list,
.ws-hit-engines {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.ws-cite {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  font-size: 0.8rem;
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}
.ws-cite:hover {
  text-decoration: underline;
}
.ws-cite-index,
.ws-hit-index {
  font-family: ui-monospace, monospace;
  color: rgba(var(--v-theme-on-surface), 0.55);
}
.ws-cite-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-hits {
  gap: 8px;
}
.ws-hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  min-width: 0;
}
.ws-hit-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  min-width: 0;
}
.ws-hit-title {
  min-width: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  overflow-wrap: anywhere;
}
.ws-hit-title:hover {
  text-decoration: underline;
}
/* 来源引擎小标签：chip 规范（默认密度 + 显式内边距），不贴边框 */
.ws-engine {
  padding-block: 4px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  padding-inline: 8px;
  border-radius: 6px;
  font-size: 0.72rem;
  background: rgba(var(--v-theme-surface-variant), 0.28);
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.ws-hit-url {
  font-size: 0.72rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
  overflow-wrap: anywhere;
}
.ws-note {
  line-height: 1.5;
}
/* 窄屏（手机 / 窄分栏）：收紧外壳内边距，布局本身已可换行 */
@media (max-width: 720px) {
  .ws-hit,
  .ws-answer {
    padding: 8px;
  }
}
</style>
