import { readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AutostartEntry } from '../shared/types'
import { AUTOSTART_DIR } from './paths'

interface DesktopFile {
  groups: Record<string, Record<string, string>>
}

function parseDesktop(raw: string): DesktopFile {
  const groups: Record<string, Record<string, string>> = {}
  let current = ''
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const sec = t.match(/^\[([^\]]+)\]/)
    if (sec) {
      current = sec[1]
      groups[current] = groups[current] ?? {}
      continue
    }
    const kv = t.match(/^([^=]+)=(.*)$/)
    if (kv && current) groups[current][kv[1].trim()] = kv[2].trim()
  }
  return { groups }
}

function serializeDesktop(desktop: DesktopFile): string {
  const lines: string[] = []
  for (const [group, kvs] of Object.entries(desktop.groups)) {
    lines.push(`[${group}]`)
    for (const [k, v] of Object.entries(kvs)) lines.push(`${k}=${v}`)
    lines.push('')
  }
  return lines.join('\n')
}

function hiddenFromGroups(desktop: DesktopFile): boolean {
  const entry = desktop.groups['Desktop Entry']
  return entry?.Hidden?.toLowerCase() === 'true'
}

export async function listAutostart(): Promise<AutostartEntry[]> {
  const files = await readdir(AUTOSTART_DIR).catch(() => [])
  const out: AutostartEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.desktop')) continue
    const full = join(AUTOSTART_DIR, file)
    const raw = await readFile(full, 'utf-8').catch(() => '')
    const desktop = parseDesktop(raw)
    const entry = desktop.groups['Desktop Entry'] ?? {}
    out.push({
      file,
      name: entry.Name ?? file.replace(/\.desktop$/, ''),
      exec: entry.Exec ?? '',
      comment: entry.Comment,
      hidden: hiddenFromGroups(desktop)
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** Enable/disable an autostart entry by toggling Hidden=true. */
export async function toggleAutostart(file: string, hidden: boolean): Promise<void> {
  const full = join(AUTOSTART_DIR, file)
  const raw = await readFile(full, 'utf-8').catch(() => '')
  const desktop = parseDesktop(raw)
  const entry = (desktop.groups['Desktop Entry'] = desktop.groups['Desktop Entry'] ?? {})
  if (hidden) {
    entry.Hidden = 'true'
  } else {
    delete entry.Hidden
  }
  await writeFile(full, serializeDesktop(desktop), 'utf-8')
}
