import type { ProviderConfig } from '../../types'
import type { AIProvider } from './types'
import { OpenAICompatibleProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'

const providerInstances = new Map<string, AIProvider>()

export function getProviderInstance(config: ProviderConfig): AIProvider {
  const cacheKey = `${config.id}:${config.baseUrl}:${config.apiKey}`
  const existing = providerInstances.get(cacheKey)
  if (existing) return existing

  let instance: AIProvider
  switch (config.type) {
    case 'anthropic':
      instance = new AnthropicProvider(config)
      break
    case 'gemini':
      instance = new GeminiProvider(config)
      break
    case 'openai':
    case 'codex-proxy':
    case 'ollama':
    default:
      instance = new OpenAICompatibleProvider(config)
      break
  }

  providerInstances.set(cacheKey, instance)
  return instance
}
