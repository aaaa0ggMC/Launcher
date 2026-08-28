export type BalanceCurrency = 'CNY' | 'USD' | 'EUR' | 'Credits' | string

export type BalanceProviderType = 'openai' | 'mimo' | 'bigmodel' | 'google'

export interface ProfileProviderStatus {
  isLoggedIn: boolean
  account?: string
  lastChecked?: number
}

export interface BalanceProfile {
  id: string
  name: string
  partition: string
  createdAt: number
  updatedAt: number
  providers?: Partial<Record<BalanceProviderType, ProfileProviderStatus>>
}

export interface BalanceResult {
  id: string
  name: string
  type: string
  icon?: string
  currency: BalanceCurrency
  amount: number
  voucher?: number | null
  cost?: boolean
  total?: number
  used?: number
  unit?: string
  error?: string | null
  latencyMs?: number
  updatedAt?: number
  raw?: Record<string, unknown> | null
  profileId?: string
  profileName?: string
}

export interface PlatformConfig {
  id: string
  name: string
  type: string // 'deepseek' | 'openrouter' | 'ppio' | 'tavily' | 'openai' | 'openai_web' | 'mimo' | 'mimo_web' | 'bigmodel' | 'bigmodel_web' | 'google_ai_studio' | 'custom'
  apiKey: string
  profileId?: string
  enabled: boolean
  baseUrl?: string
  icon?: string
  extra?: Record<string, unknown>
}

export interface BalanceSettings {
  autoRefresh: boolean
  refreshIntervalSec: number
  timeoutSec: number
  concurrency: number
}

export interface BalanceConfig {
  version: number
  settings: BalanceSettings
  platforms: PlatformConfig[]
  profiles: BalanceProfile[]
}

export interface PlatformCheckRequest {
  id: string
}
