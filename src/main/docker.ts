import type { DockerContainer } from '../shared/types'
import { run } from './util'

export async function listDocker(): Promise<DockerContainer[]> {
  const out = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '')
  const containers: DockerContainer[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const raw = JSON.parse(t)
      containers.push({
        id: raw.ID,
        name: (raw.Names ?? [])[0] ?? '',
        image: raw.Image ?? '',
        status: raw.Status ?? '',
        state: (raw.State ?? '').toLowerCase(),
        ports: raw.Ports ?? ''
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
