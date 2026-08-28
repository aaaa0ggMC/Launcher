import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher } from './base'
import { BigModelWebFetcher } from './bigmodel-web'

export class BigModelFetcher implements PlatformFetcher {
  readonly type = 'bigmodel'
  readonly defaultName = '智谱 BigModel (Token 模式)'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const apiKey = config.apiKey?.trim()

    // 1. If apiKey is empty, seamlessly fall back to BigModel Web / Profile session!
    if (!apiKey) {
      const webFetcher = new BigModelWebFetcher()
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
            : '未配置智谱 Authorization Token，请在设置中填入或点击卡片上的「登录智谱账号」'
        )
      }
    }

    const start = performance.now()
    const token = apiKey

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const url =
      config.baseUrl?.trim() || 'https://bigmodel.cn/api/biz/account/query-customer-account-report'
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      authorization: token,
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }

    try {
      const res = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)

      if (res.status === 401 || res.status === 403) {
        // Fallback to web scraper
        const webFetcher = new BigModelWebFetcher()
        return await webFetcher.fetchBalance(config, timeoutMs)
      }
      if (!res.ok) {
        // Fallback to web scraper
        const webFetcher = new BigModelWebFetcher()
        return await webFetcher.fetchBalance(config, timeoutMs)
      }

      const json = (await res.json()) as {
        code: number
        msg?: string
        data?: {
          balance?: number
          availableBalance?: number
          giveAmount?: number
          rechargeAmount?: number
          totalSpendAmount?: number
        }
        success?: boolean
      }

      if (json.code !== 200 || !json.data) {
        throw new Error(json.msg || '获取智谱账户信息失败')
      }

      const d = json.data
      const amount = d.availableBalance ?? d.balance ?? 0
      const voucher = d.giveAmount && d.giveAmount > 0 ? d.giveAmount : undefined
      const total =
        d.rechargeAmount !== undefined && d.giveAmount !== undefined
          ? d.rechargeAmount + d.giveAmount
          : undefined
      const used = d.totalSpendAmount

      return {
        id: config.id,
        name: config.name || this.defaultName,
        type: this.type,
        icon: config.icon || this.defaultIcon,
        currency: 'CNY',
        amount,
        voucher,
        total,
        used,
        latencyMs: Math.round(performance.now() - start),
        updatedAt: Date.now(),
        raw: json as unknown as Record<string, unknown>
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`请求超时 (${timeoutMs}ms)`)
      }
      throw err
    }
  }
}
