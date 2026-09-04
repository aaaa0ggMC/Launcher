import { readFile, writeFile, readdir, stat, unlink, mkdir, access } from 'fs/promises'
import { join, extname, basename } from 'path'
import { spawn } from 'child_process'
import { Notification } from 'electron'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { runCommand, listCommands } from '../../main/process/commands/registry'
import { makeLogger } from '../../main/process/logger'
import type {
  CockpitContext,
  ConsoleLineType,
  ScriptConfigSchema,
  ScriptItem,
  ScriptLanguage,
  ScriptRunResult
} from './types'

const log = makeLogger('scripting')

// esbuild is externalized and resolved at runtime
// eslint-disable-next-line @typescript-eslint/no-require-imports
const esbuild = require('esbuild')

export const SCRIPTS_DIR = join(USER_CONFIG_DIR, 'scripts')
const STORAGE_FILE = join(USER_CONFIG_DIR, 'scripting', 'storage.json')

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Script File Operations
// ---------------------------------------------------------------------------

export async function listUserScripts(): Promise<ScriptItem[]> {
  await ensureDir(SCRIPTS_DIR)
  const files = await readdir(SCRIPTS_DIR).catch(() => [])
  const items: ScriptItem[] = []

  for (const f of files) {
    const ext = extname(f).toLowerCase()
    if (!['.ts', '.js', '.mjs', '.cjs'].includes(ext)) continue
    const full = join(SCRIPTS_DIR, f)
    const st = await stat(full).catch(() => null)
    if (!st || !st.isFile()) continue

    const lang: ScriptLanguage = ext === '.ts' ? 'ts' : 'js'
    const code = await readFile(full, 'utf-8').catch(() => '')
    items.push({
      id: f,
      name: basename(f, ext),
      path: full,
      code,
      language: lang,
      updatedAt: st.mtimeMs
    })
  }

  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return items
}

export async function loadScriptFile(filePath: string): Promise<ScriptItem> {
  const code = await readFile(filePath, 'utf-8')
  const ext = extname(filePath).toLowerCase()
  const st = await stat(filePath).catch(() => null)
  return {
    id: basename(filePath),
    name: basename(filePath, ext),
    path: filePath,
    code,
    language: ext === '.ts' ? 'ts' : 'js',
    updatedAt: st?.mtimeMs ?? Date.now()
  }
}

export async function saveScriptFile(script: {
  name: string
  code: string
  language: ScriptLanguage
  path?: string
}): Promise<ScriptItem> {
  await ensureDir(SCRIPTS_DIR)
  const ext = `.${script.language}`
  let targetPath = script.path
  if (!targetPath) {
    const safeName = script.name.replace(/[/\\?%*:|"<>]/g, '_') || 'script'
    targetPath = join(SCRIPTS_DIR, `${safeName}${ext}`)
  }
  await writeFile(targetPath, script.code, 'utf-8')
  const st = await stat(targetPath).catch(() => null)
  return {
    id: basename(targetPath),
    name: basename(targetPath, extname(targetPath)),
    path: targetPath,
    code: script.code,
    language: script.language,
    updatedAt: st?.mtimeMs ?? Date.now()
  }
}

export async function deleteScriptFile(filePathOrId: string): Promise<boolean> {
  const target = filePathOrId.includes('/') ? filePathOrId : join(SCRIPTS_DIR, filePathOrId)
  try {
    await unlink(target)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// KV Storage
// ---------------------------------------------------------------------------

async function getStorageData(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(STORAGE_FILE, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function setStorageData(data: Record<string, unknown>): Promise<void> {
  await ensureDir(join(USER_CONFIG_DIR, 'scripting'))
  await writeFile(STORAGE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// Script Runner & Transpiler
// ---------------------------------------------------------------------------

export interface ExecutionHooks {
  onLog?: (type: ConsoleLineType, text: string) => void
  onProgress?: (pct: number, message?: string) => void
  signal?: AbortSignal
}

function formatArg(arg: unknown): string {
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg, null, 2)
  } catch {
    return String(arg)
  }
}

function formatArgs(...args: unknown[]): string {
  return args.map(formatArg).join(' ')
}

/**
 * Strip top-level export keywords so code is valid inside a function body.
 */
function sanitizeScriptBody(code: string): string {
  return code
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^\s*export\s+(const|let|var|function|class|async\s+function)\s+/gm, '$1 ')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '')
}

/**
 * Safely extracts the config literal object block matching balanced braces.
 */
function extractConfigObjectLiteral(code: string): string | null {
  const match = /(?:export\s+)?(?:const|let|var)\s+config\s*=\s*\{/.exec(code)
  if (!match) return null
  const startIndex = match.index + match[0].length - 1
  let depth = 0
  let inString: string | null = null
  let escape = false
  for (let i = startIndex; i < code.length; i++) {
    const char = code[i]
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      escape = true
      continue
    }
    if (inString) {
      if (char === inString) inString = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = char
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        return code.slice(startIndex, i + 1)
      }
    }
  }
  return null
}

/**
 * Extracts configuration schema declared in the script (`export const config = { ... }`).
 */
export async function extractScriptConfigSchema(
  code: string,
  language: ScriptLanguage
): Promise<ScriptConfigSchema> {
  if (!code.includes('config')) return {}

  try {
    const configSnippet = extractConfigObjectLiteral(code)

    const codeToTransform = configSnippet
      ? `(function() { return (${configSnippet}); })()`
      : `(function() {
          ${sanitizeScriptBody(code)}
          return typeof config !== 'undefined' ? config : {};
        })()`

    const transformed = await esbuild.transform(codeToTransform, {
      loader: language === 'ts' ? 'ts' : 'js',
      target: 'node20'
    })

    const fn = new Function('cockpit', `return (${transformed.code})`)
    const raw = fn({ env: process.env, config: {} })
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as ScriptConfigSchema
    }
  } catch {
    // Syntax or incomplete code while typing
  }
  return {}
}

/**
 * Compiles and wraps a JS/TS script into an executable async function.
 */
export async function compileScriptToFunction(
  code: string,
  language: ScriptLanguage
): Promise<(ctx: { cockpit: CockpitContext }) => Promise<unknown>> {
  const sanitized = sanitizeScriptBody(code)
  const wrappedCode = `(async function({ cockpit }) {\n${sanitized}\n})`

  // Transpile TS/ESM code directly inside the async function wrapper
  const transformed = await esbuild.transform(wrappedCode, {
    loader: language === 'ts' ? 'ts' : 'js',
    target: 'node20',
    sourcemap: 'inline'
  })

  const factory = new Function('return ' + transformed.code)()
  return factory as (ctx: { cockpit: CockpitContext }) => Promise<unknown>
}

/**
 * Execute script code with fully populated CockpitContext and live hooks.
 */
export async function executeScript(
  code: string,
  language: ScriptLanguage,
  hooks: ExecutionHooks = {},
  userConfig: Record<string, unknown> = {}
): Promise<ScriptRunResult> {
  const start = Date.now()
  const signal = hooks.signal ?? new AbortController().signal

  const emit = (type: ConsoleLineType, ...args: unknown[]): void => {
    const text = formatArgs(...args)
    hooks.onLog?.(type, text)
    log.debug(`[script:${type}] ${text}`)
  }

  // Build CockpitContext
  const ctx: CockpitContext = {
    config: { ...userConfig },
    command: async (name: string, args: Record<string, unknown> = {}) => {
      if (signal.aborted) throw new Error('Script execution cancelled')
      return await runCommand(name, args)
    },
    listCommands: async () => {
      return listCommands().map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage
      }))
    },
    exec: (cmd, args = [], opts = {}) => {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Script execution cancelled'))
        const cp = spawn(cmd, args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          shell: false
        })
        let stdout = ''
        let stderr = ''
        cp.stdout.on('data', (d) => {
          const str = d.toString('utf-8')
          stdout += str
          emit('stdout', str.trimEnd())
        })
        cp.stderr.on('data', (d) => {
          const str = d.toString('utf-8')
          stderr += str
          emit('stderr', str.trimEnd())
        })
        const onAbort = (): void => {
          cp.kill('SIGTERM')
          reject(new Error('Script execution cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        cp.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          resolve({ stdout, stderr, code })
        })
        cp.on('error', (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        })
      })
    },
    sh: (scriptStr, opts = {}) => {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Script execution cancelled'))
        const cp = spawn('bash', ['-c', scriptStr], {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env }
        })
        let out = ''
        let err = ''
        cp.stdout.on('data', (d) => {
          const str = d.toString('utf-8')
          out += str
          emit('stdout', str.trimEnd())
        })
        cp.stderr.on('data', (d) => {
          const str = d.toString('utf-8')
          err += str
          emit('stderr', str.trimEnd())
        })
        const onAbort = (): void => {
          cp.kill('SIGTERM')
          reject(new Error('Script execution cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        cp.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          if (code === 0) resolve(out)
          else reject(new Error(err || `Exit code ${code}`))
        })
        cp.on('error', (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        })
      })
    },
    job: async (name, args = {}) => {
      if (signal.aborted) throw new Error('Script execution cancelled')
      return (await runCommand('background.job', { name, args })) as {
        ok: boolean
        task?: unknown
        error?: string
      }
    },
    log: (...args: unknown[]) => emit('log', ...args),
    info: (...args: unknown[]) => emit('info', ...args),
    warn: (...args: unknown[]) => emit('warn', ...args),
    error: (...args: unknown[]) => emit('error', ...args),
    progress: (pct: number, message?: string) => {
      hooks.onProgress?.(pct, message)
      if (message) emit('system', `[Progress ${Math.round(pct)}%] ${message}`)
    },
    sleep: async (ms: number) => {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Script execution cancelled'))
        const t = setTimeout(resolve, ms)
        const onAbort = (): void => {
          clearTimeout(t)
          reject(new Error('Script execution cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    fetch: async (url: string, opts?: RequestInit) => {
      return await fetch(url, { ...opts, signal })
    },
    notify: async (title: string, body?: string) => {
      try {
        if (Notification.isSupported()) {
          new Notification({ title, body: body ?? '' }).show()
        }
      } catch (err) {
        log.warn('notification failed', { error: err })
      }
    },
    fs: {
      readFile: async (p: string, encoding = 'utf-8') => {
        return await readFile(p, encoding as BufferEncoding)
      },
      writeFile: async (p: string, content: string) => {
        await writeFile(p, content, 'utf-8')
      },
      readdir: async (p: string) => {
        return await readdir(p)
      },
      exists: async (p: string) => {
        return await access(p)
          .then(() => true)
          .catch(() => false)
      },
      mkdir: async (p: string) => {
        await mkdir(p, { recursive: true })
      },
      stat: async (p: string) => {
        const s = await stat(p)
        return {
          size: s.size,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          mtime: s.mtimeMs
        }
      },
      unlink: async (p: string) => {
        await unlink(p)
      }
    },
    storage: {
      get: async <T = unknown>(key: string): Promise<T | null> => {
        const data = await getStorageData()
        return (data[key] as T) ?? null
      },
      set: async (key: string, value: unknown): Promise<void> => {
        const data = await getStorageData()
        data[key] = value
        await setStorageData(data)
      },
      delete: async (key: string): Promise<void> => {
        const data = await getStorageData()
        delete data[key]
        await setStorageData(data)
      },
      all: async (): Promise<Record<string, unknown>> => {
        return await getStorageData()
      }
    },
    env: process.env,
    signal
  }

  try {
    emit('system', `[Script] 编译并启动执行 (${language.toUpperCase()})`)
    const fn = await compileScriptToFunction(code, language)
    const result = await fn({ cockpit: ctx })
    const durationMs = Date.now() - start
    if (result !== undefined) {
      emit('result', result)
    }
    emit('system', `[Script] 执行完成 (耗时: ${durationMs}ms)`)
    return { ok: true, result, durationMs }
  } catch (err: unknown) {
    const durationMs = Date.now() - start
    const msg = err instanceof Error ? err.stack || err.message : String(err)
    emit('error', msg)
    emit('system', `[Script] 执行失败: ${msg}`)
    return { ok: false, error: msg, durationMs }
  }
}
