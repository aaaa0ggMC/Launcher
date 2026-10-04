/**
 * fetch_url 的地址守卫：本机 / 局域网 / 链路本地地址上跑着 Cockpit 自己的接口（无头宿主、
 * Remote、MCP）和各种不设防的服务（ComfyUI、路由器后台……）。AI 访问它们之前必须经过
 * 隐私授权（与读写文件、运行 Shell 同级的 SCOPE_EXEC）；重定向逐跳检查，防止公网地址
 * 跳转到本机。
 *
 * 已知局限：检查与连接之间重新解析 DNS（DNS rebinding）无法完全排除——要访问的若是恶意
 * 域名，最坏情况等同于一次未授权的本机 GET；Cockpit 自己的接口都要 token。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
}

const V4_PRIVATE: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

/** 是否本机 / 私有 / 链路本地 / 组播 / 保留地址 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const n = v4ToInt(ip)
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) === (v4ToInt(base) & mask)
    })
  }
  if (kind === 6) {
    const a = ip.toLowerCase()
    if (a === '::' || a === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
    if (mapped) return isPrivateAddress(mapped[1])
    const head = parseInt(a.split(':')[0] || '0', 16)
    if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
    if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
    if ((head & 0xff00) === 0xff00) return true // 组播
    return false
  }
  return true // 解析不出的一律按受限处理
}

/** URL 指向的主机是否落在受限地址上（任一解析结果命中即算） */
export async function isPrivateUrl(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host)) return isPrivateAddress(host)
  try {
    const addrs = await lookup(host, { all: true, verbatim: true })
    return addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))
  } catch {
    return false // 解析失败：fetch 自己也会失败
  }
}
