/**
 * 会话级 Secret（SecretPlugin 的存储与文本变换）。
 *
 * 用户在消息里写 `#Secret("值")`：入库前换成 `[[secret_xxxx]]` 引用，值加密存在
 * `~/.config/LinuxCockpit/yaya/secrets/<会话>.json`，模型只看到引用。
 * 工具执行时把参数里的引用换回真值；工具结果里出现的真值再换回引用（模型 `echo` 也拿不到）。
 * 防君子不防小人：工具拿到的是真值，故意变形（base64 等）后输出照样能拿到。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { USER_CONFIG_DIR } from '../../../main/process/paths'
import { decryptSecret, encryptSecret } from '../../../main/process/encrypt'

export interface SecretEntry {
  id: string
  /** 加密后的值 */
  value: string
  createdAt: number
}

/** 引用：`[[secret_k3f9]]` */
export const SECRET_TOKEN_RE = /\[\[(secret_[a-z0-9]{4,12})\]\]/g
/**
 * `#Secret("…")`；也认中文输入法常打出的弯引号 “…” 和单引号 '…'。
 * 直引号里可以用 \" 与 \\ 转义。
 */
const SECRET_INPUT_RE = /#Secret\(\s*(?:"((?:[^"\\]|\\.)*)"|“([^”]*)”|'((?:[^'\\]|\\.)*)')\s*\)/g
/** 太短的值不做结果反替换（会把正常文字误替换成引用） */
const MIN_SCRUB_LENGTH = 3

function dir(): string {
  return join(USER_CONFIG_DIR, 'yaya', 'secrets')
}
function fileOf(sessionId: string): string {
  return join(dir(), `${sessionId.replace(/[^\w-]/g, '_')}.json`)
}

/** 明文缓存：每次工具调用都要用，别每次读盘解密 */
const cache = new Map<string, Map<string, string>>()

function load(sessionId: string): Map<string, string> {
  const hit = cache.get(sessionId)
  if (hit) return hit
  const map = new Map<string, string>()
  try {
    const path = fileOf(sessionId)
    if (existsSync(path)) {
      const list = JSON.parse(readFileSync(path, 'utf-8')) as SecretEntry[]
      for (const e of list) {
        const plain = decryptSecret(e.value)
        if (plain) map.set(e.id, plain)
      }
    }
  } catch {
    /* 读坏了就当没有：引用不会被替换，工具会拿到字面量 */
  }
  cache.set(sessionId, map)
  return map
}

function save(sessionId: string, map: Map<string, string>): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const now = Date.now()
  const list: SecretEntry[] = [...map].map(([id, v]) => ({
    id,
    value: encryptSecret(v),
    createdAt: now
  }))
  writeFileSync(fileOf(sessionId), JSON.stringify(list, null, 2), { mode: 0o600 })
}

function newId(taken: Map<string, string>): string {
  for (;;) {
    const id = `secret_${randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4)}`
    if (!taken.has(id)) return id
  }
}

function unescape(raw: string): string {
  return raw.replace(/\\(["'\\])/g, '$1')
}

/** 用户消息入库前：把 `#Secret("…")` 换成引用，值存起来。同一个值复用同一个 id */
export function extractSecrets(sessionId: string, text: string): { text: string; ids: string[] } {
  if (!text.includes('#Secret(')) return { text, ids: [] }
  const map = load(sessionId)
  const ids: string[] = []
  let changed = false
  const out = text.replace(SECRET_INPUT_RE, (_all, dq?: string, curly?: string, sq?: string) => {
    const value = dq !== undefined ? unescape(dq) : curly !== undefined ? curly : unescape(sq ?? '')
    if (!value) return _all
    let id = [...map].find(([, v]) => v === value)?.[0]
    if (!id) {
      id = newId(map)
      map.set(id, value)
      changed = true
    }
    ids.push(id)
    return `[[${id}]]`
  })
  if (changed) save(sessionId, map)
  return { text: out, ids }
}

/** 深度遍历，改写其中的字符串 */
export function mapStrings<T>(value: T, fn: (s: string) => string, depth = 0): T {
  if (typeof value === 'string') return fn(value) as T
  if (depth > 32 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1)) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = mapStrings(v, fn, depth + 1)
  return out as T
}

/** 工具参数：引用 → 真值（找不到的引用原样保留） */
export function substituteSecrets<T>(sessionId: string, value: T): T {
  const map = load(sessionId)
  if (!map.size) return value
  return mapStrings(value, (s) =>
    s.includes('[[secret_')
      ? s.replace(SECRET_TOKEN_RE, (all, id: string) => map.get(id) ?? all)
      : s
  )
}

/** 工具结果：真值 → 引用（长的先换，避免一个值是另一个的子串时换坏） */
export function scrubSecrets<T>(sessionId: string, value: T): T {
  const map = load(sessionId)
  const pairs = [...map]
    .filter(([, v]) => v.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)
  if (!pairs.length) return value
  return mapStrings(value, (s) => {
    let out = s
    for (const [id, v] of pairs) if (out.includes(v)) out = out.split(v).join(`[[${id}]]`)
    return out
  })
}

/** 本会话的 secret 引用（不含值） */
export function listSecretIds(sessionId: string): string[] {
  return [...load(sessionId).keys()]
}

/** 给用户本人的界面显示真值（命令侧必须 agent: 'deny'） */
export function secretValues(sessionId: string): Record<string, string> {
  return Object.fromEntries(load(sessionId))
}

export function deleteSessionSecrets(sessionId: string): void {
  cache.delete(sessionId)
  try {
    rmSync(fileOf(sessionId), { force: true })
  } catch {
    /* 没有就算了 */
  }
}

export function __resetSecretCacheForTest(): void {
  cache.clear()
}
