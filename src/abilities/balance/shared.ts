import type { BalanceResult } from './types'

export interface SupportedPlatformType {
  type: string
  name: string
  defaultIcon: string
}

export const DEFAULT_PLATFORM_ICON = 'gi:settings'

export const SUPPORTED_PLATFORM_TYPES: SupportedPlatformType[] = [
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

/**
 * Formats a currency balance into a pretty display string.
 */
export function formatBalanceDisplay(bal: Partial<BalanceResult>): string {
  const symbols: Record<string, string> = {
    CNY: '¥',
    USD: '$',
    EUR: '€',
    GBP: '£'
  }
  const currency = bal.currency ?? 'USD'
  const sym = symbols[currency] ?? `${currency} `
  const amount = bal.amount ?? 0

  if (bal.cost) {
    return `- ${sym}${Math.abs(amount).toFixed(2)} / 月`
  }
  if (currency === 'Credits') {
    return `${Math.round(amount).toLocaleString()} Cr`
  }
  if (bal.voucher !== undefined && bal.voucher !== null && bal.voucher > 0) {
    return `${sym}${amount.toFixed(2)} + ${sym}${bal.voucher.toFixed(2)}`
  }
  return `${sym}${amount.toFixed(2)}`
}
