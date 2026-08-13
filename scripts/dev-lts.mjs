#!/usr/bin/env node
/**
 * dev:lts — fast cold start for a dev loop without HMR.
 *
 * - Hashes all source/config that affects the build output.
 * - If the hash matches the last build AND out/ exists → reuse it and just
 *   start Electron (electron-vite preview --skipBuild). No rebuild.
 * - Otherwise → electron-vite build, persist the hash, then start Electron.
 *
 * The hash lives in node_modules/.cache/dev-lts.hash (auto-ignored).
 * Trade-off vs `pnpm dev`: no Vite dev server / HMR — a change needs a rerun.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { spawnSync } from 'child_process'

const root = process.cwd()
const HASH_FILE = join(root, 'node_modules', '.cache', 'dev-lts.hash')
const ELECTRON_VITE_BIN = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vite', '.vscode'])
const IGNORE_FILES = new Set(['.eslintcache'])

function collectFiles(dir) {
  const acc = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) acc.push(...collectFiles(p))
    } else if (!IGNORE_FILES.has(name)) {
      acc.push(p)
    }
  }
  return acc
}

function computeHash() {
  const h = createHash('sha256')
  const files = collectFiles(join(root, 'src'))
  for (const f of [
    'electron.vite.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json'
  ]) {
    const p = join(root, f)
    if (existsSync(p)) files.push(p)
  }
  const resources = join(root, 'resources')
  if (existsSync(resources)) files.push(...collectFiles(resources))
  for (const f of files.sort()) {
    h.update(relative(root, f))
    h.update('\0')
    h.update(readFileSync(f))
  }
  return h.digest('hex')
}

function runElectronVite(args) {
  const r = spawnSync(process.execPath, [ELECTRON_VITE_BIN, ...args], {
    stdio: 'inherit',
    cwd: root
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const prev = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8') : ''
const cur = computeHash()
const built =
  existsSync(join(root, 'out', 'main', 'index.js')) &&
  existsSync(join(root, 'out', 'renderer', 'index.html'))

if (prev === cur && built) {
  console.log('[dev:lts] source unchanged — reusing build')
} else {
  console.log('[dev:lts] source changed or missing build — rebuilding')
  runElectronVite(['build'])
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true })
  writeFileSync(HASH_FILE, cur)
}

runElectronVite(['preview', '--skipBuild'])
