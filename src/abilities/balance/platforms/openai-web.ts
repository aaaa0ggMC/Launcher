import { session, BrowserWindow } from 'electron'
import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher, getProfilePartition } from './base'

export function getOpenAIWebPartition(profileOrPlatformId?: string): string {
  return getProfilePartition(profileOrPlatformId)
}

const sessionAuthCache = new Map<string, { token: string; org?: string }>()

export function cacheOpenAISessionAuth(partition: string, token: string, org?: string): void {
  sessionAuthCache.set(partition, { token, org })
}

export class OpenAIWebFetcher implements PlatformFetcher {
  readonly type = 'openai_web'
  readonly defaultName = 'OpenAI (网页端/免Key)'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    const partitionName = getProfilePartition(config.profileId || config.id)
    const ses = session.fromPartition(partitionName)

    // Check all cookies in this partition
    const allCookies = await ses.cookies.get({})
    const hasAnyAuthCookie = allCookies.some(
      (c) =>
        c.domain?.includes('openai.com') ||
        c.domain?.includes('chatgpt.com') ||
        c.domain?.includes('auth0.com')
    )

    if (!hasAnyAuthCookie && !config.apiKey && !sessionAuthCache.has(partitionName)) {
      throw new Error('未登录此 OpenAI 账号，请点击卡片上的「登录 OpenAI 账号」完成一次性授权')
    }

    // 1. Fast Path: If we have a cached sess- token or user provided apiKey
    const manualToken = config.apiKey?.trim()
    const cached = sessionAuthCache.get(partitionName)
    const token = manualToken || cached?.token

    if (token) {
      try {
        const directResult = await this.fetchViaApi(token, cached?.org, timeoutMs)
        if (directResult) {
          return {
            id: config.id,
            name: config.name || this.defaultName,
            type: this.type,
            icon: config.icon || this.defaultIcon,
            currency: 'USD',
            amount: directResult.amount,
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

    // 2. Hidden Window DOM Scraper & Header Interceptor
    const extracted = await this.fetchViaHiddenWindow(partitionName, timeoutMs)
    if (!extracted) {
      throw new Error('未能从 OpenAI 网页解析出 Credit balance，请点击「重新登录」刷新授权')
    }

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'USD',
      amount: extracted.amount,
      cost: extracted.cost,
      total: extracted.total,
      used: extracted.used,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: extracted.raw
    }
  }

  private async fetchViaApi(
    token: string,
    org: string | undefined,
    timeoutMs: number
  ): Promise<{
    amount: number
    total?: number
    used?: number
    raw: Record<string, unknown>
  } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const headers: Record<string, string> = {
      accept: '*/*',
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      referer: 'https://platform.openai.com/',
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }
    if (org) {
      headers['openai-organization'] = org
    }

    try {
      const res = await fetch('https://api.openai.com/v1/dashboard/billing/credit_grants', {
        headers,
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!res.ok) return null
      const json = (await res.json()) as {
        object?: string
        total_available?: number
        total_granted?: number
        total_used?: number
      }

      if (typeof json.total_available === 'number') {
        return {
          amount: json.total_available,
          total: json.total_granted,
          used: json.total_used,
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
    cost?: boolean
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

      // Intercept Authorization header from outbound requests to cache sess- tokens
      win.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ['https://api.openai.com/*', 'https://platform.openai.com/*'] },
        (details, callback) => {
          const auth =
            details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
          const org =
            details.requestHeaders['Openai-Organization'] ||
            details.requestHeaders['openai-organization']
          if (auth && auth.includes('sess-')) {
            sessionAuthCache.set(partitionName, { token: auth, org })
          }
          callback({ requestHeaders: details.requestHeaders })
        }
      )

      win.webContents.session.webRequest.onCompleted(
        { urls: ['https://*/*.openai.com/*'] },
        (details) => {
          if (
            details.url.includes('credit_grants') ||
            details.url.includes('subscription') ||
            details.url.includes('usage') ||
            details.url.includes('costs') ||
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
            currentUrl.includes('auth0.com')
          ) {
            clearTimeout(timer)
            isResolved = true
            win.destroy()
            resolve(null)
            return true
          }

          // If we captured the token during navigation, query the API immediately
          const cached = sessionAuthCache.get(partitionName)
          if (cached?.token) {
            const apiRes = await this.fetchViaApi(cached.token, cached.org, 4000)
            if (apiRes) {
              if (!isResolved) {
                isResolved = true
                clearTimeout(timer)
                win.destroy()
                resolve({
                  amount: apiRes.amount,
                  total: apiRes.total,
                  used: apiRes.used,
                  raw: { ...(interceptedData || {}), ...apiRes.raw }
                })
                return true
              }
            }
          }

          const result = (await win.webContents.executeJavaScript(`
            (() => {
              const bodyText = document.body.innerText || ''
              if (!bodyText) return null

              let amount = null
              let cost = false

              // 1. Strict card search
              const allEls = Array.from(document.querySelectorAll('*'))
              for (const el of allEls) {
                const txt = el.textContent?.trim() || ''
                if (txt === 'Credit balance' || txt === 'Available balance' || txt === 'Remaining credit' || txt === 'Credits') {
                  const card = el.closest('div[class*="card"], div[class*="Card"], div[class*="box"]') || el.parentElement?.parentElement || el.parentElement
                  if (card) {
                    const cText = card.innerText || ''
                    const m = cText.match(/\\$\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/)
                    if (m) {
                      const val = parseFloat(m[1].replace(/,/g, ''))
                      if (!isNaN(val)) {
                        amount = val
                        cost = false
                        break
                      }
                    }
                  }
                }
              }

              // 2. Strict regex
              if (amount === null) {
                const creditMatch = bodyText.match(/(?:Credit\\s*balance|Available\\s*balance|Remaining\\s*credit)[\\s:：]*\\$\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/i)
                if (creditMatch) {
                  amount = parseFloat(creditMatch[1].replace(/,/g, ''))
                  cost = false
                }
              }

              if (amount === null) {
                const postpayMatch = bodyText.match(/(?:Usage\\s*this\\s*month|Spend\\s*this\\s*month)[\\s:：]*\\$\\s*([0-9,]+(?:\\.[0-9]{1,4})?)/i)
                if (postpayMatch) {
                  amount = parseFloat(postpayMatch[1].replace(/,/g, ''))
                  cost = true
                }
              }

              if (amount !== null && !isNaN(amount)) {
                return {
                  amount,
                  cost,
                  snippet: bodyText.slice(0, 300)
                }
              }
              return null
            })()
          `)) as { amount: number; cost?: boolean; snippet?: string } | null

          if (result && typeof result.amount === 'number') {
            if (!isResolved) {
              isResolved = true
              clearTimeout(timer)
              win.destroy()
              resolve({
                amount: result.amount,
                cost: result.cost,
                raw: { ...(interceptedData || {}), ...result }
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
        for (let i = 0; i < 20; i++) {
          if (isResolved || win.isDestroyed()) break
          const ok = await tryExtract()
          if (ok) return
          await new Promise((r) => setTimeout(r, 400))
        }
      })

      win.loadURL('https://platform.openai.com/home').catch(() => {
        // Handled by timeout
      })
    })
  }
}
