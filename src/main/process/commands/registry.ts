import type { CommandSpec } from './types'
import { makeLogger } from '../logger'
import { registerCommand, commandBlock, commandOwnerOf } from '../ability-runtime'
import {
  isAgentOrigin,
  guard,
  redactSecretKeys,
  currentOrigin,
  PrivacyDeniedError
} from '../privacy'

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
 * A registered command that can't run right now (owning ability disabled, or
 * its mode/platform gate is closed). Subclass of UnknownCommandError so the
 * existing "not exposed → no toast" handling keeps working, but the message and
 * `reason` say WHY instead of pretending the command doesn't exist.
 */
export class CommandUnavailableError extends UnknownCommandError {
  readonly reason: string
  constructor(name: string, reason: string) {
    super(name, true)
    this.reason = reason
    this.message = `命令 ${name} 当前不可用: ${reason}`
    this.name = 'CommandUnavailableError'
  }
}

/** Human-readable reason a command can't run, or null when it can. */
export async function commandUnavailableReason(name: string): Promise<string | null> {
  const block = await commandBlock(name)
  if (!block) return null
  if (block === 'ability-disabled') return `所属能力 ${commandOwnerOf(name)} 已被运行时禁用`
  if (block === 'gate-error') return '可用性检查失败'
  return commands.get(name)?.unavailableReason ?? '当前模式下不可用'
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

/** Logging follows the command's data-retention policy, independent of caller origin. */
export function commandLogsArgs(name: string): boolean {
  return commands.get(name)?.logArgs !== false
}

/**
 * Agent-only privacy middleware around a command run. UI / CLI origins pass
 * straight through. For agents: `agent: 'deny'` refuses, `requires` guards
 * (may block on the consent window), and the result gets the credential-key
 * fallback redaction so an undeclared command can't leak a password field.
 */
async function runWithPrivacy(
  spec: CommandSpec,
  ctx: Parameters<CommandSpec['run']>[0]
): Promise<unknown> {
  if (!isAgentOrigin()) return await spec.run(ctx)
  const p = spec.privacy
  if (p?.agent === 'deny') {
    log.warn('agent denied command', { name: spec.name, origin: currentOrigin() })
    throw new PrivacyDeniedError('agent_denied', [], `agent may not call ${spec.name}`)
  }
  if (p?.requires?.length) await guard(p.requires, spec.name)
  if (!p) log.debug('agent called unclassified command', { name: spec.name })
  return redactSecretKeys(await spec.run(ctx))
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
  const unavailable = await commandUnavailableReason(name)
  if (unavailable) {
    // Registered but gated off (mode/platform) → say why; do NOT fall through
    // to app-alias resolution.
    return `命令 ${name} 当前不可用: ${unavailable}`
  }
  const { named, positional } = parseArgs(tokens.slice(1))
  try {
    for (const h of preRunHooks) if (name.startsWith(h.prefix)) await h.fn()
    const result = await runWithPrivacy(spec, { named, positional })
    return formatResult(result)
  } catch (e) {
    log.error('command failed', { name, error: e instanceof Error ? e.message : String(e) })
    return `错误: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * 命令执行前的异步钩子（按命令名前缀）。inspector 用它在 agent 的 `ui.*` 调用前
 * 把该会话的独立视图建好并等它加载完（`mainContents()` 本身是同步的）。
 */
const preRunHooks: { prefix: string; fn: () => Promise<void> }[] = []
export function registerPreRunHook(prefix: string, fn: () => Promise<void>): void {
  preRunHooks.push({ prefix, fn })
}

/** Run a command with structured args (UI path). Returns the raw structured result. */
export async function runCommand(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const spec = commands.get(name)
  if (!spec) throw new UnknownCommandError(name)
  // Gated (mode/platform-exclusive) commands are silent for the renderer (no
  // toast), but the error says why it's unavailable.
  const unavailable = await commandUnavailableReason(name)
  if (unavailable) throw new CommandUnavailableError(name, unavailable)
  for (const h of preRunHooks) if (name.startsWith(h.prefix)) await h.fn()
  return await runWithPrivacy(spec, { named: args, positional: [] })
}
