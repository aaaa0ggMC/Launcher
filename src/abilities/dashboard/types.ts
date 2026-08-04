// Dashboard ability domain types — system / hardware / docker stats + grid layout.

/**
 * Dashboard grid layout version. Bumped whenever the grid geometry changes
 * (e.g. cellHeight), so stale saved layouts are discarded and rebuilt from the
 * defaults instead of rendering at the old scale.
 */
export const DASHBOARD_LAYOUT_VERSION = 2

export interface GpuInfo {
  name: string
  driver: string
  vram: string
  vramTotal?: string
  vramUsed?: string
  vramPercent?: number
  usage: string
  temp: string
  fanSpeed?: string
  power?: string
  powerLimit?: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  status: string
  state: string
  ports: string
}

export interface SystemStats {
  hostname: string
  platform: string
  arch: string
  release: string
  uptime: number
  username?: string
  shell?: string
  de?: string
  packages?: { pacman: number; flatpak: number }
  loadAvg?: [number, number, number]
  cpu: {
    model: string
    cores: number
    usage: number
    temp?: number
    freq?: number
  }
  mem: { total: number; used: number; free: number; percent: number }
  swap?: { total: number; used: number; free: number; percent: number }
  disk: { path: string; total: number; used: number; free: number; percent: number }[]
  gpu: GpuInfo[]
  docker: DockerContainer[]
}
