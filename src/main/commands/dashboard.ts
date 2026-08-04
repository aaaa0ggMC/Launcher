import { BrowserWindow } from 'electron'
import type { CommandSpec } from './types'
import { getDashboardLayout, setDashboardLayout, resetDashboardLayout } from '../ui-state'

export default [
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
