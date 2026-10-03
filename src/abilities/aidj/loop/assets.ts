/**
 * Markdown assets of the DJ loop (`prompts/*.md`, `playbooks/*.md`).
 *
 * In the app they are inlined at build time (`import.meta.glob` + `?raw`, the
 * same mechanism as the help pages) so the packaged build needs no files on
 * disk. Under plain Node (`tsx --test`) `import.meta.glob` does not exist, so we
 * fall back to reading the files next to this module.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

type Dir = 'prompts' | 'playbooks'

function fromDisk(dir: Dir): Record<string, string> {
  const base = join(__dirname, dir)
  const out: Record<string, string> = {}
  for (const f of readdirSync(base)) {
    if (f.endsWith('.md')) out[f.slice(0, -3)] = readFileSync(join(base, f), 'utf8')
  }
  return out
}

function byName(mods: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, text] of Object.entries(mods)) {
    const name = path.replace(/^.*\//, '').replace(/\.md$/, '')
    out[name] = text
  }
  return out
}

function load(dir: Dir): Record<string, string> {
  try {
    const mods =
      dir === 'prompts'
        ? import.meta.glob<string>('./prompts/*.md', {
            query: '?raw',
            import: 'default',
            eager: true
          })
        : import.meta.glob<string>('./playbooks/*.md', {
            query: '?raw',
            import: 'default',
            eager: true
          })
    return byName(mods)
  } catch {
    return fromDisk(dir)
  }
}

let cache: Partial<Record<Dir, Record<string, string>>> = {}

/** `name → text` of every `.md` file in `loop/<dir>/` (trailing newline trimmed). */
export function loopAssets(dir: Dir): Record<string, string> {
  if (!cache[dir]) {
    const raw = load(dir)
    cache[dir] = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replace(/\n+$/, '')]))
  }
  return cache[dir]!
}

/** Test hook. */
export function clearLoopAssetCache(): void {
  cache = {}
}
