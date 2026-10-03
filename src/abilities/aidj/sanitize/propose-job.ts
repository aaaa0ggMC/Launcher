/**
 * Background job `aidj.vocab-propose` — VocabAgent for every selected field in
 * parallel. Runs as a job (not a command) so it survives leaving the page and
 * shows live progress: per field `vocab_field` events (status, streamed chars,
 * elapsed) and a final `vocab_done`. The result is saved as the draft.
 *
 * args: { fields: string[], requirement: string, feedback?: string }
 */
import OpenAI from 'openai'
import { registerJobHandler } from '../../../main/process/background-tasks'
import { loadAidjConfig } from '../services/config'
import { resolveLoopPolicy } from '../loop/policy'
import { proposeFieldVocab } from './agents'
import { loadClouds } from './run'
import { archiveDraft, loadDraft, saveDraft, sanitizeLog as log, type VocabDraft } from './store'
import { SANITIZE_FIELDS, type SanitizeField } from './vocab'

/** Tag shared by every sanitize-related job, so the view can find and reattach to them. */
export const SANITIZE_TAG = 'aidj-sanitize'

registerJobHandler('aidj.vocab-propose', async (control, args) => {
  const config = await loadAidjConfig()
  if (!config) {
    control.pushLine('错误: AIDJ 配置未找到', 'stderr')
    control.finish('error')
    return
  }
  const wanted = Array.isArray(args.fields) ? (args.fields as string[]) : []
  const fields = SANITIZE_FIELDS.filter((f) => wanted.includes(f))
  if (!fields.length) {
    control.pushLine('错误: 没有选择字段', 'stderr')
    control.finish('error')
    return
  }
  const requirement = String(args.requirement ?? '')
  const feedback = String(args.feedback ?? '')
  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  const prev = await loadDraft()
  const clouds = await loadClouds()
  const client = new OpenAI({
    apiKey: config.secrets.api_key,
    baseURL: config.ai_settings.base_url
  })
  // Big fields stream for minutes on thinking models — give them room.
  const timeoutMs = Math.max(600, resolveLoopPolicy(config).fetch_timeout_sec) * 1000
  const started = Date.now()
  const emit = (field: SanitizeField, data: Record<string, unknown>): void =>
    control.push({ data: { type: 'vocab_field', field, ...data } })

  for (const f of fields)
    emit(f, { status: 'running', tags: clouds[f].length, chars: 0, thinking: 0, ms: 0 })
  control.pushLine(
    `VocabAgent: ${fields.map((f) => `${f}(${clouds[f].length})`).join(', ')}${feedback ? ' · 按意见重做' : ''}`
  )
  log.info('vocab propose start', { fields, requirement, feedback: !!feedback })

  let done = 0
  const settled = await Promise.allSettled(
    fields.map(async (field) => {
      const t0 = Date.now()
      try {
        const r = await proposeFieldVocab({
          client,
          config,
          field,
          cloud: clouds[field],
          requirement,
          feedback,
          previous: prev?.fields[field],
          timeoutMs,
          signal: ac.signal,
          onProgress: (chars, thinking) =>
            emit(field, {
              status: 'running',
              tags: clouds[field].length,
              chars,
              thinking,
              ms: Date.now() - t0
            })
        })
        emit(field, {
          status: 'done',
          tags: clouds[field].length,
          canonical: r.vocab.canonical.length,
          unmapped: r.unmapped.length,
          ms: Date.now() - t0
        })
        control.pushLine(
          `✓ ${field}: ${clouds[field].length} → ${r.vocab.canonical.length} 个规范标签（未映射 ${r.unmapped.length}，${Math.round((Date.now() - t0) / 1000)}s）`
        )
        return r
      } catch (e) {
        const error = ac.signal.aborted ? '已停止' : String(e instanceof Error ? e.message : e)
        emit(field, { status: 'error', error, ms: Date.now() - t0 })
        control.pushLine(`✗ ${field}: ${error}`, 'stderr')
        log.warn('vocab propose field failed', { field, error })
        throw e
      } finally {
        control.setProgress(Math.round((++done / fields.length) * 100))
      }
    })
  )

  if (ac.signal.aborted) {
    control.push({ data: { type: 'vocab_done', ok: false } })
    control.finish('cancelled')
    return
  }
  // Re-proposing some fields keeps the other fields of the draft (same requirement).
  const keepOld = prev && prev.requirement === requirement
  const draft: VocabDraft = {
    version: Date.now(),
    createdAt: Date.now(),
    requirement,
    fields: keepOld ? { ...prev.fields } : {},
    notes: keepOld ? { ...(prev.notes ?? {}) } : {}
  }
  let ok = 0
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const f = fields[i]
    draft.fields[f] = r.value.vocab
    draft.notes![f] = { unmapped: r.value.unmapped, badTargets: r.value.badTargets }
    ok++
  })
  if (ok) {
    // Never lose the previous proposal: archive it before replacing.
    await archiveDraft()
    await saveDraft(draft)
  }
  log.info('vocab propose done', { ok, failed: fields.length - ok, ms: Date.now() - started })
  control.push({ data: { type: 'vocab_done', ok: ok > 0 } })
  control.pushLine(ok ? `草稿已保存（${ok}/${fields.length} 个字段）` : '全部字段失败，草稿未改动')
  control.finish(ok === fields.length ? 'exited' : 'error')
})
