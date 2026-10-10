/**
 * discoverer.scan —— 常驻后台作业：周期性向局域网广播认识报文，同时接收
 * 其他 Launcher 的广播与验证报文。
 *
 * 启动途径：
 *  - 页面「开始发现」按钮 → discoverer.start 命令
 *  - 开机自启（设置 → 开机服务）→ boot-services 的 startup hook
 *
 * 协程式：await 即 yield；面板「停止」→ setCancel → abort + 关 socket。
 */

import { createSocket, type Socket } from 'dgram'
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'
import { t } from '../../main/process/i18n'
import { VERIFY_REQUEST } from './packet'
import {
  expirePeers,
  handleDatagram,
  loadDiscovererConfig,
  sendAnnounce,
  sendVerify,
  setScanActive,
  shouldAutoVerify,
  verifyPasswordPlain,
  PEER_TTL_MS
} from './service'

const log = makeLogger('discoverer-scan')

/** 同一进程内只允许一个扫描作业（端口会被第二个实例绑定失败，提前拦下） */
let scanRunning = false

registerJobHandler('discoverer.scan', async (control: JobControl) => {
  const cfg = await loadDiscovererConfig()
  if (!cfg.deviceName) {
    control.pushLine(
      t('discoverer.err.noName', '还没有设置设备名：先到 设置 → 设备发现 里填写，再启动发现'),
      'stderr'
    )
    control.finish('error')
    return
  }
  if (scanRunning) {
    control.pushLine(t('discoverer.err.alreadyRunning', '设备发现已在运行中'), 'stderr')
    control.finish('error')
    return
  }
  scanRunning = true
  setScanActive(true)

  const socket: Socket = createSocket('udp4')
  let stopped = false
  let resolveStopped: () => void = () => {}
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  control.setCancel(() => {
    stopped = true
    try {
      socket.close()
    } catch {
      /* already closed */
    }
    resolveStopped()
  })

  // 绑定端口（接收广播）；失败（端口被占用等）直接结束任务
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(cfg.port, () => {
        socket.setBroadcast(true)
        resolve()
      })
    })
  } catch (e) {
    scanRunning = false
    setScanActive(false)
    control.pushLine(
      `${t('discoverer.err.bind', '绑定 UDP 端口失败')}: ${e instanceof Error ? e.message : String(e)}`,
      'stderr'
    )
    control.finish('error')
    return
  }

  socket.on('message', (msg: Buffer, rinfo: { address: string }) => {
    if (stopped) return
    let res: ReturnType<typeof handleDatagram> = null
    try {
      res = handleDatagram(msg, rinfo.address, (payload) => {
        try {
          socket.send(payload, cfg.port, '255.255.255.255')
        } catch {
          /* socket closing */
        }
      })
    } catch (e) {
      log.warn('handle datagram failed', { error: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!res) return
    if (res.kind === 'announce') {
      if (res.isNew) {
        control.pushLine(`${t('discoverer.log.found', '发现设备')}: ${res.name}`)
        if (shouldAutoVerify(res.name)) {
          sendVerify(socket, cfg.port, VERIFY_REQUEST)
          control.pushLine(`${t('discoverer.log.verifySent', '已发送验证请求')}: ${res.name}`)
        }
      } else if (shouldAutoVerify(res.name)) {
        // 未验证的老对端：按限流节奏补发验证请求
        sendVerify(socket, cfg.port, VERIFY_REQUEST)
        control.pushLine(`${t('discoverer.log.verifySent', '已发送验证请求')}: ${res.name}`)
      }
    } else if (res.newlyVerified) {
      // 只在刚打上标记时提示，避免对端周期性验证报文刷屏
      control.pushLine(`${t('discoverer.log.verified', '已验证')}: ${res.name}`)
    }
  })
  socket.on('error', (e) => {
    if (!stopped) control.pushLine(`[socket] ${e.message}`, 'stderr')
  })

  const password = verifyPasswordPlain()
  control.pushLine(
    `${t('discoverer.log.started', '设备发现已启动')}: ${cfg.deviceName} · UDP ${cfg.port} · ${
      cfg.intervalSec
    }s/${t('discoverer.log.period', '周期')}${password ? ` · ${t('discoverer.log.verifyOn', '验证已开启')}` : ''}`
  )

  const timer = setInterval(() => {
    if (stopped) return
    sendAnnounce(socket, cfg.port)
    const gone = expirePeers(Math.max(PEER_TTL_MS, cfg.intervalSec * 3000))
    for (const name of gone) control.pushLine(`${t('discoverer.log.lost', '设备离线')}: ${name}`)
  }, cfg.intervalSec * 1000)

  // 立即广播一次，不用等第一个周期
  sendAnnounce(socket, cfg.port)

  await stoppedPromise
  clearInterval(timer)
  scanRunning = false
  setScanActive(false)
  control.pushLine(t('discoverer.log.stopped', '设备发现已停止'))
  control.finish('exited')
})
