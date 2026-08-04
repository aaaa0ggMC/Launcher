import type { SystemdUnit } from './types'
import { run } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('systemd')

const USER = process.getuid?.() !== 0

function parseUnits(out: string): SystemdUnit[] {
  const units: SystemdUnit[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    units.push({
      name: m[1],
      loaded: m[2] === 'loaded',
      active: m[3],
      sub: m[4],
      description: m[5].trim()
    })
  }
  return units
}

export async function listSystemd(): Promise<SystemdUnit[]> {
  const args = [
    ...(USER ? ['--user'] : []),
    'list-units',
    '--type=service',
    '--all',
    '--no-legend',
    '--no-pager',
    '--plain'
  ]
  const out = await run('systemctl', args).catch(() => '')
  if (!out) log.warn('systemctl list failed')
  const units = parseUnits(out)
  log.info('systemd list result', { count: units.length })
  return units
}

export async function systemdAction(
  name: string,
  action: 'start' | 'stop' | 'restart'
): Promise<SystemdUnit[]> {
  const args = [...(USER ? ['--user'] : []), action, name]
  try {
    await run('systemctl', args)
    const units = await listSystemd()
    log.info('systemd action ok', { name, action })
    return units
  } catch (e) {
    log.error('systemd action failed', {
      name,
      action,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
}
