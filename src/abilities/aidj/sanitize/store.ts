/**
 * Files of the tag sanitizer (under ~/.config/LinuxCockpit/aidj/sanitize/):
 *   draft.json        — vocabulary being reviewed
 *   active.json       — vocabulary in force (forward: new metadata conforms to it)
 *   runs.json         — every sanitize run (source → output slots, switch state)
 *   cache-<v>.jsonl   — SanitizeAgent results per vocabulary version (resume)
 */
import { readFile, appendFile, mkdir, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../../../main/process/util'
import { makeLogger } from '../../../main/process/logger'
import { getAidjDir } from '../services/config'
import type { SongMeta } from '../types'
import type { SanitizeField, TagVocab } from './vocab'

const log = makeLogger('aidj-sanitize')

function dir(): string {
  return join(getAidjDir(), 'sanitize')
}

async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(dir(), name), 'utf-8')) as T
  } catch {
    return null
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(dir(), { recursive: true })
  await writeJsonAtomic(join(dir(), name), value)
}

// -- vocabulary -------------------------------------------------------------

export interface VocabDraft extends TagVocab {
  /** Per field: old tags the AI did not map / targets it invented (shown in review). */
  notes?: Partial<Record<SanitizeField, { unmapped: string[]; badTargets: string[] }>>
}

export const loadDraft = (): Promise<VocabDraft | null> => readJson<VocabDraft>('draft.json')
export const saveDraft = (d: VocabDraft): Promise<void> => writeJson('draft.json', d)

const MAX_ARCHIVED = 10

export interface ArchivedDraftInfo {
  version: number
  createdAt: number
  archivedAt: number
  requirement: string
  /** field → canonical tag count */
  fields: Partial<Record<SanitizeField, number>>
}

/**
 * Keep the current draft before a new proposal replaces it (drafts/<version>.json,
 * newest MAX_ARCHIVED kept). Manual review edits do not archive — they refine
 * the same draft.
 */
export async function archiveDraft(): Promise<void> {
  const cur = await loadDraft()
  if (!cur) return
  const d = join(dir(), 'drafts')
  await mkdir(d, { recursive: true })
  await writeJsonAtomic(join(d, `${cur.version}.json`), { ...cur, archivedAt: Date.now() })
  const files = (await readdir(d)).filter((f) => f.endsWith('.json')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - MAX_ARCHIVED))) {
    await rm(join(d, f), { force: true })
  }
}

export async function listArchivedDrafts(): Promise<ArchivedDraftInfo[]> {
  const d = join(dir(), 'drafts')
  const out: ArchivedDraftInfo[] = []
  let files: string[] = []
  try {
    files = (await readdir(d)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    const v = await readJson<VocabDraft & { archivedAt?: number }>(join('drafts', f))
    if (!v) continue
    out.push({
      version: v.version,
      createdAt: v.createdAt,
      archivedAt: v.archivedAt ?? v.createdAt,
      requirement: v.requirement,
      fields: Object.fromEntries(
        Object.entries(v.fields).map(([k, fv]) => [k, fv?.canonical.length ?? 0])
      )
    })
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt)
}

/** Make an archived draft the current one (the current one is archived first). */
export async function restoreArchivedDraft(version: number): Promise<VocabDraft | null> {
  const v = await readJson<VocabDraft>(join('drafts', `${version}.json`))
  if (!v) return null
  await archiveDraft()
  const restored: VocabDraft = { ...v, version: Date.now() }
  delete (restored as { archivedAt?: number }).archivedAt
  await saveDraft(restored)
  return restored
}

let active: TagVocab | null | undefined

/** Vocabulary in force (cached). Null = no sanitized metadata is in use. */
export async function loadActiveVocab(): Promise<TagVocab | null> {
  if (active === undefined) active = await readJson<TagVocab>('active.json')
  return active
}

export async function setActiveVocab(v: TagVocab | null): Promise<void> {
  active = v
  if (v) await writeJson('active.json', v)
  else await rm(join(dir(), 'active.json'), { force: true })
}

// -- runs -------------------------------------------------------------------

export interface SanitizeRun {
  id: string
  createdAt: number
  vocab: TagVocab
  fields: SanitizeField[]
  /** source slot id → output slot id */
  pairs: {
    source: string
    /** '' when nothing changed (no new slot; the source stays in use). */
    output: string
    kind: 'main' | 'bili'
    /** Songs whose metadata changed. */
    changed?: number
    total: number
    direct: number
    agent: number
  }[]
  status: 'done' | 'partial'
  /** What was in use before switching to this run (restored on switch back). */
  previous?: { activeWriteSlot: string; biliDefaultSlot?: string; activeRunId?: string }
  active?: boolean
}

export async function loadRuns(): Promise<SanitizeRun[]> {
  return (await readJson<{ runs: SanitizeRun[] }>('runs.json'))?.runs ?? []
}

export async function saveRuns(runs: SanitizeRun[]): Promise<void> {
  await writeJson('runs.json', { runs })
}

// -- resume cache -------------------------------------------------------------

export async function loadCache(version: number): Promise<Map<string, Partial<SongMeta>>> {
  const map = new Map<string, Partial<SongMeta>>()
  try {
    const text = await readFile(join(dir(), `cache-${version}.jsonl`), 'utf-8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as { name: string; meta: Partial<SongMeta> }
        if (e.name) map.set(e.name, e.meta)
      } catch {
        /* skip */
      }
    }
  } catch {
    /* none yet */
  }
  return map
}

export async function appendCache(
  version: number,
  name: string,
  meta: Partial<SongMeta>
): Promise<void> {
  await mkdir(dir(), { recursive: true })
  await appendFile(join(dir(), `cache-${version}.jsonl`), JSON.stringify({ name, meta }) + '\n')
}

export { log as sanitizeLog }
