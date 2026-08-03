import type { DockerContainer } from '../shared/types'
import { run } from './util'

/** docker `--format json` may return Names as a string or an array. */
function containerName(raw: Record<string, unknown>): string {
  const n = raw.Names
  const name = Array.isArray(n) ? (n[0] ?? '') : String(n ?? '')
  return name.replace(/^\//, '')
}

export async function listDocker(): Promise<DockerContainer[]> {
  const out = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '')
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
  return containers
}

export async function dockerAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<DockerContainer[]> {
  if (action === 'restart') {
    await run('docker', ['restart', name])
  } else {
    await run('docker', [action, name])
  }
  return await listDocker()
}
