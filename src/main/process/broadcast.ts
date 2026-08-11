/**
 * Framework broadcast hub — architectural.
 *
 * The main shell owns a single `broadcast(channel, ...args)` that pushes to
 * every open BrowserWindow (`cockpit:*` events). Modules that need it (the
 * logger, background-tasks, windows) already take it via a setter wired in
 * `index.ts`. Abilities must not be wired from the shell, so this hub lets any
 * module pull the current broadcaster instead:
 *
 *   const emit = getBroadcast()
 *   emit('cockpit:apps-changed', 'rescan', root)
 *
 * `getBroadcast()` returns a closure that reads the CURRENT broadcaster at call
 * time, so abilities can grab it at module load (before `setBroadcast` runs).
 */
type Broadcast = (channel: string, ...args: unknown[]) => void

let broadcast: Broadcast = () => {}

export function setBroadcast(fn: Broadcast): void {
  broadcast = fn
}

export function getBroadcast(): Broadcast {
  return broadcast
}
