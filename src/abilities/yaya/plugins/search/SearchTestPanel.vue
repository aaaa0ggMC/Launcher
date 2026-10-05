<script setup lang="ts">
/**
 * 设置 → 插件 → 网页搜索 → 测试搜索：用已保存的配置真搜一次，告诉用户能不能用。
 * 结论（有没有结果、每个引擎成败与耗时）放在最上面，结果卡片复用工具结果视图。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolCallItem } from '../../types'
import SearchResultView from './SearchResultView.vue'

defineOptions({ name: 'yaya-search-test-panel' })

defineProps<{ pluginId: string; info?: unknown }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

interface EngineReport {
  id: string
  ok: boolean
  error?: string
  ms: number
}
interface TestResult {
  ok: boolean
  ms: number
  error?: string
  display?: { hits: unknown[]; answer: string | null; engines: EngineReport[] }
}

const query = ref('')
const running = ref(false)
const result = ref<TestResult | null>(null)

async function runTest(): Promise<void> {
  const q = query.value.trim()
  if (!q || running.value) return
  running.value = true
  result.value = null
  try {
    result.value = (await window.cockpit.command('yaya.search-test', { query: q })) as TestResult
  } catch (e) {
    result.value = { ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    running.value = false
  }
}

const summary = computed(() => {
  const r = result.value
  if (!r) return ''
  const time = r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`
  if (r.error) return r.error
  const n = r.display?.hits.length ?? 0
  if (!r.ok) return te('yaya.plugin.search.test_empty', { time }, '没有返回有效结果（{time}）')
  if (n === 0) return te('yaya.plugin.search.test_answer_only', { time }, '返回了回答（{time}）')
  return te('yaya.plugin.search.test_ok', { n: String(n), time }, '找到 {n} 条结果（{time}）')
})

/** 喂给结果视图的「工具调用」：只有 result 有意义 */
const call = computed<ToolCallItem | null>(() =>
  result.value?.display
    ? {
        id: 'search-test',
        name: 'web_search',
        args: {},
        status: 'success',
        result: result.value.display
      }
    : null
)
</script>

<template>
  <div class="d-flex flex-column ga-2">
    <span class="text-body-2 font-weight-medium">
      {{ t('yaya.plugin.search.test_title', '测试搜索') }}
    </span>
    <span class="text-caption text-medium-emphasis">
      {{
        t(
          'yaya.plugin.search.test_desc',
          '用已保存的配置真实搜索一次，看看能不能返回有效结果（会消耗一次搜索额度）'
        )
      }}
    </span>
    <div class="d-flex align-center flex-wrap ga-2">
      <v-text-field
        v-model="query"
        class="test-input"
        variant="outlined"
        density="comfortable"
        hide-details
        :label="t('yaya.plugin.search.test_query', '关键词')"
        :placeholder="t('yaya.plugin.search.test_placeholder', '例如：今天的天气')"
        @keydown.enter.prevent="runTest"
      />
      <v-btn
        color="primary"
        variant="tonal"
        prepend-icon="mdi-magnify"
        :loading="running"
        :disabled="!query.trim()"
        @click="runTest"
      >
        {{ t('yaya.plugin.search.test_run', '测试') }}
      </v-btn>
    </div>

    <div v-if="result" class="test-result" :class="result.ok ? 'is-ok' : 'is-bad'" role="status">
      <div class="d-flex align-center ga-2">
        <v-icon
          :icon="result.ok ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline'"
          :color="result.ok ? 'success' : 'error'"
          size="20"
          class="flex-shrink-0"
        />
        <span class="text-body-2 summary">{{ summary }}</span>
      </div>
      <div v-if="result.display?.engines.length" class="d-flex flex-wrap ga-2">
        <span
          v-for="e in result.display.engines"
          :key="e.id"
          class="engine-chip text-caption"
          :class="e.ok ? 'is-ok' : 'is-bad'"
          :title="e.error || undefined"
        >
          <v-icon :icon="e.ok ? 'mdi-check' : 'mdi-close'" size="14" />
          {{ e.id }} ·
          {{ e.ok ? `${e.ms} ms` : e.error || t('yaya.plugin.search.test_failed', '失败') }}
        </span>
      </div>
    </div>
    <SearchResultView v-if="call" :call="call" plugin-id="search" tool-name="search" />
  </div>
</template>

<style scoped>
.test-input {
  flex: 1 1 220px;
  min-width: 0;
}
.test-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}
.test-result.is-ok {
  border-color: rgba(var(--v-theme-success), 0.4);
  background: rgba(var(--v-theme-success), 0.06);
}
.test-result.is-bad {
  border-color: rgba(var(--v-theme-error), 0.4);
  background: rgba(var(--v-theme-error), 0.06);
}
.summary {
  min-width: 0;
  word-break: break-word;
}
.engine-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 24px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.engine-chip.is-ok {
  color: rgb(var(--v-theme-success));
}
.engine-chip.is-bad {
  color: rgb(var(--v-theme-error));
}
</style>
