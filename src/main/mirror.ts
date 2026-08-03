import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { MirrorInfo } from '../shared/types'
import { MIRRORLIST, SCRIPTS_DIR } from './paths'
import { getManifest } from './registry'

function parseServerLine(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('Server =')) return t.replace(/^Server\s*=\s*/, '').trim()
  }
  return null
}

export async function getMirrorInfo(): Promise<MirrorInfo> {
  const manifest = await getManifest()
  const cfg = manifest?.abilities.find((a) => a.id === 'mirror')?.config
  const configured = ((cfg?.mirrors as { name: string; url: string }[] | undefined) ?? []).map((m) => ({
    name: m.name,
    url: m.url
  }))
  const raw = await readFile(MIRRORLIST, 'utf-8').catch(() => '')
  return { configured, current: parseServerLine(raw) }
}

/** Switch the mirrorlist server via pkexec helper (backup + confirm in UI). */
export async function switchMirror(serverLine: string): Promise<MirrorInfo> {
  const script = join(SCRIPTS_DIR, 'switch-mirror.sh')
  const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
    execFile(
      'pkexec',
      [script, serverLine],
      { encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: stderr.trim() || err.message })
        else resolve({ ok: true, message: stdout.trim() })
      }
    )
  })
  const info = await getMirrorInfo()
  if (!result.ok) {
    return { ...info, lastError: `pkexec 失败: ${result.message}` }
  }
  return info
}
