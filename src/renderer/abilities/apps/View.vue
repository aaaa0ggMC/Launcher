<script setup lang="ts">
import { ref, shallowRef, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import type { AppEntry } from '@shared/types'
import LoadingBar from '../../components/LoadingBar.vue'
import AbilityIcon from '../../components/AbilityIcon.vue'

interface AbilitiesCtx {
  configs: Record<string, Record<string, unknown>>
  launch: (root: string, id: string, entry: AppEntry) => Promise<unknown>
}

interface SearchRoot {
  path: string
  watch: boolean
}

const { launch } = inject<AbilitiesCtx>('cockpit:abilities', {
  configs: {},
  launch: async () => {}
})

const apps = shallowRef<Record<string, AppEntry>>({})
const roots = shallowRef<SearchRoot[]>([])
const loading = ref(false)
const searchText = ref('')
const activeTag = ref('')
const showMissing = ref(false)

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
}

const form = ref<EditForm | null>(null)
const editOpen = ref(false)
const editBusy = ref(false)

const newRootOpen = ref(false)
const newRootPath = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await window.cockpit.listApps()
    apps.value = res.apps
    roots.value = res.roots
  } finally {
    loading.value = false
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

function iconSrc(entry: AppEntry): string {
  const icon = entry.icon
  if (!icon || icon === 'auto') return ''
  const abs = icon.startsWith('/') ? icon : `${entry.root}/${icon}`
  return `cockpit-icon://${encodeURIComponent(abs)}`
}

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
    managed: entry.managed ?? true
  }
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  if (!form.value) return
  editBusy.value = true
  try {
    const f = form.value
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
      security: {
        risk: f.risk as AppEntry['security'] extends infer S
          ? S extends { risk: infer R }
            ? R
            : never
          : never,
        note: f.note || undefined,
        acknowledged: apps.value[f.id]?.security?.acknowledged ?? false
      },
      managed: f.managed
    })
    editOpen.value = false
    await load()
  } finally {
    editBusy.value = false
  }
}

async function removeRoot(path: string): Promise<void> {
  await window.cockpit.removeRoot(path)
  await load()
}

async function deleteEntry(): Promise<void> {
  if (!form.value) return
  editOpen.value = false
  await window.cockpit.deleteEntry(form.value.root, form.value.id)
  await load()
}

async function addRoot(): Promise<void> {
  if (!newRootPath.value.trim()) return
  await window.cockpit.addRoot(newRootPath.value.trim())
  newRootPath.value = ''
  newRootOpen.value = false
  await load()
}

let unsub: (() => void) | null = null

onMounted(() => {
  load()
  unsub = window.cockpit.on('cockpit:apps-changed', () => load())
})

onBeforeUnmount(() => unsub?.())
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">应用注册表</div>
        <div class="text-caption on-surface-variant mt-1">桌面应用 · 别名 · 标签 · 一键启动</div>
      </div>
      <div class="d-flex align-center ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-folder-search" @click="newRootOpen = true">
          添加目录
        </v-btn>
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
          class="app-card fill-height"
        >
          <v-card-text class="d-flex flex-column">
            <div class="d-flex align-start ga-3">
              <v-avatar size="40" color="surface-variant" rounded="lg">
                <img v-if="iconSrc(entry)" :src="iconSrc(entry)" alt="" width="24" height="24" />
                <AbilityIcon
                  v-else
                  :icon="entry.icon && entry.icon !== 'auto' ? entry.icon : null"
                  :size="22"
                />
              </v-avatar>
              <div class="flex-grow-1 min-width-0">
                <div class="d-flex align-center ga-2 flex-wrap">
                  <span class="text-body-1 font-weight-medium text-truncate">{{ entry.name }}</span>
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="
                      entry.security?.risk === 'high'
                        ? 'error'
                        : entry.security?.risk === 'medium'
                          ? 'warning'
                          : 'success'
                    "
                  >
                    {{ entry.security?.risk ?? 'low' }}
                  </v-chip>
                  <v-chip v-if="entry.missing" size="x-small" variant="tonal">缺失</v-chip>
                </div>
                <div class="text-caption on-surface-variant text-truncate mt-1">
                  {{ entry.description || entry.path }}
                </div>
                <div class="d-flex flex-wrap gap-1 mt-2">
                  <v-chip
                    v-for="t in [...(entry.tags ?? []), ...(entry.tags_auto ?? [])]"
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
            <v-spacer />
            <v-btn variant="text" prepend-icon="mdi-pencil" @click="openEdit(id)">编辑</v-btn>
            <v-btn
              color="primary"
              prepend-icon="mdi-play"
              :disabled="entry.missing"
              @click="launch(entry.root ?? '', id, entry)"
            >
              启动
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-empty-state
      v-if="filtered.length === 0"
      icon="mdi-apps"
      title="没有匹配的应用"
      text="调整搜索或标签，或点击「添加目录」添加搜索根目录。"
      class="mt-6"
    />

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
          />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="newRootOpen = false">取消</v-btn>
          <v-btn color="primary" @click="addRoot">添加</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="editOpen" width="560">
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
          <v-text-field
            v-model="form.icon"
            label="图标 (路径 / emoji / auto)"
            variant="outlined"
            density="compact"
            hide-details
          />
          <v-text-field
            v-model="form.tags"
            label="标签 (逗号分隔)"
            variant="outlined"
            density="compact"
            hide-details
          />

          <v-divider />

          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="form.execType"
                :items="[
                  'uv',
                  'python',
                  'node',
                  'docker',
                  'systemd',
                  'script',
                  'desktop',
                  'custom'
                ]"
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
</style>
