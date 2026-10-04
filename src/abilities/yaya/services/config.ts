/**
 * YAYA 配置服务 — 管理 ~/.config/LinuxCockpit/yaya/config.json
 * 敏感 Key 走框架级 encryptSecret / decryptSecret 加密存储。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { abilityConfigPath } from '../../../main/process/paths'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../../main/process/encrypt'
import { makeLogger } from '../../../main/process/logger'
import type { YayaConfig } from '../types'

const log = makeLogger('yaya-config')

export const DEFAULT_YAYA_CONFIG: YayaConfig = {
  activeProviderId: 'codex-proxy',
  activeModel: 'gpt-5.5',
  systemPrompt:
    'You are YAYA (Yet Another Yes Agent), an intelligent personal assistant and autonomous agent running inside Linux System Cockpit. You are helpful, precise, and capable of executing tools to assist the user.',
  autoApproveTools: false,
  maxLoopSteps: 25,
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
    cachedConfig = { ...DEFAULT_YAYA_CONFIG }
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
      mcpServers: Array.isArray(parsed.mcpServers)
        ? parsed.mcpServers
        : DEFAULT_YAYA_CONFIG.mcpServers
    }

    // 解密 Provider 中的 apiKey
    for (const p of cfg.providers) {
      if (p.apiKey && isEncryptedSecret(p.apiKey)) {
        try {
          p.apiKey = decryptSecret(p.apiKey)
        } catch (e) {
          log.warn(`Failed to decrypt API key for provider ${p.id}`, { error: String(e) })
          p.apiKey = ''
        }
      }
    }

    cachedConfig = cfg
    return cfg
  } catch (err) {
    log.error('Failed to read YAYA config, using defaults', { error: String(err) })
    cachedConfig = { ...DEFAULT_YAYA_CONFIG }
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
      }
    }
  }

  writeFileSync(file, JSON.stringify(toSave, null, 2), 'utf8')
  cachedConfig = JSON.parse(JSON.stringify(config)) // 内存中保持明文
  log.info('YAYA config saved')
}
