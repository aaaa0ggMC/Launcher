/**
 * Ability-injected command registry.
 *
 * Every ability owns its commands in a `commands/<ability>.ts` file exporting a
 * `CommandSpec[]`; the registry just collects them here. Adding a new ability =
 * add a file + one import — no central switchboard to touch.
 */
import { registerAll } from './registry'
import configCmds from './config'
import appsCmds from './apps'
import launcherCmds from './launcher'
import systemCmds from './system'
import dashboardCmds from './dashboard'
import mirrorCmds from './mirror'
import autostartCmds from './autostart'
import systemdCmds from './systemd'
import dockerCmds from './docker'
import hardwareCmds from './hardware'
import displayCmds from './display'

registerAll([
  ...configCmds,
  ...appsCmds,
  ...launcherCmds,
  ...systemCmds,
  ...dashboardCmds,
  ...mirrorCmds,
  ...autostartCmds,
  ...systemdCmds,
  ...dockerCmds,
  ...hardwareCmds,
  ...displayCmds
])

// Re-export the dispatch surface so callers keep `from './commands'`.
export { listCommands, tryRunCommand, runCommand, parseArgs, UnknownCommandError } from './registry'
export type { CommandSpec, CommandContext } from './types'
