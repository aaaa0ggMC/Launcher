import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
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

/** Atomic JSON write (write temp then rename). */
export async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await rename(tmp, p)
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
