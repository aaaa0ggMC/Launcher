#!/usr/bin/env node
/**
 * cockpit-mcp — stdio ↔ Streamable HTTP 桥（docs/agent-access-design.md §6.2）。
 *
 * Linux Cockpit 是单实例桌面应用，MCP 客户端不能直接把它当 stdio server 拉起；
 * 这个小脚本作为 stdio server，把消息原样转发给正在运行的应用的 MCP 端点。
 * 支持 HTTP 的客户端（如 Claude Code）可以直接连 http://127.0.0.1:<port>/mcp，不需要它。
 *
 *   claude mcp add cockpit -- node /path/to/Launcher/scripts/cockpit-mcp.mjs
 *
 * 读取：~/.config/LinuxCockpit/agent/token、config.json 的 agent.mcp.port（缺省 47802）。
 * 环境变量 COCKPIT_MCP_URL / COCKPIT_MCP_TOKEN 可覆盖。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'LinuxCockpit')

function readPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))
    const p = Number(cfg?.agent?.mcp?.port)
    return Number.isInteger(p) && p > 1024 && p < 65536 ? p : 47802
  } catch {
    return 47802
  }
}

function readToken() {
  if (process.env.COCKPIT_MCP_TOKEN) return process.env.COCKPIT_MCP_TOKEN
  try {
    return readFileSync(join(dir, 'agent', 'token'), 'utf-8').trim()
  } catch {
    return ''
  }
}

const url = new URL(process.env.COCKPIT_MCP_URL || `http://127.0.0.1:${readPort()}/mcp`)
const token = readToken()
if (!token) {
  process.stderr.write(
    'cockpit-mcp: 找不到访问令牌（~/.config/LinuxCockpit/agent/token）。请先在 设置 → AI 与远程 开启 MCP。\n'
  )
  process.exit(1)
}

const upstream = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
})
const local = new StdioServerTransport()

const fail = (e) => {
  process.stderr.write(
    `cockpit-mcp: 无法连接 ${url}（Linux Cockpit 未运行或 MCP 未开启？）: ${e?.message ?? e}\n`
  )
}

local.onmessage = (msg) => upstream.send(msg).catch(fail)
upstream.onmessage = (msg) => local.send(msg).catch(fail)
upstream.onerror = fail
local.onclose = () => void upstream.close().finally(() => process.exit(0))
upstream.onclose = () => void local.close().finally(() => process.exit(0))

await upstream.start()
await local.start()
