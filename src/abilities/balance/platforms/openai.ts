import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'
import { OpenAIWebFetcher } from './openai-web'

export class OpenAIFetcher implements PlatformFetcher {
  readonly type = 'openai'
  readonly defaultName = 'OpenAI'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    const apiKey = config.apiKey?.trim()

    // 1. If apiKey is empty, seamlessly fall back to OpenAI Web session / token cache!
    if (!apiKey) {
      const webFetcher = new OpenAIWebFetcher()
      try {
        const res = await webFetcher.fetchBalance(config, timeoutMs)
        return {
          ...res,
          type: this.type,
          name: config.name || this.defaultName,
          icon: config.icon || this.defaultIcon
        }
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? err.message
            : '未配置 OpenAI API Key，请在设置中填入或点击卡片上的「登录 OpenAI 账号」'
        )
      }
    }

    // 2. If key is a Session Token (sess-...), query the dashboard credit_grants API
    if (apiKey.startsWith('sess-') || apiKey.includes('sess-')) {
      const token = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`
      const url =
        config.baseUrl?.trim() || 'https://api.openai.com/v1/dashboard/billing/credit_grants'

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: token,
          Accept: '*/*',
          Referer: 'https://platform.openai.com/',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        },
        signal: createTimeoutSignal(timeoutMs)
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
      }

      const json = (await res.json()) as {
        object?: string
        total_available?: number
        total_granted?: number
        total_used?: number
      }

      if (typeof json.total_available !== 'number') {
        throw new Error('未能从 credit_grants 返回中解析出可用余额')
      }

      return {
        id: config.id,
        name: config.name || this.defaultName,
        type: this.type,
        icon: config.icon || this.defaultIcon,
        currency: 'USD',
        amount: json.total_available,
        total: json.total_granted,
        used: json.total_used,
        latencyMs: Math.round(performance.now() - start),
        updatedAt: Date.now(),
        raw: json as unknown as Record<string, unknown>
      }
    }

    // 3. Standard API Key (sk-...) -> Monthly Costs API
    const today = new Date()
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const startTimeUnix = Math.floor(startOfMonth.getTime() / 1000)
    const endTimeUnix = Math.floor(today.getTime() / 1000)

    const baseUrl = config.baseUrl || 'https://api.openai.com'
    const costsUrl = `${baseUrl.replace(/\/+$/, '')}/v1/organization/costs?start_time=${startTimeUnix}&end_time=${endTimeUnix}&limit=100`

    const res = await fetch(costsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: createTimeoutSignal(timeoutMs)
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
    }

    const data = (await res.json()) as {
      data?: Array<{
        results?: Array<{
          amount?: {
            value?: number | string
          }
        }>
      }>
    }

    let totalUsage = 0
    if (Array.isArray(data.data)) {
      for (const bucket of data.data) {
        if (Array.isArray(bucket.results)) {
          for (const item of bucket.results) {
            totalUsage += Number(item.amount?.value ?? 0)
          }
        }
      }
    }

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'USD',
      amount: totalUsage,
      cost: true,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data as unknown as Record<string, unknown>
    }
  }
}
