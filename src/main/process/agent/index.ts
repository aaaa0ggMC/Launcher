/**
 * Agent 访问服务管理：按配置 + 启动参数启停 Remote / MCP（docs/agent-access-design.md §6）。
 * 启动时 `initAgentServices()`；配置变更后 `reloadAgentServices()`；second-instance 转交 argv。
 */
import { makeLogger } from '../logger'
import { getBroadcast } from '../broadcast'
import {
  applyLaunchFlags,
  getAgentToken,
  isEnabledByLaunchFlag,
  loadAgentConfig,
  type AgentTransport
} from './config'
import { McpService } from './mcp'
import { RemoteService } from './remote'
import { disconnectSession, endTransportSessions } from './sessions'
import { initAgentViews } from './views'

const log = makeLogger('agent')

export interface TransportStatus {
  enabled: boolean
  /** config = 设置里开启；flag = 启动参数 / 环境变量开启（本次运行） */
  source: 'config' | 'flag' | null
  running: boolean
  port: number
  url: string | null
  error: string | null
}

type Service = McpService | RemoteService
const services: Partial<Record<AgentTransport, Service>> = {}
const errors: Partial<Record<AgentTransport, string>> = {}
const status: Record<AgentTransport, TransportStatus> = {
  remote: { enabled: false, source: null, running: false, port: 0, url: null, error: null },
  mcp: { enabled: false, source: null, running: false, port: 0, url: null, error: null }
}

let chain: Promise<void> = Promise.resolve()
/** 需要强制重启的传输（token 重新生成后旧 token 立即失效） */
const needsRestart = new Set<AgentTransport>()

/** 串行化启停，避免设置页快速切换时端口竞争。 */
export function reloadAgentServices(): Promise<void> {
  chain = chain.then(apply, apply)
  return chain
}

async function apply(): Promise<void> {
  const cfg = await loadAgentConfig()
  const token = await getAgentToken()
  for (const t of ['remote', 'mcp'] as AgentTransport[]) {
    const flag = isEnabledByLaunchFlag(t)
    const want = cfg[t].enabled || flag
    const port = cfg[t].port
    const cur = services[t]
    // 关闭 / 端口变化 / token 重新生成 → 先停
    if (cur && (!want || cur.port !== port || needsRestart.has(t))) {
      await cur.stop().catch((e) => log.warn('stop failed', { t, error: String(e) }))
      endTransportSessions(t)
      delete services[t]
      log.info(`${t} stopped`)
    }
    needsRestart.delete(t)
    if (want && !services[t]) {
      const svc = t === 'mcp' ? new McpService(port, token) : new RemoteService(port, token)
      try {
        await svc.start()
        services[t] = svc
        delete errors[t]
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors[t] = /EADDRINUSE/.test(msg) ? `端口 ${port} 已被占用` : msg
        log.error(`${t} failed to start`, { port, error: msg })
      }
    }
    const running = !!services[t]
    status[t] = {
      enabled: want,
      source: cfg[t].enabled ? 'config' : flag ? 'flag' : null,
      running,
      port,
      url: running ? `http://127.0.0.1:${port}/${t === 'mcp' ? 'mcp' : 'rpc'}` : null,
      error: want ? (errors[t] ?? null) : null
    }
  }
  getBroadcast()('cockpit:agent-status', getAgentStatus())
}

/** token 重新生成后重启正在运行的服务（旧 token 立即失效）。 */
export function restartForNewToken(): Promise<void> {
  for (const t of Object.keys(services) as AgentTransport[]) needsRestart.add(t)
  return reloadAgentServices()
}

export function getAgentStatus(): Record<AgentTransport, TransportStatus> {
  return { remote: { ...status.remote }, mcp: { ...status.mcp } }
}

export { disconnectSession }

/** 启动时调用（registerIpc 之后）。 */
export async function initAgentServices(argv: string[]): Promise<void> {
  initAgentViews()
  const added = applyLaunchFlags(argv, process.env)
  if (added.length) log.info('enabled by launch flags (this run only)', { transports: added })
  await reloadAgentServices()
}

/** second-instance：`cockpit --with-mcp` 转交给已运行的实例。 */
export function handleSecondInstanceArgv(argv: string[]): void {
  const added = applyLaunchFlags(argv)
  if (added.length) {
    log.info('enabled by second-instance flags', { transports: added })
    void reloadAgentServices()
  }
}
