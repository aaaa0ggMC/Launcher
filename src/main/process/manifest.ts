import { readFile } from 'fs/promises'
import { parse as parseYaml } from 'yaml'
import type { AbilitiesManifest } from '../../shared/types'
import { ABILITIES_YAML } from './paths'

type Broadcast = (channel: string, ...args: unknown[]) => void

let broadcast: Broadcast = () => {}

export function setManifestBroadcast(fn: Broadcast): void {
  broadcast = fn
}

export { broadcast as manifestBroadcast }

/** Read + parse config/abilities.yaml. */
export async function getManifest(): Promise<AbilitiesManifest | null> {
  try {
    const raw = await readFile(ABILITIES_YAML, 'utf-8')
    return parseYaml(raw) as AbilitiesManifest
  } catch {
    return null
  }
}
