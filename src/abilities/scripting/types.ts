export type ScriptLanguage = 'ts' | 'js'

export interface ScriptItem {
  id: string
  name: string
  path?: string
  code: string
  language: ScriptLanguage
  updatedAt?: number
}

export type ConsoleLineType =
  'log' | 'info' | 'warn' | 'error' | 'stdout' | 'stderr' | 'result' | 'system'

export interface ConsoleLine {
  id: string
  time: number
  type: ConsoleLineType
  text: string
}

export type ScriptRunStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

export interface ScriptTemplate {
  id: string
  name: string
  description: string
  language: ScriptLanguage
  code: string
}

export interface ScriptRunResult {
  ok: boolean
  result?: unknown
  error?: string
  durationMs?: number
  taskId?: string
  logs?: ConsoleLine[]
}

// ---------------------------------------------------------------------------
// Script Parameter / Config Schema Definition
// ---------------------------------------------------------------------------
export type ConfigFieldType =
  'string' | 'number' | 'boolean' | 'select' | 'slider' | 'secret' | 'path'

export interface ConfigOption {
  label: string
  value: string | number | boolean
}

export interface ConfigFieldDef {
  type?: ConfigFieldType
  label?: string
  description?: string
  default?: unknown
  options?: (ConfigOption | string | number)[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
}

export type ScriptConfigSchema = Record<string, ConfigFieldDef>

export interface CockpitFsContext {
  readFile: (path: string, encoding?: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  readdir: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string) => Promise<void>
  stat: (
    path: string
  ) => Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: number }>
  unlink: (path: string) => Promise<void>
}

export interface CockpitStorageContext {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  all: () => Promise<Record<string, unknown>>
}

export interface CockpitContext {
  command: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  listCommands: () => Promise<{ name: string; description: string; usage?: string }[]>
  exec: (
    cmd: string,
    args?: string[],
    opts?: { cwd?: string; env?: Record<string, string> }
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>
  sh: (script: string, opts?: { cwd?: string; env?: Record<string, string> }) => Promise<string>
  job: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<{ ok: boolean; task?: unknown; error?: string }>
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  progress: (pct: number, message?: string) => void
  sleep: (ms: number) => Promise<void>
  fetch: (url: string, opts?: RequestInit) => Promise<Response>
  notify: (title: string, body?: string) => Promise<void>
  fs: CockpitFsContext
  storage: CockpitStorageContext
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  config: Record<string, unknown>
}
