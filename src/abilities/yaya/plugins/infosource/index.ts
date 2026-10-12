/**
 * 内置「信息源」插件：**结构化公开数据渠道**的实例化获取（与 GenericSearch 的分工：
 * 那边是「查询 → 网页搜索引擎」，这边是「查询 → 百科 / 学术 / 地名 / 国家 … 这些结构化接口」）。
 *
 * - 渠道 = **实例**：按类型（`services/info-sources.ts` 的类型注册表）建多个，各自能改模板、
 *   加参数、单独停用；编辑器见同目录 `InfoSourcesView.vue`（第二个 `settingsView` 消费）。
 * - AI 调 `fetch_info`：**一条命令里可以点名一个或多个渠道**；`query` 留空先拿目录。
 * - 全部为免 key 公开 API（调研记录见 PLAN.md §7）。
 */
import { assistantConfig, sessionAssistantId } from '../../assistants'
import { loadYayaConfig } from '../../services/config'
import { getSession } from '../../services/db'
import {
  DEFAULT_INSTANCES,
  formatCatalog,
  formatInfo,
  instancesOf,
  selectInstances,
  sourceType
} from '../../services/info-sources'
import type { PluginTool, YayaPlugin } from '../../services/plugins/types'
import { fetchSource } from './fetch'

/** 固定英文（不随界面语言 / 配置变，提示词缓存稳定） */
const INSTRUCTIONS = [
  '## fetch_info — structured public-data channels',
  '`fetch_info` pulls facts from the configured info channels (encyclopedia, scholarly works,',
  'geocoding, country data, Hacker News…), unlike `web_search` which searches the web pages.',
  '- Call it once with **no query** to list the available channels (instance names and types).',
  '- Then call it with `query`, optionally `sources: ["<instance name or type id>", ...]` to query',
  '  one or several channels **in a single call**; one failing channel never spoils the others.',
  '- Output is capped bullet facts per channel: cite the titles, say plainly when nothing matched,',
  '  and do not re-fetch the same query you already have.'
].join('\n')

const fetchInfoTool: PluginTool = {
  name: 'fetch_info',
  approval: 'auto',
  description:
    '从配置的公开信息渠道取结构化资料（百科 / 学术 / 地名 / 国家 / HN …）。query 留空 = 列出可用渠道；sources 可在一次调用里点名一个或多个渠道',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要查的内容（关键词 / 词条名 / 论文题目 …）；**留空则只返回可用渠道目录**'
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description:
          '要点名的渠道：实例名（如「维基百科」）或类型 id（如 wikipedia）；可多个，不给 = 全部启用的渠道'
      }
    }
  },
  docs: [
    '从「结构化公开数据渠道」取资料，一条命令可以同时查多个渠道。',
    '',
    '- **不带 query**：返回渠道目录（实例名 + 类型），据此再决定 `sources` 怎么填；',
    '- **带 query**：并发拉取所有（或点名的）渠道，按渠道分节返回要点；',
    '- 单个渠道失败只在该节里标注，不影响其余渠道；',
    '- 渠道在 设置 → YAYA → 插件 → 信息源 里增删改（类型 + URL 模板 + 参数 + 启停）。',
    '',
    '与 `web_search` 的分工：这个查的是百科 / 论文 / 地名这类**结构化数据**，那个搜的是网页。'
  ].join('\n'),
  async run(args, ctx) {
    const cfg = assistantConfig(loadYayaConfig(), sessionAssistantId(getSession(ctx.sessionId)))
    const instances = instancesOf(cfg.pluginConfig?.infosource?.instances)
    const query = String(args.query ?? '').trim()
    const sources = Array.isArray(args.sources)
      ? args.sources.map((s) => String(s).trim()).filter(Boolean)
      : []

    if (!query) return { content: [{ type: 'text' as const, text: formatCatalog(instances) }] }

    const { picked, notFound } = selectInstances(instances, sources)
    if (!picked.length) {
      const why = notFound.length ? `未命中渠道：${notFound.join('、')}` : '没有启用中的渠道'
      return {
        content: [{ type: 'text' as const, text: `${why}\n\n${formatCatalog(instances)}` }],
        isError: true
      }
    }

    const sections = await Promise.all(
      picked.map(async (instance) => {
        const type = sourceType(instance.type)! // selectInstances 已过滤未知类型
        const r = await fetchSource(instance, query)
        return { instance, type, items: r.items, error: r.error }
      })
    )
    const note = notFound.length ? `（这些渠道不存在：${notFound.join('、')}）\n\n` : ''
    return { content: [{ type: 'text' as const, text: note + formatInfo(sections) }] }
  }
}

const plugin: YayaPlugin = {
  id: 'infosource',
  kind: 'builtin',
  // 渠道默认配好就能用，开着无副作用
  defaultEnabled: true,
  label: '信息源',
  labelKey: 'yaya.info.label',
  description:
    '结构化公开数据渠道（百科 / 学术 / 地名 / 国家 …）：可建多个实例、逐个启停，AI 一条 fetch_info 查多个',
  descriptionKey: 'yaya.info.desc',
  icon: 'mdi-database-search-outline',
  tools: () => [fetchInfoTool],
  instructions: () => INSTRUCTIONS,
  configSchema: [
    {
      key: 'instances',
      type: 'text',
      label: '信息源实例（JSON 数组）',
      labelKey: 'yaya.info.cfg_instances',
      description: '每条 {name, type, template?, params?, note?, enabled?}；用本页编辑器维护更省事',
      descriptionKey: 'yaya.info.cfg_instances_desc',
      default: JSON.stringify(DEFAULT_INSTANCES, null, 2)
    }
  ]
}

export default plugin
