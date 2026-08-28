import { session, BrowserWindow } from 'electron'
import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher, getProfilePartition } from './base'

export function getMimoWebPartition(profileOrPlatformId?: string): string {
  return getProfilePartition(profileOrPlatformId)
}

export class MimoWebFetcher implements PlatformFetcher {
  readonly type = 'mimo_web'
  readonly defaultName = '小米 MiMo (网页端/免Key)'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    const partitionName = getProfilePartition(config.profileId || config.id)
    const ses = session.fromPartition(partitionName)

    // Check all cookies in this partition for Xiaomi / MiMo session
    const allCookies = await ses.cookies.get({})
    const mimoCookies = allCookies.filter(
      (c) =>
        c.domain?.includes('xiaomimimo.com') ||
        c.domain?.includes('xiaomi.com') ||
        c.domain?.includes('mi.com') ||
        c.name.includes('userId') ||
        c.name.includes('serviceToken') ||
        c.name.includes('passToken')
    )

    if (mimoCookies.length === 0 && !config.apiKey) {
      throw new Error('未登录小米账号，请点击卡片上的「登录小米账号」完成一次性授权')
    }

    // 1. Try direct API using filtered session cookies or manual apiKey for ultra-fast response (<100ms)
    const cookieHeader = config.apiKey?.trim()
      ? config.apiKey.includes('=')
        ? config.apiKey
        : `api-platform_serviceToken=${config.apiKey}`
      : mimoCookies.map((c) => `${c.name}=${c.value}`).join('; ')

    if (cookieHeader) {
      try {
        const directResult = await this.fetchViaApi(cookieHeader, timeoutMs)
        if (directResult) {
          return {
            id: config.id,
            name: config.name || this.defaultName,
            type: this.type,
            icon: config.icon || this.defaultIcon,
            currency: 'CNY',
            amount: directResult.amount,
            voucher: directResult.voucher,
            latencyMs: Math.round(performance.now() - start),
            updatedAt: Date.now(),
            raw: directResult.raw
          }
        }
      } catch {
        // Fallback to hidden window
      }
    }

    // 2. Fallback to hidden window DOM scraper
    const extracted = await this.fetchViaHiddenWindow(partitionName, timeoutMs)
    if (!extracted) {
      throw new Error('未能从小米 MiMo 页面解析出余额，请点击「重新登录」刷新授权')
    }

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'CNY',
      amount: extracted.amount,
      voucher: extracted.voucher,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: extracted.raw
    }
  }

  private async fetchViaApi(
    cookieHeader: string,
    timeoutMs: number
  ): Promise<{
    amount: number
    voucher?: number
    raw: Record<string, unknown>
  } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch('https://platform.xiaomimimo.com/api/v1/balance', {
        headers: {
          accept: '*/*',
          cookie: cookieHeader,
          referer: 'https://platform.xiaomimimo.com/console/balance',
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        },
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!res.ok) return null
      const json = (await res.json()) as {
        code: number
        data?: {
          balance?: string | number
          cashBalance?: string | number
          giftBalance?: string | number
          frozenBalance?: string | number
          currency?: string
        }
      }

      if (json.code === 0 && json.data) {
        const d = json.data
        const amount =
          typeof d.balance === 'number'
            ? d.balance
            : parseFloat(String(d.balance ?? d.cashBalance ?? '0'))
        const voucherNum =
          typeof d.giftBalance === 'number'
            ? d.giftBalance
            : parseFloat(String(d.giftBalance ?? '0'))
        const voucher = voucherNum > 0 ? voucherNum : undefined

        return {
          amount: isNaN(amount) ? 0 : amount,
          voucher,
          raw: json as unknown as Record<string, unknown>
        }
      }
    } catch {
      clearTimeout(timer)
    }
    return null
  }

  private async fetchViaHiddenWindow(
    partitionName: string,
    timeoutMs: number
  ): Promise<{
    amount: number
    voucher?: number
    raw: Record<string, unknown>
  } | null> {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          partition: partitionName,
          sandbox: false,
          backgroundThrottling: false
        }
      })

      let isResolved = false

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          win.destroy()
          resolve(null)
        }
      }, timeoutMs)

      const tryExtract = async (): Promise<boolean> => {
        try {
          if (win.isDestroyed()) return false
          const result = (await win.webContents.executeJavaScript(`
            (() => {
              const bodyText = document.body.innerText || ''
              if (!bodyText) return null

              let amount = null
              let voucher = null
              let cash = null

              // 1. Cash Balance / 现金余额
              const cashMatch = bodyText.match(/(?:现金余额|Cash\\s*Balance)\\s*[:：]?\\s*¥?\\s*([0-9,]+(?:\\.[0-9]+)?)/i)
              if (cashMatch) {
                cash = parseFloat(cashMatch[1].replace(/,/g, ''))
              }

              // 2. Bonus Balance / 赠送余额
              const bonusMatch = bodyText.match(/(?:赠送余额|Bonus\\s*Balance)\\s*[:：]?\\s*¥?\\s*([0-9,]+(?:\\.[0-9]+)?)/i)
              if (bonusMatch) {
                voucher = parseFloat(bonusMatch[1].replace(/,/g, ''))
              }

              // 3. Main Total Balance / 余额
              const balanceMatch = bodyText.match(/(?:余额|Balance)[\\r\\n\\s]*¥\\s*([0-9,]+(?:\\.[0-9]+)?)/i)
              if (balanceMatch) {
                amount = parseFloat(balanceMatch[1].replace(/,/g, ''))
              } else if (cash !== null) {
                amount = (cash || 0) + (voucher || 0)
              }

              if (amount !== null && !isNaN(amount)) {
                return {
                  amount,
                  voucher: (voucher !== null && !isNaN(voucher) && voucher > 0) ? voucher : undefined,
                  cash: cash !== null && !isNaN(cash) ? cash : undefined
                }
              }
              return null
            })()
          `)) as {
            amount: number
            voucher?: number
            cash?: number
          } | null

          if (result && typeof result.amount === 'number') {
            if (!isResolved) {
              isResolved = true
              clearTimeout(timer)
              win.destroy()
              resolve({
                amount: result.amount,
                voucher: result.voucher,
                raw: result as Record<string, unknown>
              })
              return true
            }
          }
        } catch {
          // Retry until timeout
        }
        return false
      }

      win.webContents.on('did-finish-load', async () => {
        // Poll for SPA DOM rendering
        for (let i = 0; i < 20; i++) {
          if (isResolved || win.isDestroyed()) break
          const ok = await tryExtract()
          if (ok) return
          await new Promise((r) => setTimeout(r, 400))
        }
      })

      win.loadURL('https://platform.xiaomimimo.com/console/balance').catch(() => {
        // Handled by timeout
      })
    })
  }
}
