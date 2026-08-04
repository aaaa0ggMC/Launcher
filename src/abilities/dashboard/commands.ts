import { BrowserWindow } from 'electron'
import type { CommandSpec } from '../../main/process/commands/types'
import { getDashboardLayout, setDashboardLayout, resetDashboardLayout } from './ui-state'
import { systemStats } from './system'
import { gpuInfo, readPmValue, togglePm } from './gpu'
import { listDocker, dockerAction } from './docker'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('dashboard')

export default [
  {
    name: 'system.stats',
    description: '系统实时状态 (host/GPU/docker/RAM/disk)',
    usage: 'system.stats',
    run: async () => {
      const result = await systemStats()
      log.info('system.stats', { ok: true })
      return result
    }
  },
  {
    name: 'hardware.gpu',
    description: 'GPU 信息 (nvidia-smi)',
    usage: 'hardware.gpu',
    run: async () => {
      const result = await gpuInfo()
      log.info('hardware.gpu', { ok: true })
      return result
    }
  },
  {
    name: 'hardware.pm',
    description: '读取 NVreg_PreserveVideoMemoryAllocations',
    usage: 'hardware.pm',
    run: async () => {
      const result = await readPmValue()
      log.info('hardware.pm', { ok: true })
      return result
    }
  },
  {
    name: 'hardware.pm-toggle',
    description: '切换 0↔1 (pkexec, 重启生效)',
    usage: 'hardware.pm-toggle',
    run: async () => {
      try {
        const result = await togglePm()
        log.info('hardware.pm-toggle', { ok: true, value: result })
        return result
      } catch (e) {
        log.error('hardware.pm-toggle', {
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        })
        throw e
      }
    }
  },
  {
    name: 'docker.list',
    description: '列出 Docker 容器',
    usage: 'docker.list',
    run: async () => {
      const result = await listDocker()
      log.info('docker.list', { ok: true, count: result.length })
      return result
    }
  },
  {
    name: 'docker.action',
    description: '启动/停止/重启容器 (--name --action)',
    usage: 'docker.action --name new-api --action start',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
      if (!name) {
        log.warn('docker.action', { ok: false, error: 'missing name' })
        return { ok: false, error: '需要 --name' }
      }
      try {
        const result = await dockerAction(name, action)
        log.info('docker.action', { ok: true, name, action })
        return result
      } catch (e) {
        log.error('docker.action', {
          ok: false,
          name,
          action,
          error: e instanceof Error ? e.message : String(e)
        })
        throw e
      }
    }
  },
  {
    name: 'dashboard.get-layout',
    description: '读取总览排版',
    usage: 'dashboard.get-layout',
    run: async () => {
      const result = await getDashboardLayout()
      log.info('dashboard.get-layout', { ok: true })
      return result
    }
  },
  {
    name: 'dashboard.set-layout',
    description: '保存总览排版 (--layout <json>)',
    usage: 'dashboard.set-layout --layout []',
    run: async (ctx) => {
      const layout = ctx.named.layout
      const arr = typeof layout === 'string' ? JSON.parse(layout) : layout
      if (!Array.isArray(arr)) {
        log.warn('dashboard.set-layout', { ok: false, error: 'layout must be array' })
        return { ok: false, error: 'layout 必须是数组' }
      }
      await setDashboardLayout(arr)
      log.info('dashboard.set-layout', { ok: true, count: arr.length })
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
      log.info('dashboard.reset-layout', { ok: true })
      return { ok: true }
    }
  }
] satisfies CommandSpec[]
