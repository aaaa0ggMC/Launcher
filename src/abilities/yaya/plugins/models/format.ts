/**
 * 模型元数据的类型与显示格式（主进程与渲染端共用，不能 import node 模块）。
 */
export interface ModelMeta {
  /** 输入价格（每百万 token） */
  input?: number
  /** 缓存命中的输入价格；缺省按 input 算 */
  cachedInput?: number
  /** 输出价格（含推理） */
  output?: number
  /** USD / CNY / … */
  currency?: string
  contextWindow?: number
  maxOutput?: number
  /** 价格来源（网址或说明） */
  source?: string
  note?: string
  updatedAt?: number
  updatedBy?: 'ai' | 'user'
}

export interface ModelMetaEntry extends ModelMeta {
  providerId: string
  model: string
}

export interface CostRow {
  providerId: string
  providerName: string
  model: string
  calls: number
  prompt: number
  cached: number
  completion: number
  /** 没有价格时为 null */
  cost: number | null
  currency: string
  meta: ModelMeta | null
}

export interface CostData {
  rows: CostRow[]
  /** 币种 → 合计 */
  totals: Record<string, number>
  /** 没有价格的模型数 */
  missing: number
}

const SYMBOLS: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  RMB: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

export function currencyOf(meta: ModelMeta | null): string {
  return meta?.currency || 'USD'
}

/** 金额显示：小额多留几位小数 */
export function formatMoney(amount: number, currency: string): string {
  const sym = SYMBOLS[currency]
  const digits = amount === 0 ? 2 : amount < 0.01 ? 4 : amount < 1 ? 3 : 2
  const n = amount.toFixed(digits)
  return sym ? `${sym}${n}` : `${n} ${currency}`
}

/** 单价显示：$1.25（去掉多余的 0） */
export function formatPrice(price: number, currency: string): string {
  const sym = SYMBOLS[currency]
  const n = String(Number(price.toFixed(4)))
  return sym ? `${sym}${n}` : `${n} ${currency}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}
