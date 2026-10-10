import type { FlavorCode, PlatformCode } from './packet'

/** discoverer 的能力配置（~/.config/LinuxCockpit/discoverer/config.json）。 */
export interface DiscovererConfig {
  /** 本机在局域网里显示的名字（报文字段，≤64 字节 UTF-8） */
  deviceName: string
  /** UDP 广播 / 监听端口（默认 47820） */
  port: number
  /** 广播周期（秒，1–60） */
  intervalSec: number
  /** 验证共享密码（落盘前经 encrypt.ts 加密成 enc:v2:…；空 = 关闭验证） */
  verifyPassword: string
  /** 已验证（蓝 V）的设备名列表 */
  verifiedPeers: string[]
}

/** 一个被发现的局域网设备。 */
export interface DiscovererPeer {
  /** 设备名（同一局域网内作为身份键） */
  name: string
  /** 对方自报的局域网 IPv4；对方没有时回落为报文来源地址 */
  ipv4: string
  /** 对方自报的全局 IPv6（没有则为空） */
  ipv6: string
  /** 平台枚举（UI 选图标用） */
  platform: PlatformCode
  /** 桌面环境 / 会话枚举（UI 显示说明用） */
  flavor: FlavorCode
  /** 最近一次收到广播的时间（epoch ms） */
  lastSeen: number
  /** 是否通过共享密码验证（蓝 V） */
  verified: boolean
}

/** 本机信息（discoverer.self）。 */
export interface DiscovererSelf {
  name: string
  ipv4: string
  ipv6: string
  platform: PlatformCode
  flavor: FlavorCode
  port: number
  /** 是否设置了验证共享密码（UI 据此显示「验证」按钮） */
  verifySet: boolean
  /** 扫描作业是否正在运行 */
  running: boolean
}
