import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { APP_ROOT, CONFIG_JSON } from './paths'

const LANGUAGES = ['zh', 'en-US']

/**
 * Translation sources: the UI framework shell + every ability + every
 * background may ship their own translations/<lang>.json. They're merged into
 * per-language tables here so main-process strings (CLI output, command
 * descriptions, dialogs) use the exact same keys as the renderer.
 */
function translationDirs(): string[] {
  const dirs = [join(APP_ROOT, 'src', 'main', 'ui', 'translations')]
  for (const scope of ['abilities', 'background']) {
    const base = join(APP_ROOT, 'src', scope)
    let names: string[] = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('.')) dirs.push(join(base, name, 'translations'))
    }
  }
  return dirs
}

let cache: Record<string, Record<string, string>> | null = null

function load(): Record<string, Record<string, string>> {
  if (cache) return cache
  cache = {}
  for (const lang of LANGUAGES) cache[lang] = {}
  for (const dir of translationDirs()) {
    for (const lang of LANGUAGES) {
      try {
        const p = join(dir, `${lang}.json`)
        if (!existsSync(p)) continue
        Object.assign(cache[lang], JSON.parse(readFileSync(p, 'utf-8')))
      } catch {
        // skip unreadable translation
      }
    }
  }
  return cache
}

/** Read configured language from config.json (default 'zh'). */
export function readConfigLang(): string {
  try {
    if (!existsSync(CONFIG_JSON)) return 'zh'
    const raw = readFileSync(CONFIG_JSON, 'utf-8')
    const cfg = JSON.parse(raw)
    return typeof cfg.language === 'string' ? cfg.language : 'zh'
  } catch {
    return 'zh'
  }
}

/** Translate a key for the configured language.
 *  Fallback chain: current → en-US → zh → fallback → key. */
export function t(key: string, fallback?: string): string {
  const lang = readConfigLang()
  const tables = load()
  const table = tables[lang] ?? tables['en-US'] ?? tables['zh'] ?? {}
  let text = table[key]
  if (text === undefined && lang !== 'en-US') text = tables['en-US']?.[key]
  if (text === undefined && lang !== 'zh') text = tables['zh']?.[key]
  if (text === undefined) text = fallback ?? key
  return text
}

/** Translate with {var} replacement. */
export function te(key: string, vars: Record<string, string>, fallback?: string): string {
  let text = t(key, fallback)
  for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v)
  return text
}
