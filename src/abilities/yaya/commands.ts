/**
 * YAYA 主进程命令注册表
 * CLI-first 架构：UI 与 CLI / Headless 共享同一套 CommandSpec。
 */
import { randomUUID } from 'node:crypto'
import type { CommandSpec } from '../../main/process/commands/types'
import { registerStartupHook } from '../../main/process/startup'
import { SCOPE_EXEC } from '../../main/process/privacy'
import {
  listSessions,
  getSession,
  getMessage,
  createSession,
  deleteSession,
  getMessageBranchWithSiblings,
  getMessageSiblings,
  updateSession,
  findLatestLeaf
} from './services/db'
import {
  startWorkflow,
  regenerateWorkflow,
  abortWorkflow,
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
import { listToolInfo } from './services/tools/registry'
import { ioCommands } from './services/io-commands'
import type { MessageAttachment, YayaConfig, Session, ProviderConfig, ProviderType } from './types'
import { fetchModelsFromEndpoint } from './services/models'
import './jobs'

// 系统启动时恢复异常中断的工作流状态
registerStartupHook(() => {
  reconcileInterruptedWorkflows()
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

  // 2. 创建新会话
  {
    name: 'yaya.session-create',
    description: '创建一个新的 YAYA 聊天会话',
    usage: 'yaya.session-create [--title <title>] [--model <model>] [--provider <providerId>]',
    run: async (ctx) => {
      const title = (ctx.named.title as string) || '新会话'
      const model = ctx.named.model as string | undefined
      const providerId = ctx.named.provider as string | undefined
      const session = createSession({
        id: randomUUID(),
        title,
        model,
        providerId
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
      'yaya.session-update --id <sessionId> [--title <title>] [--model <model>] [--provider <providerId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id)
      const updates: Partial<Session> = {}
      if (ctx.named.title !== undefined) updates.title = String(ctx.named.title)
      if (ctx.named.model !== undefined) updates.model = String(ctx.named.model)
      if (ctx.named.provider !== undefined) updates.providerId = String(ctx.named.provider)
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
    name: 'yaya.workflow-running',
    description: '列出当前正在运行工作流的会话 id',
    usage: 'yaya.workflow-running',
    run: async () => runningSessionIds()
  },

  {
    name: 'yaya.tools-list',
    description: '列出智能体可用的工具（含是否需要确认、是否被禁用）',
    usage: 'yaya.tools-list',
    run: async () => listToolInfo(loadYayaConfig().disabledTools)
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

  // 10. 人类确认工具授权 (Human-in-the-loop)
  {
    name: 'yaya.workflow-approve',
    description: '授权或拒绝当前挂起的工具调用',
    usage: 'yaya.workflow-approve --session <sessionId> --approved <true|false>',
    run: async (ctx) => {
      const sessionId = String(ctx.named.session)
      const approved = ctx.named.approved === true || ctx.named.approved === 'true'
      const ok = approveToolCall(sessionId, approved)
      return { ok }
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
    description: '保存 YAYA 全局配置',
    run: async (ctx) => {
      const config = ctx.named.config as YayaConfig
      if (!config || !Array.isArray(config.providers)) throw new Error('invalid config')
      saveYayaConfig(mergeIncomingYayaConfig(config))
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

  ...ioCommands
]

/**
 * 隐私声明：工作流里的工具能执行 shell / 写文件 → 等同 system.exec；
 * 配置里有密钥、自动审批开关 → 只许用户本人改。
 */
const PRIVACY: Record<string, CommandSpec['privacy']> = {
  'yaya.workflow-start': { requires: [SCOPE_EXEC] },
  'yaya.workflow-regenerate': { requires: [SCOPE_EXEC] },
  'yaya.workflow-approve': { agent: 'deny' },
  'yaya.config-save': { agent: 'deny' },
  'yaya.asset-import': { requires: [SCOPE_EXEC] },
  'yaya.provider-fetch-models': { agent: 'deny' }
}
for (const c of commands) {
  if (PRIVACY[c.name] && !c.privacy) c.privacy = PRIVACY[c.name]
}

export default commands
