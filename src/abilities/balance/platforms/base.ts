import type { BalanceResult, PlatformConfig } from '../types'
export { formatBalanceDisplay } from '../shared'

export interface PlatformFetcher {
  readonly type: string
  readonly defaultName: string
  readonly defaultIcon: string
  fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult>
}

/**
 * Returns a standardized, isolated Electron session partition name for a given Profile ID.
 */
export function getProfilePartition(profileId?: string): string {
  if (profileId && profileId.startsWith('persist:')) {
    return profileId
  }
  const safeId = (profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `persist:cockpit_balance_profile_${safeId}`
}

/**
 * Creates an AbortSignal that aborts after timeoutMs.
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}
