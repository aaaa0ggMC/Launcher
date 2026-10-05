/**
 * YAYA 主进程命令注册表
 * CLI-first 架构：UI 与 CLI / Headless 共享同一套 CommandSpec。
 */
import { randomUUID } from 'node:crypto'
import type { ApprovalScope } from './types'
import { normalizeEffort } from './services/providers/reasoning'
import type { CommandSpec } from '../../main/process/commands/types'
import { registerStartupHook } from '../../main/process/startup'
import { currentOrigin, SCOPE_EXEC } from '../../main/process/privacy'
import { registerPreRunHook } from '../../main/process/commands/registry'
import { getBroadcast } from '../../main/process/broadcast'
import {
  listSessions,
  getSession,
  getMessage,
  createSession,
  deleteSession,
  getMessageBranchWithSiblings,
  getMessageBranchWindow,
  getMessageSiblings,
  updateSession,
  findLatestLeaf,
  deleteMessageSubtree,
  searchSessionMessages,
  getSessionMessages,
  getMessageBranch
} from './services/db'
import { computeSessionUsage, type ToolRisk } from './services/usage'
import {
  startWorkflow,
  regenerateWorkflow,
  abortWorkflow,
  controlWorkflow,
  approveToolCall,
  getWorkflowSnapshot,
  reconcileInterruptedWorkflows,
  overlayLiveBuffer,
  runningSessionIds
} from './services/loop/manager'
import {
  loadYayaConfig,
  saveYayaConfig,
  publicYayaConfig,
  mergeIncomingYayaConfig
} from './services/config'
import {
  MAX_ASSET_DATA_BYTES,
  normalizeAssetMime,
  sanitizeAssetFilename,
  saveAsset,
  importAssetFromPath,
  assetDataUrl
} from './services/assets'
import { t, te } from '../../main/process/i18n'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('yaya-commands')

/** 附件体积的简短显示（错误信息用） */
function formatAssetBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
import {
  getPlugin,
  listPluginInfo,
  pluginSecretKeys,
  refreshPlugins,
  registerPlugin,
  restartPlugin
} from './services/plugins/registry'
import { mentionCandidates, sessionMentions } from './services/plugins/mention'
import type { PluginConfigField, PluginGroup, YayaPlugin } from './services/plugins/types'
// 动态插件来源：导入即注册（registerPluginProvider）
import './services/plugins/mcp/provider'
import './services/plugins/skills/provider'
import { mcpCommands } from './services/plugins/mcp/commands'
import { skillCommands } from './services/plugins/skills/commands'
import { ioCommands } from './services/io-commands'
import type { MessageAttachment, YayaConfig, Session, ProviderConfig, ProviderType } from './types'
import { fetchModelsFromEndpoint } from './services/models'
import './jobs'
import './services/workflow/builtin'
import { listWorkflowInfo } from './services/workflow/registry'

const normalizeScope = (v: unknown): ApprovalScope => (v === 'run' || v === 'session' ? v : 'once')

// ---------------------------------------------------------------------------
// 插件配置 / 子分组（PLAN 6.4）：入参解析与 schema 校验
// ---------------------------------------------------------------------------

/** `--values <JSON 对象>`：CLI 给字符串，设置页直接给对象 */
function parseJsonObject(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error(t('yaya.plugin.cmd_err_bad_values', '无效的配置值：需要 JSON 对象'))
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(t('yaya.plugin.cmd_err_bad_values', '无效的配置值：需要 JSON 对象'))
  return value as Record<string, unknown>
}

function badType(key: string, type: PluginConfigField['type']): Error {
  return new Error(
    te('yaya.plugin.cmd_err_bad_type', { key, type }, `配置项 ${key} 的值类型不对（应为 ${type}）`)
  )
}

/** 单个字段的校验与归一：类型不符 / 不在可选项里一律拒绝；数字夹到 min/max */
function checkedConfigValue(field: PluginConfigField, value: unknown): string | number | boolean {
  if (field.type === 'number') {
    const text = typeof value === 'number' ? String(value) : String(value ?? '').trim()
    const n = Number(text)
    if (!text || !Number.isFinite(n)) throw badType(field.key, field.type)
    let clamped = n
    if (typeof field.min === 'number') clamped = Math.max(field.min, clamped)
    if (typeof field.max === 'number') clamped = Math.min(field.max, clamped)
    return clamped
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw badType(field.key, field.type)
  }
  if (field.type === 'select') {
    const v = String(value ?? '')
    if (!(field.options ?? []).some((o) => o.value === v))
      throw new Error(
        te(
          'yaya.plugin.cmd_err_bad_option',
          { key: field.key },
          `配置项 ${field.key} 的值不在可选项里`
        )
      )
    return v
  }
  // string / text；secret 允许空串（= 不修改）
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/** 按 schema 校验配置入参：未知 key 直接拒绝（防止往配置里塞垃圾） */
function validatePluginConfig(
  plugin: YayaPlugin,
  values: Record<string, unknown>
): Record<string, unknown> {
  const schema = new Map((plugin.configSchema ?? []).map((f) => [f.key, f]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const field = schema.get(key)
    if (!field)
      throw new Error(te('yaya.plugin.cmd_err_unknown_key', { key }, `未知的配置项：${key}`))
    out[key] = checkedConfigValue(field, value)
  }
  return out
}

/** 保存插件配置 / 分组开关后的标准动作：落盘 → 重建插件表 → 广播 */
function applyPluginConfigChange(next: YayaConfig): Record<string, unknown> {
  saveYayaConfig(next)
  refreshPlugins(loadYayaConfig())
  getBroadcast()('cockpit:yaya-plugins-changed', {})
  return { ok: true, note: t('yaya.plugin.cmd_note_next_run', '新配置从下一次工具调用起生效') }
}

// 命令脚本与工具都经过注册表：不要让 YAYA 经脚本递归启动或修改自己。
registerPreRunHook('yaya.', async () => {
  if (currentOrigin().kind === 'local-agent') {
    throw new Error('yaya.* commands are not available to the local agent')
  }
})

// 内置插件：plugins/<id>/index.ts 默认导出 YayaPlugin，放进目录即注册
const builtinPlugins = import.meta.glob<YayaPlugin>('./plugins/*/index.ts', {
  eager: true,
  import: 'default'
})
for (const [file, plugin] of Object.entries(builtinPlugins)) {
  try {
    registerPlugin(plugin)
  } catch (e) {
    console.error(`[yaya] failed to register plugin ${file}`, e)
  }
}

// 系统启动时恢复异常中断的工作流状态、按配置建立插件表
registerStartupHook(() => {
  reconcileInterruptedWorkflows()
  refreshPlugins(loadYayaConfig())
})

const commands: CommandSpec[] = [
  // 1. 列出所有会话 (自动清理无消息的空会话)
  {
    name: 'yaya.sessions',
    description: '列出所有已保存的 YAYA Agent 聊天会话',
    usage: 'yaya.sessions [--activeSession <id>]',
    run: async (ctx) => {
      const activeSession = ctx.named.activeSession as string | undefined
      return listSessions(activeSession)
    }
  },

  {
    name: 'yaya.sessions-search',
    description: '按内容检索会话（匹配用户 / 助手消息正文，每个会话返回一条命中片段与命中数）',
    usage: 'yaya.sessions-search --query <text> [--limit 50]',
    run: async (ctx) => {
      const limit = Math.min(200, Math.max(1, Number(ctx.named.limit) || 50))
      return searchSessionMessages(String(ctx.named.query ?? ''), limit)
    }
  },

  // 2. 创建新会话
  {
    name: 'yaya.session-create',
    description: '创建一个新的 YAYA 聊天会话',
    usage:
      'yaya.session-create [--title <title>] [--model <model>] [--provider <providerId>] [--workflow <id>] [--reasoning <effort>]',
    run: async (ctx) => {
      const title = (ctx.named.title as string) || '新会话'
      const model = ctx.named.model as string | undefined
      const providerId = ctx.named.provider as string | undefined
      const workflow = ctx.named.workflow as string | undefined
      const reasoning = ctx.named.reasoning
      const session = createSession({
        id: randomUUID(),
        title,
        model,
        providerId,
        meta: {
          ...(workflow ? { workflow } : {}),
          ...(reasoning !== undefined ? { reasoning: normalizeEffort(reasoning) } : {})
        }
      })
      return session
    }
  },

  // 3. 获取单个会话信息
  {
    name: 'yaya.session-get',
    description: '获取指定会话的详情',
    usage: 'yaya.session-get --id <sessionId>',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      return getSession(id)
    }
  },

  // 4. 删除会话
  {
    name: 'yaya.session-delete',
    description: '删除指定的会话及所有消息树',
    usage: 'yaya.session-delete --id <sessionId>',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      abortWorkflow(id)
      deleteSession(id)
      return { ok: true, id }
    }
  },

  // 5. 获取当前分支的完整消息历史
  {
    name: 'yaya.messages-branch',
    description:
      '获取指定会话当前活跃分支的消息列表。不带 --limit 返回整条分支（数组）；带 --limit 返回 { messages, hasMore }：按用户消息边界取最后 N 轮，--before 取该消息之前的 N 轮（长会话滑动加载）',
    usage:
      'yaya.messages-branch --session <sessionId> [--leaf <leafId>] [--limit <轮数> [--before <messageId>]]',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const session = getSession(sessionId)
      const leafId = (ctx.named.leaf as string) || session?.activeLeafId
      const limit = Number(ctx.named.limit)
      if (Number.isFinite(limit) && limit > 0) {
        if (!session) return { messages: [], hasMore: false }
        const before = ctx.named.before ? String(ctx.named.before) : undefined
        const win = getMessageBranchWindow(leafId, { limit, before })
        return { ...win, messages: overlayLiveBuffer(sessionId, win.messages) }
      }
      if (!session) return []
      return overlayLiveBuffer(sessionId, getMessageBranchWithSiblings(leafId))
    }
  },

  // 6. 获取节点兄弟分支列表（支持 < 1/3 > 翻页）
  {
    name: 'yaya.message-siblings',
    description: '获取指定消息的所有同级分支 ID 列表与当前序号',
    usage: 'yaya.message-siblings --id <messageId>',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      return getMessageSiblings(id)
    }
  },

  // 7. 切换当前会话的活跃叶子节点（切换分支）
  {
    name: 'yaya.session-switch-leaf',
    description:
      '切换到某个消息节点所在的分支（自动沿该节点走到它最近更新的叶子，不会截断后续对话）',
    usage: 'yaya.session-switch-leaf --session <sessionId> --leaf <messageId>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const node = getMessage(String(ctx.named.leaf))
      if (!node || node.sessionId !== sessionId) throw new Error('message not in session')
      const leafId = findLatestLeaf(node.id)
      updateSession(sessionId, { activeLeafId: leafId })
      return { ok: true, sessionId, leafId }
    }
  },

  // 7.1 更新指定会话属性 (标题、模型、Provider 等)
  {
    name: 'yaya.session-update',
    description: '更新指定会话的属性（标题、模型、Provider 等）',
    usage:
      'yaya.session-update --id <sessionId> [--title <title>] [--model <model>] [--provider <providerId>] [--workflow <workflowId>] [--reasoning default|off|low|medium|high]',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      const updates: Partial<Session> = {}
      if (ctx.named.title !== undefined) updates.title = String(ctx.named.title)
      if (ctx.named.model !== undefined) updates.model = String(ctx.named.model)
      if (ctx.named.provider !== undefined) updates.providerId = String(ctx.named.provider)
      if (ctx.named.workflow !== undefined || ctx.named.reasoning !== undefined) {
        const current = getSession(id)
        updates.meta = { ...(current?.meta ?? {}) }
        if (ctx.named.workflow !== undefined) updates.meta.workflow = String(ctx.named.workflow)
        if (ctx.named.reasoning !== undefined)
          updates.meta.reasoning = normalizeEffort(ctx.named.reasoning)
      }
      updateSession(id, updates)
      return { ok: true, id, ...updates }
    }
  },

  // 8. 发送用户消息并触发 Agent Loop 工作流
  {
    name: 'yaya.workflow-start',
    description: '向指定会话发送提示词并启动智能体思考与工具调用循环',
    usage:
      'yaya.workflow-start --session <sessionId> --prompt <text> [--parent <messageId>] [--mentions <插件 id 或 tool:<工具名>，逗号分隔>]',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const prompt = String(ctx.named.prompt ?? '')
      const parentMessageId = ctx.named.parent as string | undefined
      const attachments = ctx.named.attachments as MessageAttachment[] | undefined
      const raw = ctx.named.mentions
      const mentions = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
        .map((x) => String(x).trim())
        .filter(Boolean)
      return startWorkflow(sessionId, prompt, attachments, parentMessageId, mentions)
    }
  },

  {
    name: 'yaya.mention-candidates',
    description:
      '输入框 @ 的候选：全部插件（内置 / MCP / Skill，含全局禁用的）与单个工具，按名字 / 描述过滤',
    usage: 'yaya.mention-candidates [--query <文本>]',
    ui: ['YAYA 输入框输入 @ / 工具栏 @ 按钮'],
    related: ['yaya.workflow-start', 'yaya.session-mentions'],
    run: (ctx) => mentionCandidates(loadYayaConfig(), String(ctx.named.query ?? ''))
  },

  {
    name: 'yaya.session-mentions',
    description:
      '本会话被 @ 点名强制启用的插件 / 工具；--remove <ref> 撤销一项（下一次运行起生效）',
    usage: 'yaya.session-mentions --id <sessionId> [--remove <插件 id 或 tool:<工具名>>]',
    ui: ['YAYA 右上角菜单 → 本对话点名的插件'],
    run: (ctx) => {
      const id = String(ctx.named.id)
      const session = getSession(id)
      if (!session) throw new Error(`Session ${id} not found`)
      let list = sessionMentions(session.meta)
      const remove = ctx.named.remove ? String(ctx.named.remove) : ''
      if (remove) {
        list = list.filter((m) => m.ref !== remove)
        updateSession(id, { meta: { ...(session.meta ?? {}), mentions: list } })
        getBroadcast()('cockpit:yaya-sessions-changed', {})
      }
      return list
    }
  },

  {
    name: 'yaya.workflow-regenerate',
    description: '从指定消息往上找到用户提问，重新生成一个新的回答分支（旧回答保留为兄弟分支）',
    usage: 'yaya.workflow-regenerate --session <sessionId> --message <messageId>',
    run: async (ctx) => regenerateWorkflow(String(ctx.named.session), String(ctx.named.message))
  },

  {
    name: 'yaya.workflows-list',
    description: '列出可选的工作流（智能体 / 纯对话 / 先规划再执行……）',
    usage: 'yaya.workflows-list',
    run: async () => listWorkflowInfo()
  },

  {
    name: 'yaya.message-delete',
    description: '删除一条消息及其后续的整个分支；当前分支被删时切到相邻分支',
    usage: 'yaya.message-delete --session <sessionId> --id <messageId>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const msg = getMessage(String(ctx.named.id))
      if (!msg || msg.sessionId !== sessionId) throw new Error('message not in session')
      abortWorkflow(sessionId)
      return { ok: true, activeLeafId: deleteMessageSubtree(msg.id) }
    }
  },

  {
    name: 'yaya.workflow-running',
    description: '列出当前正在运行工作流的会话 id',
    usage: 'yaya.workflow-running',
    run: async () => runningSessionIds()
  },

  {
    name: 'yaya.tools-list',
    description: '列出智能体可用的工具（含提供方默认审批、用户覆盖、是否被禁用）',
    usage: 'yaya.tools-list',
    run: async () => {
      // 兼容旧设置页：把各插件的工具摊平（name = wire name）
      const cfg = loadYayaConfig()
      return listPluginInfo(cfg).flatMap((p) =>
        p.tools.map((t) => ({
          name: t.wireName,
          description: t.description,
          requiresApproval: t.defaultApproval !== 'auto',
          defaultApproval: t.defaultApproval,
          approval: t.approval,
          source: p.kind === 'builtin' ? 'builtin' : p.kind === 'mcp' ? 'mcp' : 'custom',
          enabled: t.enabled && p.enabled
        }))
      )
    }
  },

  {
    name: 'yaya.plugins-list',
    description: '列出所有插件（内置 / MCP / Skill）及其工具、启用状态、连接状态',
    usage: 'yaya.plugins-list',
    run: async () => listPluginInfo(loadYayaConfig())
  },

  {
    name: 'yaya.plugin-restart',
    description: '重新连接 / 刷新一个插件（MCP 重新拉取工具列表等），返回新的状态',
    usage: 'yaya.plugin-restart --id <pluginId>',
    run: async (ctx) => {
      const status = await restartPlugin(String(ctx.named.id))
      getBroadcast()('cockpit:yaya-plugins-changed', {})
      return status
    }
  },

  {
    // 插件自己的配置（PLAN 6.4）
    name: 'yaya.plugin-config-get',
    description:
      '读取一个插件的配置 schema 与当前值（string / text / number / boolean / select；secret 字段只返回「已设置」，不回传值）。没有配置的插件返回空 schema',
    usage: 'yaya.plugin-config-get --id <pluginId>',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const info = listPluginInfo(loadYayaConfig()).find((p) => p.id === id)
      if (!info) throw new Error(t('yaya.plugin.cmd_err_unknown_plugin', `插件不存在：${id}`))
      return info.config ?? { schema: [], values: {}, secretsSet: [] }
    }
  },

  {
    // 保存插件配置：schema 校验，secret 留空 = 不修改
    name: 'yaya.plugin-config-set',
    logArgs: false, // 入参里可能有 API key 等凭据，不进日志
    description:
      '保存一个插件的配置（按 schema 校验：未知 key / 类型不符会拒绝；secret 字段传空串 = 保留原值）。保存后重建插件表，新配置从下一次工具调用起生效',
    usage: 'yaya.plugin-config-set --id <pluginId> --values <JSON 对象> [--clear <key,key>]',
    ui: ['设置 → 插件 → 插件详情 → 配置 → 保存'],
    privacy: { agent: 'deny' }, // 配置里放的是凭据，只能用户本人改
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const plugin = getPlugin(id)
      if (!plugin) throw new Error(t('yaya.plugin.cmd_err_unknown_plugin', '插件不存在：' + id))
      const checked = validatePluginConfig(plugin, parseJsonObject(ctx.named.values))
      const clear = String(ctx.named.clear ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)

      const next = JSON.parse(JSON.stringify(loadYayaConfig())) as YayaConfig
      const current: Record<string, unknown> = { ...(next.pluginConfig?.[id] ?? {}) }
      for (const key of clear) delete current[key]
      const secretKeys = new Set(pluginSecretKeys(plugin.id))
      for (const [key, value] of Object.entries(checked)) {
        // secret 留空 = 保留原值（checkedConfigValue 已把 secret 的空串归一成 ''）
        if (secretKeys.has(key) && value === '') continue
        current[key] = value
      }
      next.pluginConfig = { ...(next.pluginConfig ?? {}), [id]: current }
      return applyPluginConfigChange(next)
    }
  },

  {
    // 子分组开关（PLAN 6.4）
    name: 'yaya.plugin-group-set',
    description:
      '启用 / 禁用一个插件的子分组（如 Android Controller 的 Shizuku / Termux:API）。关掉后该分组的工具不再提供给助手',
    usage: 'yaya.plugin-group-set --id <pluginId> --group <分组 id> --enabled true|false',
    ui: ['设置 → 插件 → 插件详情 → 分组 → 开关'],
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const groupId = String(ctx.named.group ?? '')
      const enabled = ctx.named.enabled === true || ctx.named.enabled === 'true'
      const plugin = getPlugin(id)
      if (!plugin) throw new Error(t('yaya.plugin.cmd_err_unknown_plugin', '插件不存在：' + id))
      let group: PluginGroup | undefined
      try {
        group = (plugin.groups?.() ?? []).find((g) => g.id === groupId)
      } catch (e) {
        log.warn('plugin groups() failed', { plugin: id, error: String(e) })
      }
      if (!group)
        throw new Error(t('yaya.plugin.cmd_err_unknown_group', `分组不存在：${id}/${groupId}`))

      const next = JSON.parse(JSON.stringify(loadYayaConfig())) as YayaConfig
      const overrides: Record<string, boolean> = { ...(next.pluginGroupEnabled ?? {}) }
      const key = `${id}/${groupId}`
      // 与插件启用开关同一约定：等于分组的 defaultEnabled 时删键（恢复缺省值）
      if (enabled === (group.defaultEnabled ?? true)) delete overrides[key]
      else overrides[key] = enabled
      next.pluginGroupEnabled = overrides
      return applyPluginConfigChange(next)
    }
  },

  {
    name: 'yaya.session-usage',
    description:
      '会话用量统计：token（输入 / 缓存命中 / 输出 / 推理，按模型）、每次调用的上下文大小、工具调用（按工具汇总与明细，带风险等级）',
    usage: 'yaya.session-usage --id <sessionId> [--branch true]',
    ui: ['YAYA 右上角菜单 → 用量统计'],
    run: async (ctx) => {
      const id = String(ctx.named.id)
      const session = getSession(id)
      if (!session) throw new Error(`Session ${id} not found`)
      const activeIds = new Set(getMessageBranch(session.activeLeafId).map((n) => n.id))
      const approval = new Map<string, string>()
      for (const p of listPluginInfo(loadYayaConfig()))
        for (const tool of p.tools) approval.set(tool.wireName, tool.defaultApproval)
      const riskOf = (name: string): ToolRisk => {
        const d = approval.get(name)
        return d === 'ask' ? 'high' : d === 'dynamic' ? 'medium' : d === 'auto' ? 'low' : 'unknown'
      }
      const onlyActive = ctx.named.branch === true || ctx.named.branch === 'true'
      return computeSessionUsage(getSessionMessages(id), activeIds, riskOf, onlyActive)
    }
  },

  // 9. 中止当前运行中的工作流
  {
    name: 'yaya.workflow-abort',
    description: '停止指定会话正在进行的大模型生成或工具调用',
    usage: 'yaya.workflow-abort --session <sessionId>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const ok = abortWorkflow(sessionId)
      return { ok }
    }
  },

  {
    name: 'yaya.workflow-control',
    description: '暂停或继续指定会话正在进行的工作流（停止用 yaya.workflow-abort）',
    usage: 'yaya.workflow-control --session <sessionId> --action <pause|resume>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const action = String(ctx.named.action)
      if (action !== 'pause' && action !== 'resume')
        throw new Error('--action 必须是 pause 或 resume')
      return { ok: controlWorkflow(sessionId, action) }
    }
  },

  // 10. 人类确认工具授权 (Human-in-the-loop)
  {
    name: 'yaya.workflow-approve',
    description: '授权或拒绝当前挂起的工具调用',
    usage:
      'yaya.workflow-approve --session <sessionId> --approved <true|false> [--reason <拒绝理由>] [--scope once|run|session]',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const approved = ctx.named.approved === true || ctx.named.approved === 'true'
      const reason = ctx.named.reason !== undefined ? String(ctx.named.reason) : undefined
      const scope = normalizeScope(ctx.named.scope)
      const ok = approveToolCall(sessionId, approved, reason, scope)
      return { ok }
    }
  },

  {
    name: 'yaya.session-approved-tools',
    description:
      '查看 / 撤销本对话里「都允许」免确认的工具（--remove <wire name> 撤销一个，--clear true 全部撤销）',
    usage: 'yaya.session-approved-tools --id <sessionId> [--remove <tool>] [--clear true]',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      const session = getSession(id)
      if (!session) throw new Error(`Session ${id} not found`)
      let list = Array.isArray(session.meta?.approvedTools)
        ? (session.meta.approvedTools as string[])
        : []
      const clear = ctx.named.clear === true || ctx.named.clear === 'true'
      const remove = ctx.named.remove !== undefined ? String(ctx.named.remove) : null
      if (clear || remove) {
        list = clear ? [] : list.filter((x) => x !== remove)
        updateSession(id, { meta: { ...(session.meta ?? {}), approvedTools: list } })
        getBroadcast()('cockpit:yaya-sessions-changed', {})
      }
      return { ok: true, approvedTools: list }
    }
  },

  // 11. 获取当前工作流快照（断线恢复与状态同步）
  {
    name: 'yaya.workflow-snapshot',
    description: '获取正在执行或等待确认的工作流快照信息',
    usage: 'yaya.workflow-snapshot --session <sessionId>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      return getWorkflowSnapshot(sessionId)
    }
  },

  // 12. 保存多模态文件资产
  {
    name: 'yaya.asset-import',
    description: '把宿主上的文件复制进会话资产目录，返回可作为附件发送的 MessageAttachment',
    usage: 'yaya.asset-import --session <sessionId> --path <file>',
    run: async (ctx) => importAssetFromPath(String(ctx.named.session), String(ctx.named.path))
  },
  {
    name: 'yaya.asset-import-data',
    logArgs: false, // 参数里是大段 base64，不进日志
    description:
      '把 base64 数据（粘贴 / 拖放的图片等）存进会话资产目录，返回可作为附件发送的 MessageAttachment',
    usage:
      'yaya.asset-import-data --session <sessionId> --name <文件名> --mime <type> --data <base64>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session ?? '')
      if (!sessionId) {
        throw new Error(t('yaya.asset.err_no_session', '缺少参数：需要 --session <会话 id>'))
      }
      const base64 = String(ctx.named.data ?? '')
      if (!base64) {
        throw new Error(t('yaya.asset.err_no_data', '缺少参数：需要 --data <base64>'))
      }
      const buf = Buffer.from(base64, 'base64')
      if (!buf.length) {
        throw new Error(t('yaya.asset.err_empty_data', '数据为空，无法作为附件导入'))
      }
      if (buf.length > MAX_ASSET_DATA_BYTES) {
        throw new Error(
          te(
            'yaya.asset.err_too_large',
            {
              size: formatAssetBytes(buf.length),
              max: formatAssetBytes(MAX_ASSET_DATA_BYTES)
            },
            '文件太大（{size}，上限 {max}）'
          )
        )
      }
      const name = sanitizeAssetFilename(String(ctx.named.name ?? ''))
      const mime = normalizeAssetMime(String(ctx.named.mime ?? ''), name)
      return saveAsset(sessionId, name, buf, mime)
    }
  },
  {
    name: 'yaya.asset-preview',
    description: '读取图片附件的 data URL（用于界面缩略图，> 4MB 或非图片返回 null）',
    usage: 'yaya.asset-preview --uri <yaya-asset://…>',
    run: async (ctx) => assetDataUrl(String(ctx.named.uri))
  },
  {
    name: 'yaya.asset-save',
    description: '将 base64 数据存入会话资产目录（--session --name --mimeType --dataBase64）',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const name = String(ctx.named.name)
      const mimeType = String(ctx.named.mimeType || 'application/octet-stream')
      const base64 = String(ctx.named.dataBase64)
      const buf = Buffer.from(base64, 'base64')
      return saveAsset(sessionId, name, buf, mimeType)
    }
  },

  // 13. 获取全局配置
  {
    name: 'yaya.config-get',
    description: '读取 YAYA 全局配置（模型、端点、系统提示词等；密钥只返回 apiKeySet）',
    run: async () => publicYayaConfig(loadYayaConfig())
  },

  // 14. 保存全局配置
  {
    name: 'yaya.config-save',
    logArgs: false,
    description: '保存 YAYA 全局配置',
    run: async (ctx) => {
      const config = ctx.named.config as YayaConfig
      if (!config || !Array.isArray(config.providers)) throw new Error('invalid config')
      saveYayaConfig(mergeIncomingYayaConfig(config))
      refreshPlugins(loadYayaConfig())
      getBroadcast()('cockpit:yaya-plugins-changed', {})
      return { ok: true }
    }
  },

  // 16. 从模型服务端点动态拉取模型列表 (GET /v1/models 或 Ollama /api/tags)
  {
    name: 'yaya.provider-fetch-models',
    description: '探测并动态拉取服务商端点提供的模型列表',
    usage:
      'yaya.provider-fetch-models [--providerId <id>] [--baseUrl <url>] [--apiKey <key>] [--type <type>]',
    run: async (ctx) => {
      const providerId = ctx.named.providerId as string | undefined
      let baseUrl = ctx.named.baseUrl as string | undefined
      let apiKey = ctx.named.apiKey as string | undefined
      let type = ctx.named.type as ProviderType | undefined

      const cfg = loadYayaConfig()
      let targetProvider: ProviderConfig | undefined
      if (providerId) {
        targetProvider = cfg.providers.find((p) => p.id === providerId)
        if (targetProvider) {
          baseUrl = baseUrl || targetProvider.baseUrl
          apiKey = apiKey || targetProvider.apiKey
          type = type || targetProvider.type
        }
      }

      if (!baseUrl) {
        return { ok: false, models: [], error: '缺少 Base URL' }
      }

      const res = await fetchModelsFromEndpoint({ baseUrl, apiKey, type })
      if (res.ok && targetProvider && res.models.length > 0) {
        targetProvider.models = res.models
        saveYayaConfig(cfg)
      }

      return res
    }
  },

  ...ioCommands,
  ...mcpCommands,
  ...skillCommands
]

/**
 * 隐私声明：工作流里的工具能执行 shell / 写文件 → 等同 system.exec；
 * 配置里有密钥、自动审批开关 → 只许用户本人改。
 */
const PRIVACY: Record<string, CommandSpec['privacy']> = {
  'yaya.workflow-start': { requires: [SCOPE_EXEC] },
  'yaya.workflow-regenerate': { requires: [SCOPE_EXEC] },
  'yaya.workflow-approve': { agent: 'deny' },
  'yaya.workflow-control': { agent: 'deny' },
  'yaya.config-save': { agent: 'deny' },
  'yaya.asset-import': { requires: [SCOPE_EXEC] },
  'yaya.provider-fetch-models': { agent: 'deny' },
  'yaya.plugin-restart': { agent: 'deny' }
}
for (const c of commands) {
  if (PRIVACY[c.name] && !c.privacy) c.privacy = PRIVACY[c.name]
}

export default commands
