<script setup lang="ts">
/**
 * 宿主文件选择器（仅网页 / 无头模式）：浏览器拿不到宿主机上的绝对路径，
 * 所以由 web-shim 的 `file.pick` / `file.save` 派发 `cockpit:host-pick` 事件，
 * 这里弹一个对话框，经 `host.fs.list` 浏览**宿主**文件系统，点选后把路径回给调用方。
 * Electron 版有原生对话框，永远不会触发该事件。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../i18n'

interface PickOpts {
  title?: string
  directory?: boolean
  any?: boolean
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}
interface PickRequest {
  mode: 'open' | 'save'
  opts?: PickOpts
  resolve: (path: string | null) => void
}
interface Listing {
  path: string
  parent: string | null
  entries: { name: string; type: 'dir' | 'file'; size?: number }[]
  roots: { label: string; path: string }[]
  error?: string
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)

const open = ref(false)
const req = ref<PickRequest | null>(null)
const listing = ref<Listing | null>(null)
const loading = ref(false)
const pathInput = ref('')
const selected = ref<string | null>(null)
const filename = ref('')
const showAll = ref(false)
const showHidden = ref(false)

const mode = computed(() => req.value?.mode ?? 'open')
const opts = computed(() => req.value?.opts ?? {})
const wantsDir = computed(() => mode.value === 'open' && !!opts.value.directory)
const sep = computed(() =>
  listing.value && listing.value.path.includes('\\') && !listing.value.path.includes('/')
    ? '\\'
    : '/'
)

const title = computed(
  () =>
    opts.value.title ||
    (mode.value === 'save'
      ? t('hostpick.title.save', '保存到…')
      : wantsDir.value
        ? t('hostpick.title.folder', '选择文件夹')
        : t('hostpick.title.file', '选择文件'))
)

const extensions = computed(() =>
  (opts.value.filters ?? []).flatMap((f) =>
    f.extensions.map((e) => e.replace(/^\./, '').toLowerCase())
  )
)
const filterable = computed(
  () => !wantsDir.value && extensions.value.length > 0 && !extensions.value.includes('*')
)

const visible = computed(() => {
  const l = listing.value
  if (!l) return []
  return l.entries.filter((e) => {
    if (!showHidden.value && e.name.startsWith('.')) return false
    if (e.type === 'dir') return true
    if (wantsDir.value) return false
    if (mode.value === 'save' || showAll.value || !filterable.value) return true
    const dot = e.name.lastIndexOf('.')
    return dot >= 0 && extensions.value.includes(e.name.slice(dot + 1).toLowerCase())
  })
})

async function go(dir?: string): Promise<void> {
  loading.value = true
  try {
    const r = (await window.cockpit.command('host.fs.list', dir ? { path: dir } : {})) as Listing
    listing.value = r
    pathInput.value = r.path
    selected.value = null
  } catch {
    listing.value = null
  } finally {
    loading.value = false
  }
}

function join(dir: string, name: string): string {
  return dir.endsWith(sep.value) ? dir + name : dir + sep.value + name
}

function onRequest(ev: Event): void {
  const detail = (ev as CustomEvent<PickRequest>).detail
  // 已有对话框在显示：旧请求视为取消
  req.value?.resolve(null)
  req.value = detail
  showAll.value = false
  filename.value = ''
  let start: string | undefined
  const dp = detail.opts?.defaultPath
  if (dp) {
    // defaultPath 可能是「目录」或「目录/文件名」
    const cut = Math.max(dp.lastIndexOf('/'), dp.lastIndexOf('\\'))
    if (detail.mode === 'save' && cut >= 0) {
      start = dp.slice(0, cut) || '/'
      filename.value = dp.slice(cut + 1)
    } else if (detail.mode === 'save') filename.value = dp
    else start = dp
  }
  open.value = true
  void go(start)
}

onMounted(() => window.addEventListener('cockpit:host-pick', onRequest))
onBeforeUnmount(() => window.removeEventListener('cockpit:host-pick', onRequest))

function finish(path: string | null): void {
  const r = req.value
  req.value = null
  open.value = false
  r?.resolve(path)
}

const canConfirm = computed(() => {
  if (!listing.value || listing.value.error) return false
  if (mode.value === 'save') return filename.value.trim().length > 0
  if (wantsDir.value) return true
  return !!selected.value || !!opts.value.any
})

function confirm(): void {
  const l = listing.value
  if (!l || !canConfirm.value) return
  if (mode.value === 'save') return finish(join(l.path, filename.value.trim()))
  if (selected.value) return finish(join(l.path, selected.value))
  finish(l.path) // 文件夹模式 / any 模式下没选文件 = 选当前目录
}

function onItem(e: Listing['entries'][number]): void {
  if (e.type === 'dir') void go(join(listing.value!.path, e.name))
  else if (mode.value === 'save') filename.value = e.name
  else selected.value = e.name
}

function size(n?: number): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <v-dialog
    v-model="open"
    max-width="640"
    scrollable
    @update:model-value="(v: boolean) => !v && finish(null)"
  >
    <v-card>
      <v-card-title class="px-6 pt-5 pb-3">{{ title }}</v-card-title>

      <div class="px-6 pb-3 d-flex align-center ga-2">
        <v-btn
          icon="mdi-arrow-up"
          variant="text"
          size="small"
          :disabled="!listing?.parent"
          :aria-label="t('hostpick.up', '上一级')"
          :title="t('hostpick.up', '上一级')"
          @click="listing?.parent && go(listing.parent)"
        />
        <v-text-field
          v-model="pathInput"
          density="compact"
          variant="outlined"
          hide-details
          :aria-label="t('hostpick.path', '路径')"
          @keydown.enter="go(pathInput)"
        />
      </div>

      <div class="px-6 pb-3 d-flex flex-wrap ga-2">
        <v-chip
          v-for="r in listing?.roots ?? []"
          :key="r.path"
          class="py-1"
          style="min-height: 24px"
          label
          @click="go(r.path)"
        >
          {{ t('hostpick.root.' + r.label, r.label) }}
        </v-chip>
      </div>

      <v-divider />
      <v-card-text class="pa-0" style="height: 360px">
        <v-progress-linear v-if="loading" indeterminate />
        <div v-if="listing?.error" class="pa-6 text-error">
          {{ t('hostpick.error', '无法读取该目录') }}：{{ listing.error }}
        </div>
        <div v-else-if="!loading && !visible.length" class="pa-6 text-medium-emphasis">
          {{ t('hostpick.empty', '这里没有可选的内容') }}
        </div>
        <v-list density="comfortable" class="py-0">
          <v-list-item
            v-for="e in visible"
            :key="e.name"
            :active="selected === e.name"
            :prepend-icon="e.type === 'dir' ? 'mdi-folder-outline' : 'mdi-file-outline'"
            :title="e.name"
            :subtitle="size(e.size)"
            @click="onItem(e)"
            @dblclick="e.type === 'file' && mode === 'open' && ((selected = e.name), confirm())"
          />
        </v-list>
      </v-card-text>
      <v-divider />

      <div v-if="mode === 'save'" class="px-6 pt-4">
        <v-text-field
          v-model="filename"
          density="comfortable"
          variant="outlined"
          hide-details
          :label="t('hostpick.filename', '文件名')"
          @keydown.enter="confirm"
        />
      </div>

      <v-card-actions class="px-6 py-4 ga-2 flex-wrap">
        <v-checkbox
          v-if="filterable && mode === 'open'"
          v-model="showAll"
          density="compact"
          hide-details
          :label="t('hostpick.showAll', '显示所有文件')"
        />
        <v-checkbox
          v-model="showHidden"
          density="compact"
          hide-details
          :label="t('hostpick.showHidden', '显示隐藏文件')"
        />
        <v-spacer />
        <v-btn variant="text" @click="finish(null)">{{ t('hostpick.cancel', '取消') }}</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!canConfirm" @click="confirm">
          {{
            mode === 'save'
              ? t('hostpick.save', '保存')
              : wantsDir || (!selected && opts.any)
                ? t('hostpick.selectFolder', '选择此文件夹')
                : t('hostpick.select', '选择')
          }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
