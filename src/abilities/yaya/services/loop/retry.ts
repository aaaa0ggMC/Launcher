/**
 * 模型请求的自动重试（纯函数，可离线自检）。
 *
 * 只重试「换个时间再来大概率就好」的错误：限流 / 过载 / 网关错误（408、409、425、429、5xx、
 * Anthropic 的 529）和网络层错误（连接被重置、超时、DNS 抖动、流中途断开）。
 * 参数错误、鉴权失败、余额不足这类 4xx 重试也没用，直接报给用户。
 */

/** 第一次失败之后最多再试几次 */
export const MAX_RETRIES = 3
/** 退避：1s → 3s → 8s；服务端给了 Retry-After 就听它的（上限 30s） */
const BACKOFF_MS = [1000, 3000, 8000]
const RETRY_AFTER_CAP_MS = 30_000

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])
const NETWORK_RE =
  /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|terminated|premature close|other side closed|connection (?:error|closed|reset)|timed? ?out|overloaded/i

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

function textOf(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return `${e.name} ${e.message} ${cause instanceof Error ? `${cause.name} ${cause.message} ${(cause as { code?: string }).code ?? ''}` : ''}`
  }
  return String(e)
}

/** 用户主动停止的不算 */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'AbortError' || e.name === 'APIUserAbortError' || e.message === 'aborted')
  )
}

export function isRetryable(e: unknown): boolean {
  if (isAbortError(e)) return false
  const status = statusOf(e)
  if (status !== undefined) return RETRY_STATUS.has(status)
  return NETWORK_RE.test(textOf(e))
}

/** 响应头里的 Retry-After（秒或 HTTP 日期）；没有 / 解析不了返回 undefined */
function retryAfterMs(e: unknown, now: number): number | undefined {
  const headers = (e as { headers?: unknown } | null)?.headers
  let raw: string | null | undefined
  if (headers && typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('retry-after')
  } else if (headers && typeof headers === 'object') {
    const v = (headers as Record<string, unknown>)['retry-after']
    raw = typeof v === 'string' ? v : undefined
  }
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/** 第 attempt 次重试（从 1 开始）前等多久 */
export function retryDelay(attempt: number, e?: unknown, now = Date.now()): number {
  const hinted = e === undefined ? undefined : retryAfterMs(e, now)
  if (hinted !== undefined) return Math.min(RETRY_AFTER_CAP_MS, hinted)
  return BACKOFF_MS[Math.min(BACKOFF_MS.length, Math.max(1, attempt)) - 1]
}

/** 给用户看的简短原因（完整错误放 tooltip） */
export function errorBrief(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** 可中止的等待：中止时立即 reject（AbortError） */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (signal?.aborted) return reject(abortErr())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortErr())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
