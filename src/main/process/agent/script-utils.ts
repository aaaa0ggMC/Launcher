/**
 * command_script 的纯函数工具（WP-B2）：图片句柄、命令结果清洗（base64 绝不进 VM）、
 * 限额夹紧、错误 code 归一。设计见 docs/exclusive-and-script-design.md §二。
 *
 * 这里**不** import electron / 命令注册表 / 后台任务，所以可以单独 import 做离线自检。
 */

/** 单次运行最多缓存多少张图片（超出丢最旧，句柄编号仍单调递增） */
export const IMAGE_HANDLE_MAX = 32
/** `cockpit.show` 最多把多少张图附到最终返回里 */
export const SHOWN_IMAGE_MAX = 8
/** 脚本代码体积上限（字节） */
export const CODE_MAX_BYTES = 64 * 1024
/** 脚本 return 值 JSON 序列化后的字节上限，超限截断并标注 */
export const RESULT_MAX_BYTES = 256 * 1024
/** `cockpit.log` 行数 / 字节上限 */
export const LOG_MAX_LINES = 200
export const LOG_MAX_BYTES = 16 * 1024
/** `stripImages` 的最大递归深度（命令结果不该有深层嵌套，超深按空值处理） */
const MAX_DEPTH = 12

export interface ScriptImage {
  /** base64，只存在宿主侧 */
  data: string
  mimeType: string
  /** 除掉图片字段后的其余结果字段 */
  meta: Record<string, unknown>
}

/**
 * 图片句柄表：base64 存在这里，沙箱只拿到 `{ $imageRef: n }`。
 * 编号单调递增；超过上限丢最旧的一张，已发出去的句柄随之失效（show 报错）。
 */
export class ImageHandleStore {
  private seq = 0
  private readonly entries = new Map<number, ScriptImage>()

  add(data: string, mimeType: string, meta: Record<string, unknown> = {}): number {
    while (this.entries.size >= IMAGE_HANDLE_MAX) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const ref = ++this.seq
    this.entries.set(ref, { data, mimeType, meta })
    return ref
  }

  get(ref: number): ScriptImage | undefined {
    return this.entries.get(ref)
  }

  has(ref: number): boolean {
    return this.entries.has(ref)
  }
}

/** `cockpit.show` 的记录（上限 8 张）。 */
export class ShownImages {
  private readonly items: { ref: number; label: string }[] = []

  add(ref: number, label: string): void {
    if (this.items.length >= SHOWN_IMAGE_MAX)
      throw new Error(`一次脚本最多展示 ${SHOWN_IMAGE_MAX} 张图片`)
    this.items.push({ ref, label })
  }

  list(): { ref: number; label: string }[] {
    return this.items.map((x) => ({ ref: x.ref, label: x.label }))
  }
}

/**
 * 句柄校验：`ref` 必须是本场运行里存在过的图片编号。
 * 脚本从别处拿到的数字 / 已被挤出上限的旧句柄 → 抛错。
 */
export function resolveShowRef(ref: unknown, store: ImageHandleStore): number {
  const n = typeof ref === 'number' ? ref : Number.NaN
  if (!Number.isInteger(n) || !store.has(n)) throw new Error('未知的图片句柄')
  return n
}

interface RawImage {
  data: string
  mimeType: string
}

/** base64 图片至少这么长，用来避免把普通短 `data` 字段误判成图片 */
const MIN_IMAGE_CHARS = 64

/**
 * 识别两种图片形态：
 * - `$image: { data, mimeType }` —— 命令结果约定（见 tools.ts 的 imageOrJson）
 * - `{ data, mime: 'image/…' }` —— `ui.screenshot` 的结果（inspector 的 ScreenshotResult）
 */
function readRawImage(rec: Record<string, unknown>): RawImage | null {
  const img = rec.$image
  if (img && typeof img === 'object') {
    const d = (img as Record<string, unknown>).data
    const m = (img as Record<string, unknown>).mimeType
    if (typeof d === 'string' && d.length >= MIN_IMAGE_CHARS && typeof m === 'string' && m)
      return { data: d, mimeType: m }
  }
  const d2 = rec.data
  const m2 = rec.mime
  if (
    typeof d2 === 'string' &&
    d2.length >= MIN_IMAGE_CHARS &&
    typeof m2 === 'string' &&
    m2.startsWith('image/')
  )
    return { data: d2, mimeType: m2 }
  return null
}

/** 图片字段（不进 VM，换成句柄） */
const IMAGE_KEYS = new Set(['$image', 'data', 'mime', 'mimeType'])

/**
 * 递归清洗：把任意层级的图片换成 `{ …其余字段, $imageRef: n }`。
 * 同时产出一棵全新的普通对象树（无 cyclic、无 class 实例），可直接 JSON 序列化。
 */
export function stripImages(value: unknown, store: ImageHandleStore, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined
  if (Array.isArray(value)) return value.map((v) => stripImages(v, store, depth + 1))
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const img = readRawImage(rec)
    if (img) {
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (IMAGE_KEYS.has(k)) continue
        meta[k] = stripImages(v, store, depth + 1)
      }
      return { ...meta, $imageRef: store.add(img.data, img.mimeType, meta) }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = stripImages(v, store, depth + 1)
    return out
  }
  return value
}

/** JSON 往返，保证交给沙箱的值一定可序列化。 */
export function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

/** 命令结果 → 沙箱可见值：图片换成句柄，再 JSON 往返。 */
export function sanitizeCommandResult(value: unknown, store: ImageHandleStore): unknown {
  return jsonClone(stripImages(value, store))
}

// ---------------------------------------------------------------------------
// 限额（config.json 的 agent.script）
// ---------------------------------------------------------------------------

export interface ScriptConfig {
  enabled: boolean
  /** 一次脚本里 `cockpit.command` 次数上限 */
  maxCalls: number
  /** VM 内部纯计算时间上限（毫秒） */
  cpuMs: number
  /** 整体墙钟上限（秒） */
  wallSec: number
  /** QuickJS 内存上限（MB） */
  memoryMB: number
}

export const SCRIPT_CONFIG_DEFAULTS: ScriptConfig = {
  enabled: true,
  maxCalls: 300,
  cpuMs: 5000,
  wallSec: 120,
  memoryMB: 64
}

export const SCRIPT_CONFIG_RANGES = {
  maxCalls: { min: 1, max: 2000 },
  cpuMs: { min: 100, max: 60000 },
  wallSec: { min: 5, max: 1800 },
  memoryMB: { min: 16, max: 512 }
} as const

/** 逐项夹紧到 [min,max]；非数字 / 缺失 / null / 空串 → 回落默认值。 */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** `config.json` 的 `agent.script` 原值 → 夹紧后的配置。 */
export function normalizeScriptConfig(raw: unknown): ScriptConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: r.enabled !== false,
    maxCalls: clampInt(
      r.maxCalls,
      SCRIPT_CONFIG_RANGES.maxCalls.min,
      SCRIPT_CONFIG_RANGES.maxCalls.max,
      SCRIPT_CONFIG_DEFAULTS.maxCalls
    ),
    cpuMs: clampInt(
      r.cpuMs,
      SCRIPT_CONFIG_RANGES.cpuMs.min,
      SCRIPT_CONFIG_RANGES.cpuMs.max,
      SCRIPT_CONFIG_DEFAULTS.cpuMs
    ),
    wallSec: clampInt(
      r.wallSec,
      SCRIPT_CONFIG_RANGES.wallSec.min,
      SCRIPT_CONFIG_RANGES.wallSec.max,
      SCRIPT_CONFIG_DEFAULTS.wallSec
    ),
    memoryMB: clampInt(
      r.memoryMB,
      SCRIPT_CONFIG_RANGES.memoryMB.min,
      SCRIPT_CONFIG_RANGES.memoryMB.max,
      SCRIPT_CONFIG_DEFAULTS.memoryMB
    )
  }
}

export interface ScriptRequestLimits {
  maxCalls?: number
  wallSec?: number
}

/** 正数或 null（null = 请求没给，用配置值） */
function positiveOrNull(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * 请求只能把限额**调小**（`Math.min(请求, 配置)`），不能调大；没给的那项用配置值。
 */
export function resolveLimits(
  cfg: ScriptConfig,
  req: ScriptRequestLimits = {}
): {
  cpuMs: number
  wallMs: number
  memoryBytes: number
  maxCalls: number
  maxLogLines: number
  maxLogBytes: number
  maxResultBytes: number
} {
  const calls = positiveOrNull(req.maxCalls)
  const wallSec = positiveOrNull(req.wallSec)
  return {
    cpuMs: cfg.cpuMs,
    wallMs: (wallSec === null ? cfg.wallSec : Math.min(wallSec, cfg.wallSec)) * 1000,
    memoryBytes: cfg.memoryMB * 1024 * 1024,
    maxCalls: calls === null ? cfg.maxCalls : Math.min(calls, cfg.maxCalls),
    maxLogLines: LOG_MAX_LINES,
    maxLogBytes: LOG_MAX_BYTES,
    maxResultBytes: RESULT_MAX_BYTES
  }
}

// ---------------------------------------------------------------------------
// 错误归一（把命令抛出的各种错误统一成沙箱里的 CommandError 字段）
// ---------------------------------------------------------------------------

/** 没有 .code 的错误类按名字映射（命令注册表的那两个） */
const ERROR_NAME_CODES: Record<string, string> = {
  UnknownCommandError: 'unknown_command',
  CommandUnavailableError: 'command_unavailable'
}

/** 命令错误的 code：`exclusive_busy` / `privacy_denied` / `lease_lost` … 取不到用 `command_failed`。 */
export function errorCodeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && code) return code
  if (e && typeof e === 'object') {
    const name = (e as { name?: unknown }).name
    if (typeof name === 'string' && ERROR_NAME_CODES[name]) return ERROR_NAME_CODES[name]
  }
  return 'command_failed'
}

export interface HostErrorInfo {
  name: string
  message: string
  code: string
}

/** 宿主侧命令调用失败 → 抛给沙箱的字段（脚本里 catch 到的是 `CommandError`）。 */
export function hostErrorOf(e: unknown): HostErrorInfo {
  const err = (e ?? {}) as { name?: unknown; message?: unknown }
  const name = typeof err.name === 'string' && err.name ? err.name : 'Error'
  const message =
    e instanceof Error ? e.message : typeof err.message === 'string' ? err.message : String(e)
  return { name, message, code: errorCodeOf(e) }
}
