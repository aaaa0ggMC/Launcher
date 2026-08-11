import type { Ref } from 'vue'
import zh from './translations/zh.json'
import enUS from './translations/en-US.json'
import languages from './translations/index.json'

export interface LanguageMeta {
  code: string
  label: string
}

export const availableLanguages: LanguageMeta[] = languages as LanguageMeta[]

type Table = Record<string, string>

/**
 * Translations are split per module (src/main/ui + each ability + each
 * background), then merged here into per-language tables. Every module owns
 * its keys with a namespaced prefix, so merges never collide.
 */
const tables: Record<string, Table> = {
  zh: { ...(zh as Table) },
  'en-US': { ...(enUS as Table) }
}

function mergeModuleTables(
  modules: Record<string, unknown>,
  tablesToMerge: Record<string, Table>
): void {
  for (const key of Object.keys(modules)) {
    const lang = key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, '')
    const table = tablesToMerge[lang]
    if (!table) continue
    Object.assign(table, modules[key] as Table)
  }
}

// Every ability + background folder may ship its own translations/<lang>.json.
mergeModuleTables(
  import.meta.glob('../../abilities/*/translations/*.json', {
    eager: true,
    import: 'default'
  }),
  tables
)
mergeModuleTables(
  import.meta.glob('../../background/*/translations/*.json', {
    eager: true,
    import: 'default'
  }),
  tables
)

export function translate(lang: string, key: string, fallback?: string): string {
  const table = tables[lang] ?? tables.zh ?? {}
  let text = table[key]
  if (text === undefined && lang !== 'zh') text = (tables.zh as Table)[key]
  if (text === undefined) text = fallback ?? key
  return text
}

export function translateTemplate(
  lang: string,
  key: string,
  vars: Record<string, string>,
  fallback?: string
): string {
  let text = translate(lang, key, fallback)
  for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v)
  return text
}

export function useI18n(lang: Ref<string>): {
  t: (key: string, fallback?: string) => string
  te: (key: string, vars: Record<string, string>, fallback?: string) => string
  lang: Ref<string>
} {
  const t = (key: string, fallback?: string): string => translate(lang.value, key, fallback)
  const te = (key: string, vars: Record<string, string>, fallback?: string): string =>
    translateTemplate(lang.value, key, vars, fallback)
  return { t, te, lang }
}
