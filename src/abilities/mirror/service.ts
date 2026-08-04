import { execFile } from 'child_process'
import { readFile, writeFile, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import https from 'https'
import http from 'http'
import type { MirrorEntry, MirrorInfo, MirrorTestResult } from './types'
import { MIRRORLIST, SCRIPTS_DIR } from '../../main/process/paths'
import { getManifest } from '../../main/process/manifest'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('mirror')

/**
 * Serialize all mirror operations (read + toggle) — prevents the UI from
 * reading a half-written file during a toggle, and serializes concurrent
 * toggles when the user clicks rapidly.
 */
let mirrorChain: Promise<unknown> = Promise.resolve()

/** Parse the mirrorlist in [MIRROR] format (also migrates old format). */
function parseMirrorlist(raw: string): MirrorEntry[] {
  const entries: MirrorEntry[] = []
  const lines = raw.split('\n')
  let i = 0

  // New format: # [MIRROR] <name> followed by Server = or # Server =
  while (i < lines.length) {
    const line = lines[i].trim()
    const m = line.match(/^#\s*\[MIRROR\]\s*(.+)$/i)
    if (m) {
      const name = m[1].trim()
      // Look for the Server line (next non-empty line)
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length) {
        const srv = lines[j].trim()
        const enabled = srv.match(/^Server\s*=\s*(.+)$/)
        const disabled = srv.match(/^#\s*Server\s*=\s*(.+)$/)
        if (enabled) {
          entries.push({ name, url: enabled[1].trim(), enabled: true })
          i = j + 1
          continue
        } else if (disabled) {
          entries.push({ name, url: disabled[1].trim(), enabled: false })
          i = j + 1
          continue
        }
      }
      i++
      continue
    }
    i++
  }

  if (entries.length > 0) return entries

  // Old format migration: bare Server = / # Server = lines
  for (const line of lines) {
    const t = line.trim()
    const enabled = t.match(/^Server\s*=\s*(.+)$/)
    const disabled = t.match(/^#\s*Server\s*=\s*(.+)$/)
    if (enabled) {
      entries.push({ name: extractName(enabled[1]), url: enabled[1].trim(), enabled: true })
    } else if (disabled) {
      entries.push({ name: extractName(disabled[1]), url: disabled[1].trim(), enabled: false })
    }
  }
  return entries
}

/** Best-effort name extraction from a mirror URL. */
function extractName(url: string): string {
  const m = url.match(/^https?:\/\/(?:[^.]+\.)?([^.]+)\./)
  return m ? m[1].replace(/^./, (c) => c.toUpperCase()) : 'Mirror'
}

/** Merge file mirrors with config mirrors (add missing config ones as disabled). */
async function mergeWithConfig(fileMirrors: MirrorEntry[]): Promise<MirrorEntry[]> {
  const manifest = await getManifest()
  const cfg = manifest?.abilities.find((a) => a.id === 'mirror')?.config
  const configMirrors = ((cfg?.mirrors as { name: string; url: string }[] | undefined) ?? []).map(
    (m) => ({ name: m.name, url: m.url, enabled: false })
  )

  const merged = [...fileMirrors]
  for (const cm of configMirrors) {
    if (!merged.some((m) => m.url === cm.url)) {
      merged.push(cm)
    }
  }
  return merged
}

export async function getMirrorInfo(): Promise<MirrorInfo> {
  return mirrorChain.then(async () => {
    const raw = await readFile(MIRRORLIST, 'utf-8').catch(() => '')
    const fileMirrors = parseMirrorlist(raw)
    const mirrors = await mergeWithConfig(fileMirrors)
    log.info('get mirror info', { count: mirrors.length })
    return { mirrors }
  })
}

/**
 * Toggle a mirror's enabled state by ONLY flipping the comment on its Server
 * line — every other line in the file is preserved verbatim. If the mirror
 * doesn't exist in the file yet, it's appended at the end.
 *
 * Safety guarantees:
 *  - The original file is never modified in-place; a new temp file is written
 *    and atomically swapped in by write-mirrorlist.sh (mv, not cp).
 *  - If parsing fails or the target isn't found, the file is left untouched.
 *  - pkexec rejection / any error → original file stays as-is (backup is made
 *    but the swap never happens).
 *  - Concurrency: all operations (read + toggle) are serialized via mirrorChain
 *    so rapid clicks don't race on read-modify-write, and reads never see a
 *    half-written file.
 */
export async function toggleMirror(name: string, enabled: boolean): Promise<MirrorInfo> {
  // Chain this toggle after any in-flight operation to prevent IO races.
  let resolveRun!: (v: MirrorInfo) => void
  const run = new Promise<MirrorInfo>((resolve) => {
    resolveRun = resolve
  })
  const next = mirrorChain.then(async () => {
    // Re-read the file RIGHT NOW — may have been modified externally since
    // the UI last loaded it. This is the authoritative source of truth.
    const raw = await readFile(MIRRORLIST, 'utf-8').catch(() => '')
    const lines = raw.split('\n')

    // Find the [MIRROR] <name> header line index.
    let headerIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^#\s*\[MIRROR\]\s*(.+)$/i)
      if (m && m[1].trim() === name) {
        headerIdx = i
        break
      }
    }

    let newContent: string

    if (headerIdx === -1) {
      // Mirror not in file → append it (only if it exists in config).
      const mirrors = await mergeWithConfig(parseMirrorlist(raw))
      const target = mirrors.find((m) => m.name === name)
      if (!target) {
        log.warn('toggle mirror not found', { name })
        resolveRun({ mirrors, lastError: `未找到镜像源: ${name}` })
        return
      }
      const block = `\n# [MIRROR] ${name}\n${enabled ? '' : '# '}Server = ${target.url}\n`
      newContent = raw.endsWith('\n') ? raw + block.slice(1) : raw + block
    } else {
      // Mirror exists → find the Server line after the header and toggle its comment.
      let srvIdx = headerIdx + 1
      while (srvIdx < lines.length && lines[srvIdx].trim() === '') srvIdx++

      if (srvIdx >= lines.length) {
        const mirrors = await mergeWithConfig(parseMirrorlist(raw))
        log.warn('toggle mirror server line missing', { name })
        resolveRun({ mirrors, lastError: `镜像源 ${name} 的 Server 行缺失` })
        return
      }

      const srvLine = lines[srvIdx]
      // Strip any leading comment + whitespace to get the raw "Server = ..." part.
      const stripped = srvLine.replace(/^#\s*/, '')
      // Rewrite the line: add "# " prefix if disabling, strip it if enabling.
      lines[srvIdx] = enabled ? stripped : `# ${stripped}`
      newContent = lines.join('\n')
    }

    // Write to temp file, then pkexec swap.
    const tmpDir = await mkdtemp(join(tmpdir(), 'cockpit-mirror-'))
    const tmpFile = join(tmpDir, 'mirrorlist')
    await writeFile(tmpFile, newContent, 'utf-8')

    const script = join(SCRIPTS_DIR, 'write-mirrorlist.sh')
    const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      execFile('pkexec', [script, tmpFile], { encoding: 'utf-8' }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: stderr.trim() || err.message })
        else resolve({ ok: true, message: stdout.trim() })
      })
    })

    if (!result.ok) {
      const mirrors = await mergeWithConfig(parseMirrorlist(raw))
      log.error('toggle mirror failed', { name, enabled, error: result.message })
      resolveRun({ mirrors, lastError: `pkexec 失败: ${result.message}` })
      return
    }
    // Re-read to reflect the actual file state after the swap.
    const fresh = await readFile(MIRRORLIST, 'utf-8').catch(() => '')
    const freshMirrors = await mergeWithConfig(parseMirrorlist(fresh))
    log.info('toggle mirror ok', { name, enabled })
    resolveRun({ mirrors: freshMirrors })
  })
  // Keep the chain going regardless of success/failure.
  mirrorChain = next.catch(() => {})
  return run
}

/** Expand $repo / $arch placeholders into a real downloadable file URL. */
function buildTestUrl(mirrorUrl: string): string {
  return mirrorUrl
    .replace('$repo', 'core')
    .replace('$arch', process.arch === 'arm64' ? 'aarch64' : 'x86_64')
}

/** Download a small file from the mirror, measuring latency + throughput. */
function probeMirror(url: string, timeoutMs: number): Promise<{ latency: number; speed: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let firstByte: number | null = null
    let received = 0
    const lib = url.startsWith('https') ? https : http

    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy()
        resolve(probeMirror(res.headers.location, timeoutMs - (Date.now() - start)))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.on('data', (chunk: Buffer) => {
        if (firstByte === null) firstByte = Date.now()
        received += chunk.length
        if (received > 512 * 1024) {
          req.destroy()
        }
      })
      res.on('end', () => {
        const latency = firstByte ? firstByte - start : Date.now() - start
        const totalSec = (Date.now() - start) / 1000
        const speed = totalSec > 0 ? received / totalSec : 0
        resolve({ latency, speed })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

/** Test all mirrors: latency (TTFB) + download speed. */
export async function testMirrors(): Promise<MirrorTestResult[]> {
  const info = await getMirrorInfo()
  const results = await Promise.all(
    info.mirrors.map(async (m) => {
      const testUrl = buildTestUrl(m.url)
      try {
        const { latency, speed } = await probeMirror(testUrl, 10000)
        return { name: m.name, url: m.url, ok: true, latency, speed }
      } catch (e) {
        log.warn('mirror test failed', {
          name: m.name,
          error: e instanceof Error ? e.message : String(e)
        })
        return {
          name: m.name,
          url: m.url,
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    })
  )
  log.info('mirror test run', {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length
  })
  return results
}
