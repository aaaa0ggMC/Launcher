/**
 * 宿主锁 + 网页 token（docs/headless-web-plan.md A2）。
 *
 * Electron 与无头宿主是两个进程，同时跑会各自读改写同一份 ~/.config/LinuxCockpit（配置互相覆盖、
 * 播放 / 后台任务各开一份）。启动时在 `host.lock` 里登记自己；无头宿主发现 Electron 宿主在跑时
 * 默认拒绝启动，并提示去开 Electron 的内嵌网页服务（`--force` 才继续）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { USER_CONFIG_DIR } from '../main/process/paths'

export type HostKind = 'electron' | 'headless'

export interface HostLock {
  pid: number
  kind: HostKind
  startedAt: number
  /** 正在提供的网页服务（Electron 内嵌或无头宿主） */
  web?: { host: string; port: number }
}

const lockFile = (): string => join(USER_CONFIG_DIR, 'host.lock')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但不是我们的
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 另一个仍在运行的宿主（不是自己、进程还活着）；没有返回 null */
export function otherHost(): HostLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), 'utf8')) as HostLock
    if (!lock?.pid || lock.pid === process.pid || !alive(lock.pid)) return null
    return lock
  } catch {
    return null
  }
}

/** 登记自己（覆盖已失效的锁）；web 变化时再调一次更新 */
export function writeHostLock(kind: HostKind, web?: HostLock['web']): void {
  try {
    mkdirSync(USER_CONFIG_DIR, { recursive: true })
    const lock: HostLock = {
      pid: process.pid,
      kind,
      startedAt: Date.now(),
      ...(web ? { web } : {})
    }
    writeFileSync(lockFile(), JSON.stringify(lock), { mode: 0o600 })
  } catch {
    /* 锁只是防呆，写不了不影响运行 */
  }
}

/** 退出时释放（只删自己的锁） */
export function releaseHostLock(): void {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), 'utf8')) as HostLock
    if (lock.pid === process.pid) rmSync(lockFile(), { force: true })
  } catch {
    /* ignore */
  }
}

/** 网页访问 token：Electron 内嵌与无头宿主共用同一个文件 */
export function loadWebToken(): string {
  const file = join(USER_CONFIG_DIR, 'headless-token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(USER_CONFIG_DIR, { recursive: true })
  const t = randomBytes(24).toString('hex')
  writeFileSync(file, t, { mode: 0o600 })
  return t
}
