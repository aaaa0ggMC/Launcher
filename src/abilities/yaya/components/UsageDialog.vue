<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { SessionUsage, ToolRisk, UsageToolCall } from '../services/usage'

/**
 * 会话用量统计（右上角菜单 → 用量统计）。数据来自 `yaya.session-usage`。
 * 先看 token（合计 / 缓存命中 / 推理 / 每次调用的上下文大小 / 按模型），再看工具（按工具汇总 +
 * 明细，可只看高危 / 失败 / 被拒绝）。窄屏全屏显示。
 */
const props = defineProps<{ sessionId: string; sessionTitle: string }>()
const open = defineModel<boolean>({ default: false })

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const data = ref<SessionUsage | null>(null)
const loading = ref(false)
const error = ref('')
const branchOnly = ref(false)
type ToolFilter = 'all' | 'high' | 'failed' | 'rejected'
const toolFilter = ref<ToolFilter>('all')

async function load(): Promise<void> {
  if (!props.sessionId) return
  loading.value = true
  error.value = ''
  try {
    data.value = (await window.cockpit.command('yaya.session-usage', {
      id: props.sessionId,
      branch: branchOnly.value
    })) as SessionUsage
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch([open, branchOnly, () => props.sessionId], ([o]) => {
  if (o) void load()
})

// ---- 窄屏全屏 ----
const narrow = ref(false)
let mql: MediaQueryList | null = null
const updateNarrow = (): void => {
  narrow.value = !!mql?.matches
}
onMounted(() => {
  mql = window.matchMedia('(max-width: 720px)')
  updateNarrow()
  mql.addEventListener('change', updateNarrow)
})
onBeforeUnmount(() => mql?.removeEventListener('change', updateNarrow))

// ---- 格式化 ----
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}
function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : '—'
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
function fmtTime(at: number): string {
  const d = new Date(at)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const totals = computed(() => data.value?.totals)

// ---- 上下文大小柱状图（每次调用：输入，缓存命中部分加深；输出叠在上面） ----
const chart = computed(() => {
  const calls = data.value?.calls ?? []
  const max = Math.max(1, ...calls.map((c) => c.prompt + c.completion))
  return calls.map((c, i) => ({
    key: c.messageId,
    x: i,
    prompt: c.prompt / max,
    cached: Math.min(c.cached, c.prompt) / max,
    completion: c.completion / max,
    title: `#${i + 1} ${c.model}\n${t('yaya.usage.prompt', '输入')} ${c.prompt.toLocaleString()}（${t('yaya.usage.cached', '缓存命中')} ${c.cached.toLocaleString()}）\n${t('yaya.usage.completion', '输出')} ${c.completion.toLocaleString()}`
  }))
})
const peakContext = computed(() => Math.max(0, ...(data.value?.calls ?? []).map((c) => c.prompt)))

// ---- 工具 ----
const RISK_COLOR: Record<ToolRisk, string> = {
  high: 'error',
  medium: 'warning',
  low: 'success',
  unknown: 'grey'
}
function riskLabel(r: ToolRisk): string {
  return {
    high: t('yaya.usage.risk_high', '高危'),
    medium: t('yaya.usage.risk_medium', '视参数'),
    low: t('yaya.usage.risk_low', '低风险'),
    unknown: t('yaya.usage.risk_unknown', '已移除')
  }[r]
}
const maxToolCount = computed(() => Math.max(1, ...(data.value?.tools ?? []).map((x) => x.count)))
function matches(c: Pick<UsageToolCall, 'risk' | 'status'>, f: ToolFilter): boolean {
  if (f === 'high') return c.risk === 'high'
  if (f === 'failed') return c.status === 'failed'
  if (f === 'rejected') return c.status === 'rejected'
  return true
}
const filteredTools = computed(() =>
  (data.value?.tools ?? []).filter((x) =>
    toolFilter.value === 'all'
      ? true
      : toolFilter.value === 'high'
        ? x.risk === 'high'
        : toolFilter.value === 'failed'
          ? x.failed > 0
          : x.rejected > 0
  )
)
const filteredLog = computed(() =>
  [...(data.value?.toolLog ?? [])].reverse().filter((c) => matches(c, toolFilter.value))
)
const LOG_PAGE = 100
const logLimit = ref(LOG_PAGE)
watch(toolFilter, () => (logLimit.value = LOG_PAGE))
const filterCounts = computed(() => {
  const log = data.value?.toolLog ?? []
  return {
    all: log.length,
    high: log.filter((c) => c.risk === 'high').length,
    failed: log.filter((c) => c.status === 'failed').length,
    rejected: log.filter((c) => c.status === 'rejected').length
  }
})
function statusIcon(s: UsageToolCall['status']): { icon: string; color: string } {
  if (s === 'success') return { icon: 'mdi-check-circle-outline', color: 'success' }
  if (s === 'failed') return { icon: 'mdi-alert-circle-outline', color: 'error' }
  if (s === 'rejected') return { icon: 'mdi-hand-back-left-outline', color: 'warning' }
  return { icon: 'mdi-progress-clock', color: '' }
}
</script>

<template>
  <v-dialog v-model="open" :fullscreen="narrow" :max-width="narrow ? undefined : 820" scrollable>
    <v-card class="usage-card" :rounded="narrow ? 0 : 'xl'">
      <div class="usage-head">
        <v-icon icon="mdi-chart-box-outline" />
        <div class="usage-title min-w-0">
          <div class="text-subtitle-1 font-weight-medium">
            {{ t('yaya.usage.title', '用量统计') }}
          </div>
          <div class="text-caption text-medium-emphasis text-truncate">{{ sessionTitle }}</div>
        </div>
        <v-spacer />
        <v-btn
          icon="mdi-refresh"
          variant="text"
          size="small"
          :loading="loading"
          :title="t('yaya.usage.refresh', '刷新')"
          :aria-label="t('yaya.usage.refresh', '刷新')"
          @click="load"
        />
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :title="t('yaya.usage.close', '关闭')"
          :aria-label="t('yaya.usage.close', '关闭')"
          @click="open = false"
        />
      </div>
      <v-divider />

      <v-card-text class="usage-body">
        <div class="usage-scope">
          <v-btn-toggle
            v-model="branchOnly"
            mandatory
            density="comfortable"
            variant="outlined"
            divided
            rounded="lg"
          >
            <v-btn :value="false">{{ t('yaya.usage.all_branches', '全部分支') }}</v-btn>
            <v-btn :value="true">{{ t('yaya.usage.current_branch', '当前分支') }}</v-btn>
          </v-btn-toggle>
          <span class="text-caption text-medium-emphasis">
            {{
              branchOnly
                ? t('yaya.usage.scope_branch', '只统计正在看的这条分支')
                : t('yaya.usage.scope_all', '包括重新生成留下的其它分支（都花了 token）')
            }}
          </span>
        </div>

        <v-alert v-if="error" type="error" variant="tonal" class="mt-4">{{ error }}</v-alert>

        <template v-if="totals">
          <!-- Token -->
          <h3 class="usage-section">{{ t('yaya.usage.tokens', 'Token') }}</h3>
          <div class="stat-grid">
            <div class="stat">
              <div class="stat-label">{{ t('yaya.usage.total', '合计') }}</div>
              <div class="stat-value">{{ fmt(totals.total) }}</div>
              <div class="stat-sub">
                {{ te('yaya.usage.calls', { n: String(totals.calls) }, '{n} 次模型调用') }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">{{ t('yaya.usage.prompt', '输入') }}</div>
              <div class="stat-value">{{ fmt(totals.prompt) }}</div>
              <div class="stat-sub">
                {{ t('yaya.usage.cached', '缓存命中') }} {{ fmt(totals.cached) }} ·
                {{ pct(totals.cached, totals.prompt) }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">{{ t('yaya.usage.completion', '输出') }}</div>
              <div class="stat-value">{{ fmt(totals.completion) }}</div>
              <div class="stat-sub">
                {{ t('yaya.usage.reasoning', '其中推理') }} {{ fmt(totals.reasoning) }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">{{ t('yaya.usage.peak', '最大上下文') }}</div>
              <div class="stat-value">{{ fmt(peakContext) }}</div>
              <div class="stat-sub">
                {{ te('yaya.usage.runs', { n: String(totals.runs) }, '{n} 次运行') }}
                <template v-if="totals.subagentTokens">
                  · {{ t('yaya.usage.subagent', '子 Agent') }} {{ fmt(totals.subagentTokens) }}
                </template>
              </div>
            </div>
          </div>

          <div v-if="chart.length" class="chart-wrap">
            <div class="chart-legend text-caption text-medium-emphasis">
              <span>{{ t('yaya.usage.chart', '每次调用的上下文') }}</span>
              <v-spacer />
              <span class="lg lg-cached" />{{ t('yaya.usage.cached', '缓存命中') }}
              <span class="lg lg-prompt" />{{ t('yaya.usage.prompt', '输入') }}
              <span class="lg lg-completion" />{{ t('yaya.usage.completion', '输出') }}
            </div>
            <svg
              class="chart"
              :viewBox="`0 0 ${chart.length} 1`"
              preserveAspectRatio="none"
              role="img"
              :aria-label="t('yaya.usage.chart', '每次调用的上下文')"
            >
              <g v-for="b in chart" :key="b.key">
                <title>{{ b.title }}</title>
                <rect
                  class="bar-completion"
                  :x="b.x + 0.12"
                  :y="1 - b.prompt - b.completion"
                  width="0.76"
                  :height="b.completion"
                />
                <rect
                  class="bar-prompt"
                  :x="b.x + 0.12"
                  :y="1 - b.prompt"
                  width="0.76"
                  :height="b.prompt"
                />
                <rect
                  class="bar-cached"
                  :x="b.x + 0.12"
                  :y="1 - b.cached"
                  width="0.76"
                  :height="b.cached"
                />
              </g>
            </svg>
          </div>

          <div v-if="data && data.models.length > 1" class="model-list">
            <div v-for="m in data.models" :key="m.model" class="model-row">
              <span class="model-name text-truncate">{{
                m.model || t('yaya.usage.unknown_model', '未知模型')
              }}</span>
              <span class="text-caption text-medium-emphasis">
                {{ te('yaya.usage.calls', { n: String(m.calls) }, '{n} 次模型调用') }}
              </span>
              <v-spacer />
              <span class="model-tokens">{{ fmt(m.total) }}</span>
            </div>
          </div>

          <!-- 工具 -->
          <h3 class="usage-section">
            {{ t('yaya.usage.tools', '工具') }}
            <span class="text-caption text-medium-emphasis font-weight-regular">
              {{ te('yaya.usage.tool_calls', { n: String(totals.toolCalls) }, '共 {n} 次调用') }}
            </span>
          </h3>
          <v-chip-group v-model="toolFilter" mandatory selected-class="text-primary" class="mb-2">
            <v-chip value="all" variant="outlined" filter>
              {{ t('yaya.usage.f_all', '全部') }} {{ filterCounts.all }}
            </v-chip>
            <v-chip value="high" variant="outlined" filter>
              {{ t('yaya.usage.f_high', '高危') }} {{ filterCounts.high }}
            </v-chip>
            <v-chip value="failed" variant="outlined" filter>
              {{ t('yaya.usage.f_failed', '失败') }} {{ filterCounts.failed }}
            </v-chip>
            <v-chip value="rejected" variant="outlined" filter>
              {{ t('yaya.usage.f_rejected', '被拒绝') }} {{ filterCounts.rejected }}
            </v-chip>
          </v-chip-group>

          <div v-if="filteredTools.length" class="tool-list">
            <div v-for="x in filteredTools" :key="x.name" class="tool-row">
              <div class="tool-row-head">
                <span class="tool-name text-truncate">{{ x.name }}</span>
                <v-chip :color="RISK_COLOR[x.risk]" size="small" variant="tonal" label>
                  {{ riskLabel(x.risk) }}
                </v-chip>
                <v-spacer />
                <span class="tool-count">× {{ x.count }}</span>
              </div>
              <div class="tool-bar">
                <span :style="{ width: `${(x.count / maxToolCount) * 100}%` }" />
              </div>
              <div class="text-caption text-medium-emphasis">
                {{ t('yaya.usage.ok', '成功') }} {{ x.ok }}
                <template v-if="x.failed">
                  · {{ t('yaya.usage.f_failed', '失败') }} {{ x.failed }}</template
                >
                <template v-if="x.rejected">
                  · {{ t('yaya.usage.f_rejected', '被拒绝') }} {{ x.rejected }}
                </template>
                <template v-if="x.ms">
                  · {{ t('yaya.usage.time', '耗时') }} {{ fmtMs(x.ms) }}</template
                >
              </div>
            </div>
          </div>
          <div v-else class="text-body-2 text-medium-emphasis py-2">
            {{ t('yaya.usage.no_tools', '没有符合条件的工具调用') }}
          </div>

          <template v-if="filteredLog.length">
            <h4 class="usage-sub">{{ t('yaya.usage.log', '调用明细（最近的在前）') }}</h4>
            <div class="log-list">
              <div v-for="c in filteredLog.slice(0, logLimit)" :key="c.id" class="log-row">
                <v-icon
                  :icon="statusIcon(c.status).icon"
                  :color="statusIcon(c.status).color"
                  size="18"
                  class="log-status"
                />
                <div class="log-main min-w-0">
                  <div class="log-line">
                    <span class="tool-name text-truncate">{{ c.name }}</span>
                    <span class="risk-dot" :class="`is-${c.risk}`" :title="riskLabel(c.risk)" />
                    <v-spacer />
                    <span class="text-caption text-medium-emphasis log-meta">
                      {{ fmtTime(c.at)
                      }}<template v-if="c.ms !== undefined"> · {{ fmtMs(c.ms) }}</template>
                    </span>
                  </div>
                  <div class="log-summary text-caption text-medium-emphasis">{{ c.summary }}</div>
                  <div v-if="c.rejectReason" class="text-caption text-warning">
                    {{ t('yaya.usage.reject_reason', '拒绝理由') }}：{{ c.rejectReason }}
                  </div>
                </div>
              </div>
            </div>
            <div v-if="filteredLog.length > logLimit" class="d-flex justify-center pt-2">
              <v-btn variant="text" @click="logLimit += LOG_PAGE">
                {{ t('yaya.usage.more', '显示更多') }}（{{ filteredLog.length - logLimit }}）
              </v-btn>
            </div>
            <div v-if="data?.truncated" class="text-caption text-medium-emphasis pt-2">
              {{ t('yaya.usage.truncated', '只保留最近 1000 条明细；上面的汇总仍是全部') }}
            </div>
          </template>
        </template>
        <div v-else-if="loading" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary" />
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.usage-card {
  display: flex;
  flex-direction: column;
}
.usage-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 12px 14px 20px;
  padding-top: max(14px, env(safe-area-inset-top, 0px));
}
.usage-body {
  padding: 16px 20px 24px !important;
}
.usage-scope {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.usage-section {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 24px 0 12px;
  font-size: 0.95rem;
  font-weight: 600;
}
.usage-sub {
  margin: 16px 0 8px;
  font-size: 0.85rem;
  font-weight: 600;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.stat {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  min-width: 0;
}
.stat-label {
  font-size: 0.75rem;
  opacity: 0.7;
}
.stat-value {
  font-size: 1.35rem;
  font-weight: 600;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.stat-sub {
  font-size: 0.72rem;
  opacity: 0.7;
  line-height: 1.4;
}
.chart-wrap {
  margin-top: 14px;
}
.chart-legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding-bottom: 6px;
}
.lg {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.lg-cached,
.bar-cached {
  background: rgb(var(--v-theme-primary));
  fill: rgb(var(--v-theme-primary));
}
.lg-prompt,
.bar-prompt {
  background: rgba(var(--v-theme-primary), 0.4);
  fill: rgba(var(--v-theme-primary), 0.4);
}
.lg-completion,
.bar-completion {
  background: rgba(var(--v-theme-secondary), 0.7);
  fill: rgba(var(--v-theme-secondary), 0.7);
}
.chart {
  display: block;
  width: 100%;
  height: 96px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.model-list,
.tool-list,
.log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-list {
  margin-top: 12px;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 6px 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.model-name {
  font-size: 0.85rem;
  font-weight: 500;
  min-width: 0;
}
.model-tokens,
.tool-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.tool-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.tool-row-head,
.log-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tool-name {
  font-family: var(--cockpit-mono, ui-monospace, monospace);
  font-size: 0.82rem;
  min-width: 0;
}
.tool-bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  overflow: hidden;
}
.tool-bar span {
  display: block;
  height: 100%;
  background: rgb(var(--v-theme-primary));
}
.log-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
}
.log-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.log-status {
  margin-top: 2px;
}
.log-main {
  flex: 1 1 auto;
}
.log-meta {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.log-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.risk-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.risk-dot.is-high {
  background: rgb(var(--v-theme-error));
}
.risk-dot.is-medium {
  background: rgb(var(--v-theme-warning));
}
.risk-dot.is-low {
  background: rgb(var(--v-theme-success));
}
.risk-dot.is-unknown {
  background: rgba(var(--v-theme-on-surface), 0.3);
}
@media (max-width: 720px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .usage-body {
    padding: 12px 16px 24px !important;
  }
}
</style>
