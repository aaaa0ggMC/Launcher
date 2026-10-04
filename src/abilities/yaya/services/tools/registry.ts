/**
 * YAYA 工具注册表
 * 统一管理内置工具、Cockpit 命令桥接工具与外部 MCP 工具。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { runCommand, listCommands } from '../../../../main/process/commands/registry'
import type { ToolApprovalMode, ToolDefinition, ToolInfo, YayaConfig } from '../../types'

const execAsync = promisify(exec)

const toolMap = new Map<string, ToolDefinition>()

export function registerTool(tool: ToolDefinition): void {
  toolMap.set(tool.name, tool)
}

export function unregisterTool(name: string): void {
  toolMap.delete(name)
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(toolMap.values())
}

/** 按配置过滤掉被禁用的工具 */
export function getEnabledTools(disabled: string[] | undefined): ToolDefinition[] {
  const off = new Set(disabled ?? [])
  return getAllTools().filter((t) => !off.has(t.name))
}

export function listToolInfo(
  disabled: string[] | undefined,
  approval: Record<string, ToolApprovalMode> | undefined
): ToolInfo[] {
  const off = new Set(disabled ?? [])
  return getAllTools().map((t) => {
    const defaultApproval =
      typeof t.requiresApproval === 'function' ? 'dynamic' : t.requiresApproval ? 'ask' : 'auto'
    return {
      name: t.name,
      description: t.description,
      requiresApproval: defaultApproval !== 'auto',
      defaultApproval,
      approval: approval?.[t.name],
      source: t.source ?? 'builtin',
      enabled: !off.has(t.name)
    }
  })
}

/**
 * 本次调用是否需要人工确认。优先级：用户对该工具的显式设置 > 全局「自动允许」> 提供方默认
 * （`requiresApproval` 可以是按参数判断的函数）。
 */
export function toolNeedsApproval(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  config: Pick<YayaConfig, 'toolApproval' | 'autoApproveTools'>
): boolean {
  const override = config.toolApproval?.[tool.name]
  if (override === 'ask') return true
  if (override === 'auto') return false
  if (config.autoApproveTools) return false
  const r = tool.requiresApproval
  return typeof r === 'function' ? r(args) : r === true
}

/** 工具结果回传给模型前的长度上限，避免一次工具输出撑爆上下文 */
export const MAX_TOOL_RESULT_CHARS = 32_000

function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name)
}

// -------------------------------------------------------------
// 注册内置核心工具
// -------------------------------------------------------------

// 1. 获取当前系统与时间
registerTool({
  name: 'get_system_time',
  description: '获取当前系统的精确时间、星期与时区信息。',
  parameters: {
    type: 'object',
    properties: {}
  },
  source: 'builtin',
  handler: async () => {
    const now = new Date()
    return {
      iso: now.toISOString(),
      localeString: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: Date.now()
    }
  }
})

// 2. 桥接执行 Cockpit 任意系统命令
registerTool({
  name: 'cockpit_command',
  description: '调用 Linux System Cockpit 注册的系统命令（如硬件状态、应用管理、服务控制等）。',
  parameters: {
    type: 'object',
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: '命令全名，例如 "hardware.info", "apps.list", "systemd.status"'
      },
      args: {
        type: 'object',
        description: '命令参数对象，键值对'
      }
    }
  },
  source: 'builtin',
  // 有授权要求（system.exec / control 等）或只许用户本人调用的命令，执行前要人工确认
  requiresApproval: (args) => {
    const spec = listCommands().find((c) => c.name === String(args.command))
    return !spec || Boolean(spec.privacy?.requires?.length) || spec.privacy?.agent === 'deny'
  },
  handler: async (args) => {
    const cmd = String(args.command)
    const cmdArgs = (args.args as Record<string, unknown>) || {}
    // 不允许智能体再驱动自己（递归启动工作流 / 改自己的配置）
    if (cmd.startsWith('yaya.'))
      return { ok: false, error: 'yaya.* commands are not available to the agent' }
    try {
      const res = await runCommand(cmd, cmdArgs)
      return { ok: true, data: res }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }
})

// 3. 列出当前 Cockpit 可用命令清单
registerTool({
  name: 'cockpit_list_commands',
  description: '查询当前系统支持的所有可用 Cockpit 命令及其描述。',
  parameters: {
    type: 'object',
    properties: {}
  },
  source: 'builtin',
  handler: async () => {
    const cmds = listCommands().filter((c) => !c.name.startsWith('yaya.'))
    return cmds.map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage
    }))
  }
})

// 4. 读取本地文件
registerTool({
  name: 'read_file',
  description: '读取本机文本文件（可分段：offset + maxLines）；路径是目录时列出目录内容。',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: '绝对路径' },
      offset: { type: 'number', description: '起始行（0 起），默认 0' },
      maxLines: { type: 'number', description: '最多读取行数，默认 400' }
    }
  },
  source: 'builtin',
  handler: async (args) => {
    const filePath = String(args.path)
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` }
    }
    const st = await stat(filePath)
    if (st.isDirectory()) {
      const entries = await readdir(filePath, { withFileTypes: true })
      return {
        directory: filePath,
        entries: entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
        isTruncated: entries.length > 500
      }
    }
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
    const maxLines =
      typeof args.maxLines === 'number' ? Math.max(1, Math.floor(args.maxLines)) : 400
    const content = await readFile(filePath, 'utf8')
    const lines = content.split('\n')
    return {
      totalLines: lines.length,
      offset,
      isTruncated: offset + maxLines < lines.length,
      content: clip(lines.slice(offset, offset + maxLines).join('\n'))
    }
  }
})

// 5. 写入或编辑本地文件 (敏感，需要确认)
registerTool({
  name: 'write_file',
  description: '向指定路径写入文件。这是一个具有修改性的操作。',
  requiresApproval: true,
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: '绝对路径' },
      content: { type: 'string', description: '写入的完整内容' }
    }
  },
  source: 'builtin',
  handler: async (args) => {
    const filePath = String(args.path)
    const content = String(args.content)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
    return { ok: true, path: filePath, bytesWritten: Buffer.byteLength(content) }
  }
})

// 6. 执行 Shell 命令 (敏感，需要确认)
registerTool({
  name: 'run_bash',
  description: '在 Linux 终端执行 Bash 命令，返回标准输出和错误。具有潜在副作用。',
  requiresApproval: true,
  parameters: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'Bash 命令行' },
      cwd: { type: 'string', description: '工作目录' },
      timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000' }
    }
  },
  source: 'builtin',
  handler: async (args, ctx) => {
    const cmd = String(args.command)
    const cwd = args.cwd ? String(args.cwd) : homedir()
    const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        signal: ctx.signal
      })
      return { ok: true, stdout: clip(stdout), stderr: clip(stderr, 8000) }
    } catch (e: unknown) {
      const err = e as { message?: string; stdout?: string; stderr?: string; code?: number }
      return {
        ok: false,
        exitCode: err.code,
        error: err.message || String(e),
        stdout: clip(err.stdout ?? ''),
        stderr: clip(err.stderr ?? '', 8000)
      }
    }
  }
})

// 7. 抓取网页 / HTTP 资源
registerTool({
  name: 'fetch_url',
  description: '以 GET 请求抓取 http(s) URL，返回状态码与正文文本（HTML 会去掉标签，长文本截断）。',
  parameters: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: '完整的 http(s) URL' },
      maxChars: { type: 'number', description: '正文最多返回字符数，默认 20000' }
    }
  },
  source: 'builtin',
  handler: async (args, ctx) => {
    const url = String(args.url)
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs are supported' }
    const maxChars = typeof args.maxChars === 'number' ? Math.max(500, args.maxChars) : 20_000
    const timeout = AbortSignal.timeout(20_000)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
    const res = await fetch(url, { signal, redirect: 'follow' })
    const type = res.headers.get('content-type') ?? ''
    if (!/text|json|xml|javascript/i.test(type)) {
      return { ok: res.ok, status: res.status, contentType: type, note: 'non-text body omitted' }
    }
    let text = await res.text()
    if (/html/i.test(type)) text = htmlToText(text)
    return { ok: res.ok, status: res.status, contentType: type, content: clip(text, maxChars) }
  }
})

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}
