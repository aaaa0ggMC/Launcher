import os from 'os'
import { readFile } from 'fs/promises'
import type { SystemStats } from './types'
import { gpuInfo } from './gpu'
import { listDocker } from './docker'
import { run } from '../../main/process/util'

async function cpuUsage(): Promise<{
  model: string
  cores: number
  usage: number
  temp?: number
  freq?: number
}> {
  const first = os.cpus()
  const wait = (): Promise<number> => new Promise((resolve) => setTimeout(resolve, 400))
  await wait()
  const second = os.cpus()
  let idleDiff = 0
  let totalDiff = 0
  for (let i = 0; i < second.length; i++) {
    const a = first[i]?.times
    const b = second[i]?.times
    if (!a || !b) continue
    const idle = b.idle - a.idle
    const total =
      b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq)
    idleDiff += idle
    totalDiff += total
  }
  const usage = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0

  // CPU temperature — try thermal zones (works on most Linux setups without lm_sensors).
  let temp: number | undefined
  for (let i = 0; i < 4; i++) {
    const raw = await readFile(`/sys/class/thermal/thermal_zone${i}/temp`, 'utf-8').catch(() => '')
    if (raw) {
      const t = Math.round(Number(raw.trim()) / 1000)
      if (t > 0 && t < 150) {
        temp = t
        break
      }
    }
  }

  // CPU frequency — os.cpus()[0].speed returns MHz in Node.js.
  const freq = second[0]?.speed || undefined

  return {
    model: (first[0]?.model ?? 'unknown').trim(),
    cores: second.length,
    usage,
    temp,
    freq
  }
}

async function diskStats(): Promise<SystemStats['disk']> {
  const out = await run('df', ['-kP']).catch(() => '')
  const disks: SystemStats['disk'] = []
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    if (!cols[0].startsWith('/dev/')) continue
    const total = parseInt(cols[1]) * 1024
    const used = parseInt(cols[2]) * 1024
    const free = parseInt(cols[3]) * 1024
    if (!total) continue
    disks.push({
      path: cols[5],
      total,
      used,
      free,
      percent: Math.round((used / total) * 100)
    })
  }
  return disks
}

/** Parse /proc/meminfo for swap stats. */
async function swapStats(): Promise<SystemStats['swap'] | undefined> {
  const raw = await readFile('/proc/meminfo', 'utf-8').catch(() => '')
  if (!raw) return undefined
  const get = (key: string): number => {
    const m = raw.match(new RegExp(`${key}:\\s+(\\d+)`))
    return m ? parseInt(m[1]) * 1024 : 0
  }
  const total = get('SwapTotal')
  const free = get('SwapFree')
  if (!total) return undefined
  const used = total - free
  return { total, used, free, percent: Math.round((used / total) * 100) }
}

/** Package counts with 60s cache — pacman -Q is fast but flatpak list can lag. */
let pkgCache: { data: { pacman: number; flatpak: number }; ts: number } | null = null
const PKG_TTL = 60_000

async function packageCounts(): Promise<{ pacman: number; flatpak: number }> {
  if (pkgCache && Date.now() - pkgCache.ts < PKG_TTL) return pkgCache.data
  const [pacmanOut, flatpakOut] = await Promise.all([
    run('pacman', ['-Qq']).catch(() => ''),
    run('flatpak', ['list', '--columns=ref']).catch(() => '')
  ])
  const pacman = pacmanOut ? pacmanOut.trim().split('\n').filter(Boolean).length : 0
  // Match fastfetch: count unique ref names (first component before /), which
  // deduplicates runtimes installed under multiple branches (e.g. 25.08 + extra).
  const flatpakRefs = new Set(
    flatpakOut
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('/')[0])
  )
  const flatpak = flatpakRefs.size
  const data = { pacman, flatpak }
  pkgCache = { data, ts: Date.now() }
  return data
}

/** Detect desktop environment from env vars. */
function detectDE(): string | undefined {
  const xdg = process.env.XDG_CURRENT_DESKTOP
  const session = process.env.XDG_SESSION_DESKTOP
  return xdg || session || undefined
}

export async function systemStats(): Promise<SystemStats> {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  const [cpu, disks, gpu, docker, swap, packages] = await Promise.all([
    cpuUsage(),
    diskStats(),
    gpuInfo(),
    listDocker(),
    swapStats(),
    packageCounts()
  ])
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    release: os.release(),
    uptime: Math.floor(os.uptime()),
    username: os.userInfo().username,
    shell: process.env.SHELL || os.userInfo().shell || undefined,
    de: detectDE(),
    packages,
    loadAvg: os.loadavg() as [number, number, number],
    cpu,
    mem: { total, used, free, percent: Math.round((used / total) * 100) },
    swap,
    disk: disks,
    gpu,
    docker
  }
}
