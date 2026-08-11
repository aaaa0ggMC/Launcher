import { listCommands, tryRunCommand } from './commands/registry'
import { t, te } from './i18n'
import { makeLogger } from './logger'

const log = makeLogger('cli')

/**
 * CLI REPL backend.
 *
 * Dispatch order:
 *  1. `help`
 *  2. extension built-ins (e.g. apps: `list` / `info` / `launch` / `run`)
 *  3. a registered ability command (`mirror.toggle`, ...)
 *  4. extension bare-alias resolution (e.g. apps: `<alias>` → launch)
 *
 * The REPL core is ability-agnostic: abilities register their CLI vocabulary
 * through `registerCliExtension` from their own modules.
 */

export interface CliAliasMatch {
  run: (rest: string[]) => Promise<string>
}

export interface CliExtension {
  /** extra help lines shown at the top of `help` output */
  helpLines?: () => string[]
  /** additional built-in subcommands keyed by first token */
  builtins?: {
    name: string
    help: string
    run: (rest: string[], input: string) => string | Promise<string>
  }[]
  /** resolve a bare first token into a launchable action */
  resolveAlias?: (token: string) => Promise<CliAliasMatch | null>
}

const extensions: CliExtension[] = []

/** Register CLI vocabulary contributed by an ability (call once at load). */
export function registerCliExtension(ext: CliExtension): void {
  extensions.push(ext)
}

function renderHelp(): string {
  const cmds = listCommands()
  const grouped = new Map<string, string[]>()
  for (const c of cmds) {
    const ability = c.name.split('.')[0]
    const list = grouped.get(ability) ?? []
    list.push(`  ${c.name.padEnd(24)} ${t(c.name + '.desc', c.description)}`)
    grouped.set(ability, list)
  }
  const lines: string[] = []
  for (const ext of extensions) {
    for (const hl of ext.helpLines?.() ?? []) lines.push(hl)
    for (const b of ext.builtins ?? []) if (b.help) lines.push(b.help)
  }
  lines.push(t('cli.help.allCmds'))
  for (const [ability, cmdsList] of grouped) {
    lines.push(`[${ability}]`)
    lines.push(...cmdsList)
  }
  return lines.join('\n')
}

export async function cliExec(input: string): Promise<string> {
  const tokens = input.trim().split(/\s+/)
  const [cmdRaw, ...rest] = tokens
  if (!cmdRaw) return ''
  const cmd = cmdRaw.toLowerCase()
  log.debug('cli input', { cmd })

  if (cmd === 'help') return renderHelp()

  // Extension built-ins (apps: list/info/launch/run).
  for (const ext of extensions) {
    for (const b of ext.builtins ?? []) {
      if (b.name === cmd) return b.run(rest, input)
    }
  }

  // Ability command dispatch (CLI-first).
  const commandOut = await tryRunCommand(input)
  if (commandOut !== null) return commandOut

  // Bare token → extension alias resolution (apps: `<alias>` launches).
  for (const ext of extensions) {
    if (!ext.resolveAlias) continue
    const match = await ext.resolveAlias(cmdRaw)
    if (match) return match.run(rest)
  }

  log.warn('unknown cli command', { cmd: cmdRaw })
  return te('cli.error.unknown', { cmd: cmdRaw })
}
