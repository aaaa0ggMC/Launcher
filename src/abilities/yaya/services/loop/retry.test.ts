import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ProviderHttpError } from '../providers/http'
import { MAX_RETRIES, isRetryable, retryDelay, sleep } from './retry'

it('限流 / 过载 / 网关错误和网络错误重试；参数、鉴权错误和用户停止不重试', () => {
  for (const s of [408, 429, 500, 502, 503, 504, 529])
    assert.ok(isRetryable(new ProviderHttpError(s, `x ${s}`, '')), String(s))
  for (const s of [400, 401, 403, 404, 422])
    assert.ok(!isRetryable(new ProviderHttpError(s, `x ${s}`, '')), String(s))
  // OpenAI SDK 的错误也带 status
  assert.ok(isRetryable(Object.assign(new Error('Rate limit'), { status: 429 })))
  assert.ok(isRetryable(new TypeError('fetch failed')))
  assert.ok(
    isRetryable(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      })
    )
  )
  assert.ok(isRetryable(new Error('terminated')))
  assert.ok(!isRetryable(Object.assign(new Error('x'), { name: 'AbortError' })))
  assert.ok(!isRetryable(new Error('aborted')))
  assert.ok(!isRetryable(new Error('工具参数不是合法的 JSON')))
})

it('退避递增；服务端的 Retry-After 优先，上限 30 秒', () => {
  assert.deepEqual(
    Array.from({ length: MAX_RETRIES }, (_, i) => retryDelay(i + 1)),
    [1000, 3000, 8000]
  )
  const withHeader = (v: string): Error =>
    Object.assign(new Error('429'), { status: 429, headers: new Headers({ 'retry-after': v }) })
  assert.equal(retryDelay(1, withHeader('5')), 5000)
  assert.equal(retryDelay(1, withHeader('600')), 30_000)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(retryDelay(1, withHeader('Thu, 01 Jan 2026 00:00:02 GMT'), now), 2000)
  assert.equal(retryDelay(2, Object.assign(new Error('x'), { headers: {} })), 3000)
})

it('等待可以被中止', async () => {
  const ac = new AbortController()
  const p = sleep(10_000, ac.signal)
  ac.abort()
  await assert.rejects(p, { name: 'AbortError' })
})
