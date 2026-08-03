import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { dirname } from 'path'

export const execFileAsync = promisify(execFile)

/** Read + parse JSON; returns null on any error. */
export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as T
  } catch {
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
