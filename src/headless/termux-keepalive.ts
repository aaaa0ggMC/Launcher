/**
 * Termux 保活：不少厂商 ROM 会冻结后台的 Termux（安卓原生的「暂停执行已缓存的应用」关了、
 * wake lock 也拿着照样冻），宿主停住，App 连不上直到切回 Termux。
 *
 * - `termux-wake-lock`：防 CPU 深度休眠（`--no-wake-lock` 关闭）
 * - 循环播放静音：厂商冻结普遍放过「正在出声」的进程。`play-audio`（`pkg install play-audio`，
 *   见 scripts/termux-fix.sh）直接在 Termux 进程里经 OpenSL ES 播放，不抢音频焦点，
 *   不会打断其他 App 的播放（`--no-keep-audio` 关闭）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeLogger } from '../main/process/logger'
import { USER_CONFIG_DIR } from '../main/process/paths'

const log = makeLogger('termux')

export function isTermux(): boolean {
  return Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX ?? '').includes('com.termux')
}

function wakeLock(): void {
  try {
    const child = spawn('termux-wake-lock', [], { stdio: 'ignore', detached: true })
    child.on('spawn', () => log.info('termux wake lock requested'))
    child.on('error', (e) => log.warn('termux-wake-lock failed', String(e)))
    child.unref()
  } catch (e) {
    log.warn('termux-wake-lock failed', String(e))
  }
}

/** 60 秒、8kHz 单声道 16 位的全零 WAV（约 1MB） */
function silenceWav(): string {
  const file = join(USER_CONFIG_DIR, 'termux-silence.wav')
  if (existsSync(file)) return file
  const n = 8000 * 60
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // 单声道
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(16000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  mkdirSync(USER_CONFIG_DIR, { recursive: true })
  writeFileSync(file, b)
  return file
}

let player: ChildProcess | null = null
let stopping = false

function loopSilence(file: string): void {
  if (stopping) return
  const started = Date.now()
  const child = spawn('play-audio', [file], { stdio: 'ignore' })
  player = child
  child.on('error', (e: NodeJS.ErrnoException) => {
    player = null
    if (e.code === 'ENOENT')
      log.warn('play-audio not installed: Termux may be frozen in the background', {
        fix: 'pkg install play-audio（或运行 scripts/termux-fix.sh）'
      })
    else log.warn('play-audio failed', String(e))
  })
  child.on('exit', (code) => {
    if (player === child) player = null
    if (stopping) return
    // 立刻失败（设备没有音频输出等）就别疯狂重启
    const quick = Date.now() - started < 5000
    if (quick && code !== 0) {
      log.warn('play-audio exited immediately, keep-alive audio stopped', { code })
      return
    }
    setTimeout(() => loopSilence(file), 200)
  })
}

export function startTermuxKeepAlive(): void {
  if (!isTermux()) return
  if (!process.argv.includes('--no-wake-lock')) wakeLock()
  if (process.argv.includes('--no-keep-audio')) return
  try {
    loopSilence(silenceWav())
    log.info('keep-alive silent audio started (disable with --no-keep-audio)')
  } catch (e) {
    log.warn('keep-alive audio failed', String(e))
  }
  process.on('exit', () => {
    stopping = true
    player?.kill()
  })
}
