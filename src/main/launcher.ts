import { spawn } from 'child_process'
import { isAbsolute, dirname, join } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import type {
  AppEntry,
  AppExecSpec,
  AppAction,
  LaunchResult,
  ProcOutputEvent
} from '../shared/types'
import { CONFIG_JSON, SCRIPTS_DIR } from './paths'
import { readJson } from './util'

interface RuntimeConfig {
  runtime?: { terminal?: string[]; confirmBeforeLaunch?: boolean }
}

export type { ProcOutputEvent }

type OutputBroadcast = (event: ProcOutputEvent) => void

let outputBroadcast: OutputBroadcast = () => {}

export function setOutputBroadcast(fn: OutputBroadcast): void {
  outputBroadcast = fn
}

/** Read a piped stream, emit each complete line to the broadcast. */
function streamLines(
  pid: number,
  stream: 'stdout' | 'stderr',
  readable: NodeJS.ReadableStream | null
): void {
  if (!readable) return
  readable.setEncoding('utf8')
  let buf = ''
  readable.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      outputBroadcast({ pid, type: 'line', stream, line })
    }
  })
  readable.on('end', () => {
    if (buf.trim()) outputBroadcast({ pid, type: 'line', stream, line: buf })
  })
}

/** Entry's own directory (where the project/script lives).
 *  - Absolute path → its dirname
 *  - Relative dir path (e.g. "bili-viewer") with root → join(root, path)
 *  - Relative file path (e.g. "start_music") with root → root itself
 *    (script files live in the search root; their cwd should be the root)
 */
function baseDir(entry: AppEntry): string {
  if (isAbsolute(entry.path)) return dirname(entry.path)
  const root = entry.root ?? process.cwd()
  const full = join(root, entry.path)
  try {
    if (existsSync(full) && statSync(full).isFile()) return root
  } catch {
    // ignore
  }
  return full
}

/** Expand exec.cwd into an absolute path. */
function expandCwd(entry: AppEntry, spec: AppExecSpec): string {
  const cwd = spec.cwd
  if (cwd === '{self}') return baseDir(entry)
  if (cwd) {
    if (cwd.startsWith('~')) return join(homedir(), cwd.slice(1))
    if (isAbsolute(cwd)) return cwd
    return join(baseDir(entry), cwd)
  }
  return baseDir(entry)
}

/** Resolve `path` to an absolute path when used as a script/desktop target. */
function resolvePath(entry: AppEntry, target?: string): string {
  const p = target ?? entry.path
  if (isAbsolute(p)) return p
  const base = entry.root ?? process.cwd()
  return join(base, p)
}

async function readTerminal(): Promise<string[]> {
  const cfg = await readJson<RuntimeConfig>(CONFIG_JSON)
  return cfg?.runtime?.terminal ?? ['konsole', '--hold', '-e']
}

/**
 * Expand an exec spec into an argv array. NEVER shell string concatenation —
 * everything goes through child_process.spawn(argv).
 */
function expandArgv(entry: AppEntry, spec: AppExecSpec): string[] {
  const { type, command, args = [] } = spec
  const cwd = expandCwd(entry, spec)
  const root = spec.root ?? false
  const argv0 = type === 'script' || type === 'desktop' ? resolvePath(entry, spec.path) : undefined

  switch (type) {
    case 'uv':
      return ['uv', 'run', '--directory', cwd, ...command, ...args]
    case 'python': {
      const py = existsSync(join(cwd, '.venv', 'bin', 'python'))
        ? join(cwd, '.venv', 'bin', 'python')
        : 'python3'
      return [py, ...command, ...args]
    }
    case 'node':
      return ['node', ...command, ...args]
    case 'docker':
      return ['docker', ...command, ...args]
    case 'systemd': {
      const user = root ? [] : ['--user']
      return ['systemctl', ...user, ...command, ...args]
    }
    case 'script': {
      // Use bash to run the script — avoids "not executable" errors when the
      // script file lacks +x permission.
      return ['bash', argv0!, ...args]
    }
    case 'desktop':
      return ['gio', 'launch', argv0!]
    case 'custom':
      return [...command, ...args]
  }
}

/** Build the final argv for a spec (adds pkexec/terminal wrappers). */
async function buildArgv(entry: AppEntry, spec: AppExecSpec): Promise<string[]> {
  const cwd = expandCwd(entry, spec)
  let argv = expandArgv(entry, spec)
  // Root ops ONLY via pkexec + helper scripts (never direct root shell).
  if (spec.root ?? false) {
    argv = ['pkexec', join(SCRIPTS_DIR, 'run-as-root.sh'), cwd, ...argv]
  }
  if (spec.terminal ?? false) {
    argv = [...(await readTerminal()), ...argv]
  }
  return argv
}

/** Launch detached, resolve as soon as the child spawns. */
function spawnDetached(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  terminal: boolean,
  monitor = false
): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: monitor ? ['ignore', 'pipe', 'pipe'] : 'ignore'
      })
      child.unref()
      child.on('error', (err) => {
        resolve({ ok: false, error: `spawn 失败: ${err.message}` })
      })
      child.on('spawn', () => {
        if (monitor && child.pid) {
          streamLines(child.pid, 'stdout', child.stdout)
          streamLines(child.pid, 'stderr', child.stderr)
          child.on('exit', (code) => {
            outputBroadcast({ pid: child.pid!, type: 'exit', code })
          })
        }
        resolve({ ok: true, pid: child.pid, terminal, monitor })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/** Run headless and wait for exit; resolve ok only on exit code 0. */
function spawnWait(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let errBuf = ''
      child.stderr?.on('data', (d) => {
        errBuf = (errBuf + String(d)).slice(-300)
      })
      child.on('error', (err) => {
        resolve({ ok: false, error: `spawn 失败: ${err.message}` })
      })
      child.on('exit', (code) => {
        if (code === 0) resolve({ ok: true, pid: child.pid })
        else
          resolve({
            ok: false,
            error: `退出码 ${code ?? '?'}${errBuf.trim() ? ` — ${errBuf.trim()}` : ''}`
          })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

export interface LaunchOptions {
  /** capture stdout/stderr and stream line events to the renderer */
  monitor?: boolean
}

/** Launch an exec spec. Returns immediately; process runs detached. */
export async function launchSpec(
  entry: AppEntry,
  spec: AppExecSpec,
  opts: LaunchOptions = {}
): Promise<LaunchResult> {
  // In monitor mode the output must reach our pipe — a terminal wrapper would
  // swallow it, so run headless and let the transformer modal be the display.
  const eff = opts.monitor ? { ...spec, terminal: false } : spec
  const cwd = expandCwd(entry, eff)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(eff.env ?? {}) }
  const argv = await buildArgv(entry, eff)
  return await spawnDetached(argv, cwd, env, eff.terminal ?? false, opts.monitor ?? false)
}

/** Launch an app entry (primary exec). Returns immediately; process runs detached. */
export function launchEntry(entry: AppEntry, opts?: LaunchOptions): Promise<LaunchResult> {
  return launchSpec(entry, entry.exec, opts)
}

/**
 * Launch one clustered action of an app entry. Multi-step actions run each
 * intermediate step headless (awaited); only the last step launches detached
 * with its own terminal/root flags.
 */
export async function launchAction(
  entry: AppEntry,
  action: AppAction,
  opts: LaunchOptions = {}
): Promise<LaunchResult> {
  const steps = action.steps
  if (steps?.length) {
    for (let i = 0; i < steps.length - 1; i++) {
      const step = steps[i]
      const argv = await buildArgv(entry, step)
      const res = await spawnWait(argv, expandCwd(entry, step), {
        ...process.env,
        ...(step.env ?? {})
      })
      if (!res.ok) {
        return {
          ...res,
          error: `步骤 ${i + 1} 失败: ${step.command.join(' ')} — ${res.error ?? ''}`
        }
      }
    }
    const last = opts.monitor
      ? { ...steps[steps.length - 1], terminal: false }
      : steps[steps.length - 1]
    const argv = await buildArgv(entry, last)
    return await spawnDetached(
      argv,
      expandCwd(entry, last),
      {
        ...process.env,
        ...(last.env ?? {})
      },
      last.terminal ?? false,
      opts.monitor ?? false
    )
  }
  return launchSpec(entry, action.exec, opts)
}
