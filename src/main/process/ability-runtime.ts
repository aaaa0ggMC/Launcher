import { getBroadcast } from './broadcast'
import { makeLogger } from './logger'

const log = makeLogger('ability-runtime')

/**
 * Runtime ability / command enable registry — TRANSIENT, never persisted.
 *
 * MAddition: an ability's sidebar entry and its commands can be turned on/off
 * at runtime (IPC `ability.set-enabled`), so the sidebar temporarily hides the
 * page and the disabled ability's commands behave as not registered. The state
 * is session-scoped only — "组件 import 的时候自动处理" (re-derive from the
 * current registry on every access), so there is deliberately no config file
 * write here.
 *
 * Beyond whole-ability toggling, individual commands may carry an `enabled`
 * predicate (mode-gated features): when it resolves false the command is NOT
 * exposed — the CLI/UI see an unknown command. This is how dbus-only commands
 * disappear in web-player mode without per-command `if` guards.
 */

/** Runtime-disabled ability ids (transient). */
const disabledAbilities = new Set<string>()

/** command name → owning ability id (recorded at registration time). */
const commandOwner = new Map<string, string>()

/** command name → optional runtime gate. */
const commandGates = new Map<string, () => boolean | Promise<boolean>>()

/** Record a command's ownership + optional gate at registration. */
export function registerCommand(
  abilityId: string,
  name: string,
  gate?: () => boolean | Promise<boolean>
): void {
  if (abilityId) commandOwner.set(name, abilityId)
  if (gate) commandGates.set(name, gate)
}

/** Whether the whole ability is currently disabled. */
export function isAbilityDisabled(id: string): boolean {
  return disabledAbilities.has(id)
}

/** Whether a command may be dispatched right now (owner enabled + gate open). */
export async function isCommandRunnable(name: string): Promise<boolean> {
  const owner = commandOwner.get(name)
  if (owner && disabledAbilities.has(owner)) return false
  const gate = commandGates.get(name)
  if (gate) {
    try {
      if (!(await gate())) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Enable/disable an ability at runtime. Broadcasts `cockpit:abilities-changed`
 * (`{ id, enabled, disabled: [...] }`) so the renderer can re-resolve its
 * sidebar live. Returns `{ ok: false, error }` for protected abilities that
 * must stay alive (the settings shell / the background-tasks provider).
 */
export function setAbilityEnabled(id: string, enabled: boolean): { ok: boolean; error?: string } {
  if (id === 'settings' && !enabled) {
    return { ok: false, error: '设置能力不可禁用（外壳依赖它）' }
  }
  if (id === 'background' && !enabled) {
    return { ok: false, error: '后台任务能力不可禁用（多个能力依赖它）' }
  }
  if (enabled) {
    disabledAbilities.delete(id)
  } else {
    disabledAbilities.add(id)
  }
  getBroadcast()('cockpit:abilities-changed', {
    id,
    enabled,
    disabled: [...disabledAbilities]
  })
  log.info('ability enabled state', { id, enabled })
  return { ok: true }
}

/** Snapshot of the disabled set (for `ability.list` / debugging). */
export function getDisabledAbilities(): string[] {
  return [...disabledAbilities]
}

/** `{ id, enabled }` for every known ability id. */
export function listAbilityStates(ids: string[]): { id: string; enabled: boolean }[] {
  return ids.map((id) => ({ id, enabled: !disabledAbilities.has(id) }))
}
