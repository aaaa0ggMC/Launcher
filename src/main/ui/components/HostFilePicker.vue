<script setup lang="ts">
/**
 * 宿主文件选择器（仅网页 / 无头模式）：浏览器拿不到宿主机上的绝对路径，
 * 所以由 web-shim 的 `file.pick` / `file.save` 派发 `cockpit:host-pick` 事件，
 * 这里弹一个对话框，经 `host.fs.list` 浏览**宿主**文件系统，点选后把路径回给调用方。
 * Electron 版有原生对话框，永远不会触发该事件。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '../i18n'

interface PickOpts {
  title?: string
  directory?: boolean
  any?: boolean
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}
interface PickRequest {
  mode: 'open' | 'save' | 'open-multi'
  opts?: PickOpts
  resolve: (path: string | string[] | null) => void
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
const te = (k: string, vars: Record<string, string>, f: string): string =>
  translateTemplate(uiLang.value, k, vars, f)

const open = ref(false)
const req = ref<PickRequest | null>(null)
const listing = ref<Listing | null>(null)
const loading = ref(false)
const pathInput = ref('')
const selected = ref<string | null>(null)
/** 多选模式（open-multi）：勾选的完整路径，按勾选顺序 */
const picked = ref<string[]>([])
const filename = ref('')
const showAll = ref(false)
const showHidden = ref(false)

// 「从此设备选择」：浏览器的文件选择 API 只给文件内容、不给宿主路径，所以把文件上传到宿主，
// 再把宿主上的路径当作选择结果返回。只在「选文件」时可用（文件夹 / 保存不适用）。
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadPct = ref(0)
/** 多文件上传：第几个 / 共几个 */
const uploadIndex = ref(0)
const uploadTotal = ref(0)
const uploadError = ref(false)
/** 本次上传已成功的宿主路径（中途失败也保留，用户可只使用这些） */
const uploadedPaths = ref<string[]>([])
let uploadXhr: XMLHttpRequest | null = null
let uploadAborted = false

const mode = computed(() => req.value?.mode ?? 'open')
const opts = computed(() => req.value?.opts ?? {})
const multi = computed(() => mode.value === 'open-multi')
const wantsDir = computed(() => mode.value === 'open' && !!opts.value.directory)
const sep = computed(() =>
  listing.value && listing.value.path.includes('\\') && !listing.value.path.includes('/')
    ? '\\'
    : '/'
)

// 单选与多选都能从此设备上传（多选时逐个上传）；选目录 / 另存为不行
const canUpload = computed(
  () => (mode.value === 'open' || mode.value === 'open-multi') && !wantsDir.value
)
const acceptAttr = computed(() =>
  filterable.value ? extensions.value.map((e) => `.${e}`).join(',') : ''
)

function pickFromDevice(): void {
  uploadError.value = false
  if (window.cockpit.client) void pickNative()
  else fileInput.value?.click()
}

/**
 * 安卓 App：系统文件选择器 + 原生直接流式上传到宿主（不经过 WebView 的 JS 内存），
 * 进度经 `cockpit:client-upload-progress` 事件回来。取消选择 = 返回空列表，对话框留着。
 */
let nativeBusy = false
async function pickNative(): Promise<void> {
  const client = window.cockpit.client
  if (!client || nativeBusy) return
  nativeBusy = true
  // 选择文件期间不显示进度条；第一条上传进度到了才显示
  uploadAborted = false
  uploadPct.value = 0
  uploadIndex.value = 0
  uploadTotal.value = 0
  uploadedPaths.value = []
  const off = window.cockpit.on('cockpit:client-upload-progress', (p: unknown) => {
    const e = p as { index: number; total: number; pct: number }
    uploading.value = true
    uploadIndex.value = e.index
    uploadTotal.value = e.total
    uploadPct.value = Math.max(0, e.pct)
  })
  try {
    const r = await client.call<{ paths: string[] }>('pickFiles', { multiple: multi.value })
    if (uploadAborted) return
    if (r.paths.length) finish(multi.value ? r.paths : r.paths[0])
  } catch (e) {
    if (!uploadAborted) uploadError.value = true
    console.warn('[hostpick] native pick failed', e)
  } finally {
    off()
    uploading.value = false
    nativeBusy = false
  }
}

function onDeviceFile(ev: Event): void {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许再次选同一个文件
  if (files.length) void uploadFiles(files)
}

/** 顺序上传（一次一个，进度按「第 i / n 个」显示）；中途失败保留已成功的路径 */
async function uploadFiles(files: File[]): Promise<void> {
  cancelUpload()
  uploading.value = true
  uploadAborted = false
  uploadPct.value = 0
  uploadIndex.value = 0
  uploadTotal.value = files.length
  uploadError.value = false
  uploadedPaths.value = []
  for (let i = 0; i < files.length; i++) {
    uploadIndex.value = i + 1
    uploadPct.value = 0
    const path = await uploadOne(files[i])
    if (uploadAborted) {
      uploading.value = false
      uploadXhr = null
      return
    }
    if (!path) {
      uploadError.value = true
      break
    }
    uploadedPaths.value.push(path)
  }
  uploading.value = false
  uploadXhr = null
  // 全部成功：直接结束；失败时留着对话框，用户可用「仅使用已上传的 n 个」
  if (!uploadError.value) {
    finish(multi.value ? uploadedPaths.value : (uploadedPaths.value[0] ?? null))
  }
}

/** 上传单个文件；取消 / 失败返回 null */
function uploadOne(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    uploadXhr = xhr
    // 同源请求自动带 cockpit_token Cookie 鉴权
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploadPct.value = Math.round((e.loaded / e.total) * 100)
    }
    const done = (path: string | null): void => {
      if (uploadXhr === xhr) uploadXhr = null
      resolve(path)
    }
    xhr.onload = () => {
      try {
        const r = JSON.parse(xhr.responseText) as { ok?: boolean; path?: string }
        if (xhr.status === 200 && r.ok && r.path) return done(r.path)
      } catch {
        /* fallthrough */
      }
      done(null)
    }
    xhr.onerror = () => done(null)
    xhr.onabort = () => done(null)
    xhr.send(file)
  })
}

function cancelUpload(): void {
  uploadAborted = true
  uploadXhr?.abort()
  uploadXhr = null
}

/** 上传中途失败：只把已成功上传的路径当结果 */
function useUploaded(): void {
  const paths = uploadedPaths.value
  finish(multi.value ? paths : (paths[0] ?? null))
}

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
    picked.value = []
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
  picked.value = []
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

function finish(path: string | string[] | null): void {
  cancelUpload()
  const r = req.value
  req.value = null
  open.value = false
  r?.resolve(path)
}

const canConfirm = computed(() => {
  if (!listing.value || listing.value.error) return false
  if (mode.value === 'save') return filename.value.trim().length > 0
  if (wantsDir.value) return true
  if (multi.value) return picked.value.length > 0
  return !!selected.value || !!opts.value.any
})

function confirm(): void {
  const l = listing.value
  if (!l || !canConfirm.value) return
  if (mode.value === 'save') return finish(join(l.path, filename.value.trim()))
  if (multi.value) return finish([...picked.value])
  if (selected.value) return finish(join(l.path, selected.value))
  finish(l.path) // 文件夹模式 / any 模式下没选文件 = 选当前目录
}

function fullPath(e: Listing['entries'][number]): string {
  return join(listing.value!.path, e.name)
}

function isPicked(e: Listing['entries'][number]): boolean {
  return picked.value.includes(fullPath(e))
}

function togglePicked(path: string): void {
  picked.value = picked.value.includes(path)
    ? picked.value.filter((p) => p !== path)
    : [...picked.value, path]
}

function onItem(e: Listing['entries'][number]): void {
  if (e.type === 'dir') return void go(fullPath(e))
  if (mode.value === 'save') filename.value = e.name
  else if (multi.value) togglePicked(fullPath(e))
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
        <v-chip
          v-if="canUpload"
          class="py-1"
          style="min-height: 24px"
          label
          color="primary"
          variant="tonal"
          prepend-icon="mdi-upload"
          :disabled="uploading"
          @click="pickFromDevice"
        >
          {{ t('hostpick.fromDevice', '从此设备选择') }}
        </v-chip>
        <input
          ref="fileInput"
          type="file"
          class="d-none"
          :accept="acceptAttr"
          :multiple="multi"
          @change="onDeviceFile"
        />
      </div>

      <div v-if="uploading || uploadError" class="px-6 pb-3">
        <template v-if="uploading">
          <div class="d-flex align-center ga-2 mb-1">
            <span class="text-body-2">
              <template v-if="uploadTotal > 1">
                {{
                  te(
                    'hostpick.uploading_multi',
                    { i: String(uploadIndex), n: String(uploadTotal) },
                    '正在上传第 {i} / {n} 个…'
                  )
                }}
                {{ uploadPct }}%
              </template>
              <template v-else
                >{{ t('hostpick.uploading', '正在上传…') }} {{ uploadPct }}%</template
              >
            </span>
            <v-spacer />
            <v-btn variant="text" @click="cancelUpload">{{ t('hostpick.cancel', '取消') }}</v-btn>
          </div>
          <v-progress-linear :model-value="uploadPct" color="primary" height="6" rounded />
        </template>
        <div v-else class="d-flex flex-wrap align-center ga-2">
          <span class="text-error text-body-2">
            {{ t('hostpick.uploadFailed', '上传失败，请重试') }}
          </span>
          <v-btn v-if="uploadedPaths.length" variant="text" @click="useUploaded">
            {{
              te(
                'hostpick.use_uploaded',
                { n: String(uploadedPaths.length) },
                '仅使用已上传的 {n} 个'
              )
            }}
          </v-btn>
        </div>
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
            :active="multi ? isPicked(e) : selected === e.name"
            :prepend-icon="
              multi ? undefined : e.type === 'dir' ? 'mdi-folder-outline' : 'mdi-file-outline'
            "
            :title="e.name"
            :subtitle="size(e.size)"
            @click="onItem(e)"
            @dblclick="
              !multi && e.type === 'file' && mode === 'open' && ((selected = e.name), confirm())
            "
          >
            <template v-if="multi && e.type === 'file'" #prepend>
              <v-checkbox
                :model-value="isPicked(e)"
                density="compact"
                hide-details
                :title="te('hostpick.toggle', { name: e.name }, '选择 {name}')"
                :aria-label="te('hostpick.toggle', { name: e.name }, '选择 {name}')"
                @click.stop="onItem(e)"
              />
            </template>
          </v-list-item>
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
        <span v-if="multi && picked.length" class="text-caption text-medium-emphasis">
          {{ te('hostpick.picked', { n: String(picked.length) }, '已选 {n} 个') }}
        </span>
        <v-btn color="primary" variant="flat" :disabled="!canConfirm" @click="confirm">
          <template v-if="mode === 'save'">{{ t('hostpick.save', '保存') }}</template>
          <template v-else-if="multi">
            {{ te('hostpick.select_multi', { n: String(picked.length) }, '选择（{n}）') }}
          </template>
          <template v-else-if="wantsDir || (!selected && opts.any)">
            {{ t('hostpick.selectFolder', '选择此文件夹') }}
          </template>
          <template v-else>{{ t('hostpick.select', '选择') }}</template>
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
