import { BrowserWindow } from 'electron'
import type { CommandSpec } from '../../main/process/commands/types'
import { readJson, writeJsonAtomic } from '../../main/process/util'
import { CONFIG_JSON } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('settings')

async function applyConfigPatch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const cfg = (await readJson<Record<string, unknown>>(CONFIG_JSON)) ?? {}
    const merged = { ...cfg, ...patch }
    log.info('config.set', { patchKeys: Object.keys(patch) })
    await writeJsonAtomic(CONFIG_JSON, merged)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cockpit:config-changed', merged)
    }
    log.info('config.set broadcast', { keys: Object.keys(merged) })
    return merged
  } catch (e) {
    log.error('config.set failed', {
      patchKeys: Object.keys(patch),
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
}

export default [
  {
    name: 'config.get',
    description: '读取全局配置',
    usage: 'config.get',
    run: async () => {
      const cfg = await readJson(CONFIG_JSON)
      log.info('config.get', { keys: cfg ? Object.keys(cfg) : [] })
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
  }
] satisfies CommandSpec[]
