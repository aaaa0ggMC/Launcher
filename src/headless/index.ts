/**
 * 无头宿主入口：不依赖 Electron，纯 Node（桌面 / Termux 均可）。
 *
 *   node out/headless/index.js [--host 127.0.0.1] [--port 47810] [--web out/web]
 *
 * 命令注册表、后台任务、日志、能力加载与 Electron 版完全是同一份代码；`electron` 在构建期被 alias
 * 到 ./electron-stub（不支持的窗口 / 对话框 / 全局快捷键等一律 nop）。
 */
import { join, resolve } from 'node:path'
import { setBroadcast } from '../main/process/broadcast'
import { setLogBroadcast, log } from '../main/process/logger'
import { setBackgroundBroadcast, shutdownBackgroundTasks } from '../main/process/background-tasks'
import { setWindowBroadcast } from '../main/process/windows'
import { registerAbilityCommands } from '../main/process/abilities-loader'
import { registerIconProtocol } from '../main/process/icon-protocol'
import { registerAudioProtocol } from '../main/process/audio-protocol'
import { runStartupHooks } from '../main/process/startup'
import { loadExternalAbilities } from '../main/process/ability-loader'
import { registerHostCommands } from './commands'
import { pushEvent, startServer } from './server'
import { initHeadlessConsent } from './consent'
import { setStubBroadcast } from './electron-stub'
import { initPrivacyConsent } from '../main/process/privacy-consent'
import { initAgentServices } from '../main/process/agent'
import { initWebHost } from '../main/process/web-host'
import { loadWebToken, otherHost, releaseHostLock, writeHostLock } from './host-lock'

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

async function main(): Promise<void> {
  process.env.COCKPIT_HEADLESS = '1'
  const host = arg('host', '127.0.0.1')
  const port = Number(arg('port', '47810'))
  const webRoot = resolve(arg('web', join(__dirname, '../web')))
  // A2：Electron 宿主在跑时不要再起一个进程抢同一份数据
  const other = otherHost()
  if (other && !process.argv.includes('--force')) {
    const url = other.web
      ? `http://${other.web.host === '0.0.0.0' ? '127.0.0.1' : other.web.host}:${other.web.port}/`
      : null
    console.error(
      `\n  已有 ${other.kind === 'electron' ? 'Electron' : '无头'}宿主在运行（pid ${other.pid}），` +
        '两个进程会互相覆盖配置、各放各的歌。\n' +
        (url
          ? `  它已开启网页服务：${url}（token 同 ~/.config/LinuxCockpit/headless-token）\n`
          : other.kind === 'electron'
            ? '  在 Electron 里打开 设置 → 网页服务 即可用浏览器访问同一个宿主。\n'
            : '') +
        '  确定要同时运行请加 --force。\n'
    )
    process.exit(1)
  }
  const token = loadWebToken()

  setBroadcast(pushEvent)
  setStubBroadcast(pushEvent)
  setLogBroadcast((entry) => pushEvent('cockpit:log', entry))
  setBackgroundBroadcast((event) => pushEvent('cockpit:bt', event))
  setWindowBroadcast((event) => pushEvent('cockpit:windows', event))

  const { ensureVault } = await import('../main/process/encrypt')
  ensureVault()
  // 处理器由替身记下，server.ts 经 /_p/<scheme>/… 路由过去
  registerIconProtocol()
  registerAudioProtocol()
  registerAbilityCommands()
  registerHostCommands()
  // web.status 等（无头宿主里服务本来就开着）
  void initWebHost()
  initPrivacyConsent()
  // 网页里没有授权窗口：待处理请求经 SSE 推给页面的授权悬浮窗
  initHeadlessConsent((channel, list) => pushEvent(channel, list))
  void initAgentServices(process.argv)
  await runStartupHooks()
  loadExternalAbilities().catch((e) => console.error('[cockpit] external abilities:', e))

  await startServer({ host, port, token, webRoot })
  writeHostLock('headless', { host, port })
  process.on('exit', releaseHostLock)
  log.info('headless started', { platform: process.platform, node: process.version })
  console.log(`\n  Cockpit headless → http://${host}:${port}/?token=${token}\n`)

  const stop = (): void => {
    shutdownBackgroundTasks()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error('[cockpit] headless failed:', e)
  process.exit(1)
})
