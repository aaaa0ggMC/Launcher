<script setup lang="ts">
/**
 * 标签整理 — clean up emotion / genre / language / loudness tags.
 * 1 要求 → VocabAgent proposes a canonical vocabulary per field
 * 2 审核 → edit canonical tags and the old → new map (or redo with feedback)
 * 3 执行 → background job: map in code, SanitizeAgent only where needed,
 *          output = NEW metadata slots (originals untouched)
 * 4 记录 → switch the library to a run's slots, or back.
 */
import { ref, computed, onMounted, onUnmounted, inject, watch } from 'vue'
import type { Ref } from 'vue'
import type { BtTaskInfo } from '@shared/types'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import {
  norm,
  SANITIZE_FIELDS,
  type CloudEntry,
  type SanitizeField,
  type TagVocab
} from '../sanitize/vocab'

defineOptions({ name: 'AidjSanitizeView' })
const emit = defineEmits<{ close: [] }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tv = (key: string, vars: Record<string, string | number>, fallback: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])),
    fallback
  )

type Clouds = Record<SanitizeField, CloudEntry[]> & { songs: number }
interface Draft extends TagVocab {
  notes?: Partial<Record<SanitizeField, { unmapped: string[]; badTargets: string[] }>>
}
interface Run {
  id: string
  createdAt: number
  fields: SanitizeField[]
  status: 'done' | 'partial'
  active?: boolean
  vocab: TagVocab
  pairs: {
    source: string
    output: string
    total: number
    direct: number
    agent: number
    changed?: number
  }[]
}
interface ArchivedDraft {
  version: number
  archivedAt: number
  requirement: string
  fields: Partial<Record<SanitizeField, number>>
}
interface Estimate {
  sources: { id: string; label: string; total: number; direct: number; agent: number }[]
  reasons: { reason: string; count: number }[]
  cached: number
}

const FIELD_LABEL: Record<SanitizeField, [string, string]> = {
  emotion: ['aidj.sanitize.f_emotion', '情绪'],
  genre: ['aidj.sanitize.f_genre', '风格'],
  language: ['aidj.sanitize.f_language', '语言'],
  loudness: ['aidj.sanitize.f_loudness', '响度']
}
const fieldLabel = (f: SanitizeField): string => t(FIELD_LABEL[f][0], FIELD_LABEL[f][1])

// -- step 1: requirement ------------------------------------------------------
const clouds = ref<Clouds | null>(null)
const fields = ref<SanitizeField[]>(['emotion', 'genre', 'language'])
const requirement = ref('')
const fillUnknown = ref(true)
const songsPerCall = ref(1)
const error = ref('')

/** The VocabAgent background job (survives leaving the page; reattached on open). */
const proposeTask = ref<BtTaskInfo | null>(null)
interface FieldProgress {
  status: 'running' | 'done' | 'error'
  tags?: number
  chars?: number
  thinking?: number
  ms?: number
  canonical?: number
  unmapped?: number
  error?: string
}
const fieldProgress = ref<Partial<Record<SanitizeField, FieldProgress>>>({})
const proposing = computed(() => proposeTask.value?.status === 'running')
/** Feedback re-run of a single field (vs. a full proposal). */
const redoing = computed(
  () => proposing.value && proposeFields.value.length === 1 && !!lastFeedback.value
)
const proposeFields = ref<SanitizeField[]>([])
const lastFeedback = ref('')
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

/** Job tags: find our tasks in background.list after the page was reopened. */
const TAG_VOCAB = 'aidj-vocab'
const TAG_RUN = 'aidj-sanitize-run'

// -- step 2: review -----------------------------------------------------------
const draft = ref<Draft | null>(null)
const tab = ref<SanitizeField>('emotion')
const search = ref('')
const onlyChanged = ref(false)
const showLimit = ref(120)
const editing = ref<string | null>(null)
const newTag = ref('')
const feedback = ref('')

// -- step 3/4 -----------------------------------------------------------------
const est = ref<Estimate | null>(null)
const estimating = ref(false)
const task = ref<BtTaskInfo | null>(null)
const runs = ref<Run[]>([])
const switching = ref('')

const deep = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// -- archived drafts (kept when a new proposal replaces the draft) -------------
const archived = ref<ArchivedDraft[]>([])
async function refreshArchived(): Promise<void> {
  const r = await cmd<{ drafts: ArchivedDraft[] }>('aidj.vocab-drafts').catch(() => null)
  if (r?.ok) archived.value = r.drafts
}
async function restoreDraft(version: number): Promise<void> {
  const r = await cmd<{ draft: Draft }>('aidj.vocab-draft-restore', { version })
  if (!r.ok) {
    error.value = r.error ?? ''
    return
  }
  await reloadDraft()
  if (draft.value) requirement.value = draft.value.requirement
  fieldProgress.value = {}
  proposeFields.value = []
  await refreshArchived()
}
function archivedLabel(a: ArchivedDraft): string {
  const sizes = SANITIZE_FIELDS.filter((f) => a.fields[f] != null)
    .map((f) => `${fieldLabel(f)} ${a.fields[f]}`)
    .join(' · ')
  return `${fmtDate(a.archivedAt)} · ${sizes}${a.requirement ? ` · ${a.requirement}` : ''}`
}

async function cmd<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T & { ok?: boolean; error?: string }> {
  return (await window.cockpit.command(name, args)) as T & { ok?: boolean; error?: string }
}

onMounted(async () => {
  const r = await cmd<{ draft: Draft | null; clouds: Clouds }>('aidj.vocab-draft').catch(() => null)
  if (r?.ok) {
    clouds.value = r.clouds
    if (r.draft) {
      draft.value = r.draft
      requirement.value = r.draft.requirement
      const fs = SANITIZE_FIELDS.filter((f) => r.draft!.fields[f])
      if (fs.length) {
        fields.value = fs
        tab.value = fs[0]
      }
    }
  }
  await refreshRuns()
  await refreshArchived()
  listenBt()
  await reattach()
  clock = setInterval(() => (now.value = Date.now()), 1000)
})

/** Pick up sanitize jobs that are still running (the page may have been closed). */
async function reattach(): Promise<void> {
  const tasks = ((await window.cockpit.command('background.list').catch(() => [])) ??
    []) as BtTaskInfo[]
  const latest = (tag: string): BtTaskInfo | undefined =>
    tasks
      .filter((x) => x.tags?.includes(tag))
      .sort((a, b) => b.startedAt - a.startedAt)
      .find((x) => x.status === 'running')
  const v = latest(TAG_VOCAB)
  if (v) {
    proposeTask.value = v
    const out = await cmd<{ messages: { data?: unknown }[] }>('background.output', { id: v.id })
    for (const m of out.messages ?? []) onJobData(m.data)
  }
  const r = latest(TAG_RUN)
  if (r) task.value = r
}

function onJobData(d: unknown): void {
  const data = d as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return
  if (data.type === 'vocab_field') {
    const f = data.field as SanitizeField
    fieldProgress.value = { ...fieldProgress.value, [f]: data as unknown as FieldProgress }
    if (!proposeFields.value.includes(f)) proposeFields.value = [...proposeFields.value, f]
  }
}

async function reloadDraft(): Promise<void> {
  const r = await cmd<{ draft: Draft | null; clouds: Clouds }>('aidj.vocab-draft').catch(() => null)
  if (!r?.ok || !r.draft) return
  draft.value = r.draft
  clouds.value = r.clouds
  est.value = null
  const fs = SANITIZE_FIELDS.filter((f) => r.draft!.fields[f])
  if (fs.length && !fs.includes(tab.value)) tab.value = fs[0]
}

// ---- propose / redo (background job) ----
async function startPropose(list: SanitizeField[], fb: string): Promise<void> {
  error.value = ''
  est.value = null
  fieldProgress.value = {}
  proposeFields.value = [...list]
  lastFeedback.value = fb
  const r = await window.cockpit.btJob('aidj.vocab-propose', {
    fields: [...list],
    requirement: requirement.value,
    feedback: fb,
    name: t('aidj.sanitize.vocab_job', '标签整理 · 生成规范词表'),
    description: requirement.value || list.join(', '),
    tags: ['aidj-sanitize', TAG_VOCAB]
  })
  if (r?.ok && r.task) proposeTask.value = r.task
  else error.value = r?.error ?? t('aidj.sanitize.failed', '失败')
}

function propose(): void {
  if (fields.value.length) void startPropose(fields.value, '')
}

function redoField(): void {
  if (!feedback.value.trim()) return
  void startPropose([tab.value], feedback.value)
  feedback.value = ''
}

async function stopPropose(): Promise<void> {
  if (proposeTask.value) await window.cockpit.btStop(proposeTask.value.id).catch(() => {})
}

function progressText(f: SanitizeField): string {
  const p = fieldProgress.value[f]
  // Running fields tick with the clock (no events arrive before the first token).
  const live =
    proposing.value && proposeTask.value
      ? Math.round((now.value - proposeTask.value.startedAt) / 1000)
      : 0
  if (!p) return tv('aidj.sanitize.p_wait_model', { s: live }, '等待模型响应 · {s}s')
  const secs = p.status === 'running' && live ? live : Math.round((p.ms ?? 0) / 1000)
  if (p.status === 'done') {
    const vars = { from: p.tags ?? '?', to: p.canonical ?? '?', unmapped: p.unmapped ?? 0, s: secs }
    return p.unmapped
      ? tv(
          'aidj.sanitize.p_done_partial',
          vars,
          '完成：{from} → {to} 个规范标签；{unmapped} 个旧标签未映射，相关歌曲交给 SanitizeAgent（{s}s）'
        )
      : tv(
          'aidj.sanitize.p_done',
          vars,
          '完成：{from} → {to} 个规范标签，所有旧标签都有映射，全部由代码直接清理（{s}s）'
        )
  }
  if (p.status === 'error')
    return tv('aidj.sanitize.p_error', { error: p.error ?? '' }, '失败：{error}')
  if (!p.chars && p.thinking) {
    return tv('aidj.sanitize.p_thinking', { n: p.thinking, s: secs }, '思考中 · {n} 字 · {s}s')
  }
  if (!p.chars) return tv('aidj.sanitize.p_wait_model', { s: secs }, '等待模型响应 · {s}s')
  return tv('aidj.sanitize.p_writing', { n: p.chars, s: secs }, '输出中 · 已生成 {n} 字 · {s}s')
}

// ---- review editing (saved, debounced) ----
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  est.value = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    saveTimer = null
    if (!draft.value) return
    const r = await cmd<{ draft: Draft }>('aidj.vocab-draft', { set: deep(draft.value) })
    if (r.ok) draft.value = r.draft
  }, 500)
}
onUnmounted(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    if (draft.value) void cmd('aidj.vocab-draft', { set: deep(draft.value) })
  }
  btUnsub?.()
  if (clock) clearInterval(clock)
})

const fv = computed(() => draft.value?.fields[tab.value] ?? null)
const draftFields = computed(() => SANITIZE_FIELDS.filter((f) => draft.value?.fields[f]))

interface MapRow {
  tag: string
  count: number
  targets: string[] | null
  changed: boolean
}
const rows = computed<MapRow[]>(() => {
  const v = fv.value
  const cloud = clouds.value?.[tab.value] ?? []
  if (!v) return []
  return cloud.map((e) => {
    const targets = v.map[norm(e.tag)] ?? null
    const changed = !targets || targets.length !== 1 || targets[0] !== e.tag
    return { tag: e.tag, count: e.count, targets, changed }
  })
})
const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  return rows.value.filter(
    (r) =>
      (!onlyChanged.value || r.changed) &&
      (!q ||
        r.tag.toLowerCase().includes(q) ||
        (r.targets ?? []).some((x) => x.toLowerCase().includes(q)))
  )
})
watch([tab, search, onlyChanged], () => {
  showLimit.value = 120
  editing.value = null
})

const fieldSummary = computed(() => {
  const v = fv.value
  const cloud = clouds.value?.[tab.value] ?? []
  if (!v) return ''
  const unmapped = rows.value.filter((r) => !r.targets).length
  const dropped = rows.value.filter((r) => r.targets && !r.targets.length).length
  const vars = { from: cloud.length, to: v.canonical.length, unmapped, dropped }
  return unmapped
    ? tv(
        'aidj.sanitize.field_summary_partial',
        vars,
        '{from} 个标签 → {to} 个规范标签 · 删除 {dropped} · {unmapped} 个未映射（相关歌曲交给 SanitizeAgent）'
      )
    : tv(
        'aidj.sanitize.field_summary',
        vars,
        '{from} 个标签 → {to} 个规范标签 · 删除 {dropped} · 全部按映射直接清理'
      )
})

function setTargets(tag: string, targets: string[]): void {
  const v = fv.value
  if (!v) return
  const single = tab.value === 'language' || tab.value === 'loudness'
  v.map[norm(tag)] = single ? targets.slice(-1) : targets
  scheduleSave()
}

function addCanonical(): void {
  const v = fv.value
  const tag = newTag.value.trim()
  if (!v || !tag || v.canonical.some((c) => norm(c) === norm(tag))) return
  v.canonical.push(tag)
  v.map[norm(tag)] = [tag]
  newTag.value = ''
  scheduleSave()
}

function removeCanonical(tag: string): void {
  const v = fv.value
  if (!v) return
  v.canonical = v.canonical.filter((c) => c !== tag)
  for (const k of Object.keys(v.map)) v.map[k] = v.map[k].filter((x) => x !== tag)
  scheduleSave()
}

// ---- estimate / run ----
const runFields = computed(() => fields.value.filter((f) => draft.value?.fields[f]))

async function doEstimate(): Promise<void> {
  estimating.value = true
  try {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      if (draft.value) await cmd('aidj.vocab-draft', { set: deep(draft.value) })
    }
    const r = await cmd<Estimate>('aidj.sanitize-estimate', {
      fields: runFields.value.join(','),
      'fill-unknown': fillUnknown.value ? 'true' : 'false'
    })
    if (r.ok) est.value = r
    else error.value = r.error ?? ''
  } finally {
    estimating.value = false
  }
}

const agentTotal = computed(() => est.value?.sources.reduce((a, s) => a + s.agent, 0) ?? 0)
const running = computed(() => task.value?.status === 'running')

async function start(): Promise<void> {
  error.value = ''
  const r = await window.cockpit.btJob('aidj.sanitize', {
    fields: [...runFields.value],
    fillUnknownLanguage: fillUnknown.value,
    songsPerCall: Math.max(1, Math.min(20, Number(songsPerCall.value) || 1)),
    name: t('aidj.sanitize.job_name', '标签整理'),
    description: requirement.value || t('aidj.sanitize.title', '标签整理'),
    tags: ['aidj-sanitize', TAG_RUN]
  })
  if (r?.ok && r.task) task.value = r.task
  else error.value = r?.error ?? t('aidj.sanitize.failed', '失败')
}

async function stop(): Promise<void> {
  if (task.value) await window.cockpit.btStop(task.value.id).catch(() => {})
}

let btUnsub: (() => void) | null = null
function listenBt(): void {
  if (!window.cockpit?.on) return
  btUnsub = window.cockpit.on('cockpit:bt', (event: unknown) => {
    const ev = event as {
      type?: string
      id?: string
      tasks?: BtTaskInfo[]
      messages?: { data?: unknown }[]
    }
    if (ev.type === 'changed' && Array.isArray(ev.tasks)) {
      for (const ref of [task, proposeTask]) {
        const cur = ref.value && ev.tasks.find((x) => x.id === ref.value!.id)
        if (cur) ref.value = cur
      }
    }
    if (ev.type === 'output' && proposeTask.value && ev.id === proposeTask.value.id) {
      for (const m of ev.messages ?? []) onJobData(m.data)
    }
    if (ev.type === 'exit') {
      if (task.value && ev.id === task.value.id) void refreshRuns()
      if (proposeTask.value && ev.id === proposeTask.value.id) {
        proposeTask.value = { ...proposeTask.value, status: 'exited' }
        void reloadDraft()
        void refreshArchived()
      }
    }
  })
}

// ---- runs / switch ----
async function refreshRuns(): Promise<void> {
  const r = await cmd<{ runs: Run[] }>('aidj.sanitize-runs').catch(() => null)
  if (r?.ok) runs.value = r.runs
}

async function switchTo(run: Run, use: 'sanitized' | 'original'): Promise<void> {
  switching.value = run.id
  error.value = ''
  try {
    const r = await cmd('aidj.sanitize-switch', { run: run.id, use })
    if (!r.ok) error.value = r.error ?? ''
    await refreshRuns()
  } finally {
    switching.value = ''
  }
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(uiLang.value === 'zh' ? 'zh-CN' : 'en-US')
}
</script>

<template>
  <div class="san-shell d-flex flex-column">
    <div class="san-topbar d-flex align-center ga-3">
      <v-btn
        icon
        variant="text"
        size="small"
        :title="t('aidj.sanitize.close', '关闭')"
        :aria-label="t('aidj.sanitize.close', '关闭')"
        @click="emit('close')"
      >
        <v-icon size="20">mdi-arrow-left</v-icon>
      </v-btn>
      <span class="text-subtitle-1 font-weight-medium">{{
        t('aidj.sanitize.title', '标签整理')
      }}</span>
      <span class="text-caption text-medium-emphasis">{{
        t(
          'aidj.sanitize.subtitle',
          '合并同质化标签，并按要求清洗不规范的歌曲；结果写入新的元数据槽位，原数据不动'
        )
      }}</span>
    </div>

    <div class="san-scroll">
      <div class="san-body d-flex flex-column ga-4 pa-4">
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          closable
          class="san-pre"
          @click:close="error = ''"
        >
          {{ error }}
        </v-alert>

        <!-- 1. 要求 -->
        <section class="san-card pa-4">
          <div class="text-subtitle-2 mb-1">1 · {{ t('aidj.sanitize.step1', '要求') }}</div>
          <div class="text-caption text-medium-emphasis mb-3">
            {{
              t(
                'aidj.sanitize.step1_hint',
                '选择要整理的字段，写下额外要求（默认使用英文）。VocabAgent 会把每个字段的词云合并成规范词表。'
              )
            }}
          </div>
          <div class="d-flex flex-wrap ga-2 mb-3">
            <v-checkbox
              v-for="f in SANITIZE_FIELDS"
              :key="f"
              v-model="fields"
              :value="f"
              :label="`${fieldLabel(f)}（${clouds?.[f]?.length ?? '…'}）`"
              hide-details
              density="compact"
              class="flex-grow-0"
            />
          </div>
          <v-textarea
            v-model="requirement"
            :label="t('aidj.sanitize.requirement', '额外要求')"
            :placeholder="
              t(
                'aidj.sanitize.requirement_ph',
                '例如：使用中文；情绪控制在 30 个以内；保留 city pop'
              )
            "
            rows="2"
            auto-grow
            hide-details
            variant="outlined"
            class="mb-3"
          />
          <div class="d-flex align-center flex-wrap ga-3">
            <v-btn
              color="primary"
              variant="flat"
              :loading="proposing"
              :disabled="!fields.length || running"
              prepend-icon="mdi-auto-fix"
              @click="propose"
            >
              {{
                draft
                  ? t('aidj.sanitize.repropose', '重新生成规范词表')
                  : t('aidj.sanitize.propose', '生成规范词表')
              }}
            </v-btn>
            <v-menu v-if="archived.length && !proposing" location="bottom start">
              <template #activator="{ props: menuProps }">
                <v-btn v-bind="menuProps" variant="text" prepend-icon="mdi-history">
                  {{ tv('aidj.sanitize.archived', { n: archived.length }, '历史草稿（{n}）') }}
                </v-btn>
              </template>
              <v-list density="comfortable" class="san-archived">
                <v-list-subheader>{{
                  t('aidj.sanitize.archived_hint', '恢复为当前草稿（当前草稿会先存档）')
                }}</v-list-subheader>
                <v-list-item
                  v-for="a in archived"
                  :key="a.version"
                  :title="archivedLabel(a)"
                  @click="restoreDraft(a.version)"
                />
              </v-list>
            </v-menu>
            <v-btn
              v-if="proposing"
              color="error"
              variant="tonal"
              prepend-icon="mdi-stop"
              @click="stopPropose"
            >
              {{ t('aidj.sanitize.stop', '停止') }}
            </v-btn>
            <span v-if="proposing" class="text-caption text-medium-emphasis">
              {{
                t(
                  'aidj.sanitize.proposing',
                  '在后台运行，可以离开本页，回来会接着显示进度；后台面板里有日志。'
                )
              }}
            </span>
          </div>
          <div v-if="proposeFields.length" class="san-progress d-flex flex-column ga-2 mt-3">
            <div v-for="f in proposeFields" :key="f" class="d-flex align-center ga-2 flex-wrap">
              <v-progress-circular
                v-if="!fieldProgress[f] || fieldProgress[f]!.status === 'running'"
                :indeterminate="proposing"
                size="16"
                width="2"
                color="primary"
              />
              <v-icon v-else-if="fieldProgress[f]!.status === 'done'" size="18" color="success">
                mdi-check-circle-outline
              </v-icon>
              <v-icon v-else size="18" color="error">mdi-alert-circle-outline</v-icon>
              <span class="text-body-2 font-weight-medium san-progress-field">{{
                fieldLabel(f)
              }}</span>
              <span class="text-caption text-medium-emphasis">{{ progressText(f) }}</span>
            </div>
          </div>
        </section>

        <!-- 2. 审核 -->
        <section v-if="draft && draftFields.length" class="san-card pa-4">
          <div class="text-subtitle-2 mb-1">2 · {{ t('aidj.sanitize.step2', '审核') }}</div>
          <div class="text-caption text-medium-emphasis mb-3">
            {{
              t(
                'aidj.sanitize.step2_hint',
                '执行时，每首歌的这些字段都会按映射改写成规范标签，不在词表里的标签不会保留；只有带「未映射」旧标签的歌才交给 SanitizeAgent。点右侧编辑映射、删除或新增规范标签，或写意见让 VocabAgent 重做这个字段。修改自动保存。'
              )
            }}
          </div>
          <v-tabs v-model="tab" density="comfortable" class="mb-3">
            <v-tab v-for="f in draftFields" :key="f" :value="f">{{ fieldLabel(f) }}</v-tab>
          </v-tabs>

          <template v-if="fv">
            <div class="text-body-2 mb-2">{{ fieldSummary }}</div>
            <div
              v-if="draft.notes?.[tab]?.badTargets?.length"
              class="text-caption text-warning mb-2"
            >
              {{ t('aidj.sanitize.bad_targets', '已忽略不在词表里的映射目标') }}：{{
                draft.notes[tab]!.badTargets.slice(0, 8).join('；')
              }}
            </div>

            <div class="text-caption text-medium-emphasis mb-1">
              {{ t('aidj.sanitize.canonical', '规范标签') }}
            </div>
            <div class="d-flex flex-wrap align-center ga-2 mb-3">
              <v-chip
                v-for="c in fv.canonical"
                :key="c"
                closable
                variant="tonal"
                :close-label="t('aidj.sanitize.remove_tag', '删除该规范标签')"
                @click:close="removeCanonical(c)"
              >
                {{ c }}
              </v-chip>
              <v-text-field
                v-model="newTag"
                :placeholder="t('aidj.sanitize.add_tag', '新增规范标签')"
                density="compact"
                variant="outlined"
                hide-details
                class="san-add"
                append-inner-icon="mdi-plus"
                @click:append-inner="addCanonical"
                @keydown.enter="addCanonical"
              />
            </div>

            <div class="d-flex align-center flex-wrap ga-3 mb-2">
              <v-text-field
                v-model="search"
                :placeholder="t('aidj.sanitize.search', '搜索标签')"
                prepend-inner-icon="mdi-magnify"
                density="compact"
                variant="outlined"
                hide-details
                clearable
                class="san-search"
              />
              <v-switch
                v-model="onlyChanged"
                color="primary"
                :label="t('aidj.sanitize.only_changed', '只看有变动的')"
                hide-details
                density="compact"
              />
            </div>

            <div class="san-map">
              <div v-for="r in filteredRows.slice(0, showLimit)" :key="r.tag" class="san-row">
                <div class="d-flex align-center ga-2 flex-wrap py-1">
                  <span class="text-body-2 san-old">{{ r.tag }}</span>
                  <span class="text-caption text-medium-emphasis">×{{ r.count }}</span>
                  <v-icon size="16" class="text-medium-emphasis">mdi-arrow-right</v-icon>
                  <template v-if="editing !== r.tag">
                    <span v-if="!r.targets" class="san-badge san-badge-warn">
                      {{ t('aidj.sanitize.unmapped', '未映射 → SanitizeAgent') }}
                    </span>
                    <span v-else-if="!r.targets.length" class="san-badge san-badge-drop">
                      {{ t('aidj.sanitize.dropped', '删除') }}
                    </span>
                    <span v-for="x in r.targets ?? []" :key="x" class="san-badge">{{ x }}</span>
                    <v-spacer />
                    <v-btn
                      icon
                      size="small"
                      variant="text"
                      :title="t('aidj.sanitize.edit', '编辑映射')"
                      :aria-label="`${t('aidj.sanitize.edit', '编辑映射')}: ${r.tag}`"
                      @click="editing = r.tag"
                    >
                      <v-icon size="16">mdi-pencil-outline</v-icon>
                    </v-btn>
                  </template>
                  <template v-else>
                    <v-select
                      :model-value="r.targets ?? []"
                      :items="fv.canonical"
                      multiple
                      chips
                      closable-chips
                      density="compact"
                      variant="outlined"
                      hide-details
                      :placeholder="t('aidj.sanitize.dropped', '删除')"
                      class="san-edit"
                      @update:model-value="(v: string[]) => setTargets(r.tag, v)"
                    />
                    <v-btn
                      icon
                      size="small"
                      variant="text"
                      :title="t('aidj.sanitize.done', '完成')"
                      :aria-label="t('aidj.sanitize.done', '完成')"
                      @click="editing = null"
                    >
                      <v-icon size="16">mdi-check</v-icon>
                    </v-btn>
                  </template>
                </div>
              </div>
              <div v-if="filteredRows.length > showLimit" class="d-flex justify-center py-2">
                <v-btn variant="text" @click="showLimit += 200">
                  {{
                    tv(
                      'aidj.sanitize.more',
                      { n: filteredRows.length - showLimit },
                      '再显示更多（还有 {n} 个）'
                    )
                  }}
                </v-btn>
              </div>
            </div>

            <div class="d-flex align-end flex-wrap ga-3 mt-4">
              <v-textarea
                v-model="feedback"
                :label="t('aidj.sanitize.feedback', '对这个字段的意见')"
                :placeholder="
                  t(
                    'aidj.sanitize.feedback_ph',
                    '例如：合并得再激进一点；不要把 lo-fi 并进 electronic'
                  )
                "
                rows="1"
                auto-grow
                hide-details
                density="compact"
                variant="outlined"
                class="flex-grow-1 san-feedback"
              />
              <v-btn
                variant="tonal"
                :loading="redoing"
                :disabled="!feedback.trim() || running"
                prepend-icon="mdi-refresh"
                @click="redoField"
              >
                {{ t('aidj.sanitize.redo', '按意见重做此字段') }}
              </v-btn>
            </div>
          </template>
        </section>

        <!-- 3. 执行 -->
        <section v-if="draft && draftFields.length" class="san-card pa-4">
          <div class="text-subtitle-2 mb-1">3 · {{ t('aidj.sanitize.step3', '执行') }}</div>
          <div class="text-caption text-medium-emphasis mb-3">
            {{
              t(
                'aidj.sanitize.step3_hint',
                '能按映射直接处理的歌由代码完成；其余交给 SanitizeAgent（原始元数据 + 歌词）。结果写入新槽位，在下方切换后才生效。'
              )
            }}
          </div>
          <div class="san-options d-flex flex-column mb-4">
            <div class="san-option d-flex align-center ga-3">
              <span class="text-body-2 flex-grow-1">{{
                t('aidj.sanitize.fill_unknown', '尝试补全未知语言（信息不足时仍保留 unknown）')
              }}</span>
              <v-switch
                v-model="fillUnknown"
                color="primary"
                hide-details
                density="compact"
                class="flex-grow-0"
                :aria-label="t('aidj.sanitize.fill_unknown', '尝试补全未知语言')"
                @update:model-value="est = null"
              />
            </div>
            <div class="san-option d-flex align-center ga-3">
              <span class="text-body-2 flex-grow-1">{{
                t('aidj.sanitize.per_call', 'SanitizeAgent 每次处理几首')
              }}</span>
              <v-text-field
                v-model.number="songsPerCall"
                type="number"
                min="1"
                max="20"
                single-line
                density="compact"
                variant="outlined"
                hide-details
                class="san-percall flex-grow-0"
                :aria-label="t('aidj.sanitize.per_call', 'SanitizeAgent 每次处理几首')"
              />
            </div>
          </div>
          <div class="d-flex align-center flex-wrap ga-3">
            <v-btn
              variant="tonal"
              :loading="estimating"
              prepend-icon="mdi-calculator"
              @click="doEstimate"
            >
              {{ t('aidj.sanitize.estimate', '预估') }}
            </v-btn>
            <v-btn
              v-if="!running"
              color="primary"
              variant="flat"
              :disabled="!est"
              prepend-icon="mdi-play"
              @click="start"
            >
              {{ t('aidj.sanitize.start', '开始整理（后台）') }}
            </v-btn>
            <v-btn v-else color="error" variant="tonal" prepend-icon="mdi-stop" @click="stop">
              {{ t('aidj.sanitize.stop', '停止') }}
            </v-btn>
          </div>

          <div v-if="est" class="mt-3 d-flex flex-column ga-1">
            <div v-for="s in est.sources" :key="s.id" class="text-body-2">
              {{
                tv(
                  'aidj.sanitize.est_line',
                  { name: s.label, total: s.total, direct: s.direct, agent: s.agent },
                  '{name}：{total} 首 · 直接映射 {direct} · 需 SanitizeAgent {agent}'
                )
              }}
            </div>
            <div v-if="est.cached" class="text-caption text-medium-emphasis">
              {{
                tv(
                  'aidj.sanitize.est_cached',
                  { n: est.cached },
                  '其中 {n} 首已有上次（同一词表）的结果，会直接复用'
                )
              }}
            </div>
            <div v-if="est.reasons.length" class="text-caption text-medium-emphasis">
              {{ t('aidj.sanitize.reasons', '原因') }}：{{
                est.reasons.map((r) => `${r.reason} ×${r.count}`).join(' · ')
              }}
            </div>
            <div v-if="agentTotal === 0" class="text-caption text-success">
              {{ t('aidj.sanitize.all_direct', '全部可以直接映射，不需要调用 AI') }}
            </div>
          </div>

          <div v-if="task" class="mt-3">
            <div class="d-flex align-center ga-2 mb-1">
              <span class="text-body-2">{{
                running
                  ? t('aidj.sanitize.running', '整理中…（可在后台面板查看日志）')
                  : task.status === 'exited'
                    ? t('aidj.sanitize.finished', '已完成')
                    : t('aidj.sanitize.ended', '已结束')
              }}</span>
              <v-spacer />
              <span class="text-caption text-medium-emphasis">{{ task.progress ?? 0 }}%</span>
            </div>
            <v-progress-linear
              :model-value="task.progress ?? 0"
              :indeterminate="running && task.progress == null"
              color="primary"
              rounded
              height="6"
            />
          </div>
        </section>

        <!-- 4. 记录 -->
        <section class="san-card pa-4">
          <div class="d-flex align-center ga-2 mb-3">
            <span class="text-subtitle-2">{{ t('aidj.sanitize.runs', '整理记录') }}</span>
            <v-spacer />
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sanitize.refresh', '刷新')"
              :aria-label="t('aidj.sanitize.refresh', '刷新')"
              @click="refreshRuns"
            >
              <v-icon size="18">mdi-refresh</v-icon>
            </v-btn>
          </div>
          <div v-if="!runs.length" class="text-caption text-medium-emphasis">
            {{ t('aidj.sanitize.no_runs', '还没有整理记录') }}
          </div>
          <div v-for="r in runs" :key="r.id" class="san-run pa-3 mb-2">
            <div class="d-flex align-center flex-wrap ga-2 mb-1">
              <span class="text-body-2 font-weight-medium">{{ fmtDate(r.createdAt) }}</span>
              <span v-if="r.active" class="san-badge san-badge-active">{{
                t('aidj.sanitize.in_use', '使用中')
              }}</span>
              <span v-if="r.status === 'partial'" class="san-badge san-badge-warn">{{
                t('aidj.sanitize.partial', '部分失败')
              }}</span>
              <span class="text-caption text-medium-emphasis">
                {{ r.fields.map((f) => fieldLabel(f)).join(' / ') }}
                <template v-if="r.vocab.requirement"> · {{ r.vocab.requirement }}</template>
              </span>
            </div>
            <div v-for="p in r.pairs" :key="p.source" class="text-caption text-medium-emphasis">
              <template v-if="p.output">
                {{
                  tv(
                    'aidj.sanitize.pair',
                    {
                      src: p.source,
                      out: p.output,
                      total: p.total,
                      changed: p.changed ?? '?',
                      agent: p.agent
                    },
                    '{src} → {out}（{total} 首，{changed} 首有变化，AI {agent}）'
                  )
                }}
              </template>
              <template v-else>
                {{
                  tv(
                    'aidj.sanitize.pair_unchanged',
                    { src: p.source, total: p.total },
                    '{src}：{total} 首均无变化，沿用原槽位'
                  )
                }}
              </template>
            </div>
            <div class="d-flex flex-wrap ga-2 mt-2">
              <v-btn
                v-if="!r.active"
                color="primary"
                variant="tonal"
                :loading="switching === r.id"
                prepend-icon="mdi-swap-horizontal"
                @click="switchTo(r, 'sanitized')"
              >
                {{ t('aidj.sanitize.use', '使用整理后的元数据') }}
              </v-btn>
              <v-btn
                v-else
                variant="tonal"
                :loading="switching === r.id"
                prepend-icon="mdi-undo"
                @click="switchTo(r, 'original')"
              >
                {{ t('aidj.sanitize.revert', '切回之前的元数据') }}
              </v-btn>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.san-shell {
  position: absolute;
  inset: 0;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  z-index: 40;
}
.san-topbar {
  flex-shrink: 0;
  min-height: 56px;
  padding: 8px 16px;
  flex-wrap: wrap;
  row-gap: 8px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}
.san-scroll {
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
}
.san-body {
  max-width: 960px;
  margin: 0 auto;
}
.san-card {
  border-radius: 12px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  background: rgba(var(--v-theme-surface-variant), 0.25);
}
.san-progress-field {
  min-width: 48px;
}
.san-archived {
  max-width: min(560px, 90vw);
}
.san-pre {
  white-space: pre-wrap;
}
.san-add {
  max-width: 220px;
  min-width: 160px;
}
.san-search {
  max-width: 280px;
  min-width: 180px;
}
.san-options {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.san-option {
  min-height: 52px;
  padding-block: 6px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.san-percall {
  width: 96px;
}
.san-feedback {
  min-width: 240px;
}
.san-map {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.san-row {
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  /* 4px 8px：映射列表行原本 2px 4px 太挤，行与行贴在一起 */
  padding: 4px 8px;
}
.san-old {
  word-break: break-word;
}
.san-edit {
  flex: 1 1 240px;
  min-width: 200px;
}
.san-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  /* padding-block 4px 与全局 chip 底线一致（原 2px 偏挤） */
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.san-badge-warn {
  background: rgba(var(--v-theme-warning), 0.16);
  color: rgb(var(--v-theme-warning));
}
.san-badge-drop {
  background: rgba(var(--v-theme-error), 0.12);
  color: rgb(var(--v-theme-error));
}
.san-badge-active {
  background: rgba(var(--v-theme-success), 0.16);
  color: rgb(var(--v-theme-success));
}
.san-run {
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.03);
}
</style>
