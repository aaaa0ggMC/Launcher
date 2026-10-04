/**
 * 无头宿主的隐私授权：Electron 用独立子窗口（`privacy-consent.ts`）；网页里没有窗口，
 * 待处理请求经 SSE 推给页面，由外壳悬浮窗 `PrivacyConsentPopup.vue` 展示。
 *
 * 决定通道（`POST /api/privacy/decide`）除了宿主 token，还要带**随请求生成的一次性 nonce**：
 * nonce 只出现在推给页面的 SSE 帧里，不写盘、不进任何命令结果，用一次即作废。
 * 页面那边再加两道：悬浮层是 AI 禁区（页面桥不能操作）、「允许」只认真实手势（isTrusted）。
 * 「批准」仍然不是命令——CLI / 脚本 / agent 都调用不到。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  decideConsent,
  denyAllPending,
  listPendingRequests,
  setConsentPresenter,
  toConsentView as toView,
  type ConsentDecision,
  type ConsentRequest,
  type ConsentRequestView
} from '../main/process/privacy'
import { makeLogger } from '../main/process/logger'

const log = makeLogger('privacy')

export const CONSENT_CHANNEL = 'privacy:pending'

const nonces = new Map<string, string>()

export interface ConsentRequestWire extends ConsentRequestView {
  nonce: string
}

function views(list: ConsentRequest[]): ConsentRequestWire[] {
  const alive = new Set(list.map((r) => r.id))
  for (const id of [...nonces.keys()]) if (!alive.has(id)) nonces.delete(id)
  return list.map((r) => {
    let nonce = nonces.get(r.id)
    if (!nonce) {
      nonce = randomBytes(24).toString('base64url')
      nonces.set(r.id, nonce)
    }
    return { ...toView(r), nonce }
  })
}

/** 当前待处理请求（含 nonce）——只给 SSE 连接时补发用 */
export function pendingConsentFrames(): ConsentRequestWire[] {
  return views(listPendingRequests())
}

/** 启动时调用（在 initPrivacyConsent 之后，替换掉 Electron 的窗口呈现器） */
export function initHeadlessConsent(
  push: (channel: string, list: ConsentRequestWire[]) => void
): void {
  setConsentPresenter((list) => push(CONSENT_CHANNEL, views(list)))
}

const DECISIONS: ReadonlySet<string> = new Set(['deny', 'once', 'agent', 'session'])

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 页面提交决定：id 必须仍在等待、nonce 必须匹配（用后作废） */
export function decideFromPage(body: unknown): { ok: true } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const id = typeof b.id === 'string' ? b.id : ''
  const nonce = typeof b.nonce === 'string' ? b.nonce : ''
  const decision = typeof b.decision === 'string' ? b.decision : ''
  if (!id || !nonce || !DECISIONS.has(decision)) return { ok: false, error: 'bad request' }
  const want = nonces.get(id)
  if (!want || !sameNonce(want, nonce)) {
    log.warn('consent decision rejected: nonce mismatch', { id })
    return { ok: false, error: 'invalid or expired consent request' }
  }
  nonces.delete(id)
  if (!decideConsent(id, decision as ConsentDecision)) {
    return { ok: false, error: 'consent request already settled' }
  }
  return { ok: true }
}

/** 全部拒绝：安全方向，不要 nonce */
export function denyAllFromPage(): number {
  return denyAllPending()
}
