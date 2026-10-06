/**
 * 内置 providers 插件：让助手查看与配置自己的模型服务商（地址、密钥、模型列表、启用状态）。
 *
 * 安全边界：
 *  - **没有删除**：AI 只能停用服务商，删除只能由用户在设置页做；
 *  - 改动都要用户确认（approval: ask），并先过隐私授权：改地址 / 密钥按 `system.exec`
 *    （等于把凭据发往任意服务器），其余按 `system.control`；
 *  - 改地址而没给新密钥时，旧密钥会被清掉：防止把已保存的密钥转发到新地址；
 *  - 返回值里绝不出现密钥，只有 `apiKeySet`。密钥建议用 SecretPlugin 的 `[[secret_id]]` 引用，
 *    工具调用时才替换成真值，聊天记录里只留引用。
 */
import { randomUUID } from 'node:crypto'
import { guard, SCOPE_CONTROL, SCOPE_EXEC } from '../../../../main/process/privacy'
import { getBroadcast } from '../../../../main/process/broadcast'
import { t, te } from '../../../../main/process/i18n'
import {
  loadYayaConfig,
  mergeIncomingYayaConfig,
  publicYayaConfig,
  saveYayaConfig
} from '../../services/config'
import type { PluginTool, YayaPlugin } from '../../services/plugins/types'
import type { ProviderConfig, ProviderType, ReasoningStyle, YayaConfig } from '../../types'

const PLUGIN_ID = 'providers'
const TYPES: ProviderType[] = ['openai', 'codex-proxy', 'ollama', 'anthropic', 'gemini']
const STYLES: ReasoningStyle[] = [
  'auto',
  'openai',
  'deepseek',
  'qwen',
  'openrouter',
  'llamacpp',
  'none'
]
const MAX_MODELS = 200

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return String(v)
}

function fail(error: string): unknown {
  return { content: [{ type: 'text' as const, text: error }], isError: true }
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/** 只认 http / https，去掉用户名密码（不让地址里夹带凭据） */
export function providerUrl(raw: unknown): string {
  const url = new URL(str(raw).trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
  url.username = ''
  url.password = ''
  return url.toString().replace(/\/$/, '')
}

function modelList(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const list = Array.isArray(raw) ? raw : str(raw).split(',')
  return [...new Set(list.map((m) => str(m).trim()).filter(Boolean))].slice(0, MAX_MODELS)
}

/** 给模型看的视图：绝不含密钥 */
export function providerView(p: ProviderConfig, config: YayaConfig): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl ?? '',
    enabled: p.enabled !== false,
    apiKeySet: Boolean(p.apiKey),
    models: p.models,
    defaultModel: p.defaultModel ?? '',
    reasoningStyle: p.reasoningStyle ?? 'auto',
    active: p.id === config.activeProviderId
  }
}

function applyConfig(next: YayaConfig): void {
  saveYayaConfig(mergeIncomingYayaConfig(next))
  // saveYayaConfig 自己会广播 config-changed；显式再补一次，界面刷新不依赖内部细节（值无密钥）
  getBroadcast()('cockpit:yaya-config-changed', publicYayaConfig(loadYayaConfig()))
}

async function guardOrFail(
  scope: typeof SCOPE_CONTROL | typeof SCOPE_EXEC,
  reason: string
): Promise<unknown> {
  try {
    await guard(scope, reason)
    return null
  } catch (e) {
    return fail(errText(e))
  }
}

function clone(config: YayaConfig): YayaConfig {
  return JSON.parse(JSON.stringify(config)) as YayaConfig
}

const tools: PluginTool[] = [
  {
    name: 'list',
    description:
      'List the configured model providers: id, name, type, base URL, models, default model, enabled state, whether an API key is set, and which one is active. API keys are never returned.',
    approval: 'auto',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      ctx.signal.throwIfAborted()
      const config = loadYayaConfig()
      return {
        activeProviderId: config.activeProviderId,
        activeModel: config.activeModel,
        providers: config.providers.map((p) => providerView(p, config))
      }
    }
  },
  {
    name: 'add',
    description:
      'Add a model provider (OpenAI-compatible API). Pass the API key as a [[secret_id]] reference when the user gave you one with #Secret(...); a plain key would stay in the chat history. Needs the user’s approval.',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['name', 'baseUrl'],
      properties: {
        name: { type: 'string', description: 'Display name' },
        type: { type: 'string', enum: TYPES, description: 'Protocol, default openai' },
        baseUrl: { type: 'string', description: 'API base URL, http(s) only, e.g. .../v1' },
        apiKey: { type: 'string', description: 'API key, preferably a [[secret_id]] reference' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Model ids this provider offers'
        },
        defaultModel: { type: 'string', description: 'Default model id' },
        reasoningStyle: { type: 'string', enum: STYLES, description: 'Default auto' },
        enabled: { type: 'boolean', description: 'Default true' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const name = str(args.name).trim().slice(0, 64)
      if (!name) return fail(t('yaya.plugin.providers.err_need_name', '缺少服务商名称（name）'))
      let baseUrl: string
      try {
        baseUrl = providerUrl(args.baseUrl)
      } catch {
        return fail(t('yaya.plugin.providers.err_bad_url', '服务商地址只支持 http / https'))
      }
      const denied = await guardOrFail(
        SCOPE_EXEC,
        t('yaya.plugin.providers.guard_add', '添加模型服务商：把请求和密钥发往这个地址')
      )
      if (denied) return denied
      const models = modelList(args.models) ?? []
      const provider: ProviderConfig = {
        id: 'prov-' + randomUUID().slice(0, 8),
        name,
        type: TYPES.includes(args.type as ProviderType) ? (args.type as ProviderType) : 'openai',
        baseUrl,
        apiKey: str(args.apiKey).trim(),
        models,
        defaultModel: str(args.defaultModel).trim() || models[0],
        enabled: args.enabled !== false,
        reasoningStyle: STYLES.includes(args.reasoningStyle as ReasoningStyle)
          ? (args.reasoningStyle as ReasoningStyle)
          : 'auto'
      }
      const next = clone(loadYayaConfig())
      next.providers = [...next.providers, provider]
      applyConfig(next)
      const saved = loadYayaConfig()
      const view = saved.providers.find((p) => p.id === provider.id)
      return { ok: true, provider: view ? providerView(view, saved) : null }
    }
  },
  {
    name: 'update',
    description:
      'Change a provider: name, base URL, API key, model list, default model, reasoning style, enabled. models replaces the list; addModels / removeModels edit it. Changing baseUrl without a new apiKey clears the stored key (it is never sent to a new address). Providers cannot be deleted - disable them instead; deleting is for the user in settings. Needs approval.',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Provider id (from providers_list)' },
        name: { type: 'string' },
        baseUrl: { type: 'string', description: 'http(s) only' },
        apiKey: {
          type: 'string',
          description: 'New API key, preferably a [[secret_id]] reference'
        },
        models: { type: 'array', items: { type: 'string' } },
        addModels: { type: 'array', items: { type: 'string' } },
        removeModels: { type: 'array', items: { type: 'string' } },
        defaultModel: { type: 'string' },
        reasoningStyle: { type: 'string', enum: STYLES },
        enabled: { type: 'boolean', description: 'false disables the provider (never deletes it)' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      const config = loadYayaConfig()
      const current = config.providers.find((p) => p.id === id)
      if (!current)
        return fail(te('yaya.plugin.providers.err_unknown', { id }, '服务商不存在：{id}'))

      let baseUrl = current.baseUrl
      if (args.baseUrl !== undefined) {
        try {
          baseUrl = providerUrl(args.baseUrl)
        } catch {
          return fail(t('yaya.plugin.providers.err_bad_url', '服务商地址只支持 http / https'))
        }
      }
      const newKey = str(args.apiKey).trim()
      const urlChanged = (baseUrl ?? '') !== (current.baseUrl ?? '')
      const touchesCredential = urlChanged || Boolean(newKey)
      const denied = await guardOrFail(
        touchesCredential ? SCOPE_EXEC : SCOPE_CONTROL,
        touchesCredential
          ? t('yaya.plugin.providers.guard_credential', '修改模型服务商的地址 / 密钥')
          : t('yaya.plugin.providers.guard_config', '修改模型服务商的设置')
      )
      if (denied) return denied

      let models = modelList(args.models) ?? [...current.models]
      for (const m of modelList(args.addModels) ?? []) if (!models.includes(m)) models.push(m)
      const drop = new Set(modelList(args.removeModels) ?? [])
      models = models.filter((m) => !drop.has(m)).slice(0, MAX_MODELS)
      const defaultModel =
        args.defaultModel !== undefined
          ? str(args.defaultModel).trim()
          : current.defaultModel && models.includes(current.defaultModel)
            ? current.defaultModel
            : models[0]
      const keyCleared = urlChanged && !newKey && Boolean(current.apiKey)
      const updated: ProviderConfig = {
        ...current,
        name: str(args.name).trim().slice(0, 64) || current.name,
        baseUrl,
        // 空串 = 沿用旧密钥（mergeIncomingYayaConfig）；换地址没给新密钥 = 清掉
        apiKey: newKey,
        ...(keyCleared ? { clearApiKey: true } : {}),
        models,
        defaultModel,
        reasoningStyle: STYLES.includes(args.reasoningStyle as ReasoningStyle)
          ? (args.reasoningStyle as ReasoningStyle)
          : current.reasoningStyle,
        enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled !== false
      }
      const next = clone(config)
      next.providers = next.providers.map((p) => (p.id === id ? updated : p))
      applyConfig(next)
      const saved = loadYayaConfig()
      const view = saved.providers.find((p) => p.id === id)
      const notes: string[] = []
      if (keyCleared)
        notes.push(
          t(
            'yaya.plugin.providers.note_key_cleared',
            'Base URL changed without a new key: the stored API key was cleared. Ask the user for a key (#Secret) or let them enter it in settings.'
          )
        )
      if (updated.enabled === false && id === config.activeProviderId)
        notes.push(
          t(
            'yaya.plugin.providers.note_disabled_active',
            'This is the active provider. Disabled providers disappear from the model picker; conversations already using it keep it until the user picks another model.'
          )
        )
      return { ok: true, provider: view ? providerView(view, saved) : null, notes }
    }
  }
]

const INSTRUCTIONS =
  'Providers tools (providers_*): list and configure your own model providers. providers_list never ' +
  'returns API keys. providers_add / providers_update need the user’s approval; pass API keys as ' +
  '[[secret_id]] references. You cannot delete a provider - disable it with providers_update ' +
  'enabled=false; only the user deletes providers in settings.'

const DOCS = `# 模型服务商（providers）

让助手查看与配置自己的模型服务商。工具名带 \`providers_\` 前缀。

| 工具 | 说明 | 需要确认 |
| --- | --- | --- |
| \`providers_list\` | 列出服务商：地址、模型、默认模型、启用状态、是否已设置密钥、当前使用哪个（不返回密钥） | 否 |
| \`providers_add\` | 添加服务商 | **是** |
| \`providers_update\` | 修改名称 / 地址 / 密钥 / 模型列表 / 默认模型 / 思考参数格式 / 启用状态 | **是** |

## 安全边界

- **不能删除服务商**，只能停用；删除只能由你在设置页操作。
- 改地址或密钥按 \`system.exec\` 授权（等于把凭据发往任意服务器），其余按 \`system.control\`。
- 改了地址却没给新密钥时，旧密钥会被清掉，不会被发到新地址。
- 返回值里没有密钥，只有「是否已设置」。给 AI 密钥请用 \`#Secret("…")\`（SecretPlugin），
  聊天记录与工具参数里只留 \`[[secret_id]]\` 引用。
- 停用当前正在用的服务商不会中断已经在用它的对话；它会从模型选择里消失。
`

const plugin: YayaPlugin = {
  id: PLUGIN_ID,
  kind: 'builtin',
  label: '模型服务商',
  labelKey: 'yaya.plugin.providers.label',
  description: '让助手查看与配置自己的模型服务商（只能停用，不能删除）',
  descriptionKey: 'yaya.plugin.providers.desc',
  icon: 'mdi-server-network',
  namespace: PLUGIN_ID,
  defaultEnabled: true,
  docs: DOCS,
  instructions: () => INSTRUCTIONS,
  tools: () => tools
}

export default plugin
