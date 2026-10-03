<script setup lang="ts">
/**
 * Token breakdown shown when hovering the Tokens chip: input (of which cached,
 * with the hit rate), output, and the same split per agent.
 */
import { computed, inject, ref, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import { formatTokens } from './workflow-view'
import type { UsageBreakdown } from '../loop/usage'

const props = defineProps<{ usage: UsageBreakdown }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const AGENT_NAME: Record<string, string> = {
  loop: 'LoopAgent',
  lib: 'LibAgent',
  dream: 'DreamAgent',
  rank: 'RankAgent',
  text: 'Text',
  vocab: 'VocabAgent',
  sanitize: 'SanitizeAgent'
}

const rate = (cached: number, prompt: number): string =>
  prompt ? `${Math.round((cached / prompt) * 100)}%` : '—'

const agents = computed(() =>
  Object.entries(props.usage.byAgent)
    .filter(([, u]) => u.prompt + u.completion > 0)
    .sort((a, b) => b[1].prompt + b[1].completion - (a[1].prompt + a[1].completion))
)
</script>

<template>
  <div class="usage-box">
    <div class="usage-grid">
      <span>{{ t('aidj.usage.input', '输入') }}</span>
      <span class="num">{{ formatTokens(usage.prompt) }}</span>
      <span>{{ t('aidj.usage.cached', 'Cached（缓存命中）') }}</span>
      <span class="num"
        >{{ formatTokens(usage.cached) }} · {{ rate(usage.cached, usage.prompt) }}</span
      >
      <span>{{ t('aidj.usage.output', '输出') }}</span>
      <span class="num">{{ formatTokens(usage.completion) }}</span>
      <span class="strong">{{ t('aidj.usage.total', '合计') }}</span>
      <span class="num strong">{{ formatTokens(usage.prompt + usage.completion) }}</span>
    </div>
    <template v-if="agents.length">
      <div class="usage-sep" />
      <div class="usage-agents">
        <span class="head">{{ t('aidj.usage.agent', 'Agent') }}</span>
        <span class="head num">{{ t('aidj.usage.input', '输入') }}</span>
        <span class="head num">Cached</span>
        <span class="head num">{{ t('aidj.usage.output', '输出') }}</span>
        <template v-for="[name, u] in agents" :key="name">
          <span>{{ AGENT_NAME[name] ?? name }}</span>
          <span class="num">{{ formatTokens(u.prompt) }}</span>
          <span class="num">{{ formatTokens(u.cached) }}</span>
          <span class="num">{{ formatTokens(u.completion) }}</span>
        </template>
      </div>
    </template>
    <div v-if="!usage.cached && usage.prompt" class="usage-note">
      {{ t('aidj.usage.no_cache', '接口没有返回缓存命中数（或确实未命中）') }}
    </div>
  </div>
</template>

<style scoped>
.usage-box {
  font-size: 12px;
  line-height: 1.7;
  min-width: 220px;
  padding: 4px 2px;
}
.usage-grid {
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 16px;
}
.usage-agents {
  display: grid;
  grid-template-columns: auto auto auto auto;
  column-gap: 14px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.strong {
  font-weight: 600;
}
.head {
  opacity: 0.7;
}
.usage-sep {
  height: 1px;
  margin: 6px 0;
  background: currentColor;
  opacity: 0.2;
}
.usage-note {
  margin-top: 6px;
  opacity: 0.7;
}
</style>
