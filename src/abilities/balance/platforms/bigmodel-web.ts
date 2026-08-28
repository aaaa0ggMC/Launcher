import { session, BrowserWindow } from 'electron'
import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher, getProfilePartition } from './base'

export function getBigModelWebPartition(profileOrPlatformId?: string): string {
  return getProfilePartition(profileOrPlatformId)
}

export class BigModelWebFetcher implements PlatformFetcher {
  readonly type = 'bigmodel_web'
  readonly defaultName = '智谱 BigModel (网页端/免Key)'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    const partitionName = getProfilePartition(config.profileId || config.id)
    const ses = session.fromPartition(partitionName)

    // Check all cookies in this partition for BigModel / Zhipu session
    const allCookies = await ses.cookies.get({})
    const authCookie = allCookies.find(
      (c) =>
        c.name === 'bigmodel_token_production' ||
        c.name === 'token' ||
        (c.domain?.includes('bigmodel.cn') && c.name.includes('token'))
    )

    const hasAnyAuthCookie =
      !!authCookie ||
      allCookies.some(
        (c) =>
          c.domain?.includes('bigmodel.cn') ||
          c.domain?.includes('zhipuai.cn') ||
          c.name.includes('session') ||
          c.name.includes('userId')
      )

    if (!hasAnyAuthCookie && !config.apiKey) {
      throw new Error('未登录智谱 BigModel 账号，请点击卡片上的「登录智谱账号」完成一次性授权')
    }

    // 1. Try direct API with token (from cookie or apiKey) for ultra-fast response
    const token = config.apiKey?.trim() || authCookie?.value?.trim()
    if (token) {
      try {
        const directResult = await this.fetchViaApi(token, timeoutMs)
        if (directResult) {
          return {
            id: config.id,
            name: config.name || this.defaultName,
            type: this.type,
            icon: config.icon || this.defaultIcon,
            currency: 'CNY',
            amount: directResult.amount,
            voucher: directResult.voucher,
            total: directResult.total,
            used: directResult.used,
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
      throw new Error('未能从智谱 BigModel 财务页面解析出余额，请点击「重新登录」刷新授权')
    }

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'CNY',
      amount: extracted.amount,
      voucher: extracted.voucher,
      total: extracted.total,
      used: extracted.used,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: extracted.raw
    }
  }

  private async fetchViaApi(
    token: string,
    timeoutMs: number
  ): Promise<{
    amount: number
    voucher?: number
    total?: number
    used?: number
    raw: Record<string, unknown>
  } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch('https://bigmodel.cn/api/biz/account/query-customer-account-report', {
        headers: {
          accept: 'application/json, text/plain, */*',
          authorization: token,
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
          balance?: number
          availableBalance?: number
          giveAmount?: number
          rechargeAmount?: number
          totalSpendAmount?: number
        }
      }

      if (json.code === 200 && json.data) {
        const d = json.data
        const amount = d.availableBalance ?? d.balance ?? 0
        const voucher = d.giveAmount && d.giveAmount > 0 ? d.giveAmount : undefined
        const total =
          d.rechargeAmount !== undefined && d.giveAmount !== undefined
            ? d.rechargeAmount + d.giveAmount
            : undefined
        const used = d.totalSpendAmount

        return {
          amount,
          voucher,
          total,
          used,
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
    total?: number
    used?: number
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
      let interceptedData: Record<string, unknown> | null = null

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          win.destroy()
          resolve(null)
        }
      }, timeoutMs)

      win.webContents.session.webRequest.onCompleted(
        { urls: ['https://*.bigmodel.cn/*', 'https://*.zhipuai.cn/*'] },
        (details) => {
          if (
            details.url.includes('finance') ||
            details.url.includes('account') ||
            details.url.includes('overview') ||
            details.url.includes('billing')
          ) {
            interceptedData = { url: details.url, status: details.statusCode }
          }
        }
      )

      const tryExtract = async (): Promise<boolean> => {
        try {
          if (win.isDestroyed()) return false
          const currentUrl = win.webContents.getURL()
          if (
            currentUrl.includes('/login') ||
            currentUrl.includes('/auth') ||
            currentUrl.includes('/passport')
          ) {
            clearTimeout(timer)
            isResolved = true
            win.destroy()
            resolve(null)
            return true
          }

          const result = (await win.webContents.executeJavaScript(`
            (async () => {
              // 1. Try in-page fetch using localStorage/cookie token for exact API report
              try {
                const token =
                  localStorage.getItem('token') ||
                  localStorage.getItem('user_token') ||
                  localStorage.getItem('bigmodel_token_production') ||
                  (document.cookie.match(/(?:bigmodel_token_production|token)=([^;]+)/)?.[1]);

                if (token) {
                  const res = await fetch('https://bigmodel.cn/api/biz/account/query-customer-account-report', {
                    headers: { accept: 'application/json, text/plain, */*', authorization: token }
                  });
                  if (res.ok) {
                    const json = await res.json();
                    if (json.code === 200 && json.data) {
                      const d = json.data;
                      const amount = d.availableBalance ?? d.balance ?? 0;
                      const voucher = d.giveAmount && d.giveAmount > 0 ? d.giveAmount : undefined;
                      const total =
                        d.rechargeAmount !== undefined && d.giveAmount !== undefined
                          ? d.rechargeAmount + d.giveAmount
                          : undefined;
                      const used = d.totalSpendAmount;
                      return { amount, voucher, total, used, raw: json };
                    }
                  }
                }
              } catch (e) {}

              // 2. DOM Parsing Fallback
              const bodyText = document.body.innerText || ''
              if (!bodyText) return null

              let amount = null
              let voucher = null
              let cash = null
              let total = null
              let used = null

              const allEls = Array.from(document.querySelectorAll('*'))

              for (const el of allEls) {
                const txt = el.textContent?.trim() || ''
                if (txt === '账户余额' || txt === '总余额' || txt === '可用余额' || txt === '总资产' || txt === '账户总额') {
                  const card = el.closest('div[class*="card"], div[class*="Card"], div[class*="box"], div[class*="item"], div[class*="overview"]') || el.parentElement?.parentElement || el.parentElement
                  if (card) {
                    const cText = card.innerText || ''
                    const m = cText.match(/(?:¥|￥|元)?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/)
                    if (m) {
                      const val = parseFloat(m[1].replace(/,/g, ''))
                      if (!isNaN(val)) amount = val
                    }
                  }
                }

                if (txt === '代金券' || txt === '赠送余额' || txt === '体验金' || txt === '代金券余额') {
                  const card = el.closest('div[class*="card"], div[class*="Card"], div[class*="box"], div[class*="item"]') || el.parentElement?.parentElement || el.parentElement
                  if (card) {
                    const cText = card.innerText || ''
                    const m = cText.match(/(?:¥|￥|元)?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/)
                    if (m) {
                      const val = parseFloat(m[1].replace(/,/g, ''))
                      if (!isNaN(val) && val > 0) voucher = val
                    }
                  }
                }

                if (txt === '累计充值' || txt === '充值总额' || txt === '充值金额') {
                  const card = el.closest('div[class*="card"], div[class*="Card"], div[class*="box"], div[class*="item"]') || el.parentElement?.parentElement || el.parentElement
                  if (card) {
                    const cText = card.innerText || ''
                    const m = cText.match(/(?:¥|￥|元)?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/)
                    if (m) {
                      const val = parseFloat(m[1].replace(/,/g, ''))
                      if (!isNaN(val)) total = val
                    }
                  }
                }

                if (txt === '累计消费' || txt === '累计消耗' || txt === '总消耗' || txt === '消费总额') {
                  const card = el.closest('div[class*="card"], div[class*="Card"], div[class*="box"], div[class*="item"]') || el.parentElement?.parentElement || el.parentElement
                  if (card) {
                    const cText = card.innerText || ''
                    const m = cText.match(/(?:¥|￥|元)?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/)
                    if (m) {
                      const val = parseFloat(m[1].replace(/,/g, ''))
                      if (!isNaN(val)) used = val
                    }
                  }
                }
              }

              // Regex fallback
              if (amount === null) {
                const totalMatch = bodyText.match(/(?:账户余额|总余额|可用余额|总资产|账户总额)[\\s:：]*[¥￥]?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/i)
                if (totalMatch) amount = parseFloat(totalMatch[1].replace(/,/g, ''))
              }

              if (total === null) {
                const totMatch = bodyText.match(/(?:累计充值|充值总额)[\\s:：]*[¥￥]?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/i)
                if (totMatch) total = parseFloat(totMatch[1].replace(/,/g, ''))
              }

              if (used === null) {
                const uMatch = bodyText.match(/(?:累计消[耗费]|消费总额)[\\s:：]*[¥￥]?\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/i)
                if (uMatch) used = parseFloat(uMatch[1].replace(/,/g, ''))
              }

              if (amount !== null && !isNaN(amount)) {
                return {
                  amount,
                  voucher: (voucher !== null && !isNaN(voucher) && voucher > 0) ? voucher : undefined,
                  total: (total !== null && !isNaN(total)) ? total : undefined,
                  used: (used !== null && !isNaN(used)) ? used : undefined,
                  snippet: bodyText.slice(0, 400)
                }
              }
              return null
            })()
          `)) as {
            amount: number
            voucher?: number
            total?: number
            used?: number
            snippet?: string
            raw?: Record<string, unknown>
          } | null

          if (result && typeof result.amount === 'number') {
            if (!isResolved) {
              isResolved = true
              clearTimeout(timer)
              win.destroy()
              resolve({
                amount: result.amount,
                voucher: result.voucher,
                total: result.total,
                used: result.used,
                raw: result.raw || { ...(interceptedData || {}), ...result }
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
        for (let i = 0; i < 25; i++) {
          if (isResolved || win.isDestroyed()) break
          const ok = await tryExtract()
          if (ok) return
          await new Promise((r) => setTimeout(r, 400))
        }
      })

      win.loadURL('https://bigmodel.cn/finance-center/finance/overview').catch(() => {
        // Handled by timeout
      })
    })
  }
}
