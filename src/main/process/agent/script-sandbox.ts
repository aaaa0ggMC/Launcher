/**
 * command_script 的 QuickJS 沙箱（纯模块：不 import electron / 命令注册表，只靠注入的 HostApi 与外界通信）。
 * 设计见 docs/exclusive-and-script-design.md §二。WP-B1 实现；签名由副总监定好，agent/script.ts（WP-B2）依赖它。
 */

import { getQuickJS } from 'quickjs-emscripten'
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule
} from 'quickjs-emscripten'

import {
  LOG_TRUNCATED_MARK,
  MAX_STACK_BYTES,
  SCRIPT_FILENAME,
  SLEEP_CAP_MS,
  jsonClone,
  jsonValueToHandle,
  parseVmLine,
  plainJson,
  readVmErrorInfo,
  truncateUtf8,
  utf8ByteLength
} from './script-sandbox-utils'

export interface SandboxLimits {
  /** VM 内部纯计算时间上限（毫秒，累计；宿主调用 / sleep 期间不计） */
  cpuMs: number
  /** 整体墙钟上限（毫秒） */
  wallMs: number
  memoryBytes: number
  /** `cockpit.command` 调用次数上限 */
  maxCalls: number
  maxLogLines: number
  maxLogBytes: number
  /** 脚本 return 值 JSON 序列化后的字节上限，超限截断并标注 */
  maxResultBytes: number
}

/** 宿主侧能力：沙箱里的 `cockpit.command` / `cockpit.show` 最终调用它们。 */
export interface HostApi {
  /** 执行一条命令；返回值必须可 JSON 序列化；抛错 → 脚本里的 CommandError（带 name/message/code） */
  command(name: string, args: unknown): Promise<unknown>
  /** `cockpit.show(ref, label)`：宿主校验 ref 并记录；ref 非法抛错 */
  show(ref: unknown, label: string): void
  /** 每次 cockpit.command 开始前回调（作业面板记日志用） */
  onCall?(info: { index: number; name: string }): void
}

export type SandboxLimitName =
  | 'cpuMs'
  | 'wallMs'
  | 'memoryBytes'
  | 'maxCalls'
  | 'maxLogLines'
  | 'maxLogBytes'
  | 'maxResultBytes'
  | 'aborted'

export interface SandboxError {
  /** 'CommandError' | 'LimitError' | 'ScriptError' | 'Aborted' */
  name: string
  message: string
  /** 脚本里的出错行（1 起，相对用户代码；取不到则省略） */
  line?: number
  limit?: SandboxLimitName
  /** CommandError 的 code（如 exclusive_busy / privacy_denied） */
  code?: string
}

export interface SandboxResult {
  ok: boolean
  /** 脚本 return 的值（JSON）；超限被截断时是 `{ $truncated: true, preview: string }` */
  result?: unknown
  logs: string[]
  /** 已发出的 cockpit.command 次数 */
  calls: number
  elapsedMs: number
  error?: SandboxError
}

/** 需要释放的 VM 资源（句柄 / deferred promise） */
interface Disposable {
  dispose(): void
}

/** deferred promise 的最小接口（drain 用，避免依赖导出类型名） */
interface DeferredLike {
  handle: { alive: boolean }
  resolve(value: QuickJSHandle): void
}

/** VM 函数的实现签名（与 quickjs-emscripten 的 VmFunctionImplementation 对齐，但不引入该依赖类型） */
type VmFn = (this: QuickJSHandle, ...fnArgs: QuickJSHandle[]) => QuickJSHandle | void

/** 脚本里 `e instanceof CommandError` 为真所需的类（在 VM 预定义，宿主只负责 new 它） */
const COMMAND_ERROR_BOOTSTRAP = `(function () {
  function CommandError(name, message, code) {
    const err = new Error(message)
    err.name = 'CommandError'
    err.commandName = name
    err.code = code
    Object.setPrototypeOf(err, CommandError.prototype)
    return err
  }
  CommandError.prototype = Object.create(Error.prototype)
  CommandError.prototype.constructor = CommandError
  return CommandError
})()`

/** 沙箱自己挂到 globalThis 上的属性（cleanup 时要先摘掉） */
const SANDBOX_GLOBALS = ['cockpit', 'args', 'CommandError'] as const

/** 把用户代码包成 async 函数体：第 1 行是包装行，用户代码从第 2 行开始 */
function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})()`
}

/** 宿主错误的 `.code`（命令注册表的错误带 code，如 exclusive_busy / privacy_denied） */
function hostErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code ? code : undefined
}

function hostErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * 在 QuickJS 里把 `code` 当作 **async 函数体** 执行（可 await、可 return，`args` 是传入的常量）。
 * 沙箱里只有 ES 内置对象 + `cockpit`（command / sleep / log / show）+ `args`；没有 process / require / fetch /
 * setTimeout / import()。超限 / signal 中止 → 终止并返回已完成部分（ok:false + error.limit）。
 */
export async function runScript(
  code: string,
  args: unknown,
  host: HostApi,
  limits: SandboxLimits,
  signal?: AbortSignal
): Promise<SandboxResult> {
  const startedAt = Date.now()
  const totalUserLines = code.split('\n').length

  const logs: string[] = []
  let logBytes = 0
  let logTruncated = false
  let calls = 0
  let limitHit: SandboxLimitName | undefined
  let aborted = signal?.aborted === true
  /** 当前这次 VM 执行的起点（interrupt handler 累计 CPU 用） */
  let vmEnter = startedAt
  let cpuUsed = 0
  let disposed = false
  /** 宿主侧 deferred 落定时唤醒主循环，免得空转 */
  let wake: (() => void) | undefined

  /** 所有要 dispose 的 VM 句柄 / deferred（按创建顺序，cleanup 反序释放） */
  const owned: Disposable[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  let runtime: QuickJSRuntime | undefined
  let context: QuickJSContext | undefined
  let finalValue: QuickJSHandle | undefined
  let finalError: QuickJSHandle | undefined
  let jobError: QuickJSHandle | undefined

  const result: SandboxResult = { ok: false, logs: [], calls: 0, elapsedMs: 0 }

  const pushLog = (line: string): void => {
    if (logTruncated) return
    const bytes = utf8ByteLength(line)
    if (logs.length >= limits.maxLogLines || logBytes + bytes > limits.maxLogBytes) {
      logTruncated = true
      return
    }
    logs.push(line)
    logBytes += bytes
  }

  const finish = (patch: Partial<SandboxResult>): SandboxResult => {
    result.logs = logTruncated ? [...logs, LOG_TRUNCATED_MARK] : [...logs]
    result.calls = calls
    result.elapsedMs = Date.now() - startedAt
    return Object.assign(result, patch)
  }

  const failWith = (error: SandboxError): SandboxResult => finish({ ok: false, error })

  const wakeUp = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  /** 让出事件循环给宿主异步（5ms 兜底轮询，避免空转烧 CPU） */
  const yieldToHost = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve
      setTimeout(resolve, 5)
    })

  const cleanup = (): void => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    // 先把自己挂到 globalThis 上的引用摘掉，让 cockpit / args / CommandError
    // 能在 context 释放时就把引用计数级联掉（C 函数的 .prototype 是环，靠 GC 收不干净）。
    const activeCtx = context
    if (activeCtx) {
      for (const key of SANDBOX_GLOBALS) {
        try {
          activeCtx.setProp(activeCtx.global, key, activeCtx.undefined)
        } catch {
          // 上下文已不可用就跳过
        }
      }
    }
    for (let i = owned.length - 1; i >= 0; i--) {
      try {
        owned[i].dispose()
      } catch {
        // 句柄可能已被提前释放，忽略
      }
    }
    owned.length = 0
    const ctx = context
    const rt = runtime
    context = undefined
    runtime = undefined
    if (ctx) {
      try {
        ctx.dispose()
      } catch {
        // 个别句柄没释放干净也别影响 runtime 释放
      }
    }
    if (rt) {
      try {
        rt.dispose()
      } catch {
        // 同上
      }
    }
  }

  /** VM 异常 → SandboxError（限额 / 中止优先于脚本自身错误） */
  // 把未完成的宿主 promise 全部落定并驱动 VM 展开：墙钟等「不从 VM 内部触发」的中断发生后，
  // async 函数还悬在 await 上，直接 dispose 会在 QuickJS 里留下循环引用（JS_FreeRuntime 断言失败）。
  const drain = (ctx: QuickJSContext, rt: QuickJSRuntime, items: Disposable[]): void => {
    try {
      for (const item of items) {
        const deferred = item as Partial<DeferredLike>
        if (typeof deferred.resolve === 'function' && deferred.handle && deferred.handle.alive) {
          try {
            deferred.resolve(ctx.undefined)
          } catch {
            // 已释放就跳过
          }
        }
      }
      for (let i = 0; i < 50; i++) {
        if (!rt.hasPendingJob()) break
        vmEnter = Date.now()
        const jobs = rt.executePendingJobs()
        cpuUsed += Date.now() - vmEnter
        if (jobs.error) {
          jobs.error.dispose()
          break
        }
      }
    } catch {
      // 展开失败也不影响收尾
    }
  }

  const mapVmError = (info: {
    name?: string
    message?: string
    stack?: string
    code?: string
  }): SandboxError => {
    const message = info.message ?? ''
    if (limitHit) {
      return { name: 'LimitError', message, limit: limitHit }
    }
    if (aborted) {
      return { name: 'Aborted', message: message || 'aborted', limit: 'aborted' }
    }
    if (info.name === 'CommandError') {
      return { name: 'CommandError', message, code: info.code }
    }
    if (/out of memory/i.test(message)) {
      return { name: 'LimitError', message, limit: 'memoryBytes' }
    }
    return {
      name: 'ScriptError',
      message,
      line: parseVmLine(info.stack, totalUserLines)
    }
  }

  /** 读取脚本 return 值的 JSON 文本；undefined 表示脚本 return 了 undefined */
  const serializeResult = (ctx: QuickJSContext, value: QuickJSHandle): string | undefined => {
    const jsonHandle = ctx.getProp(ctx.global, 'JSON')
    const stringifyHandle = ctx.getProp(jsonHandle, 'stringify')
    jsonHandle.dispose()
    try {
      const call = ctx.callFunction(stringifyHandle, ctx.undefined, value)
      if (call.error) {
        const info = readVmErrorInfo(ctx, call.error)
        call.error.dispose()
        throw new Error(`返回值无法 JSON 序列化：${info.message || 'unknown'}`)
      }
      const rendered = call.value
      try {
        return ctx.typeof(rendered) === 'undefined' ? undefined : ctx.getString(rendered)
      } finally {
        rendered.dispose()
      }
    } finally {
      stringifyHandle.dispose()
    }
  }

  if (aborted) {
    return failWith({ name: 'Aborted', message: 'aborted', limit: 'aborted' })
  }

  try {
    const module = (await getQuickJS()) as QuickJSWASMModule
    const rt = module.newRuntime()
    runtime = rt
    const ctx = rt.newContext()
    context = ctx

    rt.setMaxStackSize(MAX_STACK_BYTES)
    if (limits.memoryBytes > 0) rt.setMemoryLimit(limits.memoryBytes)
    rt.setInterruptHandler(() => {
      if (aborted || signal?.aborted) {
        aborted = true
        return true
      }
      if (limitHit) return true
      if (cpuUsed + (Date.now() - vmEnter) > limits.cpuMs) {
        limitHit = 'cpuMs'
        return true
      }
      return false
    })

    // —— CommandError 类（VM 内预定义，保证 e instanceof CommandError 为真）——
    const bootResult = ctx.evalCode(COMMAND_ERROR_BOOTSTRAP, SCRIPT_FILENAME, { type: 'global' })
    if (bootResult.error) {
      const info = readVmErrorInfo(ctx, bootResult.error)
      bootResult.error.dispose()
      cleanup()
      return failWith({ name: 'ScriptError', message: info.message || 'sandbox 初始化失败' })
    }
    const commandErrorCtor = bootResult.value
    owned.push(commandErrorCtor)
    // 同时挂成全局：脚本里 `e instanceof CommandError` 为真
    ctx.setProp(ctx.global, 'CommandError', commandErrorCtor)

    // —— args（JSON 克隆）——
    const argsHandle = jsonValueToHandle(ctx, jsonClone(args))
    ctx.setProp(ctx.global, 'args', argsHandle)
    argsHandle.dispose()

    // —— cockpit 对象 ——
    const cockpitHandle = ctx.newObject()
    owned.push(cockpitHandle)

    const stringifyVmValue = (handle: QuickJSHandle | undefined): string => {
      if (handle === undefined) return 'undefined'
      try {
        const type = ctx.typeof(handle)
        if (type === 'string') return ctx.getString(handle)
        if (type === 'undefined') return 'undefined'
        if (type === 'number') return String(ctx.getNumber(handle))
        const dumped = ctx.dump(handle)
        return typeof dumped === 'string' ? dumped : (JSON.stringify(dumped) ?? `[${type}]`)
      } catch {
        return '[unserializable]'
      }
    }

    const buildCommandError = (name: string, error: unknown): QuickJSHandle => {
      const code = hostErrorCode(error)
      const strings = [
        ctx.newString(name),
        ctx.newString(hostErrorMessage(error)),
        code === undefined ? ctx.undefined : ctx.newString(code)
      ]
      const call = ctx.callFunction(commandErrorCtor, ctx.undefined, strings)
      for (const handle of strings) handle.dispose()
      if (call.error) {
        const fallback = ctx.newError({ name: 'CommandError', message: hostErrorMessage(error) })
        call.error.dispose()
        return fallback
      }
      return call.value
    }

    const defineFn = (name: string, length: number, impl: VmFn): void => {
      const handle = ctx.newFunctionWithOptions({ name, length, isConstructor: false, fn: impl })
      ctx.setProp(cockpitHandle, name, handle)
      handle.dispose()
    }

    // 宿主异步 → VM promise 的桥：返回的句柄归 VM 回调的 scope 所有（所以给一份 dup），
    // deferred 本体留在 owned 里由 cleanup 释放。宿主落定后立刻驱动一次 VM，
    // 否则 await 的续体要等主循环下一轮才跑（quickjs-emscripten 官方推荐的写法）。
    const bridge = (setup: (deferred: QuickJSDeferredPromise) => void): QuickJSHandle => {
      const deferred = ctx.newPromise()
      owned.push(deferred)
      deferred.settled.then(() => {
        if (disposed) return
        const activeRuntime = runtime
        if (!activeRuntime) return
        try {
          vmEnter = Date.now()
          const jobs = activeRuntime.executePendingJobs()
          cpuUsed += Date.now() - vmEnter
          if (jobs.error) jobs.error.dispose()
        } catch {
          // VM 已不可用，主循环会收尾
        }
        wakeUp()
      })
      setup(deferred)
      return deferred.handle.dup()
    }

    defineFn('command', 2, (nameHandle, argsHandle) => {
      if (limitHit || aborted) return ctx.undefined
      if (calls >= limits.maxCalls) {
        // 不向 VM 抛可捕获异常：直接终止整个脚本
        limitHit = 'maxCalls'
        return ctx.undefined
      }
      let name: string
      try {
        name = ctx.getString(nameHandle)
      } catch {
        throw new Error('cockpit.command(name, args?) 的第一个参数必须是字符串')
      }
      if (typeof name !== 'string' || !name) {
        throw new Error('cockpit.command(name, args?) 的第一个参数必须是字符串')
      }
      const rawArgs = argsHandle === undefined ? undefined : plainJson(ctx.dump(argsHandle))
      calls += 1
      host.onCall?.({ index: calls, name })
      // 注意：VM 回调的返回值会被 quickjs-emscripten 的 scope 接管并释放，
      // bridge 返回的是 dup，deferred 本体留在 owned 里由 cleanup 释放。
      return bridge((deferred) => {
        Promise.resolve()
          .then(() => host.command(name, rawArgs))
          .then((value) => {
            if (disposed || !deferred.handle.alive) return
            try {
              const valueHandle = jsonValueToHandle(ctx, jsonClone(value))
              deferred.resolve(valueHandle)
              valueHandle.dispose()
            } catch {
              deferred.resolve(ctx.undefined)
            }
          })
          .catch((error: unknown) => {
            if (disposed || !deferred.handle.alive) return
            try {
              const errorHandle = buildCommandError(name, error)
              deferred.reject(errorHandle)
              errorHandle.dispose()
            } catch {
              deferred.resolve(ctx.undefined)
            }
          })
      })
    })

    defineFn('sleep', 1, (msHandle) => {
      if (limitHit || aborted) return ctx.undefined
      const raw = ctx.getNumber(msHandle)
      const ms = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), SLEEP_CAP_MS) : 0
      // 宿主侧计时（不占 VM 的 CPU 预算；signal 中止 / 收尾时会 clearTimeout）
      return bridge((deferred) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed && deferred.handle.alive) deferred.resolve(ctx.undefined)
        }, ms)
        timers.add(timer)
      })
    })

    defineFn('log', 8, (...valueHandles: QuickJSHandle[]) => {
      pushLog(valueHandles.map((handle) => stringifyVmValue(handle)).join(' '))
      return ctx.undefined
    })

    defineFn('show', 2, (refHandle, labelHandle) => {
      const ref = refHandle === undefined ? undefined : plainJson(ctx.dump(refHandle))
      const label = String(ctx.dump(labelHandle ?? ctx.undefined) ?? '')
      // 宿主校验失败抛错 → 脚本里能 catch
      host.show(ref, label)
      return ctx.undefined
    })

    ctx.setProp(ctx.global, 'cockpit', cockpitHandle)

    // —— 执行用户代码 ——
    vmEnter = Date.now()
    const evalResult = ctx.evalCode(wrapUserCode(code), SCRIPT_FILENAME, { type: 'global' })
    cpuUsed += Date.now() - vmEnter
    if (evalResult.error) {
      const info = readVmErrorInfo(ctx, evalResult.error)
      evalResult.error.dispose()
      cleanup()
      return failWith({
        name: 'ScriptError',
        message: info.message || '脚本语法错误',
        line: parseVmLine(info.stack, totalUserLines)
      })
    }
    const promiseHandle = evalResult.value
    owned.push(promiseHandle)

    for (;;) {
      if (aborted) break
      if (limitHit) break
      if (Date.now() - startedAt > limits.wallMs) {
        limitHit = 'wallMs'
        break
      }
      // 已结束就直接收尾（别为了跑无关的 job 再烧 CPU 预算）
      const settled = ctx.getPromiseState(promiseHandle)
      if (settled.type === 'fulfilled') {
        finalValue = settled.value
        break
      }
      if (settled.type === 'rejected') {
        finalError = settled.error
        break
      }
      if (!rt.hasPendingJob()) {
        // 在等宿主（命令 / sleep）
        await yieldToHost()
        continue
      }
      vmEnter = Date.now()
      const jobs = rt.executePendingJobs()
      cpuUsed += Date.now() - vmEnter
      if (jobs.error) {
        jobError = jobs.error
        break
      }
    }

    if (finalValue !== undefined) {
      let serialized: string | undefined
      try {
        serialized = serializeResult(ctx, finalValue)
      } catch (error) {
        finalValue.dispose()
        finalValue = undefined
        cleanup()
        return failWith({ name: 'ScriptError', message: hostErrorMessage(error) })
      }
      finalValue.dispose()
      finalValue = undefined
      cleanup()
      if (serialized === undefined) return finish({ ok: true })
      const bytes = utf8ByteLength(serialized)
      if (bytes > limits.maxResultBytes) {
        return finish({
          ok: true,
          result: {
            $truncated: true,
            preview: truncateUtf8(serialized, Math.floor(limits.maxResultBytes / 2))
          }
        })
      }
      return finish({ ok: true, result: JSON.parse(serialized) })
    }

    if (jobError !== undefined || finalError !== undefined) {
      const handle = (jobError ?? finalError) as QuickJSHandle
      const info = readVmErrorInfo(ctx, handle)
      const failure = mapVmError(info)
      handle.dispose()
      cleanup()
      return failWith(failure)
    }

    // 走到这里说明是被墙钟 / 宿主侧异常打断，async 函数还悬着：先让它展开再收尾
    drain(ctx, rt, owned)
    cleanup()
    return failWith({
      name: aborted ? 'Aborted' : 'LimitError',
      message: aborted ? 'aborted' : `脚本被中断（${String(limitHit)}）`,
      limit: aborted ? 'aborted' : limitHit
    })
  } catch (error) {
    // 宿主自身的 bug 也不外抛
    cleanup()
    return failWith({ name: 'ScriptError', message: hostErrorMessage(error) })
  }
}
