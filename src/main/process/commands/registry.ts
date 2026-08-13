import type { CommandSpec } from './types'
import { makeLogger } from '../logger'
import { registerCommand, isCommandRunnable } from '../ability-runtime'

const log = makeLogger('commands')

/**
 * Thrown when a command name isn't registered (e.g. the backing ability was
 * removed, or the command's runtime gate is closed). Carries the exact name so
 * the IPC layer can notify the UI without parsing the message.
 * `silent` marks mode/platform-GATED commands — the renderer shouldn't toast
 * for those (it's "not exposed", not a bug), only for truly-missing commands.
 */
export class UnknownCommandError extends Error {
  readonly commandName: string
  readonly silent: boolean
  constructor(name: string, silent = false) {
    super(`未知命令: ${name}`)
    this.commandName = name
    this.silent = silent
    this.name = 'UnknownCommandError'
  }
}

/**
 * Central command store. Abilities register their specs here; the CLI REPL and
 * the UI (window.cockpit.command) both dispatch through it (CLI-first).
 *
 * `registerAll(...)` is called once from `commands/index.ts` with every
 * ability's injected command array.
 */

const commands = new Map<string, CommandSpec>()

export function registerAll(specs: CommandSpec[], abilityId?: string): void {
  for (const s of specs) {
    if (commands.has(s.name)) throw new Error(`重复命令: ${s.name}`)
    commands.set(s.name, s)
    registerCommand(abilityId ?? '', s.name, s.enabled)
  }
  log.info(`registered ${specs.length} commands (total ${commands.size})`)
}

export function listCommands(): CommandSpec[] {
  return [...commands.values()]
}

/** Parse `--key value` pairs + bare positional tokens. */
export function parseArgs(tokens: string[]): {
  named: Record<string, string>
  positional: string[]
} {
  const named: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--') && t.length > 2) {
      const key = t.slice(2)
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        named[key] = next
        i++
      } else {
        named[key] = 'true'
      }
    } else {
      positional.push(t)
    }
  }
  return { named, positional }
}

function formatResult(r: unknown): string {
  if (r === null || r === undefined) return '(无结果)'
  if (typeof r === 'string') return r
  if (typeof r === 'number' || typeof r === 'boolean') return String(r)
  if (Array.isArray(r)) {
    if (r.length === 0) return '(空)'
    return r
      .map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)))
      .join('\n')
  }
  return JSON.stringify(r, null, 2)
}

/**
 * Try to run `input` as a registered command. Returns formatted CLI text, or
 * null when the first token is not a registered command (caller may fall back
 * to app-alias logic).
 */
export async function tryRunCommand(input: string): Promise<string | null> {
  const tokens = input.trim().split(/\s+/)
  const name = tokens[0]
  const spec = commands.get(name)
  if (!spec) return null
  if (!(await isCommandRunnable(name))) {
    // Registered but gated off (mode/platform) → treat as unknown, do NOT fall
    // through to app-alias resolution.
    return `未知命令: ${name}`
  }
  const { named, positional } = parseArgs(tokens.slice(1))
  try {
    const result = await spec.run({ named, positional })
    return formatResult(result)
  } catch (e) {
    log.error('command failed', { name, error: e instanceof Error ? e.message : String(e) })
    return `错误: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Run a command with structured args (UI path). Returns the raw structured result. */
export async function runCommand(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const spec = commands.get(name)
  if (!spec) throw new UnknownCommandError(name)
  // Gated (mode/platform-exclusive) commands are "silently unknown" — the
  // renderer shouldn't toast for them.
  if (!(await isCommandRunnable(name))) throw new UnknownCommandError(name, true)
  return await spec.run({ named: args, positional: [] })
}
