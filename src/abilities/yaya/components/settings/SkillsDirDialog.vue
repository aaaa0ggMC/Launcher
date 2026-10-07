<script setup lang="ts">
/**
 * Skill 目录的应用内浏览（网页 / 安卓）：Skill 目录在宿主机上，这台设备的文件管理器打不开，
 * 所以给出路径 + 复制，并经 `host.fs.list` 在目录里逐层浏览（不允许走出 Skill 目录）。
 * Electron 有 `folder.open`，直接用系统文件管理器，不会走到这里。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'

defineOptions({ name: 'cockpit-yaya-skills-dir-dialog' })

const props = defineProps<{ modelValue: boolean; root: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

interface Listing {
  path: string
  entries: { name: string; type: 'dir' | 'file'; size?: number }[]
  error?: string
}

const cwd = ref('')
const listing = ref<Listing | null>(null)
const loading = ref(false)
/** 宿主不支持 host.fs.list（不是网页宿主）：只显示路径 */
const unsupported = ref(false)
const copied = ref(false)

const sep = computed(() => (props.root.includes('\\') && !props.root.includes('/') ? '\\' : '/'))

/** 相对 Skill 目录的路径段（面包屑） */
const crumbs = computed<string[]>(() => {
  if (!cwd.value || cwd.value === props.root) return []
  return cwd.value.slice(props.root.length).split(/[\\/]/).filter(Boolean)
})

async function load(dir: string): Promise<void> {
  loading.value = true
  try {
    const r = (await window.cockpit.command('host.fs.list', { path: dir })) as Listing
    listing.value = r
    cwd.value = r.path || dir
  } catch (err) {
    console.warn('[yaya] skills dir listing failed', err)
    unsupported.value = true
    listing.value = null
  } finally {
    loading.value = false
  }
}

function enter(name: string): void {
  void load(cwd.value.replace(/[\\/]+$/, '') + sep.value + name)
}

function goCrumb(i: number): void {
  // i = -1 → Skill 目录本身
  const parts = crumbs.value.slice(0, i + 1)
  void load(
    parts.length
      ? props.root.replace(/[\\/]+$/, '') + sep.value + parts.join(sep.value)
      : props.root
  )
}

async function copyPath(): Promise<void> {
  await window.cockpit.copyText(cwd.value || props.root)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function fmtSize(n?: number): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.root) return
    unsupported.value = false
    cwd.value = props.root
    void load(props.root)
  },
  { immediate: true }
)
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    width="560"
    scrollable
    @update:model-value="emit('update:modelValue', $event === true)"
  >
    <v-card class="pa-4 yaya-pop skills-dir-card">
      <v-card-title class="px-0 pt-0 text-h6 d-flex align-center ga-2">
        <v-icon icon="mdi-folder-outline" color="primary" />
        <span>{{ t('yaya.settings.plugins.skills_dir_title', 'Skill 目录') }}</span>
      </v-card-title>
      <v-card-subtitle class="px-0 text-caption text-medium-emphasis dir-hint">
        {{
          t(
            'yaya.settings.plugins.skills_dir_hint',
            '目录在运行 Cockpit 的宿主机上，这台设备无法直接打开；可以复制路径，或在下面浏览。'
          )
        }}
      </v-card-subtitle>

      <div class="d-flex align-center ga-2 mt-3 path-row pa-2 rounded border">
        <span class="text-caption path-text">{{ cwd || root }}</span>
        <v-btn
          icon="mdi-content-copy"
          size="small"
          variant="text"
          class="flex-shrink-0"
          :title="t('yaya.settings.plugins.skills_copy_path', '复制目录路径')"
          :aria-label="t('yaya.settings.plugins.skills_copy_path', '复制目录路径')"
          @click="copyPath"
        />
      </div>
      <div v-if="copied" class="text-caption text-success mt-1">
        {{ t('yaya.settings.plugins.skills_path_copied', '已复制目录路径') }}
      </div>

      <v-card-text v-if="!unsupported" class="px-0 pb-0 pt-3 list-wrap">
        <div class="d-flex flex-wrap align-center ga-1 mb-2 text-body-2">
          <v-btn variant="text" class="crumb" @click="goCrumb(-1)">skills</v-btn>
          <template v-for="(c, i) in crumbs" :key="i">
            <v-icon icon="mdi-chevron-right" size="16" class="text-medium-emphasis" />
            <v-btn variant="text" class="crumb" @click="goCrumb(i)">{{ c }}</v-btn>
          </template>
        </div>
        <v-progress-linear v-if="loading" indeterminate color="primary" height="2" />
        <div v-else-if="listing?.error" class="text-caption text-error py-2">
          {{ listing.error }}
        </div>
        <div
          v-else-if="listing && listing.entries.length === 0"
          class="text-body-2 text-medium-emphasis py-4 text-center"
        >
          {{ t('yaya.settings.plugins.skills_dir_empty', '空目录') }}
        </div>
        <v-list v-else-if="listing" density="comfortable" class="py-0 bg-transparent">
          <v-list-item
            v-for="e in listing.entries"
            :key="e.name"
            :prepend-icon="e.type === 'dir' ? 'mdi-folder' : 'mdi-file-document-outline'"
            :title="e.name"
            :subtitle="e.type === 'file' ? fmtSize(e.size) : undefined"
            :link="e.type === 'dir'"
            rounded="lg"
            @click="e.type === 'dir' && enter(e.name)"
          />
        </v-list>
      </v-card-text>

      <v-card-actions class="px-0 pb-0 pt-3 justify-end">
        <v-btn variant="text" @click="emit('update:modelValue', false)">
          {{ t('yaya.settings.plugins.skills_dir_close', '关闭') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.path-row {
  border-color: rgba(var(--v-theme-surface-bright), 0.25) !important;
}
.path-text {
  flex: 1 1 0;
  min-width: 0;
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.dir-hint {
  white-space: normal;
}
.crumb {
  text-transform: none;
  min-width: 0;
  padding-inline: 8px;
}
.list-wrap {
  max-height: min(55vh, 480px);
}
</style>
