import type { BalanceResult, PlatformConfig } from '../types'
import { type PlatformFetcher } from './base'

/**
 * 阶跃星辰 Step Plan：官方没有公开额度接口，网页接口的鉴权也不稳定，
 * 这里和 Google AI Studio 一样做成「控制台直达」卡片，在独立 Profile 会话里打开页面查看。
 */
export class StepFunWebFetcher implements PlatformFetcher {
  readonly type = 'stepfun_web'
  readonly defaultName = '阶跃星辰 Step Plan'
  readonly defaultIcon = 'default/lightning/padding'

  async fetchBalance(config: PlatformConfig): Promise<BalanceResult> {
    const targetUrl = config.baseUrl?.trim() || 'https://platform.stepfun.ai/step-plan'
    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'CNY',
      amount: 0,
      latencyMs: 1,
      updatedAt: Date.now(),
      raw: {
        targetUrl,
        isPortal: true,
        portalHint: '阶跃星辰 Step Plan 额度快捷通道：',
        portalLabel: '打开 Step Plan 页面'
      }
    }
  }
}
