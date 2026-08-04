import { BrowserWindow } from 'electron'
import type { CommandSpec } from '../../main/process/commands/types'
import { readJson, writeJsonAtomic } from '../../main/process/util'
import { CONFIG_JSON } from '../../main/process/paths'

async function applyConfigPatch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = (await readJson<Record<string, unknown>>(CONFIG_JSON)) ?? {}
  const merged = { ...cfg, ...patch }
  await writeJsonAtomic(CONFIG_JSON, merged)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cockpit:config-changed', merged)
  }
  return merged
}

export default [
  {
    name: 'config.get',
    description: '读取全局配置',
    usage: 'config.get',
    run: async () => readJson(CONFIG_JSON)
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
          return { ok: false, error: 'patch 不是合法 JSON' }
        }
      }
      return await applyConfigPatch(patch ?? {})
    }
  }
] satisfies CommandSpec[]
