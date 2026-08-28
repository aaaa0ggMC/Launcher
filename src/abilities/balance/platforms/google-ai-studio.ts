import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher, getProfilePartition } from './base'

export function getGoogleWebPartition(profileOrPlatformId?: string): string {
  return getProfilePartition(profileOrPlatformId)
}

export class GoogleAIStudioFetcher implements PlatformFetcher {
  readonly type = 'google_ai_studio'
  readonly defaultName = 'Google AI Studio'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig): Promise<BalanceResult> {
    const targetUrl = config.baseUrl?.trim() || 'https://aistudio.google.com/billing'
    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'USD',
      amount: 0,
      latencyMs: 1,
      updatedAt: Date.now(),
      raw: { targetUrl, isPortal: true }
    }
  }
}
