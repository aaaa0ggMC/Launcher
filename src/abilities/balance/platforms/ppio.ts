import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'

export class PPIOFetcher implements PlatformFetcher {
  readonly type = 'ppio'
  readonly defaultName = 'PPIO'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    if (!config.apiKey) {
      throw new Error('未配置 PPIO API Key')
    }

    const url = config.baseUrl || 'https://api.ppio.com/openapi/v1/user/info'
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json'
      },
      signal: createTimeoutSignal(timeoutMs)
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
    }

    const data = (await res.json()) as {
      balance?: number | string
      voucher?: number | string
      [key: string]: unknown
    }

    // PPIO stores balance in units of 10000 = 1 CNY
    const rawTotal = parseFloat(String(data.balance ?? 0)) / 10000
    const rawVoucher = parseFloat(String(data.voucher ?? 0)) / 10000
    const remaining = rawTotal - rawVoucher

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'CNY',
      amount: remaining,
      voucher: rawVoucher > 0 ? rawVoucher : undefined,
      total: rawTotal,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data
    }
  }
}
