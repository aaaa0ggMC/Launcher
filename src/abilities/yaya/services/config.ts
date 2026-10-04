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

    cachedConfig = cfg
    return cfg
  } catch (err) {
    log.error('Failed to read YAYA config, using defaults', { error: String(err) })
    cachedConfig = structuredClone(DEFAULT_YAYA_CONFIG)
    return cachedConfig
  }
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

  writeFileSync(file, JSON.stringify(toSave, null, 2), 'utf8')
  cachedConfig = JSON.parse(JSON.stringify(config)) // 内存中保持明文
  log.info('YAYA config saved')
  getBroadcast()('cockpit:yaya-config-changed', publicYayaConfig(cachedConfig!))
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

/** 系统提示词：`{name}` 替换为助手名 */
export function resolveSystemPrompt(prompt: string, config: YayaConfig): string {
  return prompt.split('{name}').join(normalizeAssistantName(config.assistantName))
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
  return next
}
