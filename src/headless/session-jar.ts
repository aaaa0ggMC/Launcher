/**
 * 无头模式的 `session.fromPartition()`：只实现 cookie 罐（Electron `session.cookies` 的子集）。
 *
 * 桌面版 balance 等能力在 Electron 的分区会话里登录网页、之后用会话 cookie 直接请求接口。
 * 无头模式没有浏览器窗口——登录改由安卓 App 的原生登录页完成，取回的 cookie 经命令写进这里，
 * 之后能力代码照常 `ses.cookies.get({})` 拼 Cookie 头请求，不用改。
 *
 * 每个分区一个 JSON 文件（~/.config/LinuxCockpit/headless-sessions/<分区>.json，权限 600）。
 * 其余会话能力（webRequest、setUserAgent、隐藏窗口）没有：调用是空操作。
 */
/* eslint-disable @typescript-eslint/no-empty-function -- 无头会话里不支持的成员就是空操作 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface JarCookie {
  name: string
  value: string
  /** 前导点表示包含子域（与 Electron 一致） */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  hostOnly?: boolean
  /** 秒（Unix）；缺省 = 会话 cookie */
  expirationDate?: number
}

export interface CookieFilter {
  url?: string
  name?: string
  domain?: string
  path?: string
}

export interface CookieSetDetails {
  url: string
  name?: string
  value?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

function dirOf(): string {
  return join(
    process.env.COCKPIT_SESSIONS_DIR || join(homedir(), '.config/LinuxCockpit'),
    'headless-sessions'
  )
}

function fileOf(partition: string): string {
  return join(dirOf(), `${partition.replace(/[^\w.-]+/g, '_') || 'default'}.json`)
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  const h = host.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

export class CookieJar {
  private cookies: JarCookie[] | null = null

  constructor(private readonly partition: string) {}

  private load(): JarCookie[] {
    if (this.cookies) return this.cookies
    try {
      const raw = JSON.parse(readFileSync(fileOf(this.partition), 'utf8')) as unknown
      this.cookies = Array.isArray(raw) ? (raw as JarCookie[]) : []
    } catch {
      this.cookies = []
    }
    return this.cookies
  }

  private save(): void {
    const list = this.load()
    const dir = dirOf()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = fileOf(this.partition)
    writeFileSync(file, JSON.stringify(list), { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      /* 某些文件系统不支持 */
    }
  }

  private live(): JarCookie[] {
    const now = Date.now() / 1000
    const list = this.load()
    const alive = list.filter((c) => c.expirationDate === undefined || c.expirationDate > now)
    if (alive.length !== list.length) {
      this.cookies = alive
      this.save()
    }
    return alive
  }

  async get(filter: CookieFilter = {}): Promise<JarCookie[]> {
    let list = this.live()
    if (filter.url) {
      const u = new URL(filter.url)
      list = list.filter(
        (c) =>
          domainMatches(c.domain, u.hostname) &&
          u.pathname.startsWith(c.path || '/') &&
          (!c.secure || u.protocol === 'https:')
      )
    }
    if (filter.name !== undefined) list = list.filter((c) => c.name === filter.name)
    if (filter.domain !== undefined) {
      const d = filter.domain.replace(/^\./, '')
      list = list.filter((c) => domainMatches(c.domain, d) || domainMatches(d, c.domain))
    }
    if (filter.path !== undefined) list = list.filter((c) => c.path === filter.path)
    return list.map((c) => ({ ...c }))
  }

  async set(details: CookieSetDetails): Promise<void> {
    const u = new URL(details.url)
    const name = details.name ?? ''
    const cookie: JarCookie = {
      name,
      value: details.value ?? '',
      domain: details.domain ?? u.hostname,
      path: details.path ?? '/',
      secure: details.secure ?? u.protocol === 'https:',
      httpOnly: details.httpOnly ?? false,
      hostOnly: details.domain === undefined
    }
    if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate
    const list = this.load().filter(
      (c) => !(c.name === name && c.domain === cookie.domain && c.path === cookie.path)
    )
    list.push(cookie)
    this.cookies = list
    this.save()
  }

  async remove(url: string, name: string): Promise<void> {
    const host = new URL(url).hostname
    this.cookies = this.load().filter((c) => !(c.name === name && domainMatches(c.domain, host)))
    this.save()
  }

  async flushStore(): Promise<void> {}

  clear(): void {
    this.cookies = []
    rmSync(fileOf(this.partition), { force: true })
  }

  on(): void {}
  removeListener(): void {}
}

/**
 * 把一条 `document.cookie` 风格的 Cookie 头（`a=1; b=2`，原生 CookieManager.getCookie 的返回）
 * 拆成 cookie 写进罐子：域设成该 URL 的上一级注册域（`.xiaomimimo.com`），一年有效。
 * CookieManager 不给属性（域 / 过期 / HttpOnly），这是能做的最好近似。
 */
export async function importCookieHeader(
  jar: CookieJar,
  url: string,
  header: string
): Promise<number> {
  const host = new URL(url).hostname
  const parts = host.split('.')
  const domain = parts.length > 2 ? `.${parts.slice(-2).join('.')}` : `.${host}`
  const expirationDate = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
  let n = 0
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=')
    if (eq <= 0) continue
    const name = piece.slice(0, eq).trim()
    const value = piece.slice(eq + 1).trim()
    if (!name) continue
    await jar.set({
      url,
      name,
      value,
      domain,
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate
    })
    n++
  }
  return n
}

const sessions = new Map<string, HeadlessSession>()

export class HeadlessSession {
  readonly cookies: CookieJar

  constructor(readonly partition: string) {
    this.cookies = new CookieJar(partition)
  }

  async clearStorageData(): Promise<void> {
    this.cookies.clear()
  }

  async clearCache(): Promise<void> {}
  setUserAgent(): void {}
  getUserAgent(): string {
    return ''
  }
  setProxy(): Promise<void> {
    return Promise.resolve()
  }
  /** 拦截请求头等：无头没有浏览器流量，空操作 */
  readonly webRequest = {
    onBeforeSendHeaders: (): void => {},
    onBeforeRequest: (): void => {},
    onHeadersReceived: (): void => {},
    onCompleted: (): void => {}
  }
  on(): void {}
  once(): void {}
  removeListener(): void {}
}

export function fromPartition(partition: string): HeadlessSession {
  let s = sessions.get(partition)
  if (!s) {
    s = new HeadlessSession(partition)
    sessions.set(partition, s)
  }
  return s
}

/** 测试用 */
export function resetSessions(): void {
  sessions.clear()
}
