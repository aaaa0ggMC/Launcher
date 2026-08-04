<script setup lang="ts">
import { ref, shallowRef, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import type { AppAction, AppEntry, AppExecSpec, RiskLevel } from '@shared/types'
import LoadingBar from '../../components/LoadingBar.vue'
import AbilityIcon from '../../components/AbilityIcon.vue'

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
  rootFlag: boolean
  /** multi-step mode: one command per line; overrides the single exec when non-empty */
  stepsText: string
}

interface EditForm {
  root: string
  id: string
  name: string
  alias: string
  description: string
  icon: string
  tags: string
  execType: string
  execCwd: string
  execCommand: string
  risk: string
  note: string
  terminal: boolean
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
  execType: string
  execCwd: string
  execCommand: string
  risk: string
  terminal: boolean
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
  const q = searchText.value.trim().toLowerCase()
  return entries.value.filter(({ id, entry }) => {
    if (
      activeTag.value &&
      ![...(entry.tags ?? []), ...(entry.tags_auto ?? [])].includes(activeTag.value)
    ) {
      return false
    }
    if (!q) return true
    const alias = entry.alias ?? ''
    return (
      entry.name.toLowerCase().includes(q) ||
      id.toLowerCase().includes(q) ||
      alias.toLowerCase().includes(q) ||
      (entry.description ?? '').toLowerCase().includes(q)
    )
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
    execType: entry.exec.type,
    execCwd: entry.exec.cwd ?? '',
    execCommand: entry.exec.command.join(' '),
    risk: entry.security?.risk ?? 'low',
    note: entry.security?.note ?? '',
    terminal: entry.exec.terminal ?? false,
    rootFlag: entry.exec.root ?? false,
    managed: entry.managed ?? true,
    transformer: entry.transformer ?? '',
    transformerDisplay: entry.transformer_display ?? false,
    actions: Object.entries(entry.actions ?? {}).map(([aid, a]) => ({
      id: aid,
      name: a.name,
      icon: a.icon ?? '',
      execType: a.exec.type,
      execCwd: a.exec.cwd ?? '',
      execCommand: a.exec.command.join(' '),
      risk: a.risk ?? 'low',
      terminal: a.exec.terminal ?? false,
      rootFlag: a.exec.root ?? false,
      stepsText: (a.steps ?? []).map((s) => s.command.join(' ')).join('\n')
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
    rootFlag: false,
    stepsText: ''
  })
}

function removeActionRow(i: number): void {
  form.value?.actions.splice(i, 1)
}

/** Pick an image via the native dialog and store it as a file:// icon. */
async function browseIcon(actionIndex?: number): Promise<void> {
  if (!form.value) return
  const path = await window.cockpit.pickFile({
    title: '选择图标',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'] }]
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
    // terminal / escalate. (terminal/root flags on custom specs are honored
    // by buildArgv in the launcher.)
    if (a.terminal) last.terminal = true
    if (a.rootFlag) last.root = true
    seq[seq.length - 1] = last
    return {
      name: a.name.trim() || a.id.trim(),
      icon: a.icon.trim() || undefined,
      exec: last,
      steps: seq,
      risk: a.risk as RiskLevel
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
      root: a.rootFlag
    },
    risk: a.risk as RiskLevel
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
      tags: f.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      exec: {
        type: f.execType as AppEntry['exec']['type'],
        command: f.execCommand.trim() ? f.execCommand.trim().split(/\s+/) : [],
        cwd: f.execCwd || undefined,
        terminal: f.terminal,
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
    execType: 'custom',
    execCwd: '{self}',
    execCommand: '',
    risk: 'low',
    terminal: false,
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
        path: f.path.trim() || id,
        exec: {
          type: f.execType as AppEntry['exec']['type'],
          command: f.execCommand.trim() ? f.execCommand.trim().split(/\s+/) : [],
          cwd: f.execCwd || undefined,
          terminal: f.terminal,
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
  const path = await window.cockpit.pickFile({ title: '选择搜索目录', directory: true })
  if (!path) return
  newRootPath.value = path
}

/** Pick a directory or script for the new entry's main path. */
async function browseNewPath(): Promise<void> {
  if (!newForm.value) return
  const path = await window.cockpit.pickFile({ title: '选择目录或脚本', any: true })
  if (!path) return
  newForm.value.path = path
}

/** Pick an image for the new entry's icon. */
async function browseNewIcon(): Promise<void> {
  if (!newForm.value) return
  const path = await window.cockpit.pickFile({
    title: '选择图标',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'] }]
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
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">应用注册表</div>
        <div class="text-caption on-surface-variant mt-1">
          桌面应用 · 别名 · 标签 · 聚类操作 (按钮颜色越深越危险)
        </div>
      </div>
      <div class="d-flex align-center ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-folder-search" @click="newRootOpen = true">
          添加目录
        </v-btn>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openNew">添加应用</v-btn>
      </div>
    </div>

    <v-row class="mb-2 align-center" dense>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="searchText"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索名称 / 别名 / 标签"
          density="compact"
          variant="solo-filled"
          hide-details
          clearable
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
            全部
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
          label="显示缺失条目"
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
        暂无搜索目录，点击添加
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
                  <span class="text-body-1 font-weight-medium text-truncate">{{ entry.name }}</span>
                  <v-icon
                    v-if="entry.security?.risk === 'high'"
                    color="error"
                    size="small"
                    title="高风险操作，操作前需确认"
                  >
                    mdi-shield-alert-outline
                  </v-icon>
                  <v-chip v-if="entry.missing" size="x-small" variant="tonal">缺失</v-chip>
                </div>
                <div class="text-caption on-surface-variant text-truncate mt-1">
                  {{ entry.description || entry.path }}
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
            <v-btn variant="text" prepend-icon="mdi-pencil" @click="openEdit(id)">编辑</v-btn>
            <v-spacer />
            <div class="d-flex ga-2 justify-end flex-wrap">
              <v-btn
                :color="riskBtn(entry).color"
                :variant="riskBtn(entry).variant"
                prepend-icon="mdi-play"
                :disabled="entry.missing"
                @click="launch(entry.root ?? '', id, entry)"
              >
                启动
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
      title="没有匹配的应用"
      text="调整搜索或标签，或点击「添加应用」/「添加目录」。"
      class="mt-6"
    />

    <!-- Add search root -->
    <v-dialog v-model="newRootOpen" width="440">
      <v-card>
        <v-card-title>添加搜索目录</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newRootPath"
            label="绝对路径"
            placeholder="/home/aaaa0ggmc/Apps"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn icon variant="text" size="small" title="选择目录" @click="pickNewRoot">
                <v-icon>mdi-folder-open</v-icon>
              </v-btn>
            </template>
          </v-text-field>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="newRootOpen = false">取消</v-btn>
          <v-btn color="primary" @click="addRoot">添加</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- New entry -->
    <v-dialog v-model="newOpen" width="560">
      <v-card v-if="newForm">
        <v-card-title>添加应用条目</v-card-title>
        <v-card-text class="d-flex flex-column ga-3">
          <v-select
            v-model="newForm.root"
            :items="roots.map((r) => r.path)"
            label="存储目录 (注册表所在目录)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.name"
            label="名称"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.id"
            label="ID (留空自动生成)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.path"
            label="目录/脚本路径 (相对存储目录或绝对路径)"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn icon variant="text" size="small" title="选择目录或脚本" @click="browseNewPath">
                <v-icon>mdi-folder-open</v-icon>
              </v-btn>
            </template>
          </v-text-field>
          <v-text-field
            v-model="newForm.description"
            label="描述"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="newForm.icon"
            label="图标 (default/<名字>[/padding] · emoji/😎 · file//绝对路径)"
            variant="outlined"
            density="compact"
            hide-details
          >
            <template #append-inner>
              <v-btn icon variant="text" size="small" title="选择图标文件" @click="browseNewIcon">
                <v-icon>mdi-folder-image</v-icon>
              </v-btn>
            </template>
          </v-text-field>
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="newForm.execType"
                :items="EXEC_TYPES"
                label="执行类型"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-select
                v-model="newForm.risk"
                :items="['low', 'medium', 'high']"
                label="风险等级"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-text-field
            v-model="newForm.execCommand"
            label="命令 (空格分隔 argv)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-row dense>
            <v-col cols="6">
              <v-switch
                v-model="newForm.terminal"
                label="终端中运行"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-checkbox
                v-model="newForm.createDir"
                label="创建目录 (路径不存在时)"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="newOpen = false">取消</v-btn>
          <v-btn color="primary" :loading="newBusy" @click="saveNew">创建</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edit entry -->
    <v-dialog v-model="editOpen" width="640">
      <v-card v-if="form">
        <v-card-title>编辑「{{ form.name }}」</v-card-title>
        <v-card-text class="d-flex flex-column ga-3">
          <v-text-field
            v-model="form.name"
            label="名称"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="form.alias"
            label="别名 (CLI 快捷名)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="form.description"
            label="描述"
            variant="outlined"
            density="compact"
            hide-details
          />
          <div class="d-flex align-center ga-3">
            <v-text-field
              v-model="form.icon"
              label="图标"
              hint="default/<名字>[/padding] · emoji/😎 · file//绝对路径 · 留空=默认"
              persistent-hint
              variant="outlined"
              density="compact"
              hide-details
              class="flex-grow-1"
            >
              <template #append-inner>
                <v-btn icon variant="text" size="small" title="选择图标文件" @click="browseIcon()">
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
            label="标签 (逗号分隔)"
            variant="outlined"
            density="compact"
            hide-details
          />

          <v-divider />

          <div class="text-subtitle-2">主操作 (启动按钮)</div>
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="form.execType"
                :items="EXEC_TYPES"
                label="执行类型"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="form.execCwd"
                label="工作目录 (留空 / {self})"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-text-field
            v-model="form.execCommand"
            label="命令 (空格分隔 argv)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="form.risk"
                :items="['low', 'medium', 'high']"
                label="风险等级"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="form.note"
                label="风险备注"
                variant="outlined"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <v-row dense>
            <v-col cols="6">
              <v-switch v-model="form.terminal" label="终端中运行" density="compact" hide-details />
            </v-col>
            <v-col cols="6">
              <v-switch
                v-model="form.rootFlag"
                label="以 root 运行 (pkexec)"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>

          <v-divider />

          <div class="d-flex align-center justify-space-between">
            <div class="text-subtitle-2">实时输出 Transformer</div>
            <v-switch
              v-model="form.transformerDisplay"
              label="启用实时弹窗"
              density="compact"
              hide-details
              color="primary"
            />
          </div>
          <v-textarea
            v-model="form.transformer"
            label="Transformer (JS 构造函数, onNewLine(e, ui))"
            hint="ui.add(ui.NewAlign(ui.NewText('x'), ui.NewStatus('$5.00'))) — 组件: NewText/NewTitle/NewAlign/NewBar/NewStatus/NewTable"
            persistent-hint
            variant="outlined"
            density="compact"
            rows="3"
            auto-grow
            class="font-mono"
          />

          <v-divider />

          <div class="d-flex align-center justify-space-between">
            <div class="text-subtitle-2">附加操作 (卡片上的其他按钮)</div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addActionRow">
              添加操作
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
                label="操作 ID"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
              />
              <v-text-field
                v-model="a.name"
                label="按钮名称"
                variant="outlined"
                density="compact"
                hide-details
                class="flex-grow-1"
              />
              <v-text-field
                v-model="a.icon"
                label="图标 (default/emoji/file)"
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
                    title="选择图标文件"
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
                  label="执行类型"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="8">
                <v-text-field
                  v-model="a.execCommand"
                  label="命令 (空格分隔 argv)"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>
            <v-row dense class="mt-2" align="center">
              <v-col cols="4">
                <v-text-field
                  v-model="a.execCwd"
                  label="工作目录"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="4">
                <v-select
                  v-model="a.risk"
                  :items="['low', 'medium', 'high']"
                  label="风险等级"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="2">
                <v-switch v-model="a.terminal" label="终端" density="compact" hide-details />
              </v-col>
              <v-col cols="2">
                <v-switch v-model="a.rootFlag" label="root" density="compact" hide-details />
              </v-col>
            </v-row>
            <v-textarea
              v-model="a.stepsText"
              label="多步命令 (可选, 每行一条, 依次执行; 最后一步前台运行)"
              variant="outlined"
              density="compact"
              rows="2"
              auto-grow
              hide-details
              class="mt-2"
            />
          </v-card>
          <div v-if="form.actions.length === 0" class="text-caption on-surface-variant">
            暂无附加操作 — 可在卡片上添加 开始 / 停止 / 重建 等按钮。
          </div>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-btn color="error" variant="text" prepend-icon="mdi-delete" @click="deleteEntry">
            删除
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="editOpen = false">取消</v-btn>
          <v-btn color="primary" :loading="editBusy" @click="saveEdit">保存</v-btn>
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
