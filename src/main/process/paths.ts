import { app } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

/** App root: project root in dev, install dir in prod. */
export const APP_ROOT = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()

export const SCRIPTS_DIR = join(APP_ROOT, 'scripts')

/** Per-user cockpit data (settings, configs, external abilities, logs). */
export const USER_CONFIG_DIR = join(homedir(), '.config', 'LinuxCockpit')
export const CONFIG_JSON = join(USER_CONFIG_DIR, 'config.json')
export const SIDEBAR_ORDER_JSON = join(USER_CONFIG_DIR, 'sidebar-order.json')
export const EXTERNAL_ABILITIES_DIR = join(USER_CONFIG_DIR, 'abilities')

/** Rotating log output (daily files, auto-archived). */
export const LOG_DIR = join(USER_CONFIG_DIR, 'logs')

/** Cache directory for generated thumbnails (e.g. video covers). */
export const THUMBNAIL_CACHE_DIR = join(USER_CONFIG_DIR, 'thumbnails')

/** Resolve an ability's config.json path under USER_CONFIG_DIR. */
export function abilityConfigPath(abilityId: string): string {
  return join(USER_CONFIG_DIR, abilityId, 'config.json')
}

export const AUTOSTART_DIR = join(homedir(), '.config', 'autostart')
export const MIRRORLIST = '/etc/pacman.d/mirrorlist'
export const NVIDIA_PM_CONF = '/etc/modprobe.d/nvidia-pm-override.conf'
