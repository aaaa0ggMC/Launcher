/**
 * 网页服务（docs/headless-web-plan.md A1）：Electron 宿主内嵌无头版的 HTTP + SSE 服务，
 * 浏览器 / 手机连的是**同一个进程**——状态、后台任务、播放器都只有一份。
 *
 * 配置 `config.json` 的 `web`：`{ enabled, host, port }`（默认关、127.0.0.1:47810），
 * 设置 → 网页服务 修改，改完即时生效（`config.set` 调 `reloadWebHost`）。agent 不能改 `web`。
 * 网页资源是 `pnpm build:web` 产出的 `out/web`（与无头宿主同一份），token 与无头宿主共用。
 *
 * 无头宿主里这里只提供 `web.status`（服务本来就开着，由命令行参数决定）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { net } from 'electron'
import { CONFIG_JSON } from './paths'
import { readJson } from './util'
import { makeLogger } from './logger'
import { registerAll } from './commands/registry'
import type { CommandSpec } from './commands/types'
import { getConsentPresenter } from './privacy'
import { t, te } from './i18n'
import { browserClientCount } from './browser-ui'
import { pushEvent, startServer } from '../../headless/server'
import { initHeadlessConsent } from '../../headless/consent'
import { registerHostCommands } from '../../headless/commands'
import { loadWebToken, otherHost, writeHostLock } from '../../headless/host-lock'

const log = makeLogger('web-host')

const DEFAULT_PORT = 47810
const headless = (): boolean => process.env.COCKPIT_HEADLESS === '1'

export interface WebHostConfig {
  enabled: boolean
  /** 127.0.0.1 = 仅本机；0.0.0.0 = 局域网（明文 HTTP，只在可信网络里开） */
  host: string
  port: number
}

export interface WebHostStatus {
  /** electron = 内嵌在桌面版里；headless = 本进程就是无头宿主 */
  mode: 'electron' | 'headless'
  running: boolean
  enabled: boolean
  host: string
  port: number
  /** 不含 token 的地址 */
  url: string | null
  /** 网页资源是否已构建（out/web） */
  webBuilt: boolean
  clients: number
  error?: string
}

let server: Server | null = null
let current: WebHostConfig = { enabled: false, host: '127.0.0.1', port: DEFAULT_PORT }
let lastError: string | undefined
let reloading: Promise<WebHostStatus> | null = null

const webRoot = (): string => join(__dirname, '../web')

function normalize(raw: unknown): WebHostConfig {
  const w = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const port = Number(w.port)
  return {
    enabled: w.enabled === true,
    host: w.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
  }
}

function displayUrl(host: string, port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`
}

export function webHostStatus(): WebHostStatus {
  if (headless()) {
    const host = process.argv.includes('--host')
      ? process.argv[process.argv.indexOf('--host') + 1]
      : '127.0.0.1'
    const port = process.argv.includes('--port')
      ? Number(process.argv[process.argv.indexOf('--port') + 1])
      : DEFAULT_PORT
    return {
      mode: 'headless',
      running: true,
      enabled: true,
      host,
      port,
      url: displayUrl(host, port),
      webBuilt: true,
      clients: browserClientCount()
    }
  }
  return {
    mode: 'electron',
    running: !!server,
    enabled: current.enabled,
    host: current.host,
    port: current.port,
    url: server ? displayUrl(current.host, current.port) : null,
    webBuilt: existsSync(join(webRoot(), 'index.html')),
    clients: server ? browserClientCount() : 0,
    ...(lastError ? { error: lastError } : {})
  }
}

async function stopServer(): Promise<void> {
  const s = server
  server = null
  if (!s) return
  s.closeAllConnections?.()
  await new Promise<void>((resolve) => s.close(() => resolve()))
  writeHostLock('electron')
  log.info('web host stopped')
}

async function apply(): Promise<WebHostStatus> {
  const cfg = await readJson<Record<string, unknown>>(CONFIG_JSON).catch(() => null)
  const next = normalize(cfg?.web)
  const same = server && next.enabled && next.host === current.host && next.port === current.port
  current = next
  if (same) return webHostStatus()
  await stopServer()
  lastError = undefined
  if (!next.enabled) return webHostStatus()
  if (!existsSync(join(webRoot(), 'index.html'))) {
    lastError = t('web.err_not_built', '网页资源还没构建：先运行 pnpm build:web（或 pnpm build）')
    return webHostStatus()
  }
  const other = otherHost()
  if (other?.kind === 'headless') {
    lastError = te(
      'web.err_headless_running',
      { pid: String(other.pid) },
      '无头宿主正在运行（pid {pid}），先关掉它再开启网页服务'
    )
    return webHostStatus()
  }
  try {
    server = await startServer({
      host: next.host,
      port: next.port,
      token: loadWebToken(),
      webRoot: webRoot(),
      // 自定义协议（图标 / 音频 / 瓦片）：net.fetch 会走 protocol.handle 注册的处理器
      protocolFetch: (_scheme, req) => net.fetch(req)
    })
    server.on('error', (e) => {
      lastError = e instanceof Error ? e.message : String(e)
      log.error('web host error', { error: lastError })
    })
    writeHostLock('electron', { host: next.host, port: next.port })
    log.info('web host started', { host: next.host, port: next.port })
  } catch (e) {
    server = null
    lastError = e instanceof Error ? e.message : String(e)
    log.error('web host failed to start', { error: lastError })
  }
  return webHostStatus()
}

/** 按 config.json 的 `web` 启停 / 重启（并发调用合并成一次） */
export function reloadWebHost(): Promise<WebHostStatus> {
  if (headless()) return Promise.resolve(webHostStatus())
  const run = (reloading ?? Promise.resolve()).then(apply, apply)
  reloading = run.finally(() => {
    if (reloading === run) reloading = null
  }) as Promise<WebHostStatus>
  return run
}

export async function shutdownWebHost(): Promise<void> {
  if (!headless()) await stopServer()
}

const commands: CommandSpec[] = [
  {
    name: 'web.status',
    description:
      '网页服务状态：是否运行、监听地址（不含 token）、网页资源是否已构建、在线浏览器标签页数',
    usage: 'web.status',
    privacy: {},
    run: () => webHostStatus()
  },
  {
    name: 'web.link',
    description: '带 token 的网页访问地址（token 等同于登录凭据，仅用户本人可取）',
    usage: 'web.link',
    privacy: { agent: 'deny' },
    run: () => {
      const st = webHostStatus()
      if (!st.running || !st.url)
        return { ok: false, error: t('web.err_not_running', '网页服务未运行') }
      return { ok: true, url: `${st.url}?token=${loadWebToken()}` }
    }
  },
  {
    name: 'web.restart',
    description: '按当前配置重新启动网页服务',
    usage: 'web.restart',
    privacy: { agent: 'deny' },
    run: () => reloadWebHost()
  }
]

/**
 * 启动时调用（registerAbilityCommands / initPrivacyConsent 之后）。
 * Electron：登记宿主锁、注册网页需要的宿主命令、授权同时推给网页，按配置启动服务。
 */
export async function initWebHost(): Promise<void> {
  registerAll(commands, 'web-host')
  if (headless()) return
  writeHostLock('electron')
  const other = otherHost()
  if (other?.kind === 'headless')
    log.warn('a headless host is running against the same config dir', { pid: other.pid })
  // 网页端「宿主文件选择器」等
  registerHostCommands()
  // 授权：桌面窗口照常弹，同时推给已连接的网页（任一处决定都生效）
  initHeadlessConsent((channel, list) => pushEvent(channel, list), getConsentPresenter())
  await reloadWebHost()
}

/** Electron 的 broadcast 同时推给网页客户端（没有连接时立即返回） */
export { pushEvent as pushWebEvent }
