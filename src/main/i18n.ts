import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { APP_ROOT, CONFIG_JSON } from './paths'

const TRANS_DIR = join(APP_ROOT, 'src', 'renderer', 'translations')

let cache: Record<string, Record<string, string>> | null = null

function load(): Record<string, Record<string, string>> {
  if (cache) return cache
  cache = {}
  for (const lang of ['zh', 'en-US']) {
    try {
      const p = join(TRANS_DIR, `${lang}.json`)
      cache[lang] = JSON.parse(readFileSync(p, 'utf-8'))
    } catch {
      cache[lang] = {}
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