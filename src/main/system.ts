import os from 'os'
import type { SystemStats } from '../shared/types'
import { gpuInfo } from './gpu'
import { listDocker } from './docker'
import { run } from './util'

async function cpuUsage(): Promise<{ model: string; cores: number; usage: number }> {
  const first = os.cpus()
  const wait = (): Promise<number> =>
    new Promise((resolve) => setTimeout(resolve, 400))
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
      (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq)
    idleDiff += idle
    totalDiff += total
  }
  const usage = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0
  return {
    model: (first[0]?.model ?? 'unknown').trim(),
    cores: second.length,
    usage
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

export async function systemStats(): Promise<SystemStats> {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  const [cpu, disks, gpu, docker] = await Promise.all([
    cpuUsage(),
    diskStats(),
    gpuInfo(),
    listDocker()
  ])
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    release: os.release(),
    uptime: Math.floor(os.uptime()),
    cpu,
    mem: { total, used, free, percent: Math.round((used / total) * 100) },
    disk: disks,
    gpu,
    docker
  }
}
