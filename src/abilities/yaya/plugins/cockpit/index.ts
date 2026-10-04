/**
 * 内置 cockpit 插件：把 Cockpit 的 agent 工具表（`src/main/process/agent/tools.ts`）在进程内
 * 交给 YAYA 调用——既包含界面操作（ui_snapshot / ui_click / ui_screenshot…），也包含后端命令
 * （command_run / command_script / commands_list），取代原先 system 插件里的两个桥接工具。
 *
 * 宿主已在外层套好 `withOrigin({ kind: 'local-agent', session: 'yaya:…' })`，所以隐私脱敏、
 * 授权窗口、agent deny 判定都会在 `runAgentTool` 里自动生效，这里不再处理来源。
 * 对应的界面结果视图见同目录 `ui.ts`。
 */
import {
  describeError,
  getActiveAgentTools,
  runAgentTool,
  type AgentTool
} from '../../../../main/process/agent/tools'
import { currentBrowserClient, withBrowserClient } from '../../../../main/process/browser-ui'
import { listCommands } from '../../../../main/process/commands/registry'
import { t } from '../../../../main/process/i18n'
import { clipText } from '../../services/plugins/registry'
import type { ApprovalDefault, PluginTool, YayaPlugin } from '../../services/plugins/types'
import { convertToolOutput, toolParameters } from './convert'

/**
 * YAYA 侧不暴露授权管理工具：隐私 SDK 在需要时会自己弹授权窗口，模型只管重试，
 * 不必（也不会）自己管理 request_clearance / wait_clearance / privacy_scopes。
 */
const EXCLUDED_TOOLS = new Set(['request_clearance', 'wait_clearance', 'privacy_scopes'])

/** 这两个工具跑的是用户自己的批量工作，默认 60s 超时不够 */
const LONG_RUNNING_TOOLS = new Set(['command_run', 'command_script'])
const LONG_TIMEOUT_MS = 300_000

const INSTRUCTIONS = `Linux Cockpit tools (all named cockpit_*): this app's pages and every backend command.

Start with cockpit_commands_list (every backend command: usage, availability, related commands) and cockpit_overview (current page, navigable pages).

UI: call cockpit_ui_snapshot first and act on its [ref=eN] refs — refs are only valid for the latest snapshot, so re-snapshot after the page changes. cockpit_ui_navigate switches pages. Pixel coordinates from cockpit_ui_screenshot go straight to cockpit_ui_click_at / ui_move / ui_drag / ui_scroll.

Backend: cockpit_command_run runs one command; cockpit_command_script runs one async function body (loops, awaits) for multi-step work.

Privacy: «redacted:scope» means hidden, not empty — never work around it; when a step needs clearance the user approves in a window you cannot see.

The user can pause or stop you from the title bar at any time.`

/** `command_run` 的审批：目标命令不存在、需要授权、或只许用户本人调用时要确认 */
function commandRunNeedsApproval(args: Record<string, unknown>): boolean {
  const name = String(args.name ?? '')
  const spec = listCommands().find((c) => c.name === name)
  return !spec || Boolean(spec.privacy?.requires?.length) || spec.privacy?.agent === 'deny'
}

/** 只读工具直接执行；command_run 按目标命令判断；其余（会改界面 / 系统状态）每次确认 */
function approvalOf(agentTool: AgentTool): ApprovalDefault {
  if (agentTool.name === 'command_run') return commandRunNeedsApproval
  return agentTool.readOnly ? 'auto' : 'ask'
}

async function runCockpitTool(
  agentTool: AgentTool,
  args: Record<string, unknown>
): Promise<unknown> {
  // 与旧 system 插件一致：不允许智能体再驱动自己（递归启动工作流 / 改自己的配置），
  // 命令注册表只挡住了声明了 agent:'deny' 的那几个，其余 yaya.* 得在这里挡
  if (agentTool.name === 'command_run' && String(args.name ?? '').startsWith('yaya.')) {
    const info = { error: 'yaya.* commands are not available to the agent' }
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      display: info,
      isError: true
    }
  }
  try {
    const out = await runAgentTool(agentTool, args)
    return convertToolOutput(out, {
      redactedPrefix: t('yaya.plugin.cockpit.redacted', '部分值已脱敏：')
    })
  } catch (e) {
    // 结构化错误（unknown_command / privacy_pending / exclusive_busy…）比抛异常更利于模型处理
    const info = describeError(e)
    return {
      content: [{ type: 'text', text: clipText(JSON.stringify(info, null, 2)) }],
      display: info,
      isError: true
    }
  }
}

function pluginTools(): PluginTool[] {
  return getActiveAgentTools()
    .filter((tool) => !EXCLUDED_TOOLS.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toolParameters(tool.name, tool.shape),
      approval: approvalOf(tool),
      ...(LONG_RUNNING_TOOLS.has(tool.name) ? { timeoutMs: LONG_TIMEOUT_MS } : {}),
      run: (args, ctx) =>
        withBrowserClient(currentBrowserClient(), () => runCockpitTool(tool, args), ctx.signal)
    }))
}

const plugin: YayaPlugin = {
  id: 'cockpit',
  kind: 'builtin',
  label: 'Cockpit',
  labelKey: 'yaya.plugin.cockpit.label',
  description: '操作 Linux Cockpit：调用任意命令、读取 / 操作界面、截图',
  descriptionKey: 'yaya.plugin.cockpit.desc',
  icon: 'mdi-view-dashboard-outline',
  namespace: 'cockpit',
  defaultEnabled: true,
  instructions: () => INSTRUCTIONS,
  tools: () => pluginTools()
}

export default plugin
