/**
 * Agent 访问（Remote / MCP）的配置、启动参数与 token —— docs/agent-access-design.md §6。
 *
 * - config.json `agent.remote` / `agent.mcp`：`{ enabled, port }`，默认全部关闭；只能由设置页写入
 *   （settings 的 config.set 拒绝 agent 修改 `agent.*`）。
 * - 启动参数 `--with-remote` / `--with-mcp`（或环境变量 `COCKPIT_WITH=remote,mcp`）：
 *   只对本次运行开启，不写盘。已在运行时再次执行带参数的命令 → second-instance 转交 argv。
 * - token：`~/.config/LinuxCockpit/agent/token`（0600），首次需要时生成，可重新生成。
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_JSON, USER_CONFIG_DIR } from '../paths'
import { readJson } from '../util'

export type AgentTransport = 'remote' | 'mcp'

export const DEFAULT_PORTS: Record<AgentTransport, number> = { remote: 47801, mcp: 47802 }

export interface TransportConfig {
  enabled: boolean
  port: number
}

export interface AgentConfig {
  remote: TransportConfig
  mcp: TransportConfig
}

function normalize(raw: unknown, t: AgentTransport): TransportConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const port = Number(r.port)
  return {
    enabled: r.enabled === true,
    port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_PORTS[t]
  }
}

export async function loadAgentConfig(): Promise<AgentConfig> {
  const cfg = await readJson<{ agent?: { remote?: unknown; mcp?: unknown } }>(CONFIG_JSON)
  return { remote: normalize(cfg?.agent?.remote, 'remote'), mcp: normalize(cfg?.agent?.mcp, 'mcp') }
}

/** 本次运行由启动参数 / 环境变量开启的传输（不写盘）。 */
const sessionEnabled = new Set<AgentTransport>()

/** 解析 argv / 环境变量；返回新开启的传输。 */
export function applyLaunchFlags(argv: string[], env: NodeJS.ProcessEnv = {}): AgentTransport[] {
  const added: AgentTransport[] = []
  const want = (t: AgentTransport): void => {
    if (!sessionEnabled.has(t)) {
      sessionEnabled.add(t)
      added.push(t)
    }
  }
  for (const a of argv) {
    if (a === '--with-remote') want('remote')
    else if (a === '--with-mcp') want('mcp')
  }
  for (const t of String(env.COCKPIT_WITH ?? '').split(',')) {
    const x = t.trim()
    if (x === 'remote' || x === 'mcp') want(x)
  }
  return added
}

export function isEnabledByLaunchFlag(t: AgentTransport): boolean {
  return sessionEnabled.has(t)
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export const AGENT_DIR = join(USER_CONFIG_DIR, 'agent')
export const TOKEN_FILE = join(AGENT_DIR, 'token')

let cachedToken: string | null = null

export async function getAgentToken(): Promise<string> {
  if (cachedToken) return cachedToken
  try {
    const t = (await readFile(TOKEN_FILE, 'utf-8')).trim()
    if (t.length >= 32) {
      cachedToken = t
      return t
    }
  } catch {
    /* missing → generate */
  }
  return regenerateAgentToken()
}

export async function regenerateAgentToken(): Promise<string> {
  const t = randomBytes(32).toString('hex')
  await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 })
  await writeFile(TOKEN_FILE, t + '\n', { mode: 0o600 })
  await chmod(TOKEN_FILE, 0o600).catch(() => {})
  cachedToken = t
  return t
}
