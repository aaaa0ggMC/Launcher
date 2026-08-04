import type { DockerContainer } from './types'
import { run } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('dashboard-docker')

/** docker `--format json` may return Names as a string or an array. */
function containerName(raw: Record<string, unknown>): string {
  const n = raw.Names
  const name = Array.isArray(n) ? (n[0] ?? '') : String(n ?? '')
  return name.replace(/^\//, '')
}

export async function listDocker(): Promise<DockerContainer[]> {
  const out = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '')
  if (!out) log.warn('docker ps failed')
  const containers: DockerContainer[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const raw = JSON.parse(t) as Record<string, unknown>
      containers.push({
        id: String(raw.ID ?? ''),
        name: containerName(raw),
        image: String(raw.Image ?? ''),
        status: String(raw.Status ?? ''),
        state: String(raw.State ?? '').toLowerCase(),
        ports: String(raw.Ports ?? '')
      })
    } catch {
      // skip malformed line
    }
  }
  log.info('container list result', { count: containers.length })
  return containers
}

export async function dockerAction(
  name: string,
  action: 'start' | 'stop' | 'restart'
): Promise<DockerContainer[]> {
  try {
    if (action === 'restart') {
      await run('docker', ['restart', name])
    } else {
      await run('docker', [action, name])
    }
    const containers = await listDocker()
    log.info('docker action ok', { name, action })
    return containers
  } catch (e) {
    log.error('docker action failed', {
      name,
      action,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
}
