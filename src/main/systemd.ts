import type { SystemdUnit } from '../shared/types'
import { run } from './util'

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
  return parseUnits(out)
}

export async function systemdAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<SystemdUnit[]> {
  const args = [...(USER ? ['--user'] : []), action, name]
  await run('systemctl', args)
  return await listSystemd()
}
