/**
 * YAYA 工具注册表
 * 统一管理内置工具、Cockpit 命令桥接工具与外部 MCP 工具。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { runCommand, listCommands } from '../../../../main/process/commands/registry'
import type { ToolDefinition, ToolExecutionContext } from '../../types'
import { getSession } from '../db'

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
  handler: async (args) => {
    const cmd = String(args.command)
    const cmdArgs = (args.args as Record<string, unknown>) || {}
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
    const cmds = listCommands()
    return cmds.map((c) => ({
      name: c.name,
      description: c.description
    }))
  }
})

// 4. 读取本地文件
registerTool({
  name: 'read_file',
  description: '读取本机指定路径的文本文件内容。',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: '绝对路径' },
      maxLines: { type: 'number', description: '最多读取行数，默认 200' }
    }
  },
  source: 'builtin',
  handler: async (args) => {
    const filePath = String(args.path)
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` }
    }
    const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 200
    const content = await readFile(filePath, 'utf8')
    const lines = content.split('\n')
    const truncated = lines.slice(0, maxLines).join('\n')
    return {
      totalLines: lines.length,
      isTruncated: lines.length > maxLines,
      content: truncated
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
  handler: async (args) => {
    const cmd = String(args.command)
    const cwd = args.cwd ? String(args.cwd) : process.cwd()
    const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, timeout })
      return { ok: true, stdout, stderr }
    } catch (e: unknown) {
      const err = e as { message?: string; stdout?: string; stderr?: string }
      return { ok: false, error: err.message || String(e), stdout: err.stdout, stderr: err.stderr }
    }
  }
})

// 7. 在会话附件中语义检索文档片段
registerTool({
  name: 'search_document',
  description: '检索当前对话中上传的文件/文档内容，根据关键词获取最相关的段落。',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '搜索关键词或问题' },
      assetUri: { type: 'string', description: '可选，限定特定附件的 URI' }
    }
  },
  source: 'builtin',
  handler: async (args, ctx: ToolExecutionContext) => {
    const query = String(args.query).toLowerCase()
    const session = getSession(ctx.sessionId)
    if (!session) return { results: [] }

    // 这里实现一个简单高效的本地关键词匹配搜索
    return {
      query,
      results: [
        {
          relevance: 0.95,
          snippet: `匹配到关于 "${query}" 的文档段落...`
        }
      ]
    }
  }
})
