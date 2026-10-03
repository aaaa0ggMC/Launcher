import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { copyFile } from 'fs/promises'
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
import {
  describeAbility,
  describeAllAbilities,
  renderAbilityMarkdown
} from '../../main/process/ability-describe'
import { isAgentOrigin, PrivacyDeniedError } from '../../main/process/privacy'
import { reloadPrivacyPolicy } from '../../main/process/privacy-consent'
import { reloadAgentServices } from '../../main/process/agent'
import { rewrapMasterToScrypt, vaultStatus } from '../../main/process/encrypt'

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
  font: { mode: 'default', family: '' },
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
  // `agent.*`（远程 / MCP 开关、隐私策略、永久授权）只能由用户在设置页修改——
  // agent 若能写它，就能给自己授权（docs/agent-access-design.md §5.4）。
  if (isAgentOrigin() && patch && typeof patch === 'object' && 'agent' in patch) {
    throw new PrivacyDeniedError('agent_denied', [], 'agent may not modify agent.* settings')
  }
  try {
    const existed = existsSync(CONFIG_JSON)
    const current = await readJson<Record<string, unknown>>(CONFIG_JSON)
    // 文件存在却读不出来（解析失败 / 瞬时读失败）时绝不能按空配置合并再写回，
    // 否则整份配置会被这次的补丁（如只有 { language }）覆盖。
    if (existed && current === null) {
      throw new Error('config.json 存在但无法读取，为避免覆盖已有配置已中止保存')
    }
    const cfg = current ?? {}
    const merged = { ...cfg, ...patch }
    // 写入前留一份上一版备份，误覆盖时可手动还原。
    if (existed) {
      await copyFile(CONFIG_JSON, `${CONFIG_JSON}.bak`).catch((e) =>
        log.warn('config backup failed', { error: e instanceof Error ? e.message : String(e) })
      )
    }
    const changedKeys = Object.keys(patch).filter((k) => cfg[k] !== patch[k])
    await writeJsonAtomic(CONFIG_JSON, merged)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cockpit:config-changed', merged)
    }
    if ('agent' in patch || 'uiScale' in patch) await reloadPrivacyPolicy()
    if ('agent' in patch) void reloadAgentServices()
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
  },
  {
    name: 'ability.describe',
    description:
      '按能力列出命令（含可用性与原因）、后台作业、UI 入口与帮助文档 —— 由注册表自动生成',
    usage: 'ability.describe --id <ability> [--format json|md]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? ctx.positional[0] ?? '').trim()
      // 不带 id → 全部能力的摘要，方便 agent/CLI 先看有哪些能力。
      if (!id) return { ok: true, abilities: await describeAllAbilities() }
      const described = await describeAbility(id)
      if (!described) return { ok: false, error: `未知能力: ${id}` }
      if (String(ctx.named.format ?? '') === 'md') {
        return { ok: true, markdown: renderAbilityMarkdown(described) }
      }
      return { ok: true, ability: described }
    }
  },
  {
    name: 'vault.status',
    description: '密钥库状态：主密钥的包裹方式（safeStorage / scrypt）、是否就绪',
    privacy: { agent: 'deny' },
    run: () => vaultStatus()
  },
  {
    name: 'vault.rewrap-scrypt',
    description:
      '把主密钥从系统钥匙环（safeStorage）改包成机器指纹派生（scrypt），让无头 / 网页宿主也能解开加密配置。保护强度降低，需在 Electron 里运行；原文件备份为 master.json.bak-*',
    usage: 'vault.rewrap-scrypt',
    privacy: { agent: 'deny' },
    run: () => ({ ...rewrapMasterToScrypt(), status: vaultStatus() })
  }
] satisfies CommandSpec[]
