import type { CommandSpec } from '../../main/process/commands/types'
import { registerStartupHook } from '../../main/process/startup'
import { reconcilePlayerAbilityVisibility } from './player-backend'
import './jobs'
import './listening-stats'
import { playbackCommands } from './commands/playback'
import { webPlayerCommands } from './commands/web-player'
import { curateCommands } from './commands/curate'
import { sessionsCommands } from './commands/sessions'
import { chatContinuousCommands } from './commands/chat-continuous'
import { configLyricsCommands } from './commands/config-lyrics'

export { getCurrentAbortSignal, abortCurrentRequest } from './commands/shared'

// Startup: the built-in player page is mode-bound — hide it from the sidebar
// when the app boots into dbus mode (Linux default), show it in web mode.
registerStartupHook(() => reconcilePlayerAbilityVisibility())

const commands: CommandSpec[] = [
  ...curateCommands,
  ...playbackCommands,
  ...sessionsCommands,
  ...configLyricsCommands,
  ...webPlayerCommands,
  ...chatContinuousCommands
]

export default commands
