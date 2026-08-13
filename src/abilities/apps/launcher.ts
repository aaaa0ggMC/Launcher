import { spawn } from 'child_process'
import { isAbsolute, dirname, join } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import type { AppEntry, AppExecSpec, AppAction, LaunchResult, ProcOutputEvent } from './types'
import { CONFIG_JSON, SCRIPTS_DIR } from '../../main/process/paths'
import { readJson } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'
import { startProcessTask } from '../../main/process/background-tasks'
import { getBroadcast } from '../../main/process/broadcast'
import { recordUsage } from '../../main/process/usage-stats'

const log = makeLogger('apps-launcher')

interface RuntimeConfig {
  runtime?: { terminal?: string[]; confirmBeforeLaunch?: boolean }
}

export type { ProcOutputEvent }

/** Broadcast a streamed output event to every window (`cockpit:proc-output`). */ function outputBroadcast(
  event: ProcOutputEvent
): void {
  getBroadcast()('cockpit:proc-output', event)
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
      // venv layout differs per platform: Unix `bin/python`, Windows
      // `Scripts/python.exe`. Fall back to the platform's bare interpreter
      // (`python` on Windows — `python3` doesn't exist there).
      const venvPy = join(
        cwd,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'
      )
      const py = existsSync(venvPy) ? venvPy : process.platform === 'win32' ? 'python' : 'python3'
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
        log.error('spawn failed', { argv: argv[0], error: err.message })
        resolve({ ok: false, error: `spawn 失败: ${err.message}` })
      })
      child.on('spawn', () => {
        if (monitor && child.pid) {
          log.debug('monitor streaming started', { pid: child.pid, argv: argv[0] })
          streamLines(child.pid, 'stdout', child.stdout)
          streamLines(child.pid, 'stderr', child.stderr)
          child.on('exit', (code) => {
            outputBroadcast({ pid: child.pid!, type: 'exit', code })
          })
        }
        resolve({ ok: true, pid: child.pid, terminal, monitor })
      })
    } catch (err) {
      log.error('spawn threw', {
        argv: argv[0],
        error: err instanceof Error ? err.message : String(err)
      })
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
        log.error('spawn failed', { argv: argv[0], error: err.message })
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
      log.error('spawn threw', {
        argv: argv[0],
        error: err instanceof Error ? err.message : String(err)
      })
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

export interface LaunchOptions {
  /** capture stdout/stderr and stream line events to the renderer */
  monitor?: boolean
  /**
   * run as a managed background task: spawned with piped stdio and attached to
   * the framework background-task service (global panel, live console,
   * stdin/signal control). Overrides terminal:true (a terminal would swallow
   * the pipe).
   */
  background?: boolean
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

  // Distinguish "cwd missing" from "binary missing" early — Node reports BOTH
  // as `spawn <cmd> ENOENT`, which misleads debugging when a project dir was
  // deleted/moved. Fail with a clear message instead.
  if (!existsSync(cwd)) {
    const error = `工作目录不存在: ${cwd}`
    log.warn('launch aborted: cwd missing', { name: entry.alias ?? entry.name, cwd })
    return { ok: false, error }
  }

  // Frequency statistic — every successful launch (foreground, background task
  // or multi-step action) counts once in apps.csv, keyed by `app:<root>:<path>`.
  void recordUsage(`app:${entry.root}:${entry.path}`)

  // Background task mode → hand off to the framework service. It keeps the
  // child attached to the app (not detached), pipes stdio into a ring buffer,
  // and exposes it in the global Background Tasks panel.
  if (opts.background || eff.background) {
    const headless = { ...eff, terminal: false }
    const argv = await buildArgv(entry, headless)
    const task = startProcessTask({
      name: entry.alias ?? entry.name,
      description: entry.description ?? undefined,
      argv,
      cwd,
      env
    })
    log.info('background task started', { task: task.id, name: task.name, argv })
    return { ok: true, pid: task.pid, taskId: task.id, monitor: true }
  }

  const argv = await buildArgv(entry, eff)
  const res = await spawnDetached(argv, cwd, env, eff.terminal ?? false, opts.monitor ?? false)
  log.info('launch result', {
    root: entry.root,
    name: entry.alias ?? entry.name,
    type: spec.type,
    argv,
    cwd,
    ok: res.ok,
    pid: res.pid,
    error: res.error
  })
  return res
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
    log.info('launch action', {
      root: entry.root,
      name: entry.alias ?? entry.name,
      steps: steps.length
    })
    for (let i = 0; i < steps.length - 1; i++) {
      const step = steps[i]
      const argv = await buildArgv(entry, step)
      const res = await spawnWait(argv, expandCwd(entry, step), {
        ...process.env,
        ...(step.env ?? {})
      })
      if (!res.ok) {
        log.warn('action step failed', {
          root: entry.root,
          name: entry.alias ?? entry.name,
          step: i + 1,
          error: res.error
        })
        return {
          ...res,
          error: `步骤 ${i + 1} 失败: ${step.command.join(' ')} — ${res.error ?? ''}`
        }
      }
    }
    const last = opts.monitor
      ? { ...steps[steps.length - 1], terminal: false }
      : steps[steps.length - 1]
    const lastCwd = expandCwd(entry, last)
    const lastEnv: NodeJS.ProcessEnv = { ...process.env, ...(last.env ?? {}) }
    // Background mode → hand the last step to the framework task service.
    if (opts.background || last.background) {
      const argv = await buildArgv(entry, { ...last, terminal: false })
      const task = startProcessTask({
        name: entry.alias ?? entry.name,
        description: entry.description ?? undefined,
        argv,
        cwd: lastCwd,
        env: lastEnv
      })
      log.info('action background task started', { task: task.id, name: task.name, argv })
      return { ok: true, pid: task.pid, taskId: task.id, monitor: true }
    }
    const argv = await buildArgv(entry, last)
    const res = await spawnDetached(
      argv,
      lastCwd,
      lastEnv,
      last.terminal ?? false,
      opts.monitor ?? false
    )
    log.info('action result', {
      root: entry.root,
      name: entry.alias ?? entry.name,
      steps: steps.length,
      ok: res.ok,
      pid: res.pid,
      error: res.error
    })
    return res
  }
  return launchSpec(entry, action.exec, opts)
}
