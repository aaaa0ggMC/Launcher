/**
 * The sanitize run (background job `aidj.sanitize`) and the slot switch.
 *
 * Sources = the default metadata slot and the Bilibili default slot. Each is
 * copied into a NEW slot (`Sanitized-<date>.metadata` / `Bilibili-Sanitized-…`)
 * — originals are never modified. Output slots are registered disabled; the
 * user switches with `aidj.sanitize-switch` (and back).
 */
import { writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'
import { registerJobHandler } from '../../../main/process/background-tasks'
import { loadAidjConfig, getMetadataDir } from '../services/config'
import {
  getBiliDefaultSlotName,
  getMetadataSlotEntries,
  loadSlotsConfig,
  saveSlotsConfig,
  invalidateSlotCache
} from '../services/metadata-slots'
import { loadLibrary } from '../services/library'
import { getLyricsIndex } from '../loop/agent/workflow'
import { resolveLoopPolicy } from '../loop/policy'
import type { SongMeta } from '../types'
import { applyVocab, buildClouds, SANITIZE_FIELDS, type TagVocab } from './vocab'
import { sanitizeSongs } from './agents'
import {
  appendCache,
  loadCache,
  loadDraft,
  loadRuns,
  saveRuns,
  setActiveVocab,
  sanitizeLog as log,
  type SanitizeRun
} from './store'

export interface SanitizeSource {
  id: string
  label: string
  bili: boolean
  entries: Map<string, SongMeta>
}

/**
 * The sources = the CURRENT write targets: the main write slot and the
 * Bilibili default slot. After switching to a sanitized run these are its
 * outputs (which also collect new songs), so a re-run starts from there.
 */
export async function loadSources(): Promise<SanitizeSource[]> {
  const out: SanitizeSource[] = []
  const cfg = await loadSlotsConfig()
  const mainId = cfg.activeWriteSlot || 'default'
  const biliId = await getBiliDefaultSlotName()
  const ids: [string, boolean][] = [[mainId, false]]
  if (biliId !== mainId) ids.push([biliId, true])
  for (const [id, bili] of ids) {
    const { slot, entries } = await getMetadataSlotEntries(id)
    if (!slot || !entries.length) continue
    out.push({
      id,
      label: slot.name,
      bili,
      entries: new Map(entries.map((e) => [e.name, e.metadata]))
    })
  }
  return out
}

/** Tag clouds over every song of the sources. */
export async function loadClouds(): Promise<ReturnType<typeof buildClouds> & { songs: number }> {
  const sources = await loadSources()
  const metas = sources.flatMap((s) => [...s.entries.values()])
  return { ...buildClouds(metas), songs: metas.length }
}

export interface Estimate {
  sources: { id: string; label: string; total: number; direct: number; agent: number }[]
  /** Most common reasons a song needs the agent (e.g. "genre:city-pop"). */
  reasons: { reason: string; count: number }[]
  cached: number
}

export async function estimate(
  vocab: TagVocab,
  opts: { fillUnknownLanguage: boolean }
): Promise<Estimate> {
  const sources = await loadSources()
  const cache = await loadCache(vocab.version)
  const reasons = new Map<string, number>()
  let cached = 0
  const out: Estimate['sources'] = []
  for (const s of sources) {
    let direct = 0
    let agent = 0
    for (const [name, meta] of s.entries) {
      const r = applyVocab(meta, vocab, opts)
      if (!r.needs.length) {
        direct++
        continue
      }
      agent++
      if (cache.has(name)) cached++
      for (const n of r.needs) {
        const key = n.startsWith('language:') ? n : n.replace(/:.*/, ':…')
        reasons.set(key, (reasons.get(key) ?? 0) + 1)
      }
    }
    out.push({ id: s.id, label: s.label, total: s.entries.size, direct, agent })
  }
  return {
    sources: out,
    reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    cached
  }
}

/** Key-order independent JSON (compare metadata before / after). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function freeSlotName(base: string): string {
  let name = `${base}.metadata`
  for (let i = 2; existsSync(join(getMetadataDir(), name)); i++) name = `${base}-${i}.metadata`
  return name
}

/** Register the output slot DISABLED first, then write it — never live half-written. */
async function writeOutputSlot(name: string, entries: Map<string, SongMeta>): Promise<void> {
  const cfg = await loadSlotsConfig()
  cfg.slots = cfg.slots ?? {}
  cfg.slots[name] = { enabled: false, disabledSongs: [] }
  await saveSlotsConfig(cfg)
  const path = join(getMetadataDir(), name)
  const text = [...entries].map(([n, metadata]) => JSON.stringify({ name: n, metadata })).join('\n')
  await writeFile(path, text ? `${text}\n` : '', 'utf-8')
  invalidateSlotCache(path)
}

registerJobHandler('aidj.sanitize', async (control, args) => {
  const config = await loadAidjConfig()
  const draft = await loadDraft()
  if (!config || !draft) {
    control.pushLine('错误: 没有可用的规范词表，请先在「标签整理」里生成并审核', 'stderr')
    control.finish('error')
    return
  }
  const wanted = Array.isArray(args.fields) ? (args.fields as string[]) : [...SANITIZE_FIELDS]
  const fields = SANITIZE_FIELDS.filter((f) => wanted.includes(f) && draft.fields[f])
  const vocab: TagVocab = {
    version: draft.version,
    createdAt: draft.createdAt,
    requirement: draft.requirement,
    fields: Object.fromEntries(fields.map((f) => [f, draft.fields[f]]))
  }
  const fillUnknownLanguage = args.fillUnknownLanguage !== false
  const perCall = Math.max(1, Math.min(20, Number(args.songsPerCall) || 1))
  const concurrency = Math.max(1, Math.min(16, config.preferences.metadata_concurrency || 4))
  const timeoutMs = resolveLoopPolicy(config).fetch_timeout_sec * 1000

  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  const sources = await loadSources()
  const lib = await loadLibrary()
  const lyrics = getLyricsIndex(lib.musicPaths, lib.lyrics)
  const cache = await loadCache(vocab.version)
  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })

  // 1. Map in code; collect the songs that still need the agent.
  const results = new Map<string, Map<string, SongMeta>>()
  const todo: { source: string; name: string; meta: SongMeta; base: SongMeta }[] = []
  const stats = new Map<string, { total: number; direct: number; agent: number }>()
  for (const s of sources) {
    const out = new Map<string, SongMeta>()
    const st = { total: s.entries.size, direct: 0, agent: 0 }
    for (const [name, meta] of s.entries) {
      const r = applyVocab(meta, vocab, { fillUnknownLanguage })
      out.set(name, r.meta)
      if (!r.needs.length) st.direct++
      else {
        st.agent++
        const hit = cache.get(name)
        if (hit) out.set(name, { ...r.meta, ...hit })
        else todo.push({ source: s.id, name, meta, base: r.meta })
      }
    }
    results.set(s.id, out)
    stats.set(s.id, st)
    control.pushLine(`${s.label}: ${st.total} 首 · 直接映射 ${st.direct} · 需 AI ${st.agent}`)
  }
  const resumed = [...stats.values()].reduce((a, s) => a + s.agent, 0) - todo.length
  if (resumed > 0) control.pushLine(`从缓存恢复 ${resumed} 首（同一词表的上次结果）`)
  control.pushLine(
    `SanitizeAgent: ${todo.length} 首，每次 ${perCall} 首，并发 ${concurrency}，字段 ${fields.join(', ')}`
  )

  // 2. SanitizeAgent over the rest (resumable: every result goes to the cache).
  const batches: (typeof todo)[] = []
  for (let i = 0; i < todo.length; i += perCall) batches.push(todo.slice(i, i + perCall))
  let done = 0
  let failed = 0
  let promptTokens = 0
  let completionTokens = 0
  control.setProgress(todo.length ? 0 : 100)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (!ac.signal.aborted) {
        const batch = batches[next++]
        if (!batch) return
        try {
          const outs = await sanitizeSongs({
            client,
            config,
            vocab,
            fields,
            songs: batch.map((b, i) => ({
              id: `s${i + 1}`,
              name: b.name,
              meta: b.meta,
              lyrics: lyrics.excerpt(b.name, 20)
            })),
            timeoutMs,
            signal: ac.signal,
            onUsage: (p, c) => {
              promptTokens += p
              completionTokens += c
            }
          })
          for (let i = 0; i < batch.length; i++) {
            const b = batch[i]
            const o = outs[i]
            if (o?.meta && Object.keys(o.meta).length) {
              results.get(b.source)!.set(b.name, { ...b.base, ...o.meta })
              await appendCache(vocab.version, b.name, o.meta)
              const tags = fields
                .map((f) => o.meta?.[f])
                .filter(Boolean)
                .map((v) => (Array.isArray(v) ? v.join('/') : String(v)))
                .join(' · ')
              control.pushLine(
                `✓ ${b.name} → ${tags}${o.invalid.length ? `（丢弃无效: ${o.invalid.join(', ')}）` : ''}`
              )
            } else {
              failed++
              control.pushLine(`✗ ${b.name}: 无有效输出，保留可映射部分`, 'stderr')
            }
          }
        } catch (e) {
          if (ac.signal.aborted) return
          failed += batch.length
          log.warn('sanitize batch failed', { error: String(e) })
          control.pushLine(`✗ ${batch.map((b) => b.name).join(', ')}: ${String(e)}`, 'stderr')
        }
        done += batch.length
        control.setProgress(Math.round((done / Math.max(1, todo.length)) * 100))
      }
    })
  )

  if (ac.signal.aborted) {
    control.pushLine('已停止。已完成的结果保存在缓存里，用同一词表重新开始会接着做。')
    control.finish('cancelled')
    return
  }

  // 3. Write the new slots (disabled) and record the run.
  const date = today()
  const run: SanitizeRun = {
    id: `run-${Date.now().toString(36)}`,
    createdAt: Date.now(),
    vocab,
    fields,
    pairs: [],
    status: failed ? 'partial' : 'done'
  }
  for (const s of sources) {
    const out = results.get(s.id)!
    const changed = [...s.entries].filter(([n, m]) => stable(m) !== stable(out.get(n))).length
    const kind = s.bili ? ('bili' as const) : ('main' as const)
    if (changed === 0) {
      // Nothing to change → no copy, the write target stays on the original.
      run.pairs.push({ source: s.id, output: '', kind, changed, ...stats.get(s.id)! })
      control.pushLine(`${s.label}: 无变化，沿用原槽位（不新建）`)
      continue
    }
    const name = freeSlotName(s.bili ? `Bilibili-Sanitized-${date}` : `Sanitized-${date}`)
    await writeOutputSlot(name, out)
    run.pairs.push({ source: s.id, output: name, kind, changed, ...stats.get(s.id)! })
    control.pushLine(`已写入新槽位 ${name}（${changed} 首有变化，未启用）`)
  }
  const runs = await loadRuns()
  runs.unshift(run)
  await saveRuns(runs)
  control.push({ data: { type: 'sanitize_done', runId: run.id, failed } })
  control.pushLine(
    `完成：${todo.length - failed}/${todo.length} 首经 AI 清洗${failed ? `，${failed} 首失败（保留可映射部分）` : ''}；tokens ${promptTokens}+${completionTokens}。在「标签整理」里切换即可使用。`
  )
  control.finish(failed ? 'error' : 'exited')
})

/**
 * Switch the library to a run's sanitized slots, or back to what was in use
 * before (the originals, or an earlier run the new one was built from).
 */
export async function switchRun(
  runId: string,
  use: 'sanitized' | 'original'
): Promise<{ ok: boolean; error?: string }> {
  const runs = await loadRuns()
  const run = runs.find((r) => r.id === runId)
  if (!run) return { ok: false, error: '找不到这次整理记录' }
  const cfg = await loadSlotsConfig()
  cfg.slots = cfg.slots ?? {}
  const set = (id: string, enabled: boolean): void => {
    cfg.slots[id] = { disabledSongs: [], ...(cfg.slots[id] ?? {}), enabled }
  }
  if (use === 'sanitized') {
    if (run.active) return { ok: true }
    for (const p of run.pairs) {
      if (p.output && !existsSync(join(getMetadataDir(), p.output))) {
        return { ok: false, error: `槽位文件不存在: ${p.output}` }
      }
    }
    const current = runs.find((r) => r.active)
    // Record the EFFECTIVE targets (the bili slot may only exist as a fallback name).
    run.previous = {
      activeWriteSlot: cfg.activeWriteSlot || 'default',
      biliDefaultSlot: cfg.biliDefaultSlot || (await getBiliDefaultSlotName()),
      activeRunId: current?.id
    }
    if (current) current.active = false
    for (const p of run.pairs) {
      if (!p.output) continue // unchanged source: stays as it is
      set(p.source, false)
      set(p.output, true)
      // Forward: new songs land in the sanitized slots from now on.
      if (p.kind === 'bili') cfg.biliDefaultSlot = p.output
      else cfg.activeWriteSlot = p.output
    }
    run.active = true
    await setActiveVocab(run.vocab)
  } else {
    if (!run.active) return { ok: true }
    for (const p of run.pairs) {
      if (!p.output) continue
      set(p.source, true)
      set(p.output, false)
    }
    cfg.activeWriteSlot = run.previous?.activeWriteSlot ?? 'default'
    cfg.biliDefaultSlot = run.previous?.biliDefaultSlot ?? 'Bilibili-Current.metadata'
    run.active = false
    const prev = runs.find((r) => r.id === run.previous?.activeRunId)
    if (prev) prev.active = true
    await setActiveVocab(prev?.vocab ?? null)
  }
  await saveSlotsConfig(cfg)
  await saveRuns(runs)
  invalidateSlotCache()
  log.info('sanitize switch', { runId, use })
  return { ok: true }
}
