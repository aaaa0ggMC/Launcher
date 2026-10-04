import type { ProviderConfig } from '../../types'
import type { AIProvider } from './types'
import { OpenAICompatibleProvider } from './openai'

const providerInstances = new Map<string, AIProvider>()

export function getProviderInstance(config: ProviderConfig): AIProvider {
  const cacheKey = `${config.id}:${config.baseUrl}:${config.apiKey}`
  const existing = providerInstances.get(cacheKey)
  if (existing) return existing

  let instance: AIProvider
  switch (config.type) {
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
