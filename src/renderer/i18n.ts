import type { Ref } from 'vue'
import type { AppEntry } from '@shared/types'
import zh from './translations/zh.json'
import enUS from './translations/en-US.json'
import languages from './translations/index.json'

export interface LanguageMeta {
  code: string
  label: string
}

export const availableLanguages: LanguageMeta[] = languages as LanguageMeta[]

type Table = Record<string, string>

const tables: Record<string, Table> = {
  zh: zh as Table,
  'en-US': enUS as Table
}

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

export function localize(
  entry: AppEntry,
  field: 'name' | 'description' | 'alias',
  lang: string
): string | undefined {
  // preferred language → en-US fallback → first available → base field
  const direct = entry.localized?.[lang]?.[field]
  if (direct) return direct
  const fallback = entry.localized?.['en-US']?.[field] ?? entry.localized?.['en_US']?.[field]
  if (fallback) return fallback
  if (entry.localized) {
    for (const val of Object.values(entry.localized)) {
      const v = val[field]
      if (v) return v
    }
  }
  return entry[field]
}

export function useI18n(lang: Ref<string>) {
  const t = (key: string, fallback?: string): string => translate(lang.value, key, fallback)
  const te = (key: string, vars: Record<string, string>, fallback?: string): string =>
    translateTemplate(lang.value, key, vars, fallback)
  const entryName = (entry: AppEntry): string => localize(entry, 'name', lang.value) ?? ''
  const entryDescription = (entry: AppEntry): string =>
    localize(entry, 'description', lang.value) ?? ''
  const entryAlias = (entry: AppEntry): string => localize(entry, 'alias', lang.value) ?? ''
  return { t, te, entryName, entryDescription, entryAlias, lang }
}
