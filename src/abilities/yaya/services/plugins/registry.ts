/**
 * YAYA 插件注册表：静态插件（builtin）+ 动态插件来源（MCP / Skill），
 * 负责启用判定、工具 wire name、审批判定、系统提示词片段拼接、生命周期与结果规范化。
 */
import { createHash } from 'node:crypto'
import { makeLogger } from '../../../../main/process/logger'
import { t } from '../../../../main/process/i18n'
import type { MessageAttachment, YayaConfig } from '../../types'
import { saveAsset } from '../assets'
import type {
  NormalizedToolResult,
  PluginInfo,
  PluginProvider,
  PluginStatus,
  PluginTool,
  ToolContentPart,
  ToolContentResult,
  ToolRunContext,
  YayaPlugin
} from './types'

const log = makeLogger('yaya-plugins')

const staticPlugins = new Map<string, YayaPlugin>()
const providers: PluginProvider[] = []
/** 最近一次 refresh 的完整插件表（已排序） */
let current: YayaPlugin[] = []
/** start() 进行中 / 已完成的插件 */
const starting = new Map<YayaPlugin, Promise<void>>()
const started = new Set<YayaPlugin>()
const stopping = new Map<YayaPlugin, Promise<void>>()

const KIND_ORDER = { builtin: 0, mcp: 1, skill: 2 } as const
const DEFAULT_TIMEOUT_MS = 60_000
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function registerPlugin(plugin: YayaPlugin): void {
  if (!ID_RE.test(plugin.id)) throw new Error(`invalid yaya plugin id: ${plugin.id}`)
  if (staticPlugins.has(plugin.id)) throw new Error(`duplicate yaya plugin: ${plugin.id}`)
  staticPlugins.set(plugin.id, plugin)
}

export function registerPluginProvider(provider: PluginProvider): void {
  if (providers.some((p) => p.id === provider.id)) return
  providers.push(provider)
}

/**
 * 按当前配置重算插件表（启动时、配置保存后调用）。不再存在或被禁用的插件会被 stop()。
 */
export function refreshPlugins(config: YayaConfig): YayaPlugin[] {
  const list: YayaPlugin[] = [...staticPlugins.values()]
  for (const p of providers) {
    try {
      list.push(...p.sync(config))
    } catch (e) {
      log.warn('plugin provider sync failed', { provider: p.id, error: String(e) })
    }
  }
  const seen = new Set<string>()
  const next = list
    .filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))

  for (const old of current) {
    const still = next.find((p) => p.id === old.id)
    if (!still || still !== old || !isPluginEnabled(still, config)) void stopPlugin(old)
  }
  current = next
  return current
}

export function listPlugins(): YayaPlugin[] {
  return current
}

export function getPlugin(id: string): YayaPlugin | undefined {
  return current.find((p) => p.id === id)
}

export function isPluginEnabled(plugin: YayaPlugin, config: YayaConfig): boolean {
  return config.pluginEnabled?.[plugin.id] ?? plugin.defaultEnabled ?? true
}

// ---------------------------------------------------------------------------
// 工具命名
// ---------------------------------------------------------------------------

const WIRE_MAX = 64

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_')
}

/** 对模型暴露的工具名：`<前缀>_<工具>`，超长时截断并加稳定哈希（同输入永远同输出） */
export function wireName(plugin: YayaPlugin, tool: Pick<PluginTool, 'name'>): string {
  const bare = sanitize(tool.name)
  if (plugin.namespace === false) return bare.slice(0, WIRE_MAX)
  const full = `${sanitize(plugin.namespace ?? plugin.id)}_${bare}`
  if (full.length <= WIRE_MAX) return full
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 6)
  return `${full.slice(0, WIRE_MAX - 7)}_${hash}`
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

async function ensureStarted(plugin: YayaPlugin): Promise<void> {
  await stopping.get(plugin)
  if (!plugin.start || started.has(plugin)) return
  let p = starting.get(plugin)
  if (!p) {
    p = plugin
      .start()
      .then(() => {
        started.add(plugin)
      })
      .finally(() => starting.delete(plugin))
    starting.set(plugin, p)
  }
  await p
}

async function stopPlugin(plugin: YayaPlugin): Promise<void> {
  const pending = stopping.get(plugin)
  if (pending) return pending
  const job = (async () => {
    // 等待正在建立的连接再关闭，不能让迟到的 start() 重新标成已启动。
    await starting.get(plugin)?.catch(() => {})
    started.delete(plugin)
    try {
      await plugin.stop?.()
    } catch (e) {
      log.warn('plugin stop failed', { plugin: plugin.id, error: String(e) })
    }
  })().finally(() => stopping.delete(plugin))
  stopping.set(plugin, job)
  return job
}

/** 退出时释放所有连接 */
export async function stopAllPlugins(): Promise<void> {
  await Promise.all(current.map((p) => stopPlugin(p)))
}

/** 手动重连 / 刷新（MCP「刷新」按钮） */
export async function restartPlugin(id: string): Promise<PluginStatus> {
  const plugin = getPlugin(id)
  if (!plugin) throw new Error(`plugin not found: ${id}`)
  await stopPlugin(plugin)
  try {
    await ensureStarted(plugin)
  } catch (e) {
    log.warn('plugin restart failed', { plugin: id, error: String(e) })
  }
  return pluginStatus(plugin)
}

function pluginStatus(plugin: YayaPlugin): PluginStatus {
  if (plugin.status) return plugin.status()
  return { state: 'ready' }
}

// ---------------------------------------------------------------------------
// 给工作流用：当前可用工具 / 系统提示词片段 / 审批
// ---------------------------------------------------------------------------

export interface ResolvedTool {
  wireName: string
  plugin: YayaPlugin
  tool: PluginTool
}

/**
 * 当前启用的全部工具（按插件顺序、插件内声明顺序，保证同配置下逐字节稳定）。
 * 动态插件会先 start()；连接失败的插件跳过（status 里有错误），不拖垮整个工作流。
 */
export async function resolveTools(config: YayaConfig): Promise<ResolvedTool[]> {
  const off = new Set(config.disabledTools ?? [])
  const out: ResolvedTool[] = []
  for (const plugin of current) {
    if (!isPluginEnabled(plugin, config)) continue
    try {
      await ensureStarted(plugin)
    } catch (e) {
      log.warn('plugin unavailable, its tools are skipped', {
        plugin: plugin.id,
        error: String(e)
      })
      continue
    }
    for (const tool of plugin.tools()) {
      const name = wireName(plugin, tool)
      if (!off.has(name)) out.push({ wireName: name, plugin, tool })
    }
  }
  return out
}

/** 按 wire name 找工具（只在已启动 / 静态插件里找，不触发连接） */
export function findTool(name: string): ResolvedTool | undefined {
  for (const plugin of current) {
    if (plugin.start && !started.has(plugin)) continue
    for (const tool of plugin.tools()) {
      if (wireName(plugin, tool) === name) return { wireName: name, plugin, tool }
    }
  }
  return undefined
}

/** 启用插件的 instructions，按插件顺序拼成一段（稳定，适合放在系统提示词前缀里） */
export function buildPluginInstructions(config: YayaConfig): string {
  const parts: string[] = []
  for (const plugin of current) {
    if (!isPluginEnabled(plugin, config)) continue
    const text = plugin.instructions?.().trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * 本次调用是否需要人工确认。优先级：用户对该工具的显式设置 > 全局「自动允许」> 提供方默认。
 */
export function toolNeedsApproval(
  resolved: ResolvedTool,
  args: Record<string, unknown>,
  config: Pick<YayaConfig, 'toolApproval' | 'autoApproveTools'>
): boolean {
  const override = config.toolApproval?.[resolved.wireName]
  if (override === 'ask') return true
  if (override === 'auto') return false
  if (config.autoApproveTools) return false
  const a = resolved.tool.approval ?? 'auto'
  return typeof a === 'function' ? a(args) : a === 'ask'
}

/** 带超时与中止地执行工具 */
export async function runPluginTool(
  resolved: ResolvedTool,
  args: Record<string, unknown>,
  ctx: Omit<ToolRunContext, 'pluginId'>
): Promise<unknown> {
  const timeoutMs = resolved.tool.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ac = new AbortController()
  ctx.signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      ac.abort(ctx.signal.reason)
      reject(ctx.signal.reason ?? new Error('tool aborted'))
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      cancelled,
      resolved.tool.run(args, { ...ctx, pluginId: resolved.plugin.id, signal: ac.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort()
          reject(new Error(`tool ${resolved.wireName} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// 结果规范化
// ---------------------------------------------------------------------------

/** 工具结果交给模型前的长度上限，避免一次输出撑爆上下文 */
export const MAX_TOOL_RESULT_CHARS = 32_000

export function clipText(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

function isContentResult(v: unknown): v is ToolContentResult {
  if (!v || typeof v !== 'object' || !Array.isArray((v as ToolContentResult).content)) return false
  return (v as ToolContentResult).content.every(
    (p: ToolContentPart) =>
      p &&
      (p.type === 'text'
        ? typeof p.text === 'string'
        : p.type === 'image' && typeof p.data === 'string')
  )
}

/**
 * 工具原始返回 → 模型文本 + 图片（存成会话资产，正文里只留引用）+ 界面展示数据。
 * 数据库里不存 base64：图片走资产目录，toolCall.result 里也只放资产 URI。
 */
export async function normalizeToolResult(
  raw: unknown,
  sessionId: string
): Promise<NormalizedToolResult> {
  if (!isContentResult(raw)) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
    return { text: clipText(text), images: [], display: raw, isError: false }
  }
  const texts: string[] = []
  const images: MessageAttachment[] = []
  for (const part of raw.content) {
    if (part.type === 'text') texts.push(part.text)
    else {
      const ext = part.mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png'
      const att = await saveAsset(
        sessionId,
        `tool-image.${ext}`,
        Buffer.from(part.data, 'base64'),
        part.mimeType
      )
      images.push(att)
      texts.push(`[image: ${att.name}]`)
    }
  }
  return {
    text: clipText(texts.join('\n')),
    images,
    display: raw.display ?? { text: texts.join('\n'), images: images.map((i) => i.assetPath) },
    isError: raw.isError === true
  }
}

// ---------------------------------------------------------------------------
// 设置页视图
// ---------------------------------------------------------------------------

function defaultApprovalOf(tool: PluginTool): 'ask' | 'auto' | 'dynamic' {
  const a = tool.approval ?? 'auto'
  return typeof a === 'function' ? 'dynamic' : a
}

export function listPluginInfo(config: YayaConfig): PluginInfo[] {
  const off = new Set(config.disabledTools ?? [])
  return current.map((plugin) => {
    let tools: PluginTool[] = []
    try {
      tools = plugin.tools()
    } catch {
      tools = []
    }
    return {
      id: plugin.id,
      kind: plugin.kind,
      label: plugin.labelKey ? t(plugin.labelKey, plugin.label) : plugin.label,
      description: plugin.descriptionKey
        ? t(plugin.descriptionKey, plugin.description)
        : plugin.description,
      icon: plugin.icon,
      docs: plugin.docs,
      enabled: isPluginEnabled(plugin, config),
      defaultEnabled: plugin.defaultEnabled ?? true,
      status: pluginStatus(plugin),
      instructionsChars: plugin.instructions?.().length ?? 0,
      tools: tools.map((tool) => {
        const name = wireName(plugin, tool)
        return {
          wireName: name,
          name: tool.name,
          description: tool.description,
          docs: tool.docs,
          defaultApproval: defaultApprovalOf(tool),
          approval: config.toolApproval?.[name],
          enabled: !off.has(name)
        }
      })
    }
  })
}

/** 测试用：清空注册表 */
export function __resetPluginsForTest(): void {
  staticPlugins.clear()
  providers.length = 0
  current = []
  starting.clear()
  started.clear()
  stopping.clear()
}
