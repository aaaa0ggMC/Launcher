import { readdir, stat, readFile, writeFile, mkdir } from 'fs/promises'
import { join, extname, basename } from 'path'
import { tmpdir } from 'os'
import { ipcMain } from 'electron'
import { EXTERNAL_ABILITIES_DIR } from './paths'
import { makeLogger } from './logger'

const log = makeLogger('ability-loader')

// esbuild is externalized (see electron.vite.config.ts); resolved at runtime
// from the project's node_modules. Used to compile external ability .ts files.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const esbuild = require('esbuild')

export interface AbilityContext {
  ipcMain: typeof ipcMain
  handle: (channel: string, fn: (payload?: unknown) => unknown | Promise<unknown>) => void
  log: (...args: unknown[]) => void
}

/**
 * Load backend-only modules from the external abilities dir
 * (~/.config/LinuxCockpit/abilities/). Each module may export:
 *   export function register(ctx: AbilityContext): void | Promise<void>
 * Its IPC channels are namespaced as `<ability-id>:<channel>`.
 */
export async function loadExternalAbilities(): Promise<void> {
  await mkdir(EXTERNAL_ABILITIES_DIR, { recursive: true }).catch(() => {})
  const names = await readdir(EXTERNAL_ABILITIES_DIR).catch(() => [])
  for (const name of names) {
    const full = join(EXTERNAL_ABILITIES_DIR, name)
    const st = await stat(full).catch(() => null)
    if (!st) continue

    let filePath = ''
    if (st.isFile() && ['.ts', '.js', '.mjs', '.cjs'].includes(extname(name))) {
      filePath = full
    } else if (st.isDirectory()) {
      for (const candidate of [
        join(full, 'index.ts'),
        join(full, 'index.js'),
        join(full, 'index.mjs')
      ]) {
        if (await stat(candidate).catch(() => null)) {
          filePath = candidate
          break
        }
      }
    }
    if (!filePath) continue

    try {
      const mod = await importAbility(filePath)
      if (typeof mod.register === 'function') {
        await mod.register(makeContext(basename(name, extname(name))))
        log.info('external ability loaded', { name })
      }
    } catch (e) {
      log.error('failed to load external ability', {
        name,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
}

function makeContext(id: string): AbilityContext {
  return {
    ipcMain,
    handle: (channel, fn) => {
      ipcMain.handle(`${id}:${channel}`, (_e, payload) => fn(payload))
    },
    log: (...args) => log.info(`[${id}] ${args.join(' ')}`)
  }
}

/** Import a backend module. .ts/.mjs are compiled to CJS on the fly (the main
 * bundle is CJS, so we can't natively require ESM); plain .js/.cjs load direct. */
async function importAbility(filePath: string): Promise<Record<string, unknown>> {
  if (filePath.endsWith('.ts') || filePath.endsWith('.mjs')) {
    const code = await readFile(filePath, 'utf-8')
    const result = await esbuild.transform(code, {
      format: 'cjs',
      loader: filePath.endsWith('.mjs') ? 'js' : 'ts',
      sourcefile: filePath
    })
    const tmpFile = join(
      tmpdir(),
      `cockpit-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
    )
    await writeFile(tmpFile, result.code, 'utf-8')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(tmpFile) as Record<string, unknown>
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(filePath) as Record<string, unknown>
}
