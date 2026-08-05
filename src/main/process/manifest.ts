import { readFile } from 'fs/promises'
import { parse as parseYaml } from 'yaml'
import type { AbilitiesManifest } from '../../shared/types'
import { ABILITIES_YAML } from './paths'
import { makeLogger } from './logger'

const log = makeLogger('manifest')

type Broadcast = (channel: string, ...args: unknown[]) => void

let broadcast: Broadcast = () => {}

export function setManifestBroadcast(fn: Broadcast): void {
  broadcast = fn
}

export { broadcast as manifestBroadcast }

export async function getManifest(): Promise<AbilitiesManifest | null> {
  try {
    const raw = await readFile(ABILITIES_YAML, 'utf-8')
    const manifest = parseYaml(raw) as AbilitiesManifest
    log.debug('manifest loaded', { abilities: manifest?.abilities?.length ?? 0 })
    return manifest
  } catch (e) {
    log.error('failed to load manifest', e instanceof Error ? e.message : String(e))
    return null
  }
}
