import type { PlatformFetcher } from './base'
import { DeepSeekFetcher } from './deepseek'
import { OpenRouterFetcher } from './openrouter'
import { PPIOFetcher } from './ppio'
import { TavilyFetcher } from './tavily'
import { OpenAIFetcher } from './openai'
import { OpenAIWebFetcher } from './openai-web'
import { MimoFetcher } from './mimo'
import { MimoWebFetcher } from './mimo-web'
import { BigModelFetcher } from './bigmodel'
import { BigModelWebFetcher } from './bigmodel-web'
import { GoogleAIStudioFetcher } from './google-ai-studio'
import { CustomFetcher } from './custom'

export * from './base'
export * from './deepseek'
export * from './openrouter'
export * from './ppio'
export * from './tavily'
export * from './openai'
export * from './openai-web'
export * from './mimo'
export * from './mimo-web'
export * from './bigmodel'
export * from './bigmodel-web'
export * from './google-ai-studio'
export * from './custom'

const fetchers: Record<string, PlatformFetcher> = {
  deepseek: new DeepSeekFetcher(),
  openrouter: new OpenRouterFetcher(),
  ppio: new PPIOFetcher(),
  tavily: new TavilyFetcher(),
  openai: new OpenAIFetcher(),
  openai_web: new OpenAIWebFetcher(),
  mimo: new MimoFetcher(),
  mimo_web: new MimoWebFetcher(),
  bigmodel: new BigModelFetcher(),
  bigmodel_web: new BigModelWebFetcher(),
  google_ai_studio: new GoogleAIStudioFetcher(),
  custom: new CustomFetcher()
}

export function getFetcher(type: string): PlatformFetcher {
  return fetchers[type] || fetchers['custom']
}

export function listSupportedPlatformTypes(): Array<{
  type: string
  name: string
  defaultIcon: string
}> {
  return [
    { type: 'deepseek', name: 'DeepSeek', defaultIcon: 'gi:settings' },
    { type: 'openrouter', name: 'OpenRouter', defaultIcon: 'gi:settings' },
    { type: 'ppio', name: 'PPIO 派欧算力', defaultIcon: 'gi:settings' },
    { type: 'tavily', name: 'Tavily Search', defaultIcon: 'gi:settings' },
    { type: 'openai', name: 'OpenAI (API Key 当月账单)', defaultIcon: 'gi:settings' },
    {
      type: 'openai_web',
      name: 'OpenAI (网页端/免Key)',
      defaultIcon: 'gi:settings'
    },
    {
      type: 'mimo',
      name: '小米 MiMo (Cookie/Token 模式)',
      defaultIcon: 'gi:settings'
    },
    {
      type: 'mimo_web',
      name: '小米 MiMo (网页端/免Key)',
      defaultIcon: 'gi:settings'
    },
    {
      type: 'bigmodel',
      name: '智谱 BigModel (Token 模式)',
      defaultIcon: 'gi:settings'
    },
    {
      type: 'bigmodel_web',
      name: '智谱 BigModel (网页端/免Key)',
      defaultIcon: 'gi:settings'
    },
    {
      type: 'google_ai_studio',
      name: 'Google AI Studio (网页控制台直达)',
      defaultIcon: 'gi:settings'
    },
    { type: 'custom', name: '自定义 / New API', defaultIcon: 'gi:settings' }
  ]
}
