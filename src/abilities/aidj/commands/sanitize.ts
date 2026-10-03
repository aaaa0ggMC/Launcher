import type { CommandSpec } from '../../../main/process/commands/types'
import { estimate, loadClouds, switchRun } from '../sanitize/run'
import {
  listArchivedDrafts,
  loadDraft,
  loadRuns,
  restoreArchivedDraft,
  saveDraft,
  type VocabDraft
} from '../sanitize/store'
import { repairFieldVocab, SANITIZE_FIELDS, type SanitizeField } from '../sanitize/vocab'
import { syncSlotsAndBroadcast } from './metadata-slots'

function parseFields(v: unknown): SanitizeField[] {
  const list = String(v ?? '')
    .split(',')
    .map((s) => s.trim())
  const out = SANITIZE_FIELDS.filter((f) => list.includes(f))
  return out.length ? out : [...SANITIZE_FIELDS]
}

const UI = ['AIDJ 页面菜单 · 标签整理']

export const sanitizeCommands: CommandSpec[] = [
  {
    name: 'aidj.tags-cloud',
    description:
      '标签整理：当前写入槽位（主曲库 + B 站）里 emotion / genre / language / loudness 的标签词云（标签 + 歌曲数）',
    usage: 'aidj.tags-cloud',
    ui: UI,
    related: ['job:aidj.vocab-propose', 'job:aidj.sanitize'],
    run: async () => ({ ok: true, ...(await loadClouds()) })
  },
  {
    name: 'aidj.vocab-draft',
    description:
      '标签整理：读取规范词表草稿；--set <json> 保存用户手动修改后的草稿（会校验并更新版本）',
    usage: 'aidj.vocab-draft [--set <draft json>]',
    ui: UI,
    run: async (ctx) => {
      if (ctx.named.set === undefined) {
        const draft = await loadDraft()
        return { ok: true, draft, clouds: await loadClouds() }
      }
      let incoming: VocabDraft
      try {
        incoming =
          typeof ctx.named.set === 'string'
            ? (JSON.parse(ctx.named.set) as VocabDraft)
            : (ctx.named.set as unknown as VocabDraft)
      } catch {
        return { ok: false, error: '--set 不是合法 JSON' }
      }
      const clouds = await loadClouds()
      const draft: VocabDraft = {
        version: Date.now(),
        createdAt: incoming.createdAt || Date.now(),
        requirement: String(incoming.requirement ?? ''),
        fields: {},
        notes: {}
      }
      for (const f of SANITIZE_FIELDS) {
        const fv = incoming.fields?.[f]
        if (!fv) continue
        // Same repair as AI output: targets must be canonical, canonical maps to itself.
        const { vocab, unmapped, badTargets } = repairFieldVocab(
          f,
          { canonical: fv.canonical, map: fv.map },
          clouds[f]
        )
        draft.fields[f] = vocab
        draft.notes![f] = { unmapped, badTargets }
      }
      await saveDraft(draft)
      return { ok: true, draft }
    }
  },
  {
    name: 'aidj.vocab-drafts',
    description:
      '标签整理：被新提案替换下来的历史草稿（最近 10 份；版本、时间、要求、各字段规范标签数）',
    usage: 'aidj.vocab-drafts',
    ui: UI,
    related: ['aidj.vocab-draft-restore', 'job:aidj.vocab-propose'],
    run: async () => ({ ok: true, drafts: await listArchivedDrafts() })
  },
  {
    name: 'aidj.vocab-draft-restore',
    description: '标签整理：把一份历史草稿恢复为当前草稿（当前草稿会先存档，不会丢）',
    usage: 'aidj.vocab-draft-restore --version <n>',
    ui: UI,
    related: ['aidj.vocab-drafts'],
    run: async (ctx) => {
      const version = Number(ctx.named.version)
      if (!version) return { ok: false, error: '需要 --version' }
      const draft = await restoreArchivedDraft(version)
      return draft ? { ok: true, draft } : { ok: false, error: '找不到这份历史草稿' }
    }
  },
  {
    name: 'aidj.sanitize-estimate',
    description:
      '标签整理第 3 步：用当前草稿预估每个来源槽位有多少首可直接映射、多少首需要 SanitizeAgent',
    usage: 'aidj.sanitize-estimate [--fields ...] [--fill-unknown true|false]',
    ui: UI,
    related: ['job:aidj.sanitize'],
    run: async (ctx) => {
      const draft = await loadDraft()
      if (!draft) return { ok: false, error: '还没有规范词表草稿' }
      const fields = parseFields(ctx.named.fields)
      const vocab = {
        ...draft,
        fields: Object.fromEntries(
          fields.filter((f) => draft.fields[f]).map((f) => [f, draft.fields[f]])
        )
      }
      return {
        ok: true,
        ...(await estimate(vocab, {
          fillUnknownLanguage: String(ctx.named['fill-unknown']) !== 'false'
        }))
      }
    }
  },
  {
    name: 'aidj.sanitize-runs',
    description: '标签整理：历次整理记录（来源 → 新槽位、统计、是否正在使用）',
    usage: 'aidj.sanitize-runs',
    ui: UI,
    related: ['aidj.sanitize-switch', 'job:aidj.sanitize'],
    run: async () => ({ ok: true, runs: await loadRuns() })
  },
  {
    name: 'aidj.sanitize-switch',
    description:
      '标签整理：切换到某次整理后的元数据槽位（启用新槽位、禁用来源、写入目标与规范词表随之切换），或切回之前的',
    usage: 'aidj.sanitize-switch --run <id> --use sanitized|original',
    ui: UI,
    related: ['aidj.sanitize-runs', 'aidj.metadata-slots-list'],
    run: async (ctx) => {
      const runId = String(ctx.named.run ?? '')
      const use = ctx.named.use === 'original' ? 'original' : 'sanitized'
      if (!runId) return { ok: false, error: '需要 --run 参数' }
      const r = await switchRun(runId, use)
      if (!r.ok) return r
      const synced = await syncSlotsAndBroadcast()
      return { ok: true, ...synced }
    }
  }
]
