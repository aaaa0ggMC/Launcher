import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import type { CommandSpec } from '../../main/process/commands/types'
import { readJson, writeJsonAtomic } from '../../main/process/util'
import { CONFIG_JSON, SIDEBAR_ORDER_JSON } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { registerStartupHook } from '../../main/process/startup'
import { loadUsageStats, recordUsage, clearUsageStats } from '../../main/process/usage-stats'
import {
  setAbilityEnabled,
  getDisabledAbilities,
  listAbilityStates
} from '../../main/process/ability-runtime'
import { getLoadedAbilityIds } from '../../main/process/abilities-loader'

const log = makeLogger('settings')

/** Default global shell config — materialized on first run when config.json
 *  doesn't exist yet, so the file exists for the settings UI + startup reads
 *  (and the ENOENT warn at every launch goes away). Platform-aware terminal:
 *  Windows has no konsole, so a fresh config there must not bake in the Linux
 *  default. */
const DEFAULT_GLOBAL_CONFIG = {
  theme: 'dark',
  language: 'zh',
  uiScale: 1.1,
  animations: {
    modernMotion: true,
    enabled: true,
    pageTransition: 'fade',
    themeTransition: 'corner'
  },
  window: {
    width: 1280,
    height: 800,
    frameless: true,
    rounded: true,
    background: 'transparent',
    backgroundImage: '',
    backgroundOpacity: 1,
    fuseAlpha: 0.85,
    fuseBlur: 28
  },
  runtime: {
    terminal:
      process.platform === 'win32'
        ? ['cmd', '/c', 'start', 'cmd', '/k']
        : ['konsole', '--hold', '-e'],
    confirmBeforeLaunch: true
  },
  sidebar: { default: 'cli', sort: 'alpha' }
} as const

registerStartupHook(async () => {
  if (!existsSync(CONFIG_JSON)) {
    try {
      await writeJsonAtomic(CONFIG_JSON, DEFAULT_GLOBAL_CONFIG)
      log.info('created default config.json')
    } catch (e) {
      log.warn('create config.json failed', { error: String(e) })
    }
  }
})

async function applyConfigPatch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const cfg = (await readJson<Record<string, unknown>>(CONFIG_JSON)) ?? {}
    const merged = { ...cfg, ...patch }
    const changedKeys = Object.keys(patch).filter((k) => cfg[k] !== patch[k])
    await writeJsonAtomic(CONFIG_JSON, merged)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cockpit:config-changed', merged)
    }
    log.info('config.set broadcast', { keys: Object.keys(merged) })
    log.debug('config.set changed', { changedKeys, previousKeys: Object.keys(cfg) })
    return merged
  } catch (e) {
    log.error('config.set failed', {
      patchKeys: Object.keys(patch),
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
}

async function loadSidebarOrder(): Promise<string[]> {
  try {
    const data = await readJson<string[] | { order?: string[] }>(SIDEBAR_ORDER_JSON)
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.order)) return data.order
    return []
  } catch {
    return []
  }
}

async function saveSidebarOrder(order: string[]): Promise<void> {
  await writeJsonAtomic(SIDEBAR_ORDER_JSON, order)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cockpit:sidebar-order-changed', order)
  }
}

export default [
  {
    name: 'config.get',
    description: '读取全局配置',
    usage: 'config.get',
    run: async () => {
      const cfg = await readJson(CONFIG_JSON)
      return cfg
    }
  },
  {
    name: 'config.set',
    description: '更新全局配置 (--patch <json>)',
    usage: 'config.set --patch {"theme":"pureblack"}',
    run: async (ctx) => {
      const patch = ctx.named.patch as Record<string, unknown>
      if (typeof patch === 'string') {
        try {
          return await applyConfigPatch(JSON.parse(patch))
        } catch {
          log.warn('config.set invalid patch', { error: 'patch 不是合法 JSON' })
          return { ok: false, error: 'patch 不是合法 JSON' }
        }
      }
      return await applyConfigPatch(patch ?? {})
    }
  },
  {
    name: 'sidebar.order.get',
    description: '读取侧边栏自定义排序列表 (sidebar-order.json)',
    usage: 'sidebar.order.get',
    run: async () => {
      const order = await loadSidebarOrder()
      return { ok: true, order }
    }
  },
  {
    name: 'sidebar.order.set',
    description: '更新侧边栏自定义排序列表 (--order <json>)',
    usage: 'sidebar.order.set --order \'["apps","aidj"]\'',
    run: async (ctx) => {
      let order = ctx.named.order as unknown
      if (typeof order === 'string') {
        try {
          order = JSON.parse(order)
        } catch {
          return { ok: false, error: 'order 不是合法 JSON 数组' }
        }
      }
      if (!Array.isArray(order)) {
        return { ok: false, error: 'order 必须是数组' }
      }
      const list = order.map(String)
      await saveSidebarOrder(list)
      return { ok: true, order: list }
    }
  },
  {
    name: 'stats.record',
    description: '记录一次使用 (--id)',
    usage: 'stats.record --id apps',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      await recordUsage(id)
      return { ok: true }
    }
  },
  {
    name: 'stats.list',
    description: '读取使用频次统计 (apps.csv)',
    usage: 'stats.list',
    run: async () => {
      const stats = await loadUsageStats()
      return { ok: true, stats }
    }
  },
  {
    name: 'stats.clear',
    description: '清空使用频次统计 (apps.csv)',
    usage: 'stats.clear',
    run: async () => {
      await clearUsageStats()
      return { ok: true }
    }
  },
  {
    name: 'ability.set-enabled',
    description: '运行时启用/禁用指定能力 (--id --enabled)，侧边栏与命令即时生效（不持久化）',
    usage: 'ability.set-enabled --id display --enabled false',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      const enabled = String(ctx.named.enabled ?? '') !== 'false'
      return setAbilityEnabled(id, enabled)
    }
  },
  {
    name: 'ability.list',
    description: '列出已加载能力及其运行时启用状态',
    usage: 'ability.list',
    run: async () => {
      const ids = getLoadedAbilityIds()
      return { ok: true, disabled: getDisabledAbilities(), states: listAbilityStates(ids) }
    }
  }
] satisfies CommandSpec[]
