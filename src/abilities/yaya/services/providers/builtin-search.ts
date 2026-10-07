/**
 * 模型自带的联网搜索（RikkaHub 叫「内置搜索」）：搜索在服务商那边做，模型直接拿到网页内容作答，
 * 不经过 YAYA 的工具循环。和 GenericSearch 插件（`web_search` 工具）二选一，见 `search-mode.ts`。
 *
 * 各家开法：
 * - Gemini 原生：`tools: [{ google_search: {} }]`，来源在 `groundingMetadata`；
 * - Anthropic：服务端工具 `web_search_20250305`，来源在 `web_search_tool_result` 块；
 * - OpenAI 兼容：OpenRouter `plugins: [{id:'web'}]`、通义 `enable_search`、
 *   OpenAI 搜索模型 `web_search_options`；来源在 `annotations[].url_citation` / `search_info`。
 *
 * 哪些模型能用：服务商设置里逐模型可强制开 / 关（`ProviderConfig.builtinSearch`），没设就按类型和名字猜。
 */
import type { ProviderConfig } from '../../types'
import type { BuiltinSearchInfo } from './types'

export type OpenAISearchStyle = 'openai' | 'openrouter' | 'qwen'

/** OpenAI 兼容端点用哪种字段开搜索；null = 这个端点没有已知的开法 */
export function openaiSearchStyle(
  cfg: Pick<ProviderConfig, 'type' | 'baseUrl'>
): OpenAISearchStyle | null {
  if (cfg.type !== 'openai') return null
  const url = (cfg.baseUrl ?? 'https://api.openai.com/v1').toLowerCase()
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('dashscope') || url.includes('aliyuncs')) return 'qwen'
  return 'openai'
}

/** 不是对话模型（向量 / 画图 / 语音），不谈搜索 */
const NON_CHAT = /embed|imagen|image-generation|tts|transcribe|whisper|dall-e|moderation|audio/i

/** 按服务商类型与模型名猜：这个模型有没有自带搜索 */
export function guessBuiltinSearch(
  cfg: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  model: string
): boolean {
  const m = model.toLowerCase()
  if (!m || NON_CHAT.test(m)) return false
  switch (cfg.type) {
    case 'gemini':
      return /gemini/.test(m) && !/gemma/.test(m)
    case 'anthropic':
      return /claude/.test(m) && !/claude-(instant|2|3-haiku|3-sonnet|3-opus)/.test(m)
    case 'openai': {
      const style = openaiSearchStyle(cfg)
      if (style === 'openrouter') return true
      if (style === 'qwen') return /qwen|qwq/.test(m)
      // OpenAI Chat Completions 只有 *-search-* 模型接受 web_search_options
      return /search/.test(m) && /gpt|openai/.test(m)
    }
    default:
      return false
  }
}

/** 最终判断：用户的逐模型设置优先，其次猜 */
export function supportsBuiltinSearch(
  cfg: Pick<ProviderConfig, 'type' | 'baseUrl' | 'builtinSearch'> | undefined,
  model: string
): boolean {
  if (!cfg || !model) return false
  const forced = cfg.builtinSearch?.[model]
  if (typeof forced === 'boolean') return forced
  return guessBuiltinSearch(cfg, model)
}

/** OpenAI 兼容端点：打开搜索的请求字段 */
export function openaiSearchParams(style: OpenAISearchStyle): Record<string, unknown> {
  switch (style) {
    case 'openrouter':
      return { plugins: [{ id: 'web' }] }
    case 'qwen':
      return { enable_search: true, search_options: { enable_source: true } }
    case 'openai':
    default:
      return { web_search_options: {} }
  }
}

/** 累积一次请求里的搜索词与来源（按 URL 去重，保序） */
export class SearchCollector {
  private queries: string[] = []
  private sources: BuiltinSearchInfo['sources'] = []
  private urls = new Set<string>()
  /** 模型确实用了搜索（有的端点只给来源不给查询词，反之亦然） */
  private used = false

  query(q: unknown): void {
    if (typeof q !== 'string' || !q.trim()) return
    this.used = true
    if (!this.queries.includes(q.trim())) this.queries.push(q.trim())
  }

  source(url: unknown, title?: unknown): void {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    this.used = true
    if (this.urls.has(url)) return
    this.urls.add(url)
    this.sources.push({
      url,
      ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {})
    })
  }

  /** OpenAI / OpenRouter 的 `annotations`（`url_citation`） */
  annotations(list: unknown): void {
    if (!Array.isArray(list)) return
    for (const a of list) {
      const c = (a as { url_citation?: { url?: string; title?: string } })?.url_citation
      if (c) this.source(c.url, c.title)
    }
  }

  /** 通义 `search_info.search_results` */
  qwenSearchInfo(info: unknown): void {
    const list = (info as { search_results?: unknown })?.search_results
    if (!Array.isArray(list)) return
    for (const r of list) {
      const x = r as { url?: string; title?: string }
      this.source(x.url, x.title)
    }
  }

  result(): BuiltinSearchInfo | undefined {
    if (!this.used) return undefined
    return { queries: this.queries, sources: this.sources }
  }
}

/**
 * 端点拒绝了自带搜索（这个模型其实不支持，或不能和函数调用同时用，如 Gemini 2.x 的 google_search）。
 * Provider 记下后抛这个错，运行器换回 GenericSearch 重做这一步，本次进程里这个模型不再尝试。
 */
export class BuiltinSearchUnsupportedError extends Error {
  constructor(
    public providerId: string,
    public model: string,
    detail: string
  ) {
    super(`Built-in search rejected by ${providerId}/${model}: ${detail.slice(0, 200)}`)
    this.name = 'BuiltinSearchUnsupportedError'
  }
}

const rejected = new Set<string>()

export function rejectBuiltinSearch(providerId: string, model: string): void {
  rejected.add(`${providerId}\n${model}`)
}

export function builtinSearchRejected(providerId: string, model: string): boolean {
  return rejected.has(`${providerId}\n${model}`)
}
