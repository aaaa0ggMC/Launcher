/**
 * YAYA 插件注册表：静态插件（builtin）+ 动态插件来源（MCP / Skill），
 * 负责启用判定、工具 wire name、审批判定、系统提示词片段拼接、生命周期与结果规范化。
 */
import { createHash } from 'node:crypto'
import { getBroadcast } from '../../../../main/process/broadcast'
import { makeLogger } from '../../../../main/process/logger'
import { t } from '../../../../main/process/i18n'
import type { MessageAttachment, YayaConfig } from '../../types'
import { loadYayaConfig, setPluginSecretKeysResolver } from '../config'
import { saveAsset } from '../assets'
import type {
  NormalizedToolResult,
  PluginConfigField,
  PluginConfigInfo,
  PluginGroup,
  PluginGroupInfo,
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
  getBroadcast()('cockpit:yaya-plugins-changed', {})
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

// 告诉 config.ts 哪些插件配置字段是 secret（落盘前加密、下发前脱敏都要用）。
// 放在这里而不是 config.ts 自己 import registry：registry 要读 config 的 loadYayaConfig。
setPluginSecretKeysResolver((pluginId) => pluginSecretKeys(pluginId))

/** 插件 schema 里 secret 字段的 key（没有 schema / 插件未加载时为空） */
function secretKeysOf(plugin: YayaPlugin | undefined): string[] {
  if (!plugin?.configSchema) return []
  return plugin.configSchema.filter((f) => f.secret).map((f) => f.key)
}

/** 按插件 id 查 secret 字段 key（落盘加密 / 下发脱敏 / 命令校验共用） */
export function pluginSecretKeys(pluginId: string): string[] {
  return secretKeysOf(current.find((p) => p.id === pluginId))
}

// ---------------------------------------------------------------------------
// 插件配置（PLAN 6.4）：schema 默认值 + 用户值，按字段类型归一
// ---------------------------------------------------------------------------

/**
 * 单个配置字段的归一化值：数字夹到 min/max、select 不在选项里回落默认、boolean 归一、
 * 非法数字回落默认。secret 值由 loadYayaConfig 解密后原样进入（不做其它变换）。
 */
function normalizeConfigValue(field: PluginConfigField, raw: unknown): unknown {
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) return field.default ?? 0
    let v = n
    if (typeof field.min === 'number') v = Math.max(field.min, v)
    if (typeof field.max === 'number') v = Math.min(field.max, v)
    return v
  }
  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    return raw === true || raw === 'true' || raw === 1 || raw === '1'
  }
  if (field.type === 'select') {
    const value = String(raw)
    if ((field.options ?? []).some((o) => o.value === value)) return value
    return field.default ?? ''
  }
  return typeof raw === 'string' ? raw : String(raw)
}

/**
 * 插件当前的配置值：schema 默认值 + 用户值（已归一）。没写进配置的字段用默认值，
 * 没有默认值就不出现在结果里。工具经 `ToolRunContext.config` 读到的就是这个。
 */
export function pluginConfigValues(
  plugin: YayaPlugin,
  config: Pick<YayaConfig, 'pluginConfig'>
): Record<string, unknown> {
  const stored = config.pluginConfig?.[plugin.id] ?? {}
  const out: Record<string, unknown> = {}
  for (const field of plugin.configSchema ?? []) {
    const raw = stored[field.key]
    if (raw === undefined || raw === null) {
      if (field.default !== undefined) out[field.key] = field.default
      continue
    }
    out[field.key] = normalizeConfigValue(field, raw)
  }
  return out
}

// ---------------------------------------------------------------------------
// 子分组（PLAN 6.4）
// ---------------------------------------------------------------------------

/** 插件的子分组定义（没有声明时为空数组） */
function groupsOf(plugin: YayaPlugin): PluginGroup[] {
  try {
    return plugin.groups?.() ?? []
  } catch (e) {
    log.warn('plugin groups() failed', { plugin: plugin.id, error: String(e) })
    return []
  }
}

/**
 * 分组是否启用：`pluginGroupEnabled['<插件 id>/<分组 id>']` 覆盖，缺省 = 分组的 defaultEnabled。
 */
export function isGroupEnabled(
  plugin: YayaPlugin,
  groupId: string,
  config: Pick<YayaConfig, 'pluginGroupEnabled'>
): boolean {
  const group = groupsOf(plugin).find((g) => g.id === groupId)
  return config.pluginGroupEnabled?.[`${plugin.id}/${groupId}`] ?? group?.defaultEnabled ?? true
}

/** 分组状态（没有 status 视为 ready） */
function groupStatus(group: PluginGroup): PluginStatus {
  try {
    return group.status?.() ?? { state: 'ready' }
  } catch {
    return { state: 'error', message: 'status check failed' }
  }
}

/** 分组此刻是否可用（启用 + ready） */
function groupAvailable(group: PluginGroup, enabled: boolean): boolean {
  return enabled && groupStatus(group).state === 'ready'
}

/**
 * 工具所在分组此刻是否提供给模型：分组被用户关掉、或分组状态不是 ready 时整组不提供。
 * 工具的 `group` 指向不存在的分组 = 视为无分组（照常提供）。
 */
function groupAvailableForTool(
  plugin: YayaPlugin,
  tool: PluginTool,
  config: Pick<YayaConfig, 'pluginGroupEnabled'>
): boolean {
  if (!tool.group) return true
  const group = groupsOf(plugin).find((g) => g.id === tool.group)
  if (!group) return true
  return groupAvailable(group, isGroupEnabled(plugin, group.id, config))
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
      .finally(() => {
        starting.delete(plugin)
        getBroadcast()('cockpit:yaya-plugins-changed', {})
      })
    starting.set(plugin, p)
    getBroadcast()('cockpit:yaya-plugins-changed', {})
  }
  await p
}

/** 启动插件（MCP 等动态插件连上之后才有工具）；失败返回错误文本，不抛 */
export async function tryStartPlugin(plugin: YayaPlugin): Promise<string | null> {
  try {
    await ensureStarted(plugin)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
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
  })().finally(() => {
    stopping.delete(plugin)
    getBroadcast()('cockpit:yaya-plugins-changed', {})
  })
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
 *
 * **工具表稳定性（提示词缓存）**：工具表只由插件启用态 / 分组可用性 / disabledTools 决定，
 * **与 `pluginConfig` 的取值无关**——换了引擎、改了密钥都不改变工具名与描述，
 * 插件自己的配置经 `ToolRunContext.config` 在运行时读取。
 */
/**
 * 本次运行可用的工具。`forced` = 本会话被 `@` 点名强制启用的（插件 id / `tool:<wire name>`，
 * 见 mention.ts）：即使全局禁用也提供，**追加在常规工具之后**、按点名先后排——
 * 点名前的工具表前缀不变，提示词缓存只在点名后的请求起变化一次。分组不可用的工具照样不给。
 */
export async function resolveTools(
  config: YayaConfig,
  forced: readonly string[] = []
): Promise<ResolvedTool[]> {
  const out = await resolveEnabledTools(config)
  const have = new Set(out.map((r) => r.wireName))
  for (const ref of forced) {
    const wanted = ref.startsWith('tool:') ? ref.slice(5) : null
    const plugins = wanted ? current : current.filter((p) => p.id === ref)
    for (const plugin of plugins) {
      // 点名整个插件时先启动：MCP 这类动态插件连上之前工具列表是空的
      if (wanted && !plugin.tools().some((tool) => wireName(plugin, tool) === wanted)) continue
      try {
        await ensureStarted(plugin)
      } catch (e) {
        log.warn('mentioned plugin unavailable, its tools are skipped', {
          plugin: plugin.id,
          error: String(e)
        })
        continue
      }
      const tools = plugin.tools().filter((tool) => !wanted || wireName(plugin, tool) === wanted)
      for (const tool of tools) {
        const name = wireName(plugin, tool)
        if (have.has(name) || !groupAvailableForTool(plugin, tool, config)) continue
        have.add(name)
        out.push({ wireName: name, plugin, tool })
      }
    }
  }
  return out
}

async function resolveEnabledTools(config: YayaConfig): Promise<ResolvedTool[]> {
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
      // 整组不可用（被关掉 / 分组 status 非 ready）的工具不提供给模型
      if (!groupAvailableForTool(plugin, tool, config)) continue
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

/** 启用插件的 instructions，按插件顺序拼成一段（稳定，适合放在系统提示词前缀里）。
 * 与工具表一样只取决于启用态，不随 `pluginConfig` 的取值变化（提示词缓存）。 */
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

// ---------------------------------------------------------------------------
// 数据流钩子（YayaPlugin.hooks）
// ---------------------------------------------------------------------------

function hookPlugins(config: YayaConfig): YayaPlugin[] {
  return current.filter((p) => p.hooks && isPluginEnabled(p, config))
}

/** 用户消息入库前 */
export function applyUserTextHooks(sessionId: string, text: string, config: YayaConfig): string {
  let out = text
  for (const p of hookPlugins(config)) {
    const fn = p.hooks?.userText
    if (!fn) continue
    try {
      out = fn({ sessionId, text: out })
    } catch (e) {
      log.warn('plugin userText hook failed', { plugin: p.id, error: String(e) })
    }
  }
  return out
}

/** 工具执行前 */
export function applyToolArgsHooks(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  config: YayaConfig
): Record<string, unknown> {
  let out = args
  for (const p of hookPlugins(config)) {
    const fn = p.hooks?.toolArgs
    if (!fn) continue
    try {
      out = fn({ sessionId, tool, args: out })
    } catch (e) {
      log.warn('plugin toolArgs hook failed', { plugin: p.id, error: String(e) })
    }
  }
  return out
}

/** 工具结果入库 / 交给模型前 */
export function applyToolResultHooks<T>(
  sessionId: string,
  tool: string,
  value: T,
  config: YayaConfig
): T {
  let out = value
  for (const p of hookPlugins(config)) {
    const fn = p.hooks?.toolResult
    if (!fn) continue
    try {
      out = fn({ sessionId, tool, value: out })
    } catch (e) {
      log.warn('plugin toolResult hook failed', { plugin: p.id, error: String(e) })
    }
  }
  return out
}

/** 带超时与中止地执行工具；顺带把插件当前配置（默认值已填、secret 已解密）放进 ctx.config */
export async function runPluginTool(
  resolved: ResolvedTool,
  args: Record<string, unknown>,
  ctx: Omit<ToolRunContext, 'pluginId' | 'config'>
): Promise<unknown> {
  const timeoutMs = resolved.tool.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 工具表与 instructions 不因配置变化而变（提示词缓存），但工具**运行**要读到最新配置；
  // 这里按当前配置算，调用方（runner）不需要改。
  const config = pluginConfigValues(resolved.plugin, loadYayaConfig())
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
      resolved.tool.run(args, { ...ctx, pluginId: resolved.plugin.id, signal: ac.signal, config }),
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

/** schema 的界面视图：翻译 label / description / 选项 label（不改动插件自己的对象） */
function configFieldView(field: PluginConfigField): PluginConfigField {
  const view: PluginConfigField = {
    ...field,
    label: field.labelKey ? t(field.labelKey, field.label) : field.label
  }
  if (field.description !== undefined)
    view.description = field.descriptionKey
      ? t(field.descriptionKey, field.description ?? '')
      : field.description
  if (field.options)
    view.options = field.options.map((o) => ({
      ...o,
      label: o.labelKey ? t(o.labelKey, o.label) : o.label
    }))
  return view
}

/** 给界面的配置视图：schema（已翻译）+ 非 secret 字段的值 + 已设置的 secret key */
function configInfoView(plugin: YayaPlugin, config: YayaConfig): PluginConfigInfo {
  const schema = (plugin.configSchema ?? []).map(configFieldView)
  // secret（已解密）绝不下发：页面 / 命令结果 / AI 看到的都只有「已设置」
  const values = pluginConfigValues(plugin, config)
  for (const f of schema) if (f.secret) delete values[f.key]
  const stored = config.pluginConfig?.[plugin.id] ?? {}
  const secretsSet = schema
    .filter((f) => f.secret)
    .filter((f) => stored[f.key] !== undefined && stored[f.key] !== null && stored[f.key] !== '')
    .map((f) => f.key)
  return { schema, values, secretsSet }
}

/** 给界面的分组视图：翻译文案 + 是否可用（启用且 ready） */
function groupInfoView(plugin: YayaPlugin, config: YayaConfig): PluginGroupInfo[] | undefined {
  const groups = groupsOf(plugin)
  if (groups.length === 0) return undefined
  return groups.map((g) => {
    const enabled = isGroupEnabled(plugin, g.id, config)
    const description = g.description ?? ''
    return {
      id: g.id,
      label: g.labelKey ? t(g.labelKey, g.label) : g.label,
      description: g.descriptionKey ? t(g.descriptionKey, description) : description,
      enabled,
      defaultEnabled: g.defaultEnabled ?? true,
      status: groupStatus(g),
      available: groupAvailable(g, enabled)
    }
  })
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
          enabled: !off.has(name),
          group: tool.group
        }
      }),
      groups: groupInfoView(plugin, config),
      config: plugin.configSchema ? configInfoView(plugin, config) : undefined
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
