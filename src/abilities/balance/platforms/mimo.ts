import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher } from './base'
import { MimoWebFetcher } from './mimo-web'

export class MimoFetcher implements PlatformFetcher {
  readonly type = 'mimo'
  readonly defaultName = '小米 MiMo (Cookie/Token 模式)'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const apiKey = config.apiKey?.trim()

    // 1. If apiKey is empty, seamlessly fall back to MiMo Web / Profile session!
    if (!apiKey) {
      const webFetcher = new MimoWebFetcher()
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
            : '未配置小米 MiMo Cookie / ServiceToken，请在设置中填入或点击卡片上的「登录小米账号」'
        )
      }
    }

    const start = performance.now()
    const token = apiKey

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const cookieHeader = token.includes('=') ? token : `api-platform_serviceToken=${token}`
    const url = config.baseUrl?.trim() || 'https://platform.xiaomimimo.com/api/v1/balance'

    const headers: Record<string, string> = {
      accept: '*/*',
      cookie: cookieHeader,
      referer: 'https://platform.xiaomimimo.com/console/balance',
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }

    try {
      const res = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)

      if (res.status === 401 || res.status === 403) {
        throw new Error('Cookie / Token 已失效，请重新获取或登录')
      }
      if (!res.ok) {
        // Fallback to web scraper
        const webFetcher = new MimoWebFetcher()
        return await webFetcher.fetchBalance(config, timeoutMs)
      }

      const json = (await res.json()) as {
        code: number
        message?: string
        data?: {
          balance?: string | number
          cashBalance?: string | number
          giftBalance?: string | number
          frozenBalance?: string | number
          currency?: string
        }
      }

      if (json.code !== 0 || !json.data) {
        throw new Error(json.message || '获取小米 MiMo 余额信息失败')
      }

      const d = json.data
      const amount =
        typeof d.balance === 'number'
          ? d.balance
          : parseFloat(String(d.balance ?? d.cashBalance ?? '0'))
      const voucherNum =
        typeof d.giftBalance === 'number' ? d.giftBalance : parseFloat(String(d.giftBalance ?? '0'))
      const voucher = voucherNum > 0 ? voucherNum : undefined

      return {
        id: config.id,
        name: config.name || this.defaultName,
        type: this.type,
        icon: config.icon || this.defaultIcon,
        currency: d.currency || 'CNY',
        amount: isNaN(amount) ? 0 : amount,
        voucher,
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
