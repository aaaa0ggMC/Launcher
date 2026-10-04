/**
 * 内置 plugins 插件：让助手查看与调整自己的插件 / MCP 服务器 / Skill，
 * 并读取本次运行的上下文用量。
 *
 * 安全边界（这里**绝不**提供，只能由用户在设置页操作）：
 *  - 不写 `toolApproval` / `autoApproveTools`——AI 不能给自己免审批；
 *  - 不写 `providers` / API key / `systemPrompt` / `agent.*`——凭据与系统提示词只归用户；
 *  - 返回值里不出现任何密钥：MCP 请求头只给头名（`headersSet`），值由 config 的加密落盘路径保管。
 */
import { guard, SCOPE_CONTROL, SCOPE_EXEC } from '../../../../main/process/privacy'
import { getBroadcast } from '../../../../main/process/broadcast'
import { t, te } from '../../../../main/process/i18n'
import {
  clipText,
  listPluginInfo,
  refreshPlugins,
  restartPlugin
} from '../../services/plugins/registry'
import { skillsDirOf } from '../../services/plugins/skills/provider'
import { plainHeaders, safeUrl, sanitizeServerId } from '../../services/plugins/mcp/client'
import {
  loadYayaConfig,
  mergeIncomingYayaConfig,
  publicYayaConfig,
  saveYayaConfig
} from '../../services/config'
import type { PluginInfo, PluginStatus, PluginTool, YayaPlugin } from '../../services/plugins/types'
import type { McpServerConfig, McpTransport, YayaConfig } from '../../types'

const PLUGIN_ID = 'plugins'
/** 单个插件 docs 的返回上限 */
const DOCS_MAX_CHARS = 4000
const MAX_TIMEOUT_MS = 600_000

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return String(v)
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/** 结构化失败：模型看到失败原因，界面标红 */
function fail(error: string): unknown {
  return { content: [{ type: 'text' as const, text: error }], isError: true }
}

function clone(config: YayaConfig): YayaConfig {
  return JSON.parse(JSON.stringify(config)) as YayaConfig
}

/** 已经设置（值非空）的请求头名——与 `publicYayaConfig` 的 `headersSet` 同语义，绝不给值 */
function headerNames(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {})
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
}

/** 入参里的请求头：丢掉空值、非法头名与控制字符（注入） */
function headerMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const strings: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (typeof v === 'string') strings[k] = v
  return plainHeaders(strings)
}

function timeoutOf(raw: unknown, fallback: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(Math.max(1, Math.round(raw)), MAX_TIMEOUT_MS)
}

/** 名称 → 服务器 id：与设置页一致（slug + 数字后缀去重） */
function uniqueServerId(name: string, existing: readonly McpServerConfig[]): string {
  const base = sanitizeServerId(name).slice(0, 32)
  const taken = new Set(existing.map((m) => m.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function transportOf(raw: unknown, fallback: McpTransport): McpTransport {
  if (raw === 'sse' || raw === 'streamable-http') return raw
  return fallback
}

/** 插件 id (`mcp-<id>`) → 服务器 id；不是 MCP 插件时返回 null */
function mcpServerIdOf(pluginId: string): string | null {
  return pluginId.startsWith('mcp-') ? pluginId.slice(4) : null
}

/** 给模型看的 MCP 服务器视图（不含请求头值） */
function serverView(server: McpServerConfig): Record<string, unknown> {
  return {
    id: server.id,
    pluginId: `mcp-${sanitizeServerId(server.id)}`,
    name: server.name,
    transport: server.transport,
    url: server.url,
    enabled: server.enabled !== false,
    timeoutMs: server.timeoutMs,
    headersSet: headerNames(server.headers)
  }
}

/** 插件 / 工具的精简视图（docs 全文太长，只在按 id 查询时附上） */
function pluginView(plugin: PluginInfo): Record<string, unknown> {
  return {
    id: plugin.id,
    kind: plugin.kind,
    label: plugin.label,
    description: plugin.description,
    icon: plugin.icon,
    enabled: plugin.enabled,
    status: plugin.status,
    tools: plugin.tools.map((tool) => ({
      wireName: tool.wireName,
      enabled: tool.enabled,
      approval: tool.approval ?? tool.defaultApproval
    }))
  }
}

/**
 * 保存配置后的标准动作（与设置页 / `yaya.config-save` 一致）：
 * merge（空 header 值沿用旧值）→ 加密落盘 → 重建插件表 → 广播两个事件。
 */
function applyConfig(next: YayaConfig): Record<string, unknown> {
  saveYayaConfig(mergeIncomingYayaConfig(next))
  refreshPlugins(loadYayaConfig())
  getBroadcast()('cockpit:yaya-plugins-changed', {})
  // saveYayaConfig 自己也会广播一次 config-changed；这里显式补一次，
  // 保证「配置改动一定让界面刷新」不依赖那个内部细节。值已过 publicYayaConfig，无密钥。
  getBroadcast()('cockpit:yaya-config-changed', publicYayaConfig(loadYayaConfig()))
  return { ok: true, note: t('yaya.plugin.plugins.note_next_run', '新工具从下一次对话运行起生效') }
}

/** 改配置前的隐私授权：agent 来源会弹授权窗口；非 agent 来源直接放过 */
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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const tools: PluginTool[] = [
  {
    name: 'context_info',
    description:
      '读取本次运行的上下文信息：模型与供应商、当前步数 / 步数上限、最近一次模型调用的输入 token（≈ 当前上下文大小）、输出 token、缓存命中 token、本次运行累计 token、当前分支的消息节点数与可用工具数。宿主未提供时返回 { available: false }。',
    parameters: { type: 'object', properties: {} },
    approval: 'auto',
    run: async (_args, ctx) => {
      ctx.signal.throwIfAborted()
      const info = ctx.context?.()
      return info ?? { available: false }
    }
  },

  {
    name: 'list',
    description:
      '列出全部插件（内置 / MCP / Skill）及其工具的启用与审批方式；省略 id 返回精简清单，传 id 只看一个插件并附带它的完整文档。',
    approval: 'auto',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '插件 id；省略则列出全部插件' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      const all = listPluginInfo(loadYayaConfig())
      if (!id) return { count: all.length, plugins: all.map(pluginView) }
      const found = all.find((p) => p.id === id)
      if (!found) {
        return fail(te('yaya.plugin.plugins.err_unknown_plugin', { id }, `插件不存在：${id}`))
      }
      return {
        plugin: {
          ...pluginView(found),
          docs: found.docs ? clipText(found.docs, DOCS_MAX_CHARS) : undefined
        }
      }
    }
  },

  {
    name: 'set_plugin_enabled',
    description:
      '启用或停用一个插件（内置 / MCP / Skill）。不能停用「插件管理」插件自身——那会让助手失去自我管理能力，请在设置页操作。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['id', 'enabled'],
      properties: {
        id: { type: 'string', description: '插件 id（plugins_list 的返回值）' },
        enabled: { type: 'boolean', description: 'true = 启用；false = 停用' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      const enabled = bool(args.enabled, true)
      if (!id) return fail(t('yaya.plugin.plugins.err_need_plugin', '缺少插件 id'))
      if (id === PLUGIN_ID) {
        return fail(
          t('yaya.plugin.plugins.err_self', '「插件管理」插件不能停用自己，请在设置页操作')
        )
      }
      const config = loadYayaConfig()
      if (!listPluginInfo(config).some((p) => p.id === id)) {
        return fail(te('yaya.plugin.plugins.err_unknown_plugin', { id }, `插件不存在：${id}`))
      }
      const denied = await guardOrFail(
        SCOPE_CONTROL,
        t('yaya.plugin.plugins.guard_config', '修改 YAYA 插件 / 工具的启用状态')
      )
      if (denied) return denied

      const next = clone(config)
      next.pluginEnabled = { ...(next.pluginEnabled ?? {}), [id]: enabled }
      // MCP 服务器的启用态与它的插件停用保持一致（设置页的开关就是这么做的）
      const serverId = mcpServerIdOf(id)
      const server = serverId ? next.mcpServers.find((m) => m.id === serverId) : undefined
      if (server) server.enabled = enabled
      return applyConfig(next)
    }
  },

  {
    name: 'set_tool_enabled',
    description:
      '按 wire name 启用 / 停用单个工具。不能停用「插件管理」插件自己的工具，请在设置页操作。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['wireName', 'enabled'],
      properties: {
        wireName: { type: 'string', description: '工具对模型暴露的名字（如 system_run_bash）' },
        enabled: { type: 'boolean', description: 'true = 启用；false = 停用' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const wireName = str(args.wireName).trim()
      const enabled = bool(args.enabled, true)
      if (!wireName) return fail(t('yaya.plugin.plugins.err_need_tool', '缺少工具 wire name'))
      const config = loadYayaConfig()
      const all = listPluginInfo(config)
      const owner = all.find((p) => p.tools.some((tool) => tool.wireName === wireName))
      if (!owner) {
        return fail(
          te('yaya.plugin.plugins.err_unknown_tool', { wireName }, `工具不存在：${wireName}`)
        )
      }
      if (owner.id === PLUGIN_ID) {
        return fail(
          t(
            'yaya.plugin.plugins.err_self_tool',
            '「插件管理」插件自己的工具不能停用，请在设置页操作'
          )
        )
      }
      const denied = await guardOrFail(
        SCOPE_CONTROL,
        t('yaya.plugin.plugins.guard_config', '修改 YAYA 插件 / 工具的启用状态')
      )
      if (denied) return denied

      const next = clone(config)
      const off = new Set(next.disabledTools ?? [])
      if (enabled) off.delete(wireName)
      else off.add(wireName)
      next.disabledTools = [...off].sort()
      return applyConfig(next)
    }
  },

  {
    name: 'mcp_list',
    description:
      '列出已配置的 MCP 服务器：名称、地址、传输方式、启用状态、超时与已设置的请求头名。请求头的值是凭据，一律不返回。',
    approval: 'auto',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      ctx.signal.throwIfAborted()
      const servers = loadYayaConfig().mcpServers ?? []
      return { count: servers.length, servers: servers.map(serverView) }
    }
  },

  {
    name: 'mcp_add',
    description:
      '添加一个 MCP 服务器（仅 http / https；id 由名称自动生成）。请求头的值会加密落盘；连接任意服务器并把它的工具交给 AI 等同执行能力，需要确认。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: { type: 'string', description: '服务器名称（同时用于生成 id）' },
        url: { type: 'string', description: '服务器地址，只允许 http / https' },
        transport: {
          type: 'string',
          enum: ['streamable-http', 'sse'],
          description: '传输方式，缺省 streamable-http'
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '自定义请求头（如 Authorization），值会加密保存'
        },
        timeoutMs: { type: 'number', description: '单次调用超时毫秒数，缺省 60000' },
        enabled: { type: 'boolean', description: '是否启用，缺省 true' }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const name = str(args.name).trim()
      if (!name) {
        return fail(t('yaya.plugin.plugins.err_need_name', '缺少 MCP 服务器名称（name）'))
      }
      const rawUrl = str(args.url).trim()
      let url: string
      try {
        url = safeUrl(rawUrl).toString()
      } catch {
        return fail(t('yaya.plugin.plugins.err_bad_url', '只支持 http / https 服务器地址'))
      }

      const config = loadYayaConfig()
      const existing = config.mcpServers ?? []
      const id = uniqueServerId(name, existing)
      const denied = await guardOrFail(
        SCOPE_EXEC,
        t('yaya.plugin.plugins.guard_mcp_add', '添加 MCP 服务器：连接任意服务器并把它的工具交给 AI')
      )
      if (denied) return denied

      const server: McpServerConfig = {
        id,
        name,
        transport: transportOf(args.transport, 'streamable-http'),
        url,
        headers: headerMap(args.headers),
        enabled: bool(args.enabled, true),
        timeoutMs: timeoutOf(args.timeoutMs, undefined)
      }
      const next = clone(config)
      next.mcpServers = [...existing, server]
      return { ...applyConfig(next), server: serverView(server) }
    }
  },

  {
    name: 'mcp_update',
    description:
      '修改一个已保存的 MCP 服务器：名称、地址、传输方式、启用状态、超时与请求头。header 值传空串 = 保留原值；clearHeaders 删除指定请求头。改地址 / 请求头需要执行授权。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: '服务器 id' },
        name: { type: 'string', description: '新名称' },
        url: { type: 'string', description: '新地址（只允许 http / https）' },
        transport: {
          type: 'string',
          enum: ['streamable-http', 'sse'],
          description: '传输方式'
        },
        enabled: { type: 'boolean', description: '是否启用' },
        timeoutMs: { type: 'number', description: '单次调用超时毫秒数' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '请求头；空值 = 沿用已保存的值'
        },
        clearHeaders: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的请求头名'
        }
      }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      if (!id) return fail(t('yaya.plugin.plugins.err_need_server', '缺少 MCP 服务器 id'))
      const config = loadYayaConfig()
      const current = (config.mcpServers ?? []).find((m) => m.id === id)
      if (!current) {
        return fail(te('yaya.plugin.plugins.err_unknown_server', { id }, `MCP 服务器不存在：${id}`))
      }

      let url = current.url
      if (args.url !== undefined) {
        try {
          url = safeUrl(str(args.url).trim()).toString()
        } catch {
          return fail(t('yaya.plugin.plugins.err_bad_url', '只支持 http / https 服务器地址'))
        }
      }
      const incoming = headerMap(args.headers)
      const clear = new Set(
        (Array.isArray(args.clearHeaders) ? args.clearHeaders : [])
          .map((h) => str(h).trim())
          .filter(Boolean)
      )
      const touchesCredential =
        args.url !== undefined || args.headers !== undefined || clear.size > 0
      const denied = await guardOrFail(
        touchesCredential ? SCOPE_EXEC : SCOPE_CONTROL,
        touchesCredential
          ? t(
              'yaya.plugin.plugins.guard_mcp_update',
              '修改 MCP 服务器地址 / 请求头：等同连接任意服务器'
            )
          : t('yaya.plugin.plugins.guard_config', '修改 YAYA 插件 / 工具的启用状态')
      )
      if (denied) return denied

      const headers: Record<string, string> = { ...(current.headers ?? {}) }
      for (const name of clear) delete headers[name]
      for (const [name, value] of Object.entries(incoming)) {
        if (!value) continue // 空值 = 保留原值
        headers[name] = value
      }
      const server: McpServerConfig = {
        id: current.id,
        name: str(args.name).trim() || current.name,
        transport: transportOf(args.transport, current.transport),
        url,
        headers,
        enabled: args.enabled === undefined ? current.enabled !== false : bool(args.enabled, true),
        timeoutMs: timeoutOf(args.timeoutMs, current.timeoutMs)
      }
      const next = clone(config)
      next.mcpServers = (next.mcpServers ?? []).map((m) => (m.id === id ? server : m))
      return { ...applyConfig(next), server: serverView(server) }
    }
  },

  {
    name: 'mcp_remove',
    description:
      '删除一个 MCP 服务器，同时清掉它的插件启用状态（删除后重新添加会按新服务器处理）。不可恢复。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: '服务器 id' } }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      if (!id) return fail(t('yaya.plugin.plugins.err_need_server', '缺少 MCP 服务器 id'))
      const config = loadYayaConfig()
      if (!(config.mcpServers ?? []).some((m) => m.id === id)) {
        return fail(te('yaya.plugin.plugins.err_unknown_server', { id }, `MCP 服务器不存在：${id}`))
      }
      const denied = await guardOrFail(
        SCOPE_CONTROL,
        t('yaya.plugin.plugins.guard_config', '修改 YAYA 插件 / 工具的启用状态')
      )
      if (denied) return denied

      const next = clone(config)
      next.mcpServers = (next.mcpServers ?? []).filter((m) => m.id !== id)
      const pluginKey = `mcp-${sanitizeServerId(id)}`
      const overrides = { ...(next.pluginEnabled ?? {}) }
      delete overrides[pluginKey]
      next.pluginEnabled = overrides
      return { ...applyConfig(next), id }
    }
  },

  {
    name: 'restart',
    description: '重连 / 重启一个插件（MCP 断开重连等），返回它的最新状态。',
    approval: 'auto',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: '插件 id' } }
    },
    run: async (args, ctx) => {
      ctx.signal.throwIfAborted()
      const id = str(args.id).trim()
      if (!id) return fail(t('yaya.plugin.plugins.err_need_plugin', '缺少插件 id'))
      try {
        const status: PluginStatus = await restartPlugin(id)
        return { ok: true, id, status }
      } catch (e) {
        return fail(errText(e))
      }
    }
  },

  {
    name: 'skills_list',
    description:
      '列出已安装的 Skill（id / 名称 / 描述 / 启用状态）与 Skill 目录。本插件不提供写 SKILL.md 的工具——用 system 插件的 write_file 写 <目录>/<名字>/SKILL.md（会先要执行授权），再触发一次配置改动让插件表重扫。',
    approval: 'auto',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      ctx.signal.throwIfAborted()
      const config = loadYayaConfig()
      const all = listPluginInfo(config)
      const skills = all
        .filter((p) => p.kind === 'skill' && p.id !== 'skills')
        .map((p) => ({ id: p.id, name: p.label, description: p.description, enabled: p.enabled }))
      const hub = all.find((p) => p.id === 'skills')
      return {
        dir: skillsDirOf(config),
        hubEnabled: hub?.enabled ?? false,
        count: skills.length,
        skills
      }
    }
  }
]

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

const INSTRUCTIONS =
  'Plugins tools (all named plugins_*): inspect and change your own plugins, MCP servers and skills, ' +
  'and read the current context usage. ' +
  'plugins_list gives every plugin and tool with its approval mode; plugins_context_info reports model, ' +
  'step and token usage (lastPromptTokens is roughly the current context size). ' +
  'Changing tools (plugins_set_*, plugins_mcp_add/update/remove) need the user\u2019s approval and only take ' +
  'effect from the next conversation run; this plugin can never change tool approvals, credentials or the ' +
  'system prompt \u2014 those belong to the user in the settings page.'

const DOCS = `# 插件管理（plugins）

让助手查看与调整自己的插件、MCP 服务器、Skill，并查看当前上下文用量。
工具名都带 \`plugins_\` 前缀。

## 工具

| 工具 | 说明 | 需要确认 |
| --- | --- | --- |
| \`plugins_context_info\` | 本次运行的上下文信息：模型 / 供应商、当前步数与步数上限、最近一次调用的输入（≈ 当前上下文大小）/ 输出 / 缓存命中 token、本次累计 token、分支消息数、可用工具数 | 否 |
| \`plugins_list\` | 列出全部插件与工具的启用 / 审批方式；传 \`id\` 可看单个插件并附完整文档 | 否 |
| \`plugins_set_plugin_enabled\` | 启用 / 停用一个插件 | **是** |
| \`plugins_set_tool_enabled\` | 按 wire name 启用 / 停用单个工具 | **是** |
| \`plugins_mcp_list\` | 列出 MCP 服务器（含已设置的请求头名，不含值） | 否 |
| \`plugins_mcp_add\` | 添加 MCP 服务器；header 值会加密落盘 | **是** |
| \`plugins_mcp_update\` | 修改 MCP 服务器（header 值空串 = 保留原值，\`clearHeaders\` 删除） | **是** |
| \`plugins_mcp_remove\` | 删除 MCP 服务器 | **是** |
| \`plugins_restart\` | 重连 / 重启一个插件，返回最新状态 | 否 |
| \`plugins_skills_list\` | 列出 Skill 与 Skill 目录 | 否 |

## 安全边界

- 只读工具直接执行；凡是改配置的工具都要用户确认（approval: ask），并先过隐私授权
  （\`system.control\`；涉及 MCP 地址 / 请求头时按 \`system.exec\` 处理）。
- **不能停用「插件管理」插件自己，也不能停用它自己的工具**——否则助手会失去自我管理能力，
  这类操作请到设置页完成。
- **绝不提供**：修改 \`toolApproval\` / \`autoApproveTools\`（AI 不能给自己免审批）、
  \`providers\` / API key、\`systemPrompt\`、\`agent.*\`。这些只归用户本人，在设置页修改。
- 返回值里不出现任何凭据：MCP 请求头只给头名（\`headersSet\`），值由配置的加密落盘路径保管。
- 新建 / 修改 Skill：用 \`system\` 插件的 \`write_file\` 写 \`<Skill 目录>/<名字>/SKILL.md\`（受执行授权约束），
  本插件刻意不提供写 SKILL.md 的工具。

## 生效时机

工具表在一次对话运行开始时解析一次，运行内保持稳定。修改插件 / 工具后，
**新工具从下一次对话运行起生效**（工具结果里也会带上这句提示）。
写完新的 \`SKILL.md\` 后需要触发一次插件表刷新（改一次配置，或在设置页重扫）才会被发现。
`

const plugin: YayaPlugin = {
  id: PLUGIN_ID,
  kind: 'builtin',
  label: '插件管理',
  labelKey: 'yaya.plugin.plugins.label',
  description: '让助手查看与调整自己的插件、MCP 服务器、Skill，并查看当前上下文用量',
  descriptionKey: 'yaya.plugin.plugins.desc',
  icon: 'mdi-puzzle-outline',
  namespace: PLUGIN_ID,
  defaultEnabled: true,
  docs: DOCS,
  instructions: () => INSTRUCTIONS,
  tools: () => tools
}

export default plugin
