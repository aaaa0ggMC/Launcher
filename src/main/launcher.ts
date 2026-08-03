import { spawn } from 'child_process'
import { isAbsolute, dirname, join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import type { AppEntry, LaunchResult } from '../shared/types'
import { CONFIG_JSON, SCRIPTS_DIR } from './paths'
import { readJson } from './util'

interface RuntimeConfig {
  runtime?: { terminal?: string[]; confirmBeforeLaunch?: boolean }
}

/** Entry's base directory (absolute path the entry lives in). */
function baseDir(entry: AppEntry): string {
  if (isAbsolute(entry.path)) return dirname(entry.path)
  return entry.root ?? process.cwd()
}

/** Expand exec.cwd into an absolute path. */
function expandCwd(entry: AppEntry): string {
  const spec = entry.exec.cwd
  if (spec === '{self}') return baseDir(entry)
  if (spec) {
    if (spec.startsWith('~')) return join(homedir(), spec.slice(1))
    if (isAbsolute(spec)) return spec
    return join(baseDir(entry), spec)
  }
  return baseDir(entry)
}

/** Resolve `path` to an absolute path when used as a script/desktop target. */
function resolvePath(entry: AppEntry): string {
  if (isAbsolute(entry.path)) return entry.path
  const base = entry.root ?? process.cwd()
  return join(base, entry.path)
}

async function readTerminal(): Promise<string[]> {
  const cfg = await readJson<RuntimeConfig>(CONFIG_JSON)
  return cfg?.runtime?.terminal ?? ['konsole', '--hold', '-e']
}

/**
 * Expand an exec spec into an argv array. NEVER shell string concatenation —
 * everything goes through child_process.spawn(argv).
 */
function expandArgv(entry: AppEntry): string[] {
  const { type, command, args = [] } = entry.exec
  const cwd = expandCwd(entry)
  const root = entry.exec.root ?? false
  const argv0 = type === 'script' || type === 'desktop' ? resolvePath(entry) : undefined

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
    case 'script':
      return [argv0!, ...args]
    case 'desktop':
      return ['gio', 'launch', argv0!]
    case 'custom':
      return [...command, ...args]
  }
}

/** Launch an app entry. Returns immediately; process runs detached. */
export async function launchEntry(entry: AppEntry): Promise<LaunchResult> {
  const cwd = expandCwd(entry)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(entry.exec.env ?? {}) }
  const root = entry.exec.root ?? false
  const terminal = entry.exec.terminal ?? false

  let argv = expandArgv(entry)

  // Root ops ONLY via pkexec + helper scripts (never direct root shell).
  if (root) {
    argv = ['pkexec', join(SCRIPTS_DIR, 'run-as-root.sh'), cwd, ...argv]
  }
  if (terminal) {
    const term = await readTerminal()
    argv = [...term, ...argv]
  }

  return await new Promise<LaunchResult>((resolve) => {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      child.on('error', (err) => {
        resolve({ ok: false, error: `spawn 失败: ${err.message}` })
      })
      child.on('spawn', () => {
        resolve({ ok: true, pid: child.pid, terminal })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
