/**
 * YAYA 配置服务 — 管理 ~/.config/LinuxCockpit/yaya/config.json
 * 敏感 Key 走框架级 encryptSecret / decryptSecret 加密存储。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { abilityConfigPath } from '../../../main/process/paths'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../../main/process/encrypt'
import { makeLogger } from '../../../main/process/logger'
import { getBroadcast } from '../../../main/process/broadcast'
import type { McpServerConfig, ProviderConfig, YayaConfig } from '../types'
import { applyPromptVars, type PromptVar } from './prompt-vars'
import { normalizeProfile } from '../profile'

const log = makeLogger('yaya-config')

export const DEFAULT_ASSISTANT_NAME = 'YAYA'

export const DEFAULT_YAYA_CONFIG: YayaConfig = {
  assistantName: DEFAULT_ASSISTANT_NAME,
  activeProviderId: 'codex-proxy',
  activeModel: 'gpt-5.5',
  systemPrompt:
    'You are {name}, an intelligent personal assistant and autonomous agent running inside Linux System Cockpit. You are helpful, precise, and capable of executing tools to assist the user.',
  autoApproveTools: false,
  maxLoopSteps: 25,
  processPreviewSteps: 1,
  streamOutput: true,
  providers: [
    {
      id: 'codex-proxy',
      name: 'Codex Proxy (Local)',
      type: 'codex-proxy',
      baseUrl: 'http://127.0.0.1:6769/v1',
      apiKey: 'dummy',
      models: ['gpt-5.5', 'gpt-5.6-luna', 'gpt-4o', 'deepseek-chat'],
      defaultModel: 'gpt-5.5',
      enabled: true
    },
    {
      id: 'openai',
      name: 'OpenAI Official',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
      defaultModel: 'gpt-4o',
      enabled: false
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      enabled: false
    },
    {
      id: 'ollama',
      name: 'Ollama (Local)',
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      models: ['llama3.2', 'qwen2.5'],
      defaultModel: 'llama3.2',
      enabled: false
    }
  ],
  mcpServers: []
}

let cachedConfig: YayaConfig | null = null

export function getYayaConfigPath(): string {
  return abilityConfigPath('yaya')
}

export function loadYayaConfig(): YayaConfig {
  if (cachedConfig) return cachedConfig
  const file = getYayaConfigPath()
  if (!existsSync(file)) {
    cachedConfig = structuredClone(DEFAULT_YAYA_CONFIG)
    saveYayaConfig(cachedConfig)
    return cachedConfig
  }

  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<YayaConfig>
    const cfg: YayaConfig = {
      ...DEFAULT_YAYA_CONFIG,
      ...parsed,
      providers:
        Array.isArray(parsed.providers) && parsed.providers.length > 0
          ? parsed.providers
          : DEFAULT_YAYA_CONFIG.providers,
      mcpServers: normalizeMcpServers(parsed.mcpServers)
    }
    cfg.assistantName = normalizeAssistantName(cfg.assistantName)
    cfg.processPreviewSteps = normalizeProcessPreviewSteps(cfg.processPreviewSteps)
    cfg.profile = normalizeProfile(cfg.profile)
    // 仅传输字段不该出现在内存配置里（旧版本可能落过盘）
    delete cfg.pluginSecretsSet
    delete cfg.pluginClearSecrets

    // 解密 MCP 自定义请求头的值
    for (const m of cfg.mcpServers) {
      for (const [k, v] of Object.entries(m.headers ?? {})) {
        if (!isEncryptedSecret(v)) continue
        try {
          m.headers![k] = decryptSecret(v)
        } catch (e) {
          log.warn(`Failed to decrypt MCP header ${k} for ${m.id}`, { error: String(e) })
          // 保留密文，避免下一次保存悄悄丢掉无法解密的凭据。
        }
      }
    }

    // 解密 Provider 中的 apiKey
    for (const p of cfg.providers) {
      if (p.apiKey && isEncryptedSecret(p.apiKey)) {
        try {
          p.apiKey = decryptSecret(p.apiKey)
        } catch (e) {
          log.warn(`Failed to decrypt API key for provider ${p.id}`, { error: String(e) })
          // 保留密文供用户恢复 vault 后重试。
        }
      }
    }

    // 解密插件配置里的 secret 值：凡是密文一律解密（不依赖 schema —— 插件可能还没加载，
    // 而 secret 落盘时一定是密文形式，见 saveYayaConfig）
    for (const [pid, values] of Object.entries(cfg.pluginConfig ?? {})) {
      if (!values || typeof values !== 'object') continue
      for (const [key, v] of Object.entries(values)) {
        if (typeof v !== 'string' || !isEncryptedSecret(v)) continue
        // 记住它在磁盘上是密文：插件没加载（拿不到 schema）时保存 / 下发也照样当 secret
        knownSecrets.add(`${pid}/${key}`)
        try {
          values[key] = decryptSecret(v)
        } catch (e) {
          log.warn(`Failed to decrypt plugin config value ${key}`, { error: String(e) })
          // 保留密文，避免下一次保存悄悄丢掉无法解密的凭据。
        }
      }
    }

    cachedConfig = cfg
    return cfg
  } catch (err) {
    log.error('Failed to read YAYA config, using defaults', { error: String(err) })
    cachedConfig = structuredClone(DEFAULT_YAYA_CONFIG)
    return cachedConfig
  }
}

let configRevision = 0
export function getYayaConfigRevision(): number {
  return configRevision
}

export function saveYayaConfig(config: YayaConfig): void {
  const file = getYayaConfigPath()
  mkdirSync(dirname(file), { recursive: true })

  // 深度克隆并加密存储
  const toSave: YayaConfig = JSON.parse(JSON.stringify(config))
  for (const p of toSave.providers) {
    if (p.apiKey && !isEncryptedSecret(p.apiKey)) {
      try {
        p.apiKey = encryptSecret(p.apiKey)
      } catch (e) {
        log.warn(`Failed to encrypt API key for provider ${p.id}`, { error: String(e) })
        throw e
      }
    }
  }

  for (const p of toSave.providers) {
    delete p.apiKeySet
    delete p.clearApiKey
  }
  for (const m of toSave.mcpServers ?? []) {
    delete m.headersSet
    delete m.clearHeaders
    for (const [k, v] of Object.entries(m.headers ?? {})) {
      if (!v || isEncryptedSecret(v)) continue
      try {
        m.headers![k] = encryptSecret(v)
      } catch (e) {
        log.warn(`Failed to encrypt MCP header ${k} for ${m.id}`, { error: String(e) })
        throw e
      }
    }
  }

  // 插件配置：schema 标 secret 的字段加密落盘（key 清单由 registry 注入）；
  // 已经是密文的原样保留（重复保存同一份配置不会二次加密）
  for (const [pid, values] of Object.entries(toSave.pluginConfig ?? {})) {
    if (!values || typeof values !== 'object') continue
    const secretKeys = secretKeysFor(pid)
    for (const [key, v] of Object.entries(values)) {
      if (!secretKeys.has(key) || typeof v !== 'string' || !v || isEncryptedSecret(v)) continue
      knownSecrets.add(`${pid}/${key}`)
      try {
        values[key] = encryptSecret(v)
      } catch (e) {
        log.warn(`Failed to encrypt plugin config ${pid}.${key}`, { error: String(e) })
        throw e
      }
    }
  }
  // 这两个字段只在传输里出现（config-get 返回 / config-save 入参），不落盘
  delete toSave.pluginSecretsSet
  delete toSave.pluginClearSecrets

  writeFileSync(file, JSON.stringify(toSave, null, 2), 'utf8')
  // 内存中保持明文（插件工具通过 ctx.config 读到的就是解密后的值）
  cachedConfig = JSON.parse(JSON.stringify(config)) as YayaConfig
  delete cachedConfig.pluginSecretsSet
  delete cachedConfig.pluginClearSecrets
  log.info('YAYA config saved')
  getBroadcast()('cockpit:yaya-config-changed', publicYayaConfig(cachedConfig!), ++configRevision)
}

export function normalizeAssistantName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim().slice(0, 32) : ''
  return s || DEFAULT_ASSISTANT_NAME
}

/** 过程卡片收起时预览的步数：0 = 完全折叠；上限 5（再多的预览没有意义） */
export const PROCESS_PREVIEW_STEPS_MAX = 5

export function normalizeProcessPreviewSteps(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return 1
  return Math.min(PROCESS_PREVIEW_STEPS_MAX, Math.max(0, Math.round(n)))
}

/**
 * 系统提示词：`{name}` 替换为助手名；`vars` 是运行开始时取的其余变量快照（见 prompt-vars.ts）
 */
export function resolveSystemPrompt(
  prompt: string,
  config: YayaConfig,
  vars: Partial<Record<PromptVar, string>> = {}
): string {
  const profile = normalizeProfile(config.profile)
  const name = profile.assistantNameVisible
    ? normalizeAssistantName(config.assistantName)
    : 'an AI assistant'
  const userName = profile.userNameVisible ? (profile.userName ?? '') : ''
  let out = applyPromptVars(prompt, { ...vars, name, user: userName || 'the user' })
  // 设了名字、允许 AI 知道、提示词里又没用 {user}：补一句（内容稳定，不影响提示词缓存）
  if (userName && !prompt.includes('{user}')) out += `\n\nThe user's name is ${userName}.`
  return out
}

/** 给渲染端 / agent 的配置视图：去掉密钥明文，只给 apiKeySet */
export function publicYayaConfig(config: YayaConfig): YayaConfig {
  const out: YayaConfig = JSON.parse(JSON.stringify(config))
  out.providers = out.providers.map((p: ProviderConfig) => {
    const rest = { ...p }
    delete rest.clearApiKey
    return { ...rest, apiKey: '', apiKeySet: Boolean(p.apiKey) }
  })
  out.mcpServers = (out.mcpServers ?? []).map((m: McpServerConfig) => {
    const headers = m.headers ?? {}
    const rest = { ...m }
    delete rest.clearHeaders
    return {
      ...rest,
      // 头名保留（界面要显示有哪些头），值一律不下发
      headers: Object.fromEntries(Object.keys(headers).map((k) => [k, ''])),
      headersSet: Object.keys(headers).filter((k) => Boolean(headers[k]))
    }
  })
  // 插件配置：schema 标 secret 的值一律不下发（只回传 pluginSecretsSet）；
  // 兜底再按密文特征识别一遍，双重保证不泄露
  const secretsSet: Record<string, string[]> = {}
  const pluginConfig = out.pluginConfig
  if (pluginConfig) {
    out.pluginConfig = {}
    for (const [pid, values] of Object.entries(pluginConfig)) {
      const secretKeys = secretKeysFor(pid)
      const kept: Record<string, unknown> = {}
      const set: string[] = []
      for (const [key, v] of Object.entries(values ?? {})) {
        const isSecret = secretKeys.has(key) || (typeof v === 'string' && isEncryptedSecret(v))
        if (isSecret) {
          if (!isEmptySecretValue(v)) set.push(key)
          continue
        }
        kept[key] = v
      }
      out.pluginConfig[pid] = kept
      if (set.length > 0) secretsSet[pid] = set.sort()
    }
  }
  out.pluginSecretsSet = secretsSet
  delete out.pluginClearSecrets
  return out
}

/**
 * 插件 secret 字段查询：插件 id → schema 里 `secret: true` 的字段 key。
 *
 * 由 `plugins/registry` 注入（见那里的 `setPluginSecretKeysResolver(...)` 调用）：
 * config.ts **不能** import registry —— registry 自己要读本文件（`runPluginTool` 需要当前
 * 插件配置），反向 import 会成环。用注入还有一个好处：**所有**保存路径（config-save、
 * provider-fetch-models、插件表刷新、内置插件自己改配置…）都自动知道哪些值要加密，
 * 不会漏掉哪一处而把明文 secret 写进磁盘；新调用方也不需要记得传参。
 */
export type PluginSecretKeysResolver = (pluginId: string) => string[]

let pluginSecretKeysOf: PluginSecretKeysResolver = () => []

/**
 * 磁盘上是密文的 `<插件 id>/<key>`：只靠 schema 判断不够——插件暂时没加载（构建期关掉、
 * MCP 还没连上）时 schema 拿不到，读进来已解密的凭据会被当成普通字段明文写盘 / 下发页面。
 */
const knownSecrets = new Set<string>()

function secretKeysFor(pid: string): Set<string> {
  const keys = new Set(pluginSecretKeysOf(pid))
  for (const ref of knownSecrets) if (ref.startsWith(`${pid}/`)) keys.add(ref.slice(pid.length + 1))
  return keys
}

export function setPluginSecretKeysResolver(resolve: PluginSecretKeysResolver): void {
  pluginSecretKeysOf = resolve
}

/** 「不修改」的语义值：secret 字段留空 = 沿用已保存的值（与 MCP 请求头同规则） */
function isEmptySecretValue(v: unknown): boolean {
  return v === '' || v === undefined || v === null
}

/** `<插件 id>/<key>` 集合（`pluginClearSecrets`） */
function makeSecretClearSet(clear: readonly string[] | undefined): Set<string> {
  return new Set((clear ?? []).map((s) => s.trim()).filter(Boolean))
}

/**
 * 合并提交上来的插件配置：
 * - secret 字段空串 = 沿用旧值（`plugin-config-get` 不回传值）；
 * - `pluginClearSecrets` 里的 `<插件 id>/<key>` 删除；
 * - 非 secret 字段直接覆盖；未知插件 / 未知 key 原样保留（插件可能暂时没加载）；
 * - 只在这里删 `pluginSecretsSet` / `pluginClearSecrets` 这两个仅传输字段，不落盘。
 */
function mergePluginConfig(
  incoming: Record<string, Record<string, unknown>> | undefined,
  current: Record<string, Record<string, unknown>> | undefined,
  clear: Set<string>
): Record<string, Record<string, unknown>> | undefined {
  if (!incoming && !current) return undefined
  const ids = [...new Set([...Object.keys(current ?? {}), ...Object.keys(incoming ?? {})])]
  const out: Record<string, Record<string, unknown>> = {}
  for (const pid of ids) {
    const values: Record<string, unknown> = { ...(current?.[pid] ?? {}) }
    const secretKeys = secretKeysFor(pid)
    for (const [key, value] of Object.entries(incoming?.[pid] ?? {})) {
      if (clear.has(`${pid}/${key}`)) {
        delete values[key]
        knownSecrets.delete(`${pid}/${key}`)
        continue
      }
      // secret 留空 = 不修改，保留旧值
      if (secretKeys.has(key) && isEmptySecretValue(value)) continue
      values[key] = value
    }
    for (const ref of clear) {
      if (!ref.startsWith(`${pid}/`)) continue
      delete values[ref.slice(pid.length + 1)]
      knownSecrets.delete(ref)
    }
    out[pid] = values
  }
  return out
}

/** 读配置时校验 MCP 服务器条目：只保留已实现的传输方式，补齐缺省字段 */
export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return []
  const out: McpServerConfig[] = []
  for (const r of raw as Partial<McpServerConfig>[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue
    const transport = r.transport === 'sse' ? 'sse' : 'streamable-http'
    out.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id,
      transport,
      url: typeof r.url === 'string' ? r.url.trim() : '',
      headers:
        r.headers && typeof r.headers === 'object'
          ? Object.fromEntries(
              Object.entries(r.headers).filter(
                ([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'string'
              )
            )
          : {},
      enabled: r.enabled !== false,
      timeoutMs:
        typeof r.timeoutMs === 'number' && r.timeoutMs > 0
          ? Math.min(r.timeoutMs, 600_000)
          : undefined
    })
  }
  return out
}

/**
 * 合并渲染端提交的配置：密钥字段为空 = 沿用旧值（config-get 不回传明文），
 * `clearApiKey: true` 才清空。
 */
export function mergeIncomingYayaConfig(incoming: YayaConfig): YayaConfig {
  const current = loadYayaConfig()
  const next: YayaConfig = JSON.parse(JSON.stringify(incoming))
  next.assistantName = normalizeAssistantName(next.assistantName)
  next.processPreviewSteps = normalizeProcessPreviewSteps(next.processPreviewSteps)
  next.profile = normalizeProfile(next.profile)
  next.providers = (next.providers ?? []).map((p) => {
    const prev = current.providers.find((c) => c.id === p.id)
    let apiKey = p.apiKey
    if (p.clearApiKey) apiKey = ''
    else if (!apiKey) apiKey = prev?.apiKey ?? ''
    const rest = { ...p }
    delete rest.apiKeySet
    delete rest.clearApiKey
    return { ...rest, apiKey }
  })
  // MCP 请求头：值为空 = 沿用旧值（config-get 不回传值）；clearHeaders 里的头删除；
  // 渲染端提交里没有的头名 = 用户删掉了
  next.mcpServers = normalizeMcpServers(
    (incoming.mcpServers ?? []).map((m) => {
      const prev = current.mcpServers.find((c) => c.id === m.id)
      const clear = new Set(m.clearHeaders ?? [])
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.headers ?? {})) {
        const name = k.trim()
        if (!name || clear.has(k)) continue
        const value = v || prev?.headers?.[k] || ''
        if (value) headers[name] = value
      }
      return { ...m, headers }
    })
  )
  // 插件配置：secret 空串沿用旧值、pluginClearSecrets 删除、未知插件 / key 原样保留
  next.pluginConfig = mergePluginConfig(
    incoming.pluginConfig,
    current.pluginConfig,
    makeSecretClearSet(incoming.pluginClearSecrets)
  )
  delete next.pluginSecretsSet
  delete next.pluginClearSecrets
  return next
}
