/**
 * 当前这次 agent 调用的中止信号（经 AsyncLocalStorage 贯穿调用链，和 `withOrigin` 同一个思路）。
 *
 * 为什么：MCP / Remote 的客户端对一次调用有自己的超时，超时 / 断开后客户端当作失败，但服务端的操作还在继续
 * （正在按键、正在跑循环）。网关把 SDK 给的 `extra.signal`（MCP）/ HTTP 连接断开（Remote）放进这里，
 * 长跑的命令（wait-until / command_script / 按键序列）在循环里检查 `callSignal()?.aborted`，客户端放弃了就立刻停手。
 * 没有信号（UI / CLI 来源、内部调用）时返回 undefined，等于永不中止。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<AbortSignal>()

export function withCallSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? store.run(signal, fn) : fn()
}

export function callSignal(): AbortSignal | undefined {
  return store.getStore()
}

/** 当前调用已被客户端放弃？ */
export function callAborted(): boolean {
  return callSignal()?.aborted === true
}

/** 可被中止的等待：`ms` 毫秒后 resolve；调用被放弃时提前 resolve（调用方再检查 `callAborted()`）。 */
export function abortableSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const signal = callSignal()
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
