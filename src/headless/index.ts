/**
 * 无头宿主入口：不依赖 Electron，纯 Node（桌面 / Termux 均可）。
 *
 *   node out/headless/index.js [--host 127.0.0.1] [--port 47810] [--web out/web]
 *
 * 命令注册表、后台任务、日志、能力加载与 Electron 版完全是同一份代码；`electron` 在构建期被 alias
 * 到 ./electron-stub（不支持的窗口 / 对话框 / 全局快捷键等一律 nop）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { USER_CONFIG_DIR } from '../main/process/paths'
import { setBroadcast } from '../main/process/broadcast'
import { setLogBroadcast, log } from '../main/process/logger'
import { setBackgroundBroadcast, shutdownBackgroundTasks } from '../main/process/background-tasks'
import { setWindowBroadcast } from '../main/process/windows'
import { registerAbilityCommands } from '../main/process/abilities-loader'
import { runStartupHooks } from '../main/process/startup'
import { loadExternalAbilities } from '../main/process/ability-loader'
import { pushEvent, startServer } from './server'

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

function loadToken(): string {
  const file = join(USER_CONFIG_DIR, 'headless-token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(USER_CONFIG_DIR, { recursive: true })
  const t = randomBytes(24).toString('hex')
  writeFileSync(file, t, { mode: 0o600 })
  return t
}

async function main(): Promise<void> {
  const host = arg('host', '127.0.0.1')
  const port = Number(arg('port', '47810'))
  const webRoot = resolve(arg('web', join(__dirname, '../web')))
  const token = loadToken()

  setBroadcast(pushEvent)
  setLogBroadcast((entry) => pushEvent('cockpit:log', entry))
  setBackgroundBroadcast((event) => pushEvent('cockpit:bt', event))
  setWindowBroadcast((event) => pushEvent('cockpit:windows', event))

  const { ensureVault } = await import('../main/process/encrypt')
  ensureVault()
  registerAbilityCommands()
  await runStartupHooks()
  loadExternalAbilities().catch((e) => console.error('[cockpit] external abilities:', e))

  await startServer({ host, port, token, webRoot })
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
