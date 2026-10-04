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
import { saveAsset, importAssetFromPath, assetDataUrl } from './services/assets'
import {
  listPluginInfo,
  refreshPlugins,
  registerPlugin,
  restartPlugin
} from './services/plugins/registry'
import type { YayaPlugin } from './services/plugins/types'
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
    description: '获取指定会话当前活跃分支的消息列表',
    usage: 'yaya.messages-branch --session <sessionId> [--leaf <leafId>]',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const session = getSession(sessionId)
      if (!session) return []
      const leafId = (ctx.named.leaf as string) || session.activeLeafId
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
    usage: 'yaya.workflow-start --session <sessionId> --prompt <text> [--parent <messageId>]',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const prompt = String(ctx.named.prompt)
      const parentMessageId = ctx.named.parent as string | undefined
      const attachments = ctx.named.attachments as MessageAttachment[] | undefined
      return startWorkflow(sessionId, prompt, attachments, parentMessageId)
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
