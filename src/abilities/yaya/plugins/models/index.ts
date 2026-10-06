/**
 * 内置 models 插件：模型元数据（价格、上下文长度）。
 *
 * - 助手可以自己查官方价格（web_search / fetch_url）后用 `models_set` 写进来（要用户确认）；
 *   用户也可以在设置 → 插件 → 模型元数据里手动改。没有删除工具，删除只在用户界面。
 * - 数据只用于显示：用量统计里按模型算费用（插件 SDK `hooks.usage` + 渲染端 `usageView`），
 *   模型选择里显示价格 / 上下文标签（`hooks.modelHint`）。不进系统提示词以外的任何地方，
 *   instructions 固定不变（提示词缓存）。
 */
import { getBroadcast } from '../../../../main/process/broadcast'
import { guard, SCOPE_CONTROL } from '../../../../main/process/privacy'
import { t, te } from '../../../../main/process/i18n'
import { loadYayaConfig } from '../../services/config'
import type { ModelHint, PluginTool, YayaPlugin } from '../../services/plugins/types'
import type { SessionUsage } from '../../services/usage'
import {
  callCost,
  currencyOf,
  formatMoney,
  formatPrice,
  formatTokens,
  hasPrice,
  listMeta,
  lookupMeta,
  normalizeMetaPatch,
  setMeta,
  type ModelMeta,
  type ModelMetaEntry
} from './store'
import type { CostData, CostRow } from './format'

export type { CostData, CostRow } from './format'

const PLUGIN_ID = 'models'
const MAX_SET = 50

/** 把一次会话的用量按模型算成费用（纯函数，方便测试） */
export function computeCost(
  usage: Pick<SessionUsage, 'calls'>,
  providerName: (id: string) => string,
  lookup: (providerId: string, model: string) => ModelMeta | null = lookupMeta
): CostData {
  const rows = new Map<string, CostRow>()
  const totals: Record<string, number> = {}
  for (const c of usage.calls) {
    const key = `${c.provider}\n${c.model}`
    let row = rows.get(key)
    if (!row) {
      const meta = lookup(c.provider, c.model)
      row = {
        providerId: c.provider,
        providerName: providerName(c.provider),
        model: c.model,
        calls: 0,
        prompt: 0,
        cached: 0,
        completion: 0,
        cost: hasPrice(meta) ? 0 : null,
        currency: currencyOf(meta),
        meta
      }
      rows.set(key, row)
    }
    row.calls++
    row.prompt += c.prompt
    row.cached += c.cached
    row.completion += c.completion
    const cost = callCost(c, row.meta)
    if (cost !== null && row.cost !== null) {
      row.cost += cost
      totals[row.currency] = (totals[row.currency] ?? 0) + cost
    }
  }
  const list = [...rows.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
  return { rows: list, totals, missing: list.filter((r) => r.cost === null).length }
}

function notifyChanged(): void {
  getBroadcast()('cockpit:yaya-usage-changed', { plugin: PLUGIN_ID })
  getBroadcast()('cockpit:yaya-model-hints-changed', { plugin: PLUGIN_ID })
}

/** 用户界面改了元数据（commands.ts）后也要通知 */
export { notifyChanged as notifyModelMetaChanged }

function fail(error: string): unknown {
  return { content: [{ type: 'text' as const, text: error }], isError: true }
}

const tools: PluginTool[] = [
  {
    name: 'list',
    description:
      'List stored model metadata (price per 1M tokens for input / cached input / output, currency, context window, max output, source) and the configured models that have no price yet.',
    approval: 'auto',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring filter on the model name' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const config = loadYayaConfig()
      const entries = listMeta().filter((e) => !q || e.model.toLowerCase().includes(q))
      const missing: { providerId: string; provider: string; model: string }[] = []
      for (const p of config.providers) {
        if (p.enabled === false) continue
        for (const m of p.models) {
          if (q && !m.toLowerCase().includes(q)) continue
          if (!hasPrice(lookupMeta(p.id, m)))
            missing.push({ providerId: p.id, provider: p.name, model: m })
        }
      }
      return {
        active: { providerId: config.activeProviderId, model: config.activeModel },
        entries,
        missingPrice: missing.slice(0, 200),
        ...(missing.length > 200 ? { missingTruncated: missing.length } : {})
      }
    }
  },
  {
    name: 'set',
    description:
      'Write metadata for one or more models (merged into what is stored; omitted fields keep their value, null clears a field). Prices are per 1M tokens. providerId "*" (default) applies to that model under any provider; use a provider id from providers_list only when that provider charges differently. Always put where the price came from in source. Needs approval.',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['entries'],
      properties: {
        entries: {
          type: 'array',
          maxItems: MAX_SET,
          items: {
            type: 'object',
            required: ['model'],
            properties: {
              providerId: { type: 'string', description: '"*" = any provider (default)' },
              model: { type: 'string', description: 'Model id exactly as used in requests' },
              input: { type: 'number', description: 'Input price per 1M tokens' },
              cachedInput: { type: 'number', description: 'Cached input price per 1M tokens' },
              output: { type: 'number', description: 'Output price per 1M tokens' },
              currency: { type: 'string', description: 'ISO code, e.g. USD, CNY (default USD)' },
              contextWindow: { type: 'number', description: 'Context window in tokens' },
              maxOutput: { type: 'number', description: 'Max output tokens' },
              source: { type: 'string', description: 'URL or short description of the source' },
              note: { type: 'string' }
            }
          }
        }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const list = Array.isArray(args.entries) ? args.entries.slice(0, MAX_SET) : []
      if (!list.length) return fail(t('yaya.plugin.models.err_empty', 'entries 为空'))
      try {
        await guard(SCOPE_CONTROL, t('yaya.plugin.models.guard_set', '写入模型元数据（价格等）'))
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
      const saved: ModelMetaEntry[] = []
      const errors: string[] = []
      for (const raw of list) {
        const item = (raw ?? {}) as Record<string, unknown>
        const model = typeof item.model === 'string' ? item.model : ''
        try {
          saved.push(
            setMeta(
              typeof item.providerId === 'string' && item.providerId.trim() ? item.providerId : '*',
              model,
              normalizeMetaPatch(item),
              'ai'
            )
          )
        } catch (e) {
          errors.push(`${model || '?'}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (saved.length) notifyChanged()
      return { ok: errors.length === 0, saved, ...(errors.length ? { errors } : {}) }
    }
  }
]

const INSTRUCTIONS =
  'Model metadata tools (models_*): models_list shows stored prices / context windows and which ' +
  'configured models have no price; models_set writes them (needs approval). Prices are per 1M ' +
  'tokens. When asked to fill in prices, look them up from the official pricing page (web search / ' +
  'fetch) and record the URL in source; do not guess numbers.'

const DOCS = `# 模型元数据（models）

给模型记下价格（每百万 token 的输入 / 缓存命中 / 输出价格、币种）和上下文长度。

- **用量统计**会按这里的价格算出每个对话花了多少钱（右上角菜单 → 用量统计 → 费用）。
- **模型选择**里模型旁边显示价格和上下文长度。
- 可以让助手去查：「帮我把用到的模型价格补齐」。它会查官方价格页，用 \`models_set\` 写入（需要你确认），并在来源里记下网址。
- 也可以在下面的列表里手动添加 / 修改 / 删除。助手不能删除。

| 工具 | 说明 | 需要确认 |
| --- | --- | --- |
| \`models_list\` | 列出已记录的元数据，以及还没有价格的模型 | 否 |
| \`models_set\` | 写入 / 修改元数据 | **是** |

服务商写 \`*\` 表示「任何服务商下的这个模型」；同一个模型在某个服务商那里价格不同时再单独写。
`

function providerNames(): (id: string) => string {
  const map = new Map(loadYayaConfig().providers.map((p) => [p.id, p.name]))
  return (id) => map.get(id) ?? id
}

function hintOf(meta: ModelMeta | null): ModelHint | null {
  if (!meta) return null
  const cur = currencyOf(meta)
  const badges: string[] = []
  const lines: string[] = []
  if (hasPrice(meta)) {
    badges.push(`${formatPrice(meta.input ?? 0, cur)} / ${formatPrice(meta.output ?? 0, cur)}`)
    const parts = [
      `${t('yaya.plugin.models.price_input', '输入')} ${formatPrice(meta.input ?? 0, cur)}`
    ]
    if (meta.cachedInput !== undefined)
      parts.push(
        `${t('yaya.plugin.models.price_cached', '缓存命中')} ${formatPrice(meta.cachedInput, cur)}`
      )
    parts.push(
      `${t('yaya.plugin.models.price_output', '输出')} ${formatPrice(meta.output ?? 0, cur)}`
    )
    lines.push(`${parts.join(' · ')} ${t('yaya.plugin.models.per_m', '（每百万 token）')}`)
  }
  if (meta.contextWindow) {
    badges.push(formatTokens(meta.contextWindow))
    lines.push(
      te(
        'yaya.plugin.models.context_line',
        { n: formatTokens(meta.contextWindow) },
        '上下文 {n} token'
      )
    )
  }
  return badges.length ? { badges, title: lines.join('\n') } : null
}

const plugin: YayaPlugin = {
  id: PLUGIN_ID,
  kind: 'builtin',
  label: '模型元数据',
  labelKey: 'yaya.plugin.models.label',
  description: '记录模型价格与上下文长度：用量统计里算费用，模型选择里显示价格',
  descriptionKey: 'yaya.plugin.models.desc',
  icon: 'mdi-tag-text-outline',
  namespace: PLUGIN_ID,
  defaultEnabled: true,
  docs: DOCS,
  instructions: () => INSTRUCTIONS,
  tools: () => tools,
  hooks: {
    usage: ({ usage }) => {
      if (!usage.calls.length) return null
      const data = computeCost(usage, providerNames())
      const currencies = Object.keys(data.totals)
      const stats = currencies.map((c) => ({
        label: t('yaya.plugin.models.stat_cost', '费用'),
        value: formatMoney(data.totals[c], c),
        sub: c
      }))
      if (!stats.length)
        stats.push({
          label: t('yaya.plugin.models.stat_cost', '费用'),
          value: '—',
          sub: t('yaya.plugin.models.stat_no_price', '还没有价格')
        })
      if (data.missing)
        stats[stats.length - 1].sub = te(
          'yaya.plugin.models.stat_missing',
          { n: String(data.missing) },
          '{n} 个模型没有价格'
        )
      return {
        title: t('yaya.plugin.models.section', '费用'),
        icon: 'mdi-cash-multiple',
        stats,
        data
      }
    },
    modelHint: ({ providerId, model }) => hintOf(lookupMeta(providerId, model))
  }
}

export default plugin
