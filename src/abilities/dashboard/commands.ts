import { BrowserWindow } from 'electron'
import type { CommandSpec } from '../../main/process/commands/types'
import { getDashboardLayout, setDashboardLayout, resetDashboardLayout } from './ui-state'
import { systemStats } from './system'
import { gpuInfo, readPmValue, togglePm } from './gpu'
import { listDocker, dockerAction } from './docker'

export default [
  {
    name: 'system.stats',
    description: '系统实时状态 (host/GPU/docker/RAM/disk)',
    usage: 'system.stats',
    run: async () => systemStats()
  },
  {
    name: 'hardware.gpu',
    description: 'GPU 信息 (nvidia-smi)',
    usage: 'hardware.gpu',
    run: async () => gpuInfo()
  },
  {
    name: 'hardware.pm',
    description: '读取 NVreg_PreserveVideoMemoryAllocations',
    usage: 'hardware.pm',
    run: async () => readPmValue()
  },
  {
    name: 'hardware.pm-toggle',
    description: '切换 0↔1 (pkexec, 重启生效)',
    usage: 'hardware.pm-toggle',
    run: async () => togglePm()
  },
  {
    name: 'docker.list',
    description: '列出 Docker 容器',
    usage: 'docker.list',
    run: async () => listDocker()
  },
  {
    name: 'docker.action',
    description: '启动/停止/重启容器 (--name --action)',
    usage: 'docker.action --name new-api --action start',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
      if (!name) return { ok: false, error: '需要 --name' }
      return await dockerAction(name, action)
    }
  },
  {
    name: 'dashboard.get-layout',
    description: '读取总览排版',
    usage: 'dashboard.get-layout',
    run: async () => getDashboardLayout()
  },
  {
    name: 'dashboard.set-layout',
    description: '保存总览排版 (--layout <json>)',
    usage: 'dashboard.set-layout --layout []',
    run: async (ctx) => {
      const layout = ctx.named.layout
      const arr = typeof layout === 'string' ? JSON.parse(layout) : layout
      if (!Array.isArray(arr)) return { ok: false, error: 'layout 必须是数组' }
      await setDashboardLayout(arr)
      return { ok: true }
    }
  },
  {
    name: 'dashboard.reset-layout',
    description: '重置总览排版为默认',
    usage: 'dashboard.reset-layout',
    run: async () => {
      await resetDashboardLayout()
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('cockpit:dashboard-reset')
      }
      return { ok: true }
    }
  }
] satisfies CommandSpec[]
