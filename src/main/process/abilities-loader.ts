import type { CommandSpec } from './commands/types'
import { registerAll, listCommands } from './commands/registry'

/**
 * Built-in ability command loader.
 *
 * Every ability owns its commands in `src/abilities/<id>/commands.ts` (a
 * `CommandSpec[]` default export). This loader globs those files at build time
 * and registers them into the central command registry — so adding/removing an
 * ability is a pure folder operation, no central switchboard to edit.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

/** Register every built-in ability's commands. Call once at startup. */
export function registerAbilityCommands(): void {
  const loaded: string[] = []
  for (const key of Object.keys(commandModules).sort()) {
    const mod = commandModules[key]
    const specs = mod?.default
    if (!Array.isArray(specs)) {
      console.warn(`[cockpit] ${key}: 缺少 default CommandSpec[] 导出，跳过`)
      continue
    }
    try {
      registerAll(specs)
      loaded.push(key)
    } catch (e) {
      console.error(`[cockpit] 注册 ${key} 失败:`, e)
    }
  }
  console.log(`[cockpit] 已注册 ${listCommands().length} 个命令 (${loaded.length} 个能力)`)
}
