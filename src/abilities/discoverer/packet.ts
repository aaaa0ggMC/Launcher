/**
 * discoverer 的报文编解码 —— 纯函数，不依赖 electron，可单测（packet.test.ts）。
 *
 * 两种报文都走 UDP 广播（255.255.255.255:<port>），只在同一广播域内传播。
 *
 * ── 认识报文（announce，「简单认识」）──────────────────────────────
 *
 *   [16B 随机 AES-128 密钥][4B 名字字节长度 BE][密文]
 *   密文 = AES-128-CTR(密钥, 全零 IV) 加密的：
 *     名字 UTF-8 || IPv4(4B 二进制) || IPv6(16B 二进制) || 平台(1B) || 桌面环境(1B)
 *
 *   - 密钥每次发送都重新随机，因此外界（没有密钥的人）看到的就是一段随机字节；
 *   - CTR 是流式变换，明密文等长 —— 名字长度单独放在头部，其余字段全部定长；
 *   - IP 不用凯撒加密：IPv4 常有大片 0x00（10.0.0.1 → 0a 00 00 01），凯撒的
 *     「每字节 +k」会留下明显规律。同一条 keystream 覆盖 IP 与平台字节，
 *     既定长又无规律（密钥只用一次，全零 IV 不存在复用问题）。
 *
 * ── 验证报文（verify，共享密码）──────────────────────────────────
 *
 *   [AES-256-CTR(sha256(共享密码), 全零 IV) 加密的：
 *     类型(1B: 1=请求 2=应答) || 时间戳(8B BE, ms) || 名字长度(2B BE) || 名字 || 随机填充(0–48B)]
 *
 *   - 不需要「你的设备名」：验证同样走广播，结尾随机长度填充用来混淆报文长度；
 *   - 时间戳只用于防重放（超过 VERIFY_WINDOW_MS 的丢弃），不参与加密运算；
 *   - 类型字节避免请求/应答互相触发形成广播风暴：收到「请求」才回「应答」，
 *     收到「应答」不再回。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** 名字最大字节数（UTF-8；中文约 21 字） */
export const NAME_MAX_BYTES = 64

/** 认识报文的固定开销：16B 密钥 + 4B 长度 + (4B v4 + 16B v6 + 1B 平台 + 1B 桌面) */
export const ANNOUNCE_HEADER_BYTES = 20
export const ANNOUNCE_TAIL_BYTES = 22

/** 平台枚举（UI 图标） */
export type PlatformCode = 0 | 1 | 2 | 3 | 4
export const PLATFORM_UNKNOWN: PlatformCode = 0
export const PLATFORM_LINUX: PlatformCode = 1
export const PLATFORM_MACOS: PlatformCode = 2
export const PLATFORM_WINDOWS: PlatformCode = 3
export const PLATFORM_ANDROID: PlatformCode = 4

/** 桌面环境 / 会话枚举（UI 说明文字） */
export type FlavorCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export const FLAVOR_UNKNOWN: FlavorCode = 0
export const FLAVOR_KDE: FlavorCode = 1
export const FLAVOR_GNOME: FlavorCode = 2
export const FLAVOR_XFCE: FlavorCode = 3
export const FLAVOR_OTHER_DESKTOP: FlavorCode = 4
export const FLAVOR_TTY: FlavorCode = 5
export const FLAVOR_TERMUX: FlavorCode = 6
export const FLAVOR_WINDOWS: FlavorCode = 7
export const FLAVOR_MACOS: FlavorCode = 8

/** 验证报文类型 */
export const VERIFY_REQUEST = 1
export const VERIFY_REPLY = 2

/** 时间戳新鲜度窗口（±2 分钟，容忍局域网内机器的时钟偏差） */
export const VERIFY_WINDOW_MS = 120_000

/** 全零 IV：密钥每次随机 / 由密码派生且只用一次，IV 复用无风险 */
const ZERO_IV = Buffer.alloc(16)

export interface AnnouncePayload {
  name: string
  ipv4: string
  ipv6: string
  platform: PlatformCode
  flavor: FlavorCode
}

export interface VerifyPayload {
  kind: typeof VERIFY_REQUEST | typeof VERIFY_REPLY
  time: number
  name: string
}

/* ------------------------------- IPv4/IPv6 ------------------------------- */

/** 点分十进制 → 4 字节；非法输入返回全零（调用方按「无」处理）。 */
export function ipv4ToBytes(addr: string): Buffer {
  const out = Buffer.alloc(4)
  const parts = addr.split('.')
  if (parts.length !== 4) return out
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return out
    out[i] = n
  }
  return out
}

/** 4 字节 → 点分十进制；全零返回 '0.0.0.0'（调用方按「无」处理）。 */
export function bytesToIpv4(buf: Buffer): string {
  if (buf.length < 4) return '0.0.0.0'
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`
}

/**
 * IPv6 文本 → 16 字节（支持 `::` 压缩与尾部嵌入 IPv4）；非法返回 null。
 * 调用方传入的地址来自 os.networkInterfaces()，可能带 `%zone` 后缀，先剥掉。
 */
export function ipv6ToBytes(addr: string): Buffer | null {
  const text = addr.split('%')[0].trim()
  if (!text) return null
  const head: string[] = []
  const tail: string[] = []
  const sides = text.split('::')
  if (sides.length > 2) return null
  const parseSide = (side: string, into: string[]): boolean => {
    if (!side) return true
    for (const group of side.split(':')) {
      if (group.includes('.')) {
        // 尾部嵌入 IPv4（::ffff:192.168.1.1）→ 两个 16 位组
        const v4 = ipv4ToBytes(group)
        if (v4.equals(Buffer.alloc(4))) return false
        into.push(((v4[0] << 8) | v4[1]).toString(16))
        into.push(((v4[2] << 8) | v4[3]).toString(16))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false
      into.push(group)
    }
    return true
  }
  if (!parseSide(sides[0] ?? '', head)) return null
  if (sides.length === 2 && !parseSide(sides[1] ?? '', tail)) return null
  if (sides.length === 1 && head.length !== 8) return null
  if (sides.length === 2 && head.length + tail.length > 7) return null
  const groups: string[] = [...head]
  if (sides.length === 2) {
    while (groups.length < 8 - tail.length) groups.push('0')
    groups.push(...tail)
  }
  if (groups.length !== 8) return null
  const out = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i], 16), i * 2)
  return out
}

/** 16 字节 → 压缩表示法的 IPv6（`::` 合并最长的全零段，长度 ≥ 2 才压）。
 *  IPv4-mapped（::ffff:a.b.c.d）按点分十进制显示，更好认。 */
export function bytesToIpv6(buf: Buffer): string {
  if (buf.length < 16) return '::'
  const groups: number[] = []
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(i * 2))
  if (groups.every((g) => g === 0)) return '::'
  // ::ffff:0:0/96 → IPv4-mapped，尾部两组按点分十进制显示
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const v4 = buf.subarray(12, 16)
    return `::ffff:${bytesToIpv4(v4)}`
  }
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i
      curLen++
      if (curLen > bestLen) {
        bestLen = curLen
        bestStart = curStart
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':')
  const before = groups.slice(0, bestStart).map((g) => g.toString(16))
  const after = groups.slice(bestStart + bestLen).map((g) => g.toString(16))
  return `${before.join(':')}::${after.join(':')}`
}

/* ------------------------------ 认识报文 ------------------------------ */

/**
 * 编码一条认识报文。名字超长 / IPv6 无法解析时返回 null（调用方应先校验配置）。
 */
export function encodeAnnounce(p: AnnouncePayload): Buffer | null {
  const nameBytes = Buffer.from(p.name, 'utf8')
  if (!nameBytes.length || nameBytes.length > NAME_MAX_BYTES) return null
  const v4 = ipv4ToBytes(p.ipv4 || '0.0.0.0')
  const v6 = p.ipv6 ? ipv6ToBytes(p.ipv6) : Buffer.alloc(16)
  if (p.ipv6 && !v6) return null
  const platform = Math.min(4, Math.max(0, p.platform | 0))
  const flavor = Math.min(8, Math.max(0, p.flavor | 0))
  const plain = Buffer.concat([
    nameBytes,
    v4,
    v6 ?? Buffer.alloc(16),
    Buffer.from([platform, flavor])
  ])
  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ctr', key, ZERO_IV)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(nameBytes.length, 0)
  return Buffer.concat([key, len, ct])
}

/** 解码认识报文；任何字段不合法都返回 null（当作噪声丢弃）。 */
export function decodeAnnounce(buf: Buffer): AnnouncePayload | null {
  if (buf.length < ANNOUNCE_HEADER_BYTES + ANNOUNCE_TAIL_BYTES) return null
  const nameLen = buf.readUInt32BE(16)
  if (!nameLen || nameLen > NAME_MAX_BYTES) return null
  const total = ANNOUNCE_HEADER_BYTES + nameLen + ANNOUNCE_TAIL_BYTES
  if (buf.length < total) return null
  const key = buf.subarray(0, 16)
  const ct = buf.subarray(
    ANNOUNCE_HEADER_BYTES,
    ANNOUNCE_HEADER_BYTES + nameLen + ANNOUNCE_TAIL_BYTES
  )
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-128-ctr', key, ZERO_IV)
    plain = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    return null
  }
  const name = plain.subarray(0, nameLen).toString('utf8')
  if (!name) return null
  const ipv4 = bytesToIpv4(plain.subarray(nameLen, nameLen + 4))
  const ipv6 = bytesToIpv6(plain.subarray(nameLen + 4, nameLen + 20))
  const platform = (plain[nameLen + 20] ?? 0) as PlatformCode
  const flavor = (plain[nameLen + 21] ?? 0) as FlavorCode
  return {
    name,
    ipv4: ipv4 === '0.0.0.0' ? '' : ipv4,
    ipv6: ipv6 === '::' ? '' : ipv6,
    platform: platform > 4 ? PLATFORM_UNKNOWN : platform,
    flavor: flavor > 8 ? FLAVOR_UNKNOWN : flavor
  }
}

/* ------------------------------ 验证报文 ------------------------------ */

/** 共享密码 → AES-256 密钥（sha256；威胁模型是「局域网内不可读」，不是抗离线爆破）。 */
function verifyKey(password: string): Buffer {
  return createHash('sha256').update(password, 'utf8').digest()
}

/**
 * 编码一条验证报文。`padding` 由调用方传入随机字节（0–48B），用于混淆长度。
 */
export function encodeVerify(
  password: string,
  kind: typeof VERIFY_REQUEST | typeof VERIFY_REPLY,
  name: string,
  time: number,
  padding: Buffer
): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(11)
  head.writeUInt8(kind, 0)
  head.writeBigUInt64BE(BigInt(Math.trunc(time)), 1)
  head.writeUInt16BE(Math.min(NAME_MAX_BYTES, nameBytes.length), 9)
  const plain = Buffer.concat([head, nameBytes, padding])
  const cipher = createCipheriv('aes-256-ctr', verifyKey(password), ZERO_IV)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/** 解码验证报文；密码不符 / 结构非法返回 null。不检查时间戳新鲜度（调用方判断）。 */
export function decodeVerify(password: string, buf: Buffer): VerifyPayload | null {
  if (buf.length < 11) return null
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-ctr', verifyKey(password), ZERO_IV)
    plain = Buffer.concat([decipher.update(buf), decipher.final()])
  } catch {
    return null
  }
  if (plain.length < 11) return null
  const kind = plain.readUInt8(0)
  if (kind !== VERIFY_REQUEST && kind !== VERIFY_REPLY) return null
  const time = Number(plain.readBigUInt64BE(1))
  const nameLen = plain.readUInt16BE(9)
  if (nameLen > NAME_MAX_BYTES || plain.length < 11 + nameLen) return null
  const name = plain.subarray(11, 11 + nameLen).toString('utf8')
  if (!name) return null
  return { kind, time, name }
}

/** 时间戳是否在允许窗口内（容忍时钟偏差，超出视为重放/噪声）。 */
export function verifyFresh(time: number, now: number = Date.now()): boolean {
  return Math.abs(now - time) <= VERIFY_WINDOW_MS
}

/** 验证报文用的随机填充（0–48 字节，长度不定以混淆报文长度）。 */
export function randomVerifyPadding(): Buffer {
  return randomBytes(Math.floor(Math.random() * 49))
}
