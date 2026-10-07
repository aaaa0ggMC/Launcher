/**
 * 联网搜索的两条路，参考 RikkaHub：
 *
 * - **generic**（缺省）：GenericSearch 插件提供 `web_search` 工具，走你配置的搜索引擎
 *   （Tavily / Brave / SearXNG …），任何会调工具的模型都能用，结果在工具卡片里看得到；
 * - **builtin**：模型自带的搜索（Gemini google_search、Claude web_search、OpenRouter web、通义 enable_search…），
 *   服务商替模型搜，不走工具循环，答案里带引用来源。
 *
 * 选择顺序：会话（`session.meta.search`，输入框菜单里切）→ 助手 / 全局默认（`searchMode`）。
 * 选了 builtin 但当前模型不支持 = 照旧用 generic，不会两边都没有；
 * builtin 生效时 GenericSearch 插件这次不提供给模型（工具和说明都去掉），避免同一件事两套做法。
 * 主进程与渲染端共用（纯函数）。
 */
import type { ProviderConfig, SearchMode, YayaConfig } from '../types'
import { supportsBuiltinSearch } from './providers/builtin-search'

export const SEARCH_MODES: SearchMode[] = ['generic', 'builtin']
/** GenericSearch 插件 id */
export const GENERIC_SEARCH_PLUGIN = 'search'

export function normalizeSearchMode(v: unknown): SearchMode {
  return v === 'builtin' ? 'builtin' : 'generic'
}

/** 会话选的 → 默认 */
export function chosenSearchMode(
  config: Pick<YayaConfig, 'searchMode'>,
  sessionMeta: Record<string, unknown> | undefined
): SearchMode {
  return normalizeSearchMode(sessionMeta?.search ?? config.searchMode)
}

/** 这次实际用不用模型自带搜索 */
export function useBuiltinSearch(
  mode: SearchMode,
  provider: Pick<ProviderConfig, 'type' | 'baseUrl' | 'builtinSearch'> | undefined,
  model: string
): boolean {
  return mode === 'builtin' && supportsBuiltinSearch(provider, model)
}

/** builtin 生效时给插件解析用的配置：GenericSearch 关掉（只影响本次运行，不落盘） */
export function withoutGenericSearch(config: YayaConfig): YayaConfig {
  return {
    ...config,
    pluginEnabled: { ...(config.pluginEnabled ?? {}), [GENERIC_SEARCH_PLUGIN]: false }
  }
}
