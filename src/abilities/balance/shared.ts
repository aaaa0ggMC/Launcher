import type { BalanceProviderType, BalanceResult } from './types'

/**
 * 安卓 App 里的网页登录（无头宿主没有浏览器窗口）：App 开一个原生登录页，登录完把这些 URL 下的
 * cookie 取回来交给宿主（balance.profiles.import-cookies）。只列余额靠 cookie 取的厂商——
 * OpenAI 网页版靠拦截请求头、Google 不允许在 WebView 里登录，这两家在 App 里用不了网页登录。
 */
export interface WebLoginSpec {
  /** 打开的第一页 */
  url: string
  /** 登录完会回到的站点；离开过它（去了登录页）再回来且已加载完 → 自动完成 */
  doneHosts: string[]
  /** 取 cookie 的 URL（覆盖登录涉及的各个域） */
  cookieUrls: string[]
}

export const WEB_LOGIN: Partial<Record<BalanceProviderType, WebLoginSpec>> = {
  mimo: {
    url: 'https://platform.xiaomimimo.com/console/balance',
    doneHosts: ['platform.xiaomimimo.com'],
    cookieUrls: [
      'https://platform.xiaomimimo.com/',
      'https://xiaomimimo.com/',
      'https://account.xiaomi.com/'
    ]
  },
  bigmodel: {
    url: 'https://bigmodel.cn/finance-center/finance/overview',
    doneHosts: ['bigmodel.cn', 'www.bigmodel.cn'],
    cookieUrls: ['https://bigmodel.cn/', 'https://www.bigmodel.cn/', 'https://open.bigmodel.cn/']
  }
}

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
  {
    type: 'codex',
    name: 'Codex (ChatGPT 配额)',
    defaultIcon: 'default/lightning/padding'
  },
  {
    type: 'claude_code',
    name: 'Claude Code (订阅配额)',
    defaultIcon: 'default/lightning/padding'
  },
  {
    type: 'stepfun_web',
    name: '阶跃星辰 Step Plan (网页端/免Key)',
    defaultIcon: 'default/lightning/padding'
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

  if (currency === '%' || bal.unit === '%') {
    return `${Math.round(amount)}%`
  }
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
