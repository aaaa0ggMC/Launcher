import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'

export class CustomFetcher implements PlatformFetcher {
  readonly type = 'custom'
  readonly defaultName = '自定义平台'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    if (!config.baseUrl) {
      throw new Error('未配置接口 Base URL')
    }

    const headers: Record<string, string> = {
      Accept: 'application/json'
    }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    let targetUrl = config.baseUrl.trim()
    const customKind = String(config.extra?.customKind || 'newapi')

    if (customKind === 'newapi' && !targetUrl.includes('/api/')) {
      targetUrl = `${targetUrl.replace(/\/+$/, '')}/api/user/self`
    }

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: createTimeoutSignal(timeoutMs)
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
    }

    const data = (await res.json()) as Record<string, unknown>
    let amount = 0
    let currency = (config.extra?.currency as string) || 'USD'
    let voucher: number | undefined

    // Check for New API / One API quota structure: { success: true, data: { quota: number } } (500000 = 1 USD)
    if (data && typeof data === 'object') {
      const innerData = (data.data as Record<string, unknown>) || data
      if (typeof innerData.quota === 'number') {
        amount = innerData.quota / 500000
        currency = 'USD'
      } else if (typeof innerData.balance === 'number' || typeof innerData.balance === 'string') {
        amount = parseFloat(String(innerData.balance))
      } else if (
        typeof innerData.total_balance === 'number' ||
        typeof innerData.total_balance === 'string'
      ) {
        amount = parseFloat(String(innerData.total_balance))
      } else if (typeof innerData.credits === 'number' || typeof innerData.credits === 'string') {
        amount = parseFloat(String(innerData.credits))
        currency = 'Credits'
      }
    }

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency,
      amount,
      voucher,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data
    }
  }
}
