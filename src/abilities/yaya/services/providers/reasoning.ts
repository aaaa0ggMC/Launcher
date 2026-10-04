/**
 * 思考强度 → 各家 OpenAI 兼容端点的请求参数。
 *
 * 没有统一标准：OpenAI / Ollama 用 `reasoning_effort`，DeepSeek 用 `thinking.type`，
 * Qwen（DashScope / vLLM）用 `enable_thinking` + `thinking_budget`，OpenRouter 用 `reasoning`，
 * llama.cpp 用 `chat_template_kwargs`。服务商可在设置里指定格式，缺省按地址猜。
 * `default` = 什么都不发（模型自己的默认行为）。
 */
import type { ProviderConfig, ReasoningEffort, ReasoningStyle } from '../../types'

export const REASONING_EFFORTS: ReasoningEffort[] = ['default', 'off', 'low', 'medium', 'high']

export function normalizeEffort(v: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(v as ReasoningEffort) ? (v as ReasoningEffort) : 'default'
}

/** `auto` → 按服务商类型 / 地址猜 */
export function resolveReasoningStyle(
  cfg: Pick<ProviderConfig, 'type' | 'baseUrl' | 'reasoningStyle'>
): Exclude<ReasoningStyle, 'auto'> {
  if (cfg.reasoningStyle && cfg.reasoningStyle !== 'auto') return cfg.reasoningStyle
  const url = (cfg.baseUrl ?? '').toLowerCase()
  if (url.includes('deepseek')) return 'deepseek'
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('dashscope') || url.includes('aliyuncs')) return 'qwen'
  if (url.includes('llama') || /:8080(\/|$)/.test(url)) return 'llamacpp'
  return 'openai'
}

const QWEN_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 4096,
  high: 16384
}

/** 额外的请求体字段（空对象 = 不改请求） */
export function reasoningParams(
  style: Exclude<ReasoningStyle, 'auto'>,
  effort: ReasoningEffort,
  providerType?: ProviderConfig['type']
): Record<string, unknown> {
  if (effort === 'default' || style === 'none') return {}
  const off = effort === 'off'
  switch (style) {
    case 'deepseek':
      return { thinking: { type: off ? 'disabled' : 'enabled' } }
    case 'qwen':
      return off
        ? { enable_thinking: false }
        : { enable_thinking: true, thinking_budget: QWEN_BUDGET[effort] }
    case 'openrouter':
      return { reasoning: off ? { enabled: false } : { effort } }
    case 'llamacpp':
      return {
        chat_template_kwargs: off
          ? { enable_thinking: false }
          : { enable_thinking: true, reasoning_effort: effort }
      }
    case 'openai':
    default:
      // OpenAI 没有「完全不思考」，最接近的是 minimal；Ollama 认 none
      return { reasoning_effort: off ? (providerType === 'ollama' ? 'none' : 'minimal') : effort }
  }
}
