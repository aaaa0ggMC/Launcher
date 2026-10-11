/**
 * discoverer 主进程服务 —— 配置、本机信息、对端注册表、验证逻辑。
 *
 * 与 UI 的契约全部走命令（commands.ts）：页面轮询 `discoverer.peers` /
 * `discoverer.self`，设置项读写 `discoverer.config-*`；扫描本身是常驻后台
 * 作业 `discoverer.scan`（jobs.ts），可经设置 → 开机服务 登记为开机自启。
 */

import { networkInterfaces } from 'os'
import type { Socket } from 'dgram'
import { abilityConfigPath } from '../../main/process/paths'
import { readOrCreateJson, writeJsonAtomic } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'
import { decryptSecret, encryptSecret } from '../../main/process/encrypt'
import { t } from '../../main/process/i18n'
import {
  ANNOUNCE_HEADER_BYTES,
  ANNOUNCE_TAIL_BYTES,
  FLAVOR_TERMUX,
  FLAVOR_TTY,
  PLATFORM_ANDROID,
  PLATFORM_LINUX,
  PLATFORM_MACOS,
  PLATFORM_UNKNOWN,
  PLATFORM_WINDOWS,
  VERIFY_REPLY,
  VERIFY_REQUEST,
  decodeAnnounce,
  decodeVerify,
  encodeAnnounce,
  encodeVerify,
  randomVerifyPadding,
  verifyFresh,
  type AnnouncePayload,
  type FlavorCode,
  type PlatformCode
} from './packet'
import type { DiscovererConfig, DiscovererPeer, DiscovererSelf } from './types'

const log = makeLogger('discoverer')

/** 默认 UDP 端口（项目已占用 47801 remote / 47802 mcp / 47810 headless） */
export const DEFAULT_PORT = 47820
const DEFAULT_INTERVAL_SEC = 5
const MAX_NAME_CHARS = 32
/** 对端超过这么久没再广播就从列表里消失 */
export const PEER_TTL_MS = 30_000
/** 同一个未验证对端自动重发验证请求的最小间隔 */
const VERIFY_RETRY_MS = 30_000

const DEFAULT_CONFIG: DiscovererConfig = {
  deviceName: '',
  port: DEFAULT_PORT,
  intervalSec: DEFAULT_INTERVAL_SEC,
  verifyPassword: '',
  verifiedPeers: []
}

let cached: DiscovererConfig | null = null
let verifiedNames = new Set<string>()
let saveQueue: Promise<void> = Promise.resolve()
/** 扫描作业是否在跑（jobs.ts 维护） */
let scanActive = false

export function discovererConfigPath(): string {
  return abilityConfigPath('discoverer')
}

/** 归一化一份配置（坏值回落默认，绝不抛）。 */
function normalizeConfig(raw: Partial<DiscovererConfig> | null): DiscovererConfig {
  const port = Number(raw?.port)
  const intervalSec = Number(raw?.intervalSec)
  return {
    deviceName: String(raw?.deviceName ?? '')
      .trim()
      .slice(0, MAX_NAME_CHARS),
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
    intervalSec:
      Number.isInteger(intervalSec) && intervalSec >= 1 && intervalSec <= 60
        ? intervalSec
        : DEFAULT_INTERVAL_SEC,
    verifyPassword: typeof raw?.verifyPassword === 'string' ? raw.verifyPassword : '',
    verifiedPeers: Array.isArray(raw?.verifiedPeers)
      ? [...new Set(raw.verifiedPeers.filter((x): x is string => typeof x === 'string' && !!x))]
      : []
  }
}

/** 读取配置（内存缓存；文件缺失时创建默认配置）。 */
export async function loadDiscovererConfig(): Promise<DiscovererConfig> {
  if (cached) return cached
  const file = await readOrCreateJson<DiscovererConfig>(discovererConfigPath(), () => ({
    ...DEFAULT_CONFIG
  }))
  cached = normalizeConfig(file)
  verifiedNames = new Set(cached.verifiedPeers)
  return cached
}

/** 落盘（串行化，避免并发读改写互相覆盖）。 */
async function persist(next: DiscovererConfig): Promise<void> {
  const task = saveQueue.then(() => writeJsonAtomic(discovererConfigPath(), next))
  saveQueue = task.catch(() => {})
  await task
}

/**
 * 保存配置。`verifyPassword` 传明文（空串 = 清除验证），落盘前经 encrypt.ts
 * 加密；省略该字段则保留原值。
 */
export async function saveDiscovererConfig(
  patch: Partial<Omit<DiscovererConfig, 'verifyPassword'>> & { verifyPassword?: string }
): Promise<DiscovererConfig> {
  const cur = await loadDiscovererConfig()
  const next = normalizeConfig({ ...cur, ...patch })
  if (patch.verifyPassword !== undefined && patch.verifyPassword !== cur.verifyPassword) {
    next.verifyPassword = patch.verifyPassword ? safeEncrypt(patch.verifyPassword) : ''
  }
  await persist(next)
  cached = next
  verifiedNames = new Set(next.verifiedPeers)
  log.info('discoverer config saved', {
    deviceName: next.deviceName,
    port: next.port,
    intervalSec: next.intervalSec,
    verifySet: !!next.verifyPassword
  })
  return next
}

function safeEncrypt(plain: string): string {
  try {
    return encryptSecret(plain)
  } catch (e) {
    log.error('encrypt verify password failed', {
      error: e instanceof Error ? e.message : String(e)
    })
    throw new Error(t('discoverer.err.vault', '密钥库不可用，无法保存验证密码'))
  }
}

/** 验证密码明文（未设置 / 解密失败返回空串）。 */
export function verifyPasswordPlain(): string {
  if (!cached?.verifyPassword) return ''
  return decryptSecret(cached.verifyPassword)
}

/** 给前端的配置视图（密码只回「是否已设置」）。 */
export function publicConfig(cfg: DiscovererConfig): Record<string, unknown> {
  return {
    deviceName: cfg.deviceName,
    port: cfg.port,
    intervalSec: cfg.intervalSec,
    verifyPasswordSet: !!cfg.verifyPassword,
    verifiedPeers: [...cfg.verifiedPeers]
  }
}

/* ------------------------------ 本机信息 ------------------------------ */

/** 跳过回环与虚拟网卡（docker/veth/网桥/tun 等），挑一个像「局域网网卡」的地址。 */
const VIRTUAL_IFACE = /^(lo|docker\d*|veth.*|br-.*|virbr.*|zt.*|tun.*|tap.*|wg.*|kube.*)/i
/** 真实网卡名前缀打分（越高越优先） */
const REAL_IFACE = /^(eth|en|em|wl|wlan|wlp|eno|enp|ens)/i

/** 本机局域网 IPv4 / 全局 IPv6（没有则为空串）。 */
export function localAddresses(): { ipv4: string; ipv6: string } {
  const ifaces = networkInterfaces()
  let bestV4: { addr: string; score: number } | null = null
  let v6 = ''
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue
    const score = REAL_IFACE.test(name) ? 1 : 0
    for (const a of addrs ?? []) {
      if (a.internal) continue
      if (a.family === 'IPv4') {
        if (!bestV4 || score > bestV4.score) bestV4 = { addr: a.address, score }
      } else if (a.family === 'IPv6' && !v6) {
        // 链路本地地址（fe80::）带 zone 才能用，展示与通信都不合适，跳过
        const addr = a.address.split('%')[0]
        if (!addr.startsWith('fe80')) v6 = addr
      }
    }
  }
  return { ipv4: bestV4?.addr ?? '', ipv6: v6 }
}

/** 本机平台 / 桌面环境枚举（报文里 2 个字节，UI 据此选图标）。 */
export function platformInfo(): { platform: PlatformCode; flavor: FlavorCode } {
  const p = process.platform
  // Termux（Android 上的 Linux node）先认出来：设备是手机
  if (process.env.TERMUX_VERSION) return { platform: PLATFORM_ANDROID, flavor: FLAVOR_TERMUX }
  if (p === 'linux') {
    const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase()
    if (desktop.includes('KDE')) return { platform: PLATFORM_LINUX, flavor: 1 }
    if (desktop.includes('GNOME')) return { platform: PLATFORM_LINUX, flavor: 2 }
    if (desktop.includes('XFCE')) return { platform: PLATFORM_LINUX, flavor: 3 }
    if (desktop) return { platform: PLATFORM_LINUX, flavor: 4 }
    return { platform: PLATFORM_LINUX, flavor: FLAVOR_TTY }
  }
  if (p === 'darwin') return { platform: PLATFORM_MACOS, flavor: 8 }
  if (p === 'win32') return { platform: PLATFORM_WINDOWS, flavor: 7 }
  if (p === 'android') return { platform: PLATFORM_ANDROID, flavor: FLAVOR_TERMUX }
  return { platform: PLATFORM_UNKNOWN, flavor: 0 }
}

/** 本机信息（discoverer.self）。 */
export function selfInfo(port: number): DiscovererSelf {
  const addr = localAddresses()
  const { platform, flavor } = platformInfo()
  return {
    name: cached?.deviceName ?? '',
    ipv4: addr.ipv4,
    ipv6: addr.ipv6,
    platform,
    flavor,
    port,
    verifySet: !!cached?.verifyPassword,
    running: scanActive
  }
}

/* ------------------------------ 对端注册表 ------------------------------ */

interface PeerRecord {
  name: string
  ipv4: string
  ipv6: string
  platform: PlatformCode
  flavor: FlavorCode
  lastSeen: number
}

const peers = new Map<string, PeerRecord>()

/** 全部已发现设备（按名字排序；verified 来自配置）。 */
export function getPeers(): DiscovererPeer[] {
  return [...peers.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((p) => ({ ...p, verified: verifiedNames.has(p.name) }))
}

/**
 * 登记一条认识报文。自己发的（同名 / 同 IPv4）直接忽略。
 * 返回是否为「新出现」的对端（调用方据此打日志 / 触发自动验证）。
 */
export function noteAnnounce(
  p: AnnouncePayload,
  from: string
): { name: string; isNew: boolean } | null {
  const myName = cached?.deviceName ?? ''
  if (myName && p.name === myName) return null
  if (p.ipv4 && p.ipv4 === localAddresses().ipv4) return null
  const isNew = !peers.has(p.name)
  peers.set(p.name, {
    name: p.name,
    ipv4: p.ipv4 || from,
    ipv6: p.ipv6,
    platform: p.platform,
    flavor: p.flavor,
    lastSeen: Date.now()
  })
  return { name: p.name, isNew }
}

/** 清掉超久没广播的对端，返回被清掉的名字。 */
export function expirePeers(maxAgeMs: number = PEER_TTL_MS): string[] {
  const now = Date.now()
  const gone: string[] = []
  for (const [name, rec] of peers) {
    if (now - rec.lastSeen > maxAgeMs) {
      peers.delete(name)
      gone.push(name)
    }
  }
  return gone
}

export function clearPeers(): void {
  peers.clear()
}

/* -------------------------------- 验证 -------------------------------- */

const lastVerifyAt = new Map<string, number>()

/** 是否应该给这个未验证对端自动发验证请求（限流）。 */
export function shouldAutoVerify(name: string): boolean {
  if (!verifyPasswordPlain()) return false
  if (verifiedNames.has(name)) return false
  const last = lastVerifyAt.get(name) ?? 0
  if (Date.now() - last < VERIFY_RETRY_MS) return false
  lastVerifyAt.set(name, Date.now())
  return true
}

/** 手动验证也刷新限流表（避免和自动重试叠加）。 */
export function noteManualVerify(name: string): void {
  lastVerifyAt.set(name, Date.now())
}

/** 处理一条收到的 UDP 报文：认识 → 登记；验证 → 标记 + 应答。 */
export function handleDatagram(
  buf: Buffer,
  from: string,
  reply: (payload: Buffer) => void
): {
  kind: 'announce' | 'verify-request' | 'verify-reply'
  name: string
  isNew?: boolean
  /** 本次是否新打上验证标记（UI / 日志只在翻转时提示） */
  newlyVerified?: boolean
} | null {
  const ann = decodeAnnounce(buf)
  if (ann) {
    const res = noteAnnounce(ann, from)
    return res ? { kind: 'announce', name: res.name, isNew: res.isNew } : null
  }
  const password = verifyPasswordPlain()
  if (!password) return null
  const ver = decodeVerify(password, buf)
  if (!ver || !verifyFresh(ver.time)) return null
  const myName = cached?.deviceName ?? ''
  if (myName && ver.name === myName) return null
  const newlyVerified = markVerified(ver.name)
  if (ver.kind === VERIFY_REQUEST) {
    reply(encodeVerify(password, VERIFY_REPLY, myName, Date.now(), randomVerifyPadding()))
    return { kind: 'verify-request', name: ver.name, newlyVerified }
  }
  return { kind: 'verify-reply', name: ver.name, newlyVerified }
}

/** 标记设备已验证（蓝 V）并落盘；已是则什么都不做。 */
export function markVerified(name: string): boolean {
  if (!name || verifiedNames.has(name)) return false
  verifiedNames.add(name)
  const cur = cached ?? { ...DEFAULT_CONFIG }
  const next = normalizeConfig({ ...cur, verifiedPeers: [...cur.verifiedPeers, name] })
  // 先更新内存再落盘：否则同一 tick 内多个对端同时验证会基于过期缓存互相覆盖
  cached = next
  void persist(next)
    .then(() => log.info('peer verified', { name }))
    .catch((e) => log.error('persist verified failed', { name, error: String(e) }))
  return true
}

/** 取消某个设备的验证标记。 */
export async function unverifyPeer(name: string): Promise<DiscovererConfig> {
  const cur = await loadDiscovererConfig()
  return saveDiscovererConfig({ verifiedPeers: cur.verifiedPeers.filter((x) => x !== name) })
}

/* -------------------------------- 发送 -------------------------------- */

/** 构造一条认识报文（配置 + 本机地址 + 平台）。 */
export function buildAnnounce(): Buffer | null {
  const cfg = cached
  if (!cfg?.deviceName) return null
  const addr = localAddresses()
  const { platform, flavor } = platformInfo()
  return encodeAnnounce({
    name: cfg.deviceName,
    ipv4: addr.ipv4,
    ipv6: addr.ipv6,
    platform,
    flavor
  })
}

/** 在已绑定 / 已开广播的 socket 上发一条认识报文。 */
export function sendAnnounce(socket: Socket, port: number): boolean {
  const buf = buildAnnounce()
  if (!buf) return false
  try {
    socket.send(buf, port, '255.255.255.255')
    return true
  } catch (e) {
    log.warn('announce send failed', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** 在已绑定 / 已开广播的 socket 上发一条验证报文。 */
export function sendVerify(socket: Socket, port: number, kind: 1 | 2): boolean {
  const cfg = cached
  const password = verifyPasswordPlain()
  if (!cfg?.deviceName || !password) return false
  const buf = encodeVerify(password, kind, cfg.deviceName, Date.now(), randomVerifyPadding())
  try {
    socket.send(buf, port, '255.255.255.255')
    return true
  } catch (e) {
    log.warn('verify send failed', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** 一次性广播一条认识报文（不依赖扫描作业；「发送一次」按钮用）。 */
export async function announceOnce(port: number): Promise<boolean> {
  const buf = buildAnnounce()
  if (!buf) return false
  return oneShotSend(buf, port, 250)
}

/** 一次性广播一条验证请求（「验证」按钮用；扫描在不在跑都行）。
 *  会短暂监听：对端的「应答」回来后由 handleDatagram 标记已验证。 */
export async function verifyOnce(port: number): Promise<boolean> {
  const cfg = cached
  const password = verifyPasswordPlain()
  if (!cfg?.deviceName || !password) return false
  const buf = encodeVerify(
    password,
    VERIFY_REQUEST,
    cfg.deviceName,
    Date.now(),
    randomVerifyPadding()
  )
  return oneShotSend(buf, port, 1500)
}

/**
 * 起一个临时 socket 广播一份数据。会先尝试绑定协议端口：
 *  - 绑上了（扫描作业没在跑）→ 短暂监听，对端的验证「应答」由 handleDatagram
 *    处理并标记已验证，然后关掉；
 *  - 绑不上（作业正在跑）→ 只负责发，应答由作业自己的 socket 收。
 *
 * 注意：Node 的 dgram 必须 bind 之后才能 setBroadcast（否则 EBADF /
 * EACCES），临时 socket 先绑临时端口再开广播。
 */
async function oneShotSend(buf: Buffer, port: number, listenMs: number): Promise<boolean> {
  const bound = await tryBindPort(port)
  const socket = bound ?? (await bindEphemeral())
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => done(true), listenMs)
    timer.unref()
    function done(ok: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(ok)
    }
    socket.on('error', (e) => {
      log.warn('one-shot send failed', { error: e.message })
      done(false)
    })
    if (bound) {
      socket.on('message', (msg: Buffer, rinfo: { address: string }) => {
        try {
          handleDatagram(msg, rinfo.address, (payload) => {
            try {
              socket.send(payload, port, '255.255.255.255')
            } catch {
              /* closing */
            }
          })
        } catch (e) {
          log.warn('one-shot handle failed', { error: e instanceof Error ? e.message : String(e) })
        }
      })
    }
    try {
      socket.send(buf, port, '255.255.255.255', (e) => {
        // 发送失败立即收尾；成功则（绑了端口的）继续监听到 listenMs 等应答
        if (e) {
          log.warn('one-shot send error', { error: e.message })
          done(false)
        } else if (!bound) {
          done(true)
        }
      })
    } catch (e) {
      log.warn('one-shot send threw', { error: e instanceof Error ? e.message : String(e) })
      done(false)
    }
  })
}

/** 尝试绑定协议端口（仅当没有别的 socket 占着时成功）；失败返回 null。 */
async function tryBindPort(port: number): Promise<Socket | null> {
  const { createSocket } = await import('dgram')
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const onError = (e: Error): void => {
      log.debug('one-shot bind skipped', { port, error: e.message })
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(null)
    }
    socket.once('error', onError)
    socket.bind(port, () => {
      socket.removeListener('error', onError)
      socket.setBroadcast(true)
      resolve(socket)
    })
  })
}

/** 绑一个临时端口并打开广播（只发不收的场景）。 */
async function bindEphemeral(): Promise<Socket> {
  const { createSocket } = await import('dgram')
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, () => {
      socket.removeListener('error', reject)
      socket.setBroadcast(true)
      resolve(socket)
    })
  })
}

/* ------------------------------ 作业状态 ------------------------------ */

export function setScanActive(active: boolean): void {
  scanActive = active
}

export function isScanActive(): boolean {
  return scanActive
}

/** 认识报文的期望长度（校验 / 测试用）。 */
export function announceLength(nameBytes: number): number {
  return ANNOUNCE_HEADER_BYTES + nameBytes + ANNOUNCE_TAIL_BYTES
}
