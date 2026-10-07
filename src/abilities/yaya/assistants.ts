/**
 * 多助手：每个助手有自己的名字 / 头像 / 系统提示词 / 模型 / 插件与 MCP 开关 / 工具审批 / 上下文。
 * 主进程与渲染端共用的纯函数。
 *
 * - 全局配置里的同名字段 = 「新助手的默认值」，新建助手时整份复制过去（模型除外：留空 = 跟随默认模型）；
 * - 旧配置没有助手列表：读取时用全局字段生成 id = `default` 的第一个助手，行为与以前一致；
 * - 会话记住自己的助手（`session.meta.assistantId`），运行时 `assistantConfig()` 把助手叠加到全局配置上，
 *   之后的代码照旧读 `config.pluginEnabled` 等字段，不用知道助手的存在。
 */
import type { YayaAssistant, YayaConfig, YayaProfile } from './types'
import { normalizeAvatar } from './profile'
import { normalizeContextConfig } from './services/context'

export const DEFAULT_ASSISTANT_ID = 'default'
const MAX_ASSISTANTS = 64

/** 助手覆盖的 YayaConfig 字段（profile 单独处理：只覆盖助手那一半） */
export const ASSISTANT_KEYS = [
  'assistantName',
  'systemPrompt',
  'activeProviderId',
  'activeModel',
  'defaultWorkflow',
  'reasoningEffort',
  'searchMode',
  'autoApproveTools',
  'maxLoopSteps',
  'pluginEnabled',
  'pluginGroupEnabled',
  'disabledTools',
  'toolApproval',
  'context'
] as const satisfies readonly (keyof YayaAssistant & keyof YayaConfig)[]

export type AssistantKey = (typeof ASSISTANT_KEYS)[number]

export const ASSISTANT_PROFILE_KEYS = [
  'assistantAvatar',
  'assistantAvatarMode',
  'assistantLabel',
  'assistantNameVisible'
] as const satisfies readonly (keyof YayaProfile)[]

type AssistantProfile = NonNullable<YayaAssistant['profile']>

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().slice(0, 32) : ''
  return s || fallback
}

function assistantProfileOf(profile: YayaProfile | undefined): AssistantProfile {
  const p = profile ?? {}
  const mode = p.assistantAvatarMode
  return {
    assistantAvatar: normalizeAvatar(p.assistantAvatar),
    assistantAvatarMode: mode === 'custom' || mode === 'model' ? mode : 'default',
    assistantLabel: p.assistantLabel === 'model' ? 'model' : 'name',
    assistantNameVisible: p.assistantNameVisible !== false
  }
}

/**
 * 用全局配置（= 新助手的默认值）生成一个助手。`keepModel` 只给迁移出来的第一个助手用：
 * 以前全局的模型就是它的模型；新建的助手默认跟随「默认模型」。
 */
export function assistantFromDefaults(
  cfg: YayaConfig,
  id: string,
  opts: { name?: string; keepModel?: boolean; now?: number } = {}
): YayaAssistant {
  return {
    id,
    createdAt: opts.now ?? Date.now(),
    assistantName: cleanName(opts.name ?? cfg.assistantName, 'YAYA'),
    systemPrompt: cfg.systemPrompt ?? '',
    activeProviderId: opts.keepModel ? cfg.activeProviderId : '',
    activeModel: opts.keepModel ? cfg.activeModel : '',
    defaultWorkflow: cfg.defaultWorkflow,
    reasoningEffort: cfg.reasoningEffort,
    searchMode: cfg.searchMode,
    autoApproveTools: cfg.autoApproveTools === true,
    maxLoopSteps: cfg.maxLoopSteps,
    pluginEnabled: clone(cfg.pluginEnabled),
    pluginGroupEnabled: clone(cfg.pluginGroupEnabled),
    disabledTools: clone(cfg.disabledTools),
    toolApproval: clone(cfg.toolApproval),
    context: clone(cfg.context),
    profile: assistantProfileOf(cfg.profile)
  }
}

function normalizeAssistant(raw: unknown, cfg: YayaConfig): YayaAssistant | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<YayaAssistant>
  if (typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id)) return null
  const steps = Number(r.maxLoopSteps)
  const record = <T>(v: unknown): Record<string, T> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : undefined
  return {
    id: r.id,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    assistantName: cleanName(r.assistantName, 'YAYA'),
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : '',
    activeProviderId: typeof r.activeProviderId === 'string' ? r.activeProviderId : '',
    activeModel: typeof r.activeModel === 'string' ? r.activeModel : '',
    defaultWorkflow: typeof r.defaultWorkflow === 'string' ? r.defaultWorkflow : undefined,
    reasoningEffort: r.reasoningEffort,
    searchMode:
      r.searchMode === 'builtin'
        ? 'builtin'
        : r.searchMode === 'generic'
          ? 'generic'
          : cfg.searchMode,
    autoApproveTools: r.autoApproveTools === true,
    maxLoopSteps: Number.isFinite(steps)
      ? Math.min(100, Math.max(1, Math.round(steps)))
      : cfg.maxLoopSteps,
    pluginEnabled: record<boolean>(r.pluginEnabled),
    pluginGroupEnabled: record<boolean>(r.pluginGroupEnabled),
    disabledTools: Array.isArray(r.disabledTools)
      ? r.disabledTools.filter((x): x is string => typeof x === 'string')
      : undefined,
    toolApproval: record<'ask' | 'auto'>(r.toolApproval),
    context: normalizeContextConfig(r.context),
    profile: assistantProfileOf(r.profile)
  }
}

/** 校验助手列表：去掉坏条目 / 重复 id；空列表 = 从全局字段迁移出第一个助手；活动助手必须存在 */
export function normalizeAssistants(cfg: YayaConfig): void {
  const seen = new Set<string>()
  const list: YayaAssistant[] = []
  for (const raw of Array.isArray(cfg.assistants) ? cfg.assistants : []) {
    const a = normalizeAssistant(raw, cfg)
    if (!a || seen.has(a.id)) continue
    seen.add(a.id)
    list.push(a)
    if (list.length >= MAX_ASSISTANTS) break
  }
  if (!list.length) list.push(assistantFromDefaults(cfg, DEFAULT_ASSISTANT_ID, { keepModel: true }))
  cfg.assistants = list
  if (!list.some((a) => a.id === cfg.activeAssistantId)) cfg.activeAssistantId = list[0].id
}

/** 按 id 找助手；找不到（被删了）退回第一个。不传 id = 活动助手（新会话用的那个） */
export function findAssistant(cfg: YayaConfig, id?: string | null): YayaAssistant | undefined {
  const list = cfg.assistants ?? []
  const want = id ?? cfg.activeAssistantId
  return (want ? list.find((a) => a.id === want) : undefined) ?? list[0]
}

/**
 * 助手叠加到全局配置上的「生效配置」。没有助手（还没迁移的配置）时原样返回。
 * 助手没选模型 = 跟随全局默认模型。
 */
export function assistantConfig(cfg: YayaConfig, id?: string | null): YayaConfig {
  const a = findAssistant(cfg, id)
  if (!a) return cfg
  const out: YayaConfig = { ...cfg }
  const target = out as unknown as Record<string, unknown>
  for (const key of ASSISTANT_KEYS) {
    if (key === 'activeProviderId' || key === 'activeModel') continue
    target[key] = a[key]
  }
  if (a.activeModel) {
    out.activeModel = a.activeModel
    out.activeProviderId = a.activeProviderId || cfg.activeProviderId
  }
  out.profile = { ...(cfg.profile ?? {}), ...(a.profile ?? {}) }
  return out
}

/**
 * 会话的助手 id。旧会话没记 = 迁移出来的第一个助手（`default`），不跟着「活动助手」变：
 * 换了新会话默认用的助手，旧会话照旧用原来的设置。
 */
export function sessionAssistantId(
  session: { meta?: Record<string, unknown> } | null | undefined
): string {
  const id = session?.meta?.assistantId
  return typeof id === 'string' && id ? id : DEFAULT_ASSISTANT_ID
}

/**
 * 会话实际归属的助手 id（会话记的助手被删了 = 退回第一个助手，与 `assistantConfig` 的取值一致）。
 * 会话列表按它过滤，避免助手被删后它的旧会话在哪个助手下都看不到。
 */
export function sessionOwnerId(
  cfg: YayaConfig,
  session: { meta?: Record<string, unknown> } | null | undefined
): string {
  const id = sessionAssistantId(session)
  return findAssistant(cfg, id)?.id ?? id
}
