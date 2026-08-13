import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { makeLogger } from './logger'

const log = makeLogger('util')

export const execFileAsync = promisify(execFile)
/** Read + parse JSON; returns null on any error. */
export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as T
  } catch (e) {
    log.warn('readJson failed', { path: p, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Read a JSON config file, or materialize it when missing — like `mkdir -p`
 * for configs. If `p` doesn't exist, `create()` is called and the result is
 * deep-created (`writeJsonAtomic` mkdirs every parent) and returned, so a
 * config always exists after the first read. A corrupt existing file falls
 * back to `create()` in memory WITHOUT overwriting it (the next save repairs).
 *
 * Every ability settings UI should go through this instead of raw `readJson`
 * + bailing on null, so fresh installs never dead-end on a missing config.
 */
export async function readOrCreateJson<T>(p: string, create: () => T): Promise<T> {
  if (!existsSync(p)) {
    const defaults = create()
    try {
      await writeJsonAtomic(p, defaults)
    } catch (e) {
      log.warn('create json failed', { path: p, error: String(e) })
    }
    return defaults
  }
  return (await readJson<T>(p)) ?? create()
}

/** Atomic JSON write (write temp then rename). The temp name must be unique
 *  per call: a fixed `${p}.tmp-${pid}` collides when two saves run concurrently
 *  (e.g. settings auto-save) — the second rename fails with ENOENT and the
 *  config is silently lost. Last writer wins, which is fine for config. */
export async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await rename(tmp, p)
}

/**
 * Serialized atomic JSON write — same as `writeJsonAtomic`, but writes to the
 * same target are queued. On Windows, concurrent renames to one destination
 * race (MoveFileEx REPLACE_EXISTING can EPERM when another replace is mid-way),
 * so bursts like the settings page firing a watcher per field can fail the
 * trailing write. Queuing guarantees last-writer-wins deterministically.
 */
const writeQueues = new Map<string, Promise<void>>()

export async function writeJsonAtomicSerialized(p: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(p) ?? Promise.resolve()
  const task = prev.then(() => writeJsonAtomic(p, data))
  writeQueues.set(
    p,
    task.catch(() => {})
  )
  return task
}

/**
 * Write arbitrary text to a file (exported console logs, sessions, ...).
 * Shared by every ability's export command so file-writing stays in one place
 * instead of each ability re-implementing writeFile.
 */
export async function writeTextFile(
  p: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, text ?? '', 'utf-8')
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('writeTextFile failed', { path: p, error })
    return { ok: false, error }
  }
}

/** Write raw bytes (Buffer / Uint8Array) to a file. */
export async function writeBinaryFile(
  p: string,
  data: Uint8Array
): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, data)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error('writeBinaryFile failed', { path: p, error })
    return { ok: false, error }
  }
}

/** Run a command, return stdout; throws on non-zero exit. */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    timeout: opts.timeout ?? 15000
  })
  return stdout
}
