import { app } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

/** App root: project root in dev, install dir in prod. */
export const APP_ROOT = app.getAppPath()

export const CONFIG_DIR = join(APP_ROOT, 'config')
export const CONFIG_JSON = join(CONFIG_DIR, 'config.json')
export const ABILITIES_YAML = join(CONFIG_DIR, 'abilities.yaml')
export const SCRIPTS_DIR = join(APP_ROOT, 'scripts')

/** Per-user cockpit data (settings overrides, external abilities). */
export const USER_CONFIG_DIR = join(homedir(), '.config', 'LinuxCockpit')
export const EXTERNAL_ABILITIES_DIR = join(USER_CONFIG_DIR, 'abilities')

/** Rotating log output (daily files, auto-archived). */
export const LOG_DIR = join(USER_CONFIG_DIR, 'logs')

export const AUTOSTART_DIR = join(homedir(), '.config', 'autostart')
export const MIRRORLIST = '/etc/pacman.d/mirrorlist'
export const NVIDIA_PM_CONF = '/etc/modprobe.d/nvidia-pm-override.conf'
