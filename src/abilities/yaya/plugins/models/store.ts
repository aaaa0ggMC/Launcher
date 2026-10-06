/**
 * 模型元数据（价格 / 上下文长度等）存储与费用计算。
 *
 * 存在 `~/.config/LinuxCockpit/yaya/model-meta.json`，key = `<服务商 id>/<模型>`；
 * 服务商写 `*` 表示「任何服务商下的这个模型」。查找顺序：精确 → `*` → 去掉厂商前缀的模型名
 * （`openai/gpt-5` 与 `gpt-5` 视为同一个）。价格单位：每百万 token。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { USER_CONFIG_DIR } from '../../../../main/process/paths'
import type { ModelMeta, ModelMetaEntry } from './format'

export type { ModelMeta, ModelMetaEntry } from './format'
export { currencyOf, formatMoney, formatPrice, formatTokens } from './format'

const MAX_ENTRIES = 2000

function file(): string {
  return join(USER_CONFIG_DIR, 'yaya', 'model-meta.json')
}

let cache: Record<string, ModelMeta> | null = null

export function metaKey(providerId: string, model: string): string {
  return `${providerId || '*'}/${model}`
}

function splitKey(key: string): { providerId: string; model: string } {
  const i = key.indexOf('/')
  return { providerId: key.slice(0, i), model: key.slice(i + 1) }
}

function load(): Record<string, ModelMeta> {
  if (cache) return cache
  let data: Record<string, ModelMeta> = {}
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf-8')) as {
        entries?: Record<string, ModelMeta>
      }
      if (raw && typeof raw.entries === 'object' && raw.entries) data = raw.entries
    }
  } catch {
    /* 读坏了当空：下次写入覆盖 */
  }
  cache = data
  return data
}

function save(entries: Record<string, ModelMeta>): void {
  mkdirSync(dirname(file()), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2))
  renameSync(tmp, file())
  cache = entries
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}
const int = (v: unknown): number | undefined => {
  const n = num(v)
  return n === undefined ? undefined : Math.round(n)
}
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

/** 规范化一份（来自 AI / 界面）的输入：非法值丢掉；null = 清除这个字段 */
export function normalizeMetaPatch(raw: Record<string, unknown>): Partial<ModelMeta> {
  const out: Record<string, unknown> = {}
  const set = (k: keyof ModelMeta, v: unknown): void => {
    if (raw[k] === null) out[k] = undefined
    else if (v !== undefined) out[k] = v
  }
  set('input', num(raw.input))
  set('cachedInput', num(raw.cachedInput))
  set('output', num(raw.output))
  const cur = text(raw.currency, 8)
  set('currency', cur ? cur.toUpperCase() : undefined)
  set('contextWindow', int(raw.contextWindow))
  set('maxOutput', int(raw.maxOutput))
  set('source', text(raw.source, 300))
  set('note', text(raw.note, 300))
  return out as Partial<ModelMeta>
}

export function listMeta(): ModelMetaEntry[] {
  return Object.entries(load())
    .map(([key, meta]) => ({ ...splitKey(key), ...meta }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.providerId.localeCompare(b.providerId))
}

/** 合并写入：patch 里没给的字段沿用旧值；返回写入后的条目 */
export function setMeta(
  providerId: string,
  model: string,
  patch: Partial<ModelMeta>,
  by: 'ai' | 'user'
): ModelMetaEntry {
  const m = model.trim().slice(0, 200)
  if (!m) throw new Error('model is required')
  const entries = { ...load() }
  const key = metaKey(providerId.trim(), m)
  if (!(key in entries) && Object.keys(entries).length >= MAX_ENTRIES)
    throw new Error(`too many entries (max ${MAX_ENTRIES})`)
  const merged: ModelMeta = { ...entries[key], ...patch, updatedAt: Date.now(), updatedBy: by }
  for (const k of Object.keys(merged) as (keyof ModelMeta)[])
    if (merged[k] === undefined) delete merged[k]
  entries[key] = merged
  save(entries)
  return { ...splitKey(key), ...merged }
}

export function deleteMeta(providerId: string, model: string): boolean {
  const entries = { ...load() }
  const key = metaKey(providerId, model)
  if (!(key in entries)) return false
  delete entries[key]
  save(entries)
  return true
}

const bare = (model: string): string => model.slice(model.lastIndexOf('/') + 1).toLowerCase()

/** 找某个服务商下某模型的元数据 */
export function lookupMeta(providerId: string, model: string): ModelMeta | null {
  if (!model) return null
  const entries = load()
  const exact = entries[metaKey(providerId, model)] ?? entries[metaKey('*', model)]
  if (exact) return exact
  const b = bare(model)
  let any: ModelMeta | null = null
  for (const [key, meta] of Object.entries(entries)) {
    const k = splitKey(key)
    if (bare(k.model) !== b) continue
    if (k.providerId === providerId) return meta
    if (k.providerId === '*' || !any) any = meta
  }
  return any
}

export function hasPrice(meta: ModelMeta | null): meta is ModelMeta {
  return !!meta && (meta.input !== undefined || meta.output !== undefined)
}

/** 一次调用的费用；没有价格返回 null */
export function callCost(
  tokens: { prompt: number; cached: number; completion: number },
  meta: ModelMeta | null
): number | null {
  if (!hasPrice(meta)) return null
  const cached = Math.min(tokens.cached, tokens.prompt)
  const input = meta.input ?? 0
  const cachedPrice = meta.cachedInput ?? input
  return (
    ((tokens.prompt - cached) * input +
      cached * cachedPrice +
      tokens.completion * (meta.output ?? 0)) /
    1_000_000
  )
}

export function __resetModelMetaCacheForTest(): void {
  cache = null
}
