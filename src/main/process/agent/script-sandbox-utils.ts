/**
 * command_script 沙箱的纯辅助函数（不 import electron / 命令注册表 / logger）。
 * 只处理「宿主 JSON 值 ↔ QuickJS 句柄」的转换与 VM 错误信息提取。
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten'

/** VM 里脚本的文件名（用于 stack 行号解析） */
export const SCRIPT_FILENAME = 'command_script.js'

/** 包装头部 `(async () => {` 占用的行数：用户第 1 行 = VM 第 2 行 */
export const WRAPPER_LINES = 1

/** 日志被截断时追加的提示行 */
export const LOG_TRUNCATED_MARK = '…日志已截断'

/** 宿主值递归写进 VM 的最大深度，防栈溢出 */
export const MAX_NESTING_DEPTH = 64

/** VM 栈上限（字节） */
export const MAX_STACK_BYTES = 512 * 1024

/** cockpit.sleep 单次上限（毫秒） */
export const SLEEP_CAP_MS = 10000

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 按「字节」截断（不会把 UTF-8 序列切断） */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(text) <= maxBytes) return text
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  return buf.toString('utf8')
}

/** JSON 克隆；不可序列化时回落 null（不让进不了沙箱的脚本炸掉宿主） */
export function jsonClone(value: unknown): unknown {
  try {
    const cloned = JSON.parse(JSON.stringify(value ?? null))
    return cloned === undefined ? null : cloned
  } catch {
    return null
  }
}

/** JSON 语义的 dump + 再克隆一遍，保证交给宿主的 args 是纯 JSON */
export function plainJson(value: unknown): unknown {
  try {
    const cloned = JSON.parse(JSON.stringify(value))
    return cloned === undefined ? null : cloned
  } catch {
    return null
  }
}

/**
 * 把宿主 JSON 值写进 VM 里的 `target[key]`。
 * 注意：`setProp` 之后调用方仍持有 `value` 句柄的所有权（这里统一由调用方 dispose）。
 */
export function writeJsonValue(
  context: QuickJSContext,
  target: QuickJSHandle,
  key: string | number,
  value: unknown,
  depth = 0
): void {
  if (depth > MAX_NESTING_DEPTH) throw new Error('args 嵌套层级过深')
  if (value === null) {
    setProp(context, target, key, context.null)
    return
  }
  switch (typeof value) {
    case 'string':
      setProp(context, target, key, context.newString(value))
      break
    case 'number':
      setProp(context, target, key, context.newNumber(Number.isFinite(value) ? value : 0))
      break
    case 'boolean':
      setProp(context, target, key, value ? context.true : context.false)
      break
    case 'object': {
      if (Array.isArray(value)) {
        const arr = context.newArray()
        value.forEach((item, index) => writeJsonValue(context, arr, index, item, depth + 1))
        // setProp 接管 arr 的所有权（内部 dup 后释放源句柄）
        setProp(context, target, key, arr)
        break
      }
      const obj = context.newObject()
      for (const [name, item] of Object.entries(value)) {
        writeJsonValue(context, obj, name, item, depth + 1)
      }
      setProp(context, target, key, obj)
      break
    }
    default:
      // undefined / bigint / function / symbol：JSON 语义下忽略
      break
  }
}

/** 把一个宿主 JSON 值变成一个 VM 句柄（调用方负责 dispose） */
export function jsonValueToHandle(
  context: QuickJSContext,
  value: unknown,
  depth = 0
): QuickJSHandle {
  if (value === null || value === undefined) return context.null
  switch (typeof value) {
    case 'string':
      return context.newString(value)
    case 'number':
      return context.newNumber(Number.isFinite(value) ? value : 0)
    case 'boolean':
      return value ? context.true : context.false
    case 'object': {
      if (Array.isArray(value)) {
        const arr = context.newArray()
        value.forEach((item, index) => writeJsonValue(context, arr, index, item, depth + 1))
        return arr
      }
      const obj = context.newObject()
      for (const [name, item] of Object.entries(value)) {
        writeJsonValue(context, obj, name, item, depth + 1)
      }
      return obj
    }
    default:
      return context.null
  }
}

/**
 * 写入属性。`setProp` 是否 dup 值的语义各版本不完全一致，这里统一先 dup 再释放源句柄，
 * 两种语义下都安全。
 */
function setProp(
  context: QuickJSContext,
  target: QuickJSHandle,
  key: string | number,
  value: QuickJSHandle
): void {
  context.setProp(target, key, value)
  value.dispose()
}

export interface VmErrorInfo {
  name?: string
  message?: string
  stack?: string
  code?: string
}

/** 读取 VM 异常对象的 name / message / stack / code（不 dispose 传入的句柄） */
export function readVmErrorInfo(context: QuickJSContext, handle: QuickJSHandle): VmErrorInfo {
  const info: VmErrorInfo = {}
  for (const key of ['name', 'message', 'stack', 'code'] as const) {
    try {
      const prop = context.getProp(handle, key)
      const dumped = context.dump(prop)
      prop.dispose()
      if (typeof dumped === 'string') info[key] = dumped
      else if (key === 'code' && dumped !== undefined && dumped !== null) {
        info.code = String(dumped)
      }
    } catch {
      // 忽略读不到的属性
    }
  }
  return info
}

/**
 * 从 stack 里解析「相对用户代码」的行号（扣掉包装行偏移）。
 * 例：`at <anonymous> (command_script.js:4:5)` → 用户第 3 行（WRAPPER_LINES=1）。
 */
export function parseVmLine(stack: string | undefined, totalUserLines: number): number | undefined {
  if (!stack) return undefined
  const match = new RegExp(`${SCRIPT_FILENAME.replace('.', '\\.')}:(\\d+)`).exec(stack)
  if (!match) return undefined
  const vmLine = Number.parseInt(match[1], 10)
  if (!Number.isFinite(vmLine)) return undefined
  const line = vmLine - WRAPPER_LINES
  if (line < 1 || line > totalUserLines) return undefined
  return line
}
