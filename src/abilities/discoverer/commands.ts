/**
 * discoverer 的主进程命令 + 副作用入口（abilities-loader eager glob 的唯一
 * 加载点）：
 *  - import './jobs'         注册常驻作业 discoverer.scan
 *  - registerBootService(...) 向 Launcher 登记开机自启服务（开关在设置里，默认关）
 */

import { registerBootService } from '../../main/process/boot-services'
import { startJobByName } from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'
import { t } from '../../main/process/i18n'
import type { CommandSpec } from '../../main/process/commands/types'
import {
  announceOnce,
  isScanActive,
  loadDiscovererConfig,
  noteManualVerify,
  publicConfig,
  saveDiscovererConfig,
  selfInfo,
  getPeers,
  unverifyPeer,
  verifyOnce
} from './service'
import { withPrivacy } from './privacy'
import './jobs'

const log = makeLogger('discoverer')

registerBootService({
  id: 'discoverer',
  label: '设备发现',
  labelKey: 'ability.discoverer.name',
  description: '启动 Launcher 时自动在局域网广播 / 监听设备信息',
  descriptionKey: 'discoverer.boot.desc',
  job: 'discoverer.scan',
  // 内容只是局域网里的名字与 IP，丢了无所谓：退出时直接终结，不弹窗
  mustComplete: false
})

export default withPrivacy([
  {
    name: 'discoverer.config-get',
    description: '读取设备发现配置（验证密码只回是否已设置）',
    usage: 'discoverer.config-get',
    ui: ['设置 → 设备发现'],
    run: async () => ({ ok: true, config: publicConfig(await loadDiscovererConfig()) })
  },
  {
    name: 'discoverer.config-save',
    description:
      '保存设备发现配置 (--deviceName --port --intervalSec --verifyPassword [空串=清除] --verifiedPeers)',
    usage:
      'discoverer.config-save --deviceName "我的电脑" --port 47820 --intervalSec 5 --verifyPassword ""',
    ui: ['设置 → 设备发现'],
    related: ['discoverer.config-get'],
    run: async (ctx) => {
      const patch: Record<string, unknown> = {}
      if (typeof ctx.named.deviceName === 'string') {
        const name = ctx.named.deviceName.trim()
        if (!name) return { ok: false, error: t('discoverer.err.noName', '设备名不能为空') }
        patch.deviceName = name
      }
      if (ctx.named.port !== undefined) patch.port = Number(ctx.named.port)
      if (ctx.named.intervalSec !== undefined) patch.intervalSec = Number(ctx.named.intervalSec)
      if (typeof ctx.named.verifyPassword === 'string')
        patch.verifyPassword = ctx.named.verifyPassword
      if (Array.isArray(ctx.named.verifiedPeers)) {
        patch.verifiedPeers = ctx.named.verifiedPeers.map((x) => String(x))
      }
      try {
        const next = await saveDiscovererConfig(patch)
        return { ok: true, config: publicConfig(next) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  },
  {
    name: 'discoverer.self',
    description: '本机信息：设备名、IPv4/IPv6、平台、端口、扫描是否在运行',
    usage: 'discoverer.self',
    ui: ['设备发现页「我的设备」卡片'],
    run: async () => {
      const cfg = await loadDiscovererConfig()
      return { ok: true, self: selfInfo(cfg.port) }
    }
  },
  {
    name: 'discoverer.peers',
    description: '列出已发现的局域网设备（名字 / IP / 平台 / 是否已验证）',
    usage: 'discoverer.peers',
    ui: ['设备发现页设备列表'],
    related: ['discoverer.verify', 'discoverer.unverify'],
    run: async () => {
      await loadDiscovererConfig()
      return { ok: true, peers: getPeers() }
    }
  },
  {
    name: 'discoverer.announce',
    description: '立即向局域网广播一次认识报文（不依赖扫描作业）',
    usage: 'discoverer.announce',
    ui: ['设备发现页「发送一次」按钮'],
    related: ['job:discoverer.scan'],
    run: async () => {
      const cfg = await loadDiscovererConfig()
      if (!cfg.deviceName) {
        return { ok: false, error: t('discoverer.err.noName', '还没有设置设备名') }
      }
      const sent = await announceOnce(cfg.port)
      return sent
        ? { ok: true }
        : { ok: false, error: t('discoverer.err.sendFailed', '广播发送失败') }
    }
  },
  {
    name: 'discoverer.start',
    description: '启动设备发现后台任务（周期性广播 + 监听）',
    usage: 'discoverer.start',
    ui: ['设备发现页「开始发现」按钮'],
    related: ['job:discoverer.scan'],
    run: async () => {
      if (isScanActive())
        return { ok: false, error: t('discoverer.err.alreadyRunning', '设备发现已在运行中') }
      const cfg = await loadDiscovererConfig()
      if (!cfg.deviceName) {
        return { ok: false, error: t('discoverer.err.noName', '还没有设置设备名') }
      }
      const task = await startJobByName('discoverer.scan', {
        name: '设备发现',
        description: t('discoverer.job.desc', '局域网 UDP 广播 / 监听')
      })
      if (!task) return { ok: false, error: t('discoverer.err.startFailed', '启动失败') }
      log.info('discoverer scan started', { task: task.id })
      return { ok: true, task }
    }
  },
  {
    name: 'discoverer.verify',
    description: '向局域网广播验证请求（对端设置了相同共享密码即标记已验证）',
    usage: 'discoverer.verify [--name <设备名>]',
    ui: ['设备发现页设备卡片「验证」按钮'],
    related: ['discoverer.unverify'],
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const cfg = await loadDiscovererConfig()
      if (!cfg.verifyPassword) {
        return { ok: false, error: t('discoverer.err.noPassword', '还没有设置验证共享密码') }
      }
      if (name) noteManualVerify(name)
      const sent = await verifyOnce(cfg.port)
      return sent
        ? { ok: true }
        : { ok: false, error: t('discoverer.err.sendFailed', '验证请求发送失败') }
    }
  },
  {
    name: 'discoverer.unverify',
    description: '取消某个设备的已验证（蓝 V）标记 (--name)',
    usage: 'discoverer.unverify --name "我的手机"',
    ui: ['设备发现页已验证设备卡片「取消验证」按钮'],
    related: ['discoverer.verify'],
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      if (!name) return { ok: false, error: t('discoverer.err.needName', '需要 --name') }
      const next = await unverifyPeer(name)
      return { ok: true, config: publicConfig(next) }
    }
  }
] satisfies CommandSpec[])
