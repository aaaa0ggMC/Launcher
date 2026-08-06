<script setup lang="ts">
import { ref, shallowRef, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { AppAction, AppEntry, AppExecSpec, RiskLevel } from './types'
import LoadingBar from '@ui/components/LoadingBar.vue'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import { localize, translate, translateTemplate, availableLanguages } from '@ui/i18n'
import { filterByQuery, fields } from '@ui/composables/search'

interface AbilitiesCtx {
  configs: Record<string, Record<string, unknown>>
  launch: (root: string, id: string, entry: AppEntry) => Promise<unknown>
  launchAction: (
    root: string,
    id: string,
    entry: AppEntry,
    actionId: string,
    action: AppAction
  ) => Promise<unknown>
}

interface SearchRoot {
  path: string
  watch: boolean
}

const { launch, launchAction } = inject<AbilitiesCtx>('cockpit:abilities', {
  configs: {},
  launch: async () => {},
  launchAction: async () => {}
})
const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))

const EXEC_TYPES = ['uv', 'python', 'node', 'docker', 'systemd', 'script', 'desktop', 'custom']

const apps = shallowRef<Record<string, AppEntry>>({})
const roots = shallowRef<SearchRoot[]>([])
const loading = ref(false)
const searchText = ref('')
const activeTag = ref('')
const showMissing = ref(false)

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || s
  )
}

/** Button styling encodes danger — darker background = more dangerous. */
function riskBtn(
  entry: AppEntry,
  action?: AppAction
): { color: string; variant: 'tonal' | 'flat' } {
  const risk = action?.risk ?? entry.security?.risk ?? 'low'
  if (risk === 'high') return { color: 'error', variant: 'flat' }
  if (risk === 'medium') return { color: 'warning', variant: 'tonal' }
  return { color: 'success', variant: 'tonal' }
}

function actionList(entry: AppEntry): [string, AppAction][] {
  return Object.entries(entry.actions ?? {})
}

/** Manual + auto tags, deduplicated (auto scan may re-add the same tag). */
function entryTags(entry: AppEntry): string[] {
  return [...new Set([...(entry.tags ?? []), ...(entry.tags_auto ?? [])])]
}

// ---------------------------------------------------------------------------
// Edit dialog (primary exec + clustered actions)
// ---------------------------------------------------------------------------
interface ActionForm {
  id: string
  name: string
  icon: string
  execType: string
  execCwd: string
  execCommand: string
  risk: string
  terminal: boolean
  background: boolean
  rootFlag: boolean
  stepsText: string
  localized?: Record<string, { name?: string; description?: string }>
}

interface EditForm {
  root: string
  id: string
  name: string
  alias: string
  description: string
  icon: string
  tags: string
  localized: Record<string, { name?: string; description?: string; alias?: string }>
  execType: string
  execCwd: string
  execCommand: string
  risk: string
  note: string
  terminal: boolean
  background: boolean
  rootFlag: boolean
  managed: boolean
  transformer: string
  transformerDisplay: boolean
  actions: ActionForm[]
}

const form = ref<EditForm | null>(null)
const editOpen = ref(false)
const editBusy = ref(false)

// ---------------------------------------------------------------------------
// New entry dialog
// ---------------------------------------------------------------------------
interface NewEntryForm {
  root: string
  id: string
  name: string
  path: string
  description: string
  icon: string
  localized: Record<string, { name?: string; description?: string; alias?: string }>
  execType: string
  execCwd: string
  execCommand: string
  risk: string
  terminal: boolean
  background: boolean
  rootFlag: boolean
  createDir: boolean
}

const newOpen = ref(false)
const newBusy = ref(false)
const newForm = ref<NewEntryForm | null>(null)

const newRootOpen = ref(false)
const newRootPath = ref('')

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    const res = await window.cockpit.listApps()
    apps.value = res.apps
    roots.value = res.roots
  } finally {
    if (!silent) loading.value = false
  }
}

const entries = computed(() =>
  Object.entries(apps.value)
    .map(([id, entry]) => ({ id, entry }))
    .filter(({ entry }) => !entry.missing || showMissing.value)
)

const allTags = computed(() => {
  const set = new Set<string>()
  for (const e of Object.values(apps.value)) {
    for (const t of [...(e.tags ?? []), ...(e.tags_auto ?? [])]) set.add(t)
  }
  return [...set].sort()
})

const filtered = computed(() => {
  let list = entries.value
  if (activeTag.value) {
    list = list.filter(({ entry }) =>
      [...(entry.tags ?? []), ...(entry.tags_auto ?? [])].includes(activeTag.value)
    )
  }
  if (!searchText.value.trim()) return list
  // shared weighted AND search: name > alias > description > id
  return filterByQuery(list, searchText.value, ({ id, entry }) => {
    const name = localize(entry, 'name', uiLang.value) ?? entry.name
    const alias = localize(entry, 'alias', uiLang.value) ?? ''
    const desc = localize(entry, 'description', uiLang.value) ?? ''
    const f = fields(name, alias, desc)
    if (id) f.push({ text: id.toLowerCase(), weight: 2 })
    return f
  })
})

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
function openEdit(id: string): void {
  const entry = apps.value[id]
  if (!entry) return
  form.value = {
    root: entry.root ?? '',
    id,
    name: entry.name,
    alias: entry.alias ?? '',
    description: entry.description ?? '',
    icon: entry.icon ?? '',
    tags: (entry.tags ?? []).join(', '),
    localized: JSON.parse(JSON.stringify(entry.localized ?? {})),
    execType: entry.exec.type,
    execCwd: entry.exec.cwd ?? '',
    execCommand: entry.exec.command.join(' '),
    risk: entry.security?.risk ?? 'low',
    note: entry.security?.note ?? '',
    terminal: entry.exec.terminal ?? false,
    rootFlag: entry.exec.root ?? false,
    background: entry.exec.background ?? false,
    managed: entry.managed ?? true,
    transformer: entry.transformer ?? '',
    transformerDisplay: entry.transformer_display ?? false,
    actions: Object.entries(entry.actions ?? {}).map(([aid, a]) => ({
      id: aid,
      name: typeof a.name === 'string' ? a.name : '',
      icon: a.icon ?? '',
      execType: a.exec.type,
      execCwd: a.exec.cwd ?? '',
      execCommand: a.exec.command.join(' '),
      risk: a.risk ?? 'low',
      terminal: a.exec.terminal ?? false,
      background: a.exec.background ?? false,
      rootFlag: a.exec.root ?? false,
      stepsText: (a.steps ?? []).map((s) => s.command.join(' ')).join('\n'),
      localized: a.localized ?? {}
    }))
  }
  editOpen.value = true
}

function addActionRow(): void {
  if (!form.value) return
  const used = new Set(form.value.actions.map((a) => a.id))
  let n = form.value.actions.length + 1
  let id = `action-${n}`
  while (used.has(id)) {
    n++
    id = `action-${n}`
  }
  form.value.actions.push({
    id,
    name: '',
    icon: '',
    execType: 'custom',
    execCwd: '{self}',
    execCommand: '',
    risk: 'medium',
    terminal: false,
    background: false,
    rootFlag: false,
    stepsText: ''
  })
}

function removeActionRow(i: number): void {
  form.value?.actions.splice(i, 1)
}

/** Set a localized field value on a form's localized map. */
function setLocalized(
  f: { localized: Record<string, Record<string, string | undefined>> },
  langCode: string,
  field: string,
  value: string
): void {
  if (!f.localized[langCode]) f.localized[langCode] = {}
  f.localized[langCode][field] = value || undefined
}

/** Pick an image via the native dialog and store it as a file:// icon. */
async function browseIcon(actionIndex?: number): Promise<void> {
  if (!form.value) return
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectIcon'),
    filters: [
      {
        name: translate(uiLang.value, 'dialog.filterImages'),
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico']
      }
    ]
  })
  if (!path) return
  const v = `file/${path}`
  if (actionIndex === undefined) {
    form.value.icon = v
  } else {
    const a = form.value.actions[actionIndex]
    if (a) a.icon = v
  }
}

/** Convert an action editor row back into a persisted AppAction. */
function buildAction(a: ActionForm): AppAction {
  const cwd = a.execCwd || undefined
  const steps = a.stepsText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (steps.length) {
    const seq: AppExecSpec[] = steps.map((line) => ({
      type: 'custom',
      command: line.split(/\s+/),
      cwd
    }))
    const last: AppExecSpec = { ...seq[seq.length - 1] }
    // Intermediate steps run headless + awaited; only the last may open a
    // terminal / escalate / run as a background task. (terminal/root flags on
    // custom specs are honored by buildArgv in the launcher.)
    if (a.terminal) last.terminal = true
    if (a.rootFlag) last.root = true
    if (a.background) last.background = true
    seq[seq.length - 1] = last
    return {
      name: a.name.trim() || a.id.trim(),
      icon: a.icon.trim() || undefined,
      exec: last,
      steps: seq,
      risk: a.risk as RiskLevel,
      localized: a.localized && Object.keys(a.localized).length ? a.localized : undefined
    }
  }
  return {
    name: a.name.trim() || a.id.trim(),
    icon: a.icon.trim() || undefined,
    exec: {
      type: a.execType as AppAction['exec']['type'],
      command: a.execCommand.trim() ? a.execCommand.trim().split(/\s+/) : [],
      cwd: a.execCwd || undefined,
      terminal: a.terminal,
      background: a.background,
      root: a.rootFlag
    },
    risk: a.risk as RiskLevel,
    localized: a.localized && Object.keys(a.localized).length ? a.localized : undefined
  }
}

async function saveEdit(): Promise<void> {
  if (!form.value) return
  editBusy.value = true
  try {
    const f = form.value
    const actions: Record<string, AppAction> = Object.fromEntries(
      f.actions
        .filter((a) => a.id.trim() && (a.name.trim() || a.execCommand.trim() || a.stepsText.trim()))
        .map((a) => [a.id.trim(), buildAction(a)])
    )
    await window.cockpit.updateEntry(f.root, f.id, {
      name: f.name,
      alias: f.alias || undefined,
      description: f.description || undefined,
      icon: f.icon || undefined,
      localized: Object.keys(f.localized).length ? f.localized : undefined,
      tags: f.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      exec: {
        type: f.execType as AppEntry['exec']['type'],
        command: f.execCommand.trim() ? f.execCommand.trim().split(/\s+/) : [],
        cwd: f.execCwd || undefined,
        terminal: f.terminal,
        background: f.background,
        root: f.rootFlag
      },
      actions: Object.keys(actions).length ? actions : undefined,
      security: {
        risk: f.risk as RiskLevel,
        note: f.note || undefined,
        acknowledged: apps.value[f.id]?.security?.acknowledged ?? false
      },
      transformer: f.transformer.trim() || undefined,
      transformer_display: f.transformerDisplay,
      managed: f.managed
    })
    editOpen.value = false
    await load()
  } finally {
    editBusy.value = false
  }
}

async function deleteEntry(): Promise<void> {
  if (!form.value) return
  editOpen.value = false
  await window.cockpit.deleteEntry(form.value.root, form.value.id)
  await load()
}

// ---------------------------------------------------------------------------
// New entry
// ---------------------------------------------------------------------------
function openNew(): void {
  newForm.value = {
    root: roots.value[0]?.path ?? '',
    id: '',
    name: '',
    path: '',
    description: '',
    icon: '',
    localized: {},
    execType: 'custom',
    execCwd: '{self}',
    execCommand: '',
    risk: 'low',
    terminal: false,
    background: false,
    rootFlag: false,
    createDir: false
  }
  newOpen.value = true
}

async function saveNew(): Promise<void> {
  if (!newForm.value) return
  const f = newForm.value
  if (!f.root || !f.name.trim()) return
  newBusy.value = true
  try {
    const id = f.id.trim() || slugify(f.path.trim() || f.name.trim())
    await window.cockpit.createEntry(
      f.root,
      id,
      {
        name: f.name.trim(),
        description: f.description || undefined,
        icon: f.icon.trim() || undefined,
        localized: Object.keys(f.localized).length ? f.localized : undefined,
        path: f.path.trim() || id,
        exec: {
          type: f.execType as AppEntry['exec']['type'],
          command: f.execCommand.trim() ? f.execCommand.trim().split(/\s+/) : [],
          cwd: f.execCwd || undefined,
          terminal: f.terminal,
          background: f.background,
          root: f.rootFlag
        },
        security: { risk: f.risk as RiskLevel },
        managed: true
      },
      { mkdir: f.createDir }
    )
    newOpen.value = false
    await load()
  } finally {
    newBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------
async function removeRoot(path: string): Promise<void> {
  await window.cockpit.removeRoot(path)
  await load()
}

async function addRoot(): Promise<void> {
  if (!newRootPath.value.trim()) return
  await window.cockpit.addRoot(newRootPath.value.trim())
  newRootPath.value = ''
  newRootOpen.value = false
  await load()
}

/** Pick a search-root directory via the native dialog. */
async function pickNewRoot(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectDir'),
    directory: true
  })
  if (!path) return
  newRootPath.value = path
}

/** Pick a directory or script for the new entry's main path. */
async function browseNewPath(): Promise<void> {
  if (!newForm.value) return
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectPath'),
    any: true
  })
  if (!path) return
  newForm.value.path = path
}

/** Pick an image for the new entry's icon. */
async function browseNewIcon(): Promise<void> {
  if (!newForm.value) return
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectIcon'),
    filters: [
      {
        name: translate(uiLang.value, 'dialog.filterImages'),
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico']
      }
    ]
  })
  if (!path) return
  newForm.value.icon = `file/${path}`
}

let unsub: (() => void) | null = null

onMounted(() => {
  load()
  unsub = window.cockpit.on('cockpit:apps-changed', () => load(true))
})

onBeforeUnmount(() => unsub?.())

/** Export the app registry as markdown (name/desc/path/exec/risk/tags/actions). */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'apps.mdHeading')]
  if (roots.value.length) {
    lines.push(
      translateTemplate(uiLang.value, 'apps.mdRoots', {
        paths: roots.value.map((r) => `\`${r.path}\``).join(' · ')
      })
    )
    lines.push('')
  }
  for (const { id, entry } of entries.value) {
    const name = localize(entry, 'name', uiLang.value) || entry.name
    const missing = entry.missing ? ` _(${translate(uiLang.value, 'apps.mdMissing')})_` : ''
    lines.push(`- **${name}**${missing} — ${entry.description || entry.path}`)
    lines.push(`  - ID: \`${id}\` · Path: \`${entry.path}\``)
    if (entry.exec.command.length)
      lines.push(
        `  - ${translate(uiLang.value, 'apps.mdExec')}: \`${entry.exec.command.join(' ')}\``
      )
    const risk = entry.security?.risk
    if (risk && risk !== 'low')
      lines.push(`  - ${translate(uiLang.value, 'apps.mdRisk')}: **${risk}**`)
    const tags = entryTags(entry)
    if (tags.length) lines.push(`  - ${translate(uiLang.value, 'apps.mdTags')}: ${tags.join(', ')}`)
    const acts = Object.entries(entry.actions ?? {})
    if (acts.length) {
      lines.push(`  - ${translate(uiLang.value, 'apps.mdActions')}:`)
      for (const [aid, a] of acts) {
        const cmd = a.exec?.command?.join(' ') ?? ''
        lines.push(`    - **${a.name || aid}**${cmd ? ` — \`${cmd}\`` : ''}`)
      }
    }
  }
  if (entries.value.length === 0) lines.push(`- ${translate(uiLang.value, 'apps.empty')}`)
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">{{ translate(uiLang, 'apps.heading') }}</div>
        <div class="text-caption on-surface-variant mt-1">
          {{ translate(uiLang, 'apps.subtitle') }}
        </div>
      </div>
      <div class="d-flex align-center ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-folder-search" @click="newRootOpen = true">
          {{ translate(uiLang, 'apps.addDir') }}
        </v-btn>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openNew">{{
          translate(uiLang, 'apps.addApp')
        }}</v-btn>
      </div>
    </div>

    <v-row class="mb-2 align-center" dense>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="searchText"
          prepend-inner-icon="mdi-magnify"
          :placeholder="translate(uiLang, 'apps.search')"
          density="compact"
          variant="solo-filled"
          hide-details
          clearable
          @click:clear="searchText = ''"
        />
      </v-col>
      <v-col cols="12" sm="8">
        <div class="d-flex flex-wrap align-center gap-1">
          <v-chip
            size="small"
            variant="outlined"
            :color="activeTag === '' ? 'primary' : ''"
            @click="activeTag = ''"
          >
            {{ translate(uiLang, 'apps.all') }}
          </v-chip>
          <v-chip
            v-for="t in allTags"
            :key="t"
            size="small"
            variant="tonal"
            :color="activeTag === t ? 'primary' : ''"
            @click="activeTag = activeTag === t ? '' : t"
          >
            {{ t }}
          </v-chip>
        </div>
        <v-checkbox
          v-model="showMissing"
          :label="translate(uiLang, 'apps.showMissing')"
          density="compact"
          hide-details
          class="mt-1"
        />
      </v-col>
    </v-row>

    <div class="mb-3">
      <template v-for="r in roots" :key="r.path">
        <v-chip
          size="small"
          variant="outlined"
          closable
          class="mr-2 mb-1"
          @click:close="removeRoot(r.path)"
        >
          {{ r.path }}
        </v-chip>
      </template>
      <v-chip
        v-if="roots.length === 0"
        size="small"
        variant="tonal"
        prepend-icon="mdi-folder-alert-outline"
        @click="newRootOpen = true"
      >
        {{ translate(uiLang, 'apps.noRoots') }}
      </v-chip>
    </div>

    <LoadingBar :loading="loading" />

    <v-row dense align="stretch">
      <v-col v-for="{ id, entry } in filtered" :key="id" cols="12" sm="6" md="4" lg="3">
        <v-card
          rounded="lg"
          variant="tonal"
          :class="entry.missing ? 'opacity-60' : ''"
          class="app-card card-fill"
        >
          <v-card-text class="d-flex flex-column">
            <div class="d-flex align-start ga-3">
              <v-avatar size="40" color="surface-variant" rounded="lg">
                <AbilityIcon
                  :icon="entry.icon && entry.icon !== 'auto' ? entry.icon : null"
                  :size="22"
                />
              </v-avatar>
              <div class="flex-grow-1 min-width-0">
                <div class="d-flex align-center ga-2 flex-wrap">
                  <span class="text-body-1 font-weight-medium text-truncate">{{
                    localize(entry, 'name', uiLang) || entry.name
                  }}</span>
                  <v-icon
                    v-if="entry.security?.risk === 'high'"
                    color="error"
                    size="small"
                    :title="translate(uiLang, 'apps.highRisk')"
                  >
                    mdi-shield-alert-outline
                  </v-icon>
                  <v-chip v-if="entry.missing" size="x-small" variant="tonal">{{
                    translate(uiLang, 'apps.missing')
                  }}</v-chip>
                </div>
                <div class="text-caption on-surface-variant text-truncate mt-1">
                  {{ localize(entry, 'description', uiLang) || entry.description || entry.path }}
                </div>
                <div class="d-flex flex-wrap gap-1 mt-2">
                  <v-chip
                    v-for="t in entryTags(entry)"
                    :key="t"
                    size="x-small"
                    variant="flat"
                    color="secondary-container"
                  >
                    {{ t }}
                  </v-chip>
                </div>
              </div>
            </div>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0 ga-2">
            <v-btn variant="text" prepend-icon="mdi-pencil" @click="openEdit(id)">{{
              translate(uiLang, 'apps.edit')
            }}</v-btn>
            <v-spacer />
            <div class="d-flex ga-2 justify-end flex-wrap">
              <v-btn
                :color="riskBtn(entry).color"
                :variant="riskBtn(entry).variant"
                prepend-icon="mdi-play"
                :disabled="entry.missing"
                @click="launch(entry.root ?? '', id, entry)"
              >
                {{ translate(uiLang, 'apps.launch') }}
              </v-btn>
              <v-btn
                v-for="[aid, act] in actionList(entry)"
                :key="aid"
                :color="riskBtn(entry, act).color"
                :variant="riskBtn(entry, act).variant"
                :disabled="entry.missing"
                @click="launchAction(entry.root ?? '', id, entry, aid, act)"
              >
                <template v-if="act.icon" #prepend>
                  <AbilityIcon :icon="act.icon" :size="16" />
                </template>
                {{ act.name || aid }}
              </v-btn>
            </div>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-empty-state
      v-if="filtered.length === 0"
      icon="mdi-apps"
      :title="translate(uiLang, 'apps.empty')"
      :text="translate(uiLang, 'apps.emptyText')"
      class="mt-6"
    />

    <!-- Add search root -->
    <v-dialog v-model="newRootOpen" width="440">
      <v-card>
        <v-card-title>{{ translate(uiLang, 'apps.addRootTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newRootPath"
            :label="translate(uiLang, 'apps.absolutePath')"
            placeholder="/home/aaaa0ggmc/Apps"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn
                icon
                variant="text"
                size="small"
                :title="translate(uiLang, 'apps.selectDir')"
                @click="pickNewRoot"
              >
                <v-icon>mdi-folder-open</v-icon>
              </v-btn>
            </template>
          </v-text-field>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="newRootOpen = false">{{
            translate(uiLang, 'apps.cancel')
          }}</v-btn>
          <v-btn color="primary" @click="addRoot">{{ translate(uiLang, 'apps.add') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- New entry -->
    <v-dialog v-model="newOpen" width="560">
      <v-card v-if="newForm">
        <v-card-title>{{ translate(uiLang, 'apps.addEntryTitle') }}</v-card-title>
        <v-card-text class="d-flex flex-column ga-3">
          <v-select
            v-model="newForm.root"
            :items="roots.map((r) => r.path)"
            :label="translate(uiLang, 'apps.storeDir')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.name"
            :label="translate(uiLang, 'apps.name')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.id"
            :label="translate(uiLang, 'apps.idAuto')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.path"
            :label="translate(uiLang, 'apps.path')"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn
                icon
                variant="text"
                size="small"
                :title="translate(uiLang, 'apps.selectPath')"
                @click="browseNewPath"
              >
                <v-icon>mdi-folder-open</v-icon>
              </v-btn>
            </template>
          </v-text-field>
          <v-text-field
            v-model="newForm.description"
            :label="translate(uiLang, 'apps.description')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.icon"
            :label="translate(uiLang, 'apps.icon')"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn
                icon
                variant="text"
                size="small"
                :title="translate(uiLang, 'apps.selectIcon')"
                @click="browseNewIcon"
              >
                <v-icon>mdi-folder-image</v-icon>
              </v-btn>
            </template>
          </v-text-field>
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="newForm.execType"
                :items="EXEC_TYPES"
                :label="translate(uiLang, 'apps.execType')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-select
                v-model="newForm.risk"
                :items="['low', 'medium', 'high']"
                :label="translate(uiLang, 'apps.risk')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-text-field
            v-model="newForm.execCommand"
            :label="translate(uiLang, 'apps.command')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-row dense>
            <v-col cols="6">
              <v-switch
                v-model="newForm.terminal"
                :label="translate(uiLang, 'apps.terminal')"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-checkbox
                v-model="newForm.createDir"
                :label="translate(uiLang, 'apps.createDir')"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-row dense>
            <v-col cols="6">
              <v-switch
                v-model="newForm.background"
                :label="translate(uiLang, 'apps.background')"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-expansion-panels variant="accordion" class="mt-2">
            <v-expansion-panel>
              <v-expansion-panel-title class="text-subtitle-2">
                多语言 / Multi-language
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <div v-for="lang in availableLanguages" :key="lang.code" class="mb-2">
                  <div class="text-caption font-weight-medium mb-1">{{ lang.label }}</div>
                  <v-text-field
                    :model-value="newForm.localized[lang.code]?.name ?? ''"
                    :label="translate(uiLang, 'apps.name')"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-2"
                    @update:model-value="setLocalized(newForm, lang.code, 'name', $event)"
                  />
                  <v-text-field
                    :model-value="newForm.localized[lang.code]?.description ?? ''"
                    :label="translate(uiLang, 'apps.description')"
                    variant="outlined"
                    density="compact"
                    hide-details
                    @update:model-value="setLocalized(newForm, lang.code, 'description', $event)"
                  />
                </div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="newOpen = false">{{
            translate(uiLang, 'apps.cancel')
          }}</v-btn>
          <v-btn color="primary" :loading="newBusy" @click="saveNew">{{
            translate(uiLang, 'apps.create')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edit entry -->
    <v-dialog v-model="editOpen" width="640">
      <v-card v-if="form">
        <v-card-title>{{
          translateTemplate(uiLang, 'apps.editTitle', { name: form.name || '' })
        }}</v-card-title>
        <v-card-text class="d-flex flex-column ga-3">
          <v-text-field
            v-model="form.name"
            :label="translate(uiLang, 'apps.name')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="form.alias"
            :label="translate(uiLang, 'apps.alias')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="form.description"
            :label="translate(uiLang, 'apps.description')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <div class="d-flex align-center ga-3">
            <v-text-field
              v-model="form.icon"
              :label="translate(uiLang, 'apps.icon')"
              :hint="translate(uiLang, 'apps.iconHint')"
              persistent-hint
              variant="outlined"
              density="compact"
              hide-details
              class="flex-grow-1"
            >
              <template #append-inner>
                <v-btn
                  icon
                  variant="text"
                  size="small"
                  :title="translate(uiLang, 'apps.selectIcon')"
                  @click="browseIcon()"
                >
                  <v-icon>mdi-folder-image</v-icon>
                </v-btn>
              </template>
            </v-text-field>
            <v-avatar size="40" color="surface-variant" rounded="lg">
              <AbilityIcon :icon="form.icon || null" :size="22" />
            </v-avatar>
          </div>
          <v-text-field
            v-model="form.tags"
            :label="translate(uiLang, 'apps.tags')"
            variant="outlined"
            density="compact"
            hide-details
          />

          <v-divider />

          <div class="text-subtitle-2">{{ translate(uiLang, 'apps.mainAction') }}</div>
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="form.execType"
                :items="EXEC_TYPES"
                :label="translate(uiLang, 'apps.execType')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="form.execCwd"
                :label="translate(uiLang, 'apps.cwd')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-text-field
            v-model="form.execCommand"
            :label="translate(uiLang, 'apps.command')"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="form.risk"
                :items="['low', 'medium', 'high']"
                :label="translate(uiLang, 'apps.risk')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="form.note"
                :label="translate(uiLang, 'apps.riskNote')"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-row dense>
            <v-col cols="6">
              <v-switch
                v-model="form.terminal"
                :label="translate(uiLang, 'apps.terminal')"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-switch
                v-model="form.background"
                :label="translate(uiLang, 'apps.background')"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-row dense>
            <v-col cols="6">
              <v-switch
                v-model="form.rootFlag"
                :label="translate(uiLang, 'apps.rootRun')"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>

          <v-divider />

          <div class="d-flex align-center justify-space-between">
            <div class="text-subtitle-2">{{ translate(uiLang, 'apps.transformerSection') }}</div>
            <v-switch
              v-model="form.transformerDisplay"
              :label="translate(uiLang, 'apps.transformerToggle')"
              density="compact"
              hide-details
              color="primary"
            />
          </div>
          <v-textarea
            v-model="form.transformer"
            :label="translate(uiLang, 'apps.transformerInput')"
            :hint="translate(uiLang, 'apps.transformerHint')"
            persistent-hint
            variant="outlined"
            rows="3"
            auto-grow
            class="font-mono"
          />

          <v-divider />

          <div class="d-flex align-center justify-space-between">
            <div class="text-subtitle-2">{{ translate(uiLang, 'apps.actionsSection') }}</div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addActionRow">
              {{ translate(uiLang, 'apps.addAction') }}
            </v-btn>
          </div>
          <v-card
            v-for="(a, i) in form.actions"
            :key="a.id || i"
            variant="outlined"
            class="pa-2 action-editor"
          >
            <div class="d-flex align-center ga-2">
              <v-text-field
                v-model="a.id"
                :label="translate(uiLang, 'apps.actionId')"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
              />
              <v-text-field
                v-model="a.name"
                :label="translate(uiLang, 'apps.actionName')"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
              />
              <v-text-field
                v-model="a.icon"
                :label="translate(uiLang, 'apps.actionIcon')"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
              >
                <template #append-inner>
                  <v-btn
                    icon
                    variant="text"
                    size="small"
                    :title="translate(uiLang, 'apps.selectIcon')"
                    @click="browseIcon(i)"
                  >
                    <v-icon>mdi-folder-image</v-icon>
                  </v-btn>
                </template>
              </v-text-field>
              <v-btn icon variant="text" color="error" @click="removeActionRow(i)">
                <v-icon>mdi-delete</v-icon>
              </v-btn>
            </div>
            <v-row dense class="mt-2">
              <v-col cols="4">
                <v-select
                  v-model="a.execType"
                  :items="EXEC_TYPES"
                  :label="translate(uiLang, 'apps.actionExecType')"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="8">
                <v-text-field
                  v-model="a.execCommand"
                  :label="translate(uiLang, 'apps.actionCommand')"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>
            <v-row dense class="mt-2" align="center">
              <v-col cols="3">
                <v-text-field
                  v-model="a.execCwd"
                  :label="translate(uiLang, 'apps.actionCwd')"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="3">
                <v-select
                  v-model="a.risk"
                  :items="['low', 'medium', 'high']"
                  :label="translate(uiLang, 'apps.actionRisk')"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="2">
                <v-switch
                  v-model="a.terminal"
                  :label="translate(uiLang, 'apps.actionTerminal')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="2">
                <v-switch
                  v-model="a.background"
                  :label="translate(uiLang, 'apps.actionBackground')"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="2">
                <v-switch
                  v-model="a.rootFlag"
                  :label="translate(uiLang, 'apps.actionRoot')"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>
            <v-textarea
              v-model="a.stepsText"
              :label="translate(uiLang, 'apps.actionSteps')"
              variant="outlined"
              rows="2"
              auto-grow
              hide-details
              class="mt-2"
            />
          </v-card>
          <div v-if="form.actions.length === 0" class="text-caption on-surface-variant">
            {{ translate(uiLang, 'apps.noActions') }}
          </div>
          <v-expansion-panels variant="accordion" class="mt-2">
            <v-expansion-panel>
              <v-expansion-panel-title class="text-subtitle-2">
                多语言 / Multi-language
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <div v-for="lang in availableLanguages" :key="lang.code" class="mb-2">
                  <div class="text-caption font-weight-medium mb-1">{{ lang.label }}</div>
                  <v-text-field
                    :model-value="form.localized[lang.code]?.name ?? ''"
                    :label="translate(uiLang, 'apps.name')"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-2"
                    @update:model-value="setLocalized(form, lang.code, 'name', $event)"
                  />
                  <v-text-field
                    :model-value="form.localized[lang.code]?.description ?? ''"
                    :label="translate(uiLang, 'apps.description')"
                    variant="outlined"
                    density="compact"
                    hide-details
                    @update:model-value="setLocalized(form, lang.code, 'description', $event)"
                  />
                </div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-btn color="error" variant="text" prepend-icon="mdi-delete" @click="deleteEntry">
            {{ translate(uiLang, 'apps.delete') }}
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="editOpen = false">{{
            translate(uiLang, 'apps.cancel')
          }}</v-btn>
          <v-btn color="primary" :loading="editBusy" @click="saveEdit">{{
            translate(uiLang, 'apps.save')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.gap-1 {
  gap: 4px;
}
.opacity-60 {
  opacity: 0.6;
}
.min-width-0 {
  min-width: 0;
}
.app-card {
  min-height: 168px;
  display: flex;
  flex-direction: column;
}
.app-card .v-card-actions {
  margin-top: auto;
}
.action-editor {
  border-style: dashed;
}
</style>
