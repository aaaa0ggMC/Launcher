<script setup lang="ts">
import { ref, onMounted, inject, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { ResolvedBiliItem } from '../commands/metadata-slots'
import type { MetadataSlotInfo } from '../services/metadata-slots'

const emit = defineEmits<{
  (e: 'back'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// Input & parsing state
const rawInput = ref('')
const resolving = ref(false)
const resolvedItems = ref<ResolvedBiliItem[]>([])

// Download options
const audioOnly = ref(false)
const selectedSlot = ref('Bilibili-Current.metadata')
const slotOptions = ref<{ title: string; value: string }[]>([
  { title: 'Bilibili-Current.metadata (B站专用)', value: 'Bilibili-Current.metadata' }
])

// Submission & feedback state
const downloading = ref(false)
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function loadSlots(): Promise<void> {
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-list')) as {
      ok: boolean
      slots: MetadataSlotInfo[]
      biliDefaultSlot?: string
    }
    if (res?.ok && Array.isArray(res.slots)) {
      const defaultBili = res.biliDefaultSlot || 'Bilibili-Current.metadata'
      const opts: { title: string; value: string }[] = []
      let hasBili = false
      for (const s of res.slots) {
        const val = s.id === 'default' ? 'music_metadata.jsonl' : s.id
        const isBiliDef = s.id === defaultBili || val === defaultBili
        if (isBiliDef) hasBili = true
        opts.push({
          title: isBiliDef ? `${s.name} (${t('aidj.slots.bili_target', 'B站默认')})` : s.name,
          value: val
        })
      }
      if (!hasBili) {
        opts.unshift({
          title: `${defaultBili} (${t('aidj.slots.bili_target', 'B站默认')})`,
          value: defaultBili
        })
      }
      slotOptions.value = opts
      selectedSlot.value = defaultBili
    }
  } catch {
    /* fallback to default */
  }
}

async function handleResolve(): Promise<void> {
  const text = rawInput.value.trim()
  if (!text) {
    showSnack(t('aidj.bili.input_empty', '请输入 BV 号、AV 号或 Bilibili 视频链接'), 'warning')
    return
  }

  resolving.value = true
  try {
    const res = (await window.cockpit.command('aidj.bili-resolve', { input: text })) as {
      ok: boolean
      items?: ResolvedBiliItem[]
      errors?: string[]
      error?: string
    }

    if (res?.ok && Array.isArray(res.items) && res.items.length > 0) {
      // Append unique items to existing resolved list
      const existingIds = new Set(resolvedItems.value.map((it) => it.id))
      let added = 0
      for (const item of res.items) {
        if (!existingIds.has(item.id)) {
          resolvedItems.value.push(item)
          existingIds.add(item.id)
          added++
        }
      }

      if (res.errors && res.errors.length > 0) {
        showSnack(`已解析添加 ${added} 项，部分异常: ${res.errors.join('; ')}`, 'warning')
      } else {
        showSnack(`成功解析并添加 ${added} 个视频项目`)
      }
    } else {
      showSnack(res?.error || t('aidj.bili.resolve_failed', '未能解析出有效的视频项目'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    resolving.value = false
  }
}

function handleRemoveItem(index: number): void {
  resolvedItems.value.splice(index, 1)
}

function handleClearAll(): void {
  resolvedItems.value = []
}

async function handleConfirmDownload(): Promise<void> {
  if (resolvedItems.value.length === 0) return

  downloading.value = true
  try {
    const targetItems = JSON.parse(JSON.stringify(resolvedItems.value))
    const taskName = `B站下载 (${targetItems.length}项)`

    const res = (await window.cockpit.btJob('aidj.bili-batch-download', {
      name: taskName,
      description: `批量下载 ${targetItems.length} 个 Bilibili 音视频并同步元数据`,
      items: targetItems,
      audioOnly: audioOnly.value,
      slotName: selectedSlot.value
    })) as { ok?: boolean; task?: { id?: string }; error?: string }

    if (res?.ok || res?.task) {
      showSnack(`已启动批量下载任务 (${targetItems.length}项)，可在后台任务面板查看`)
      resolvedItems.value = []
      rawInput.value = ''
    } else if (res?.error) {
      showSnack(res.error, 'error')
    } else {
      showSnack('下载任务已提交')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    downloading.value = false
  }
}

onMounted(() => {
  loadSlots()
})
</script>

<template>
  <div class="bili-download-container">
    <!-- Header -->
    <div class="bili-head d-flex align-center ga-2 pb-3">
      <v-btn
        icon
        size="small"
        variant="text"
        :title="t('aidj.sessions.back', '返回')"
        @click="emit('back')"
      >
        <v-icon size="18">mdi-arrow-left</v-icon>
      </v-btn>
      <span class="text-body-2 font-weight-medium">
        {{ t('aidj.bili.title', 'Bilibili 视频解析与下载') }}
      </span>
      <v-spacer />
      <v-chip
        v-if="resolvedItems.length > 0"
        size="small"
        color="primary"
        variant="flat"
        class="count-chip"
      >
        {{ `${resolvedItems.length} 项待下载` }}
      </v-chip>
    </div>

    <!-- Input Section -->
    <div class="bili-input-box px-1 pb-3">
      <v-textarea
        v-model="rawInput"
        rows="2"
        density="compact"
        variant="outlined"
        hide-details
        no-resize
        :placeholder="
          t(
            'aidj.bili.input_placeholder',
            '输入单个或一串 BV号 / AV号 / 视频链接 (支持空格、逗号或换行分隔)'
          )
        "
        @keydown.ctrl.enter="handleResolve"
      />
      <div class="d-flex align-center ga-2 pt-2">
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-movie-search-outline"
          :loading="resolving"
          class="resolve-btn"
          @click="handleResolve"
        >
          {{ t('aidj.bili.resolve_btn', '解析视频') }}
        </v-btn>
        <v-btn v-if="rawInput" variant="text" class="clear-input-btn" @click="rawInput = ''">
          {{ t('aidj.clear', '清空输入') }}
        </v-btn>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          {{ t('aidj.bili.shortcut_hint', 'Ctrl+Enter 快速解析') }}
        </span>
      </div>
    </div>

    <!-- Options Toolbar (Slot Switcher & Audio/Video) -->
    <div class="bili-options-box px-1 py-2 d-flex align-center ga-3 flex-wrap">
      <!-- User can switch metadata slot -->
      <div class="slot-select-wrap flex-grow-1 min-w-0">
        <v-select
          v-model="selectedSlot"
          :items="slotOptions"
          item-title="title"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          :label="t('aidj.bili.slot_label', '元数据写入槽位')"
          prepend-inner-icon="mdi-database-outline"
          class="slot-select"
        />
      </div>

      <!-- Audio only toggle -->
      <div class="d-flex align-center ga-2 flex-shrink-0">
        <v-switch
          v-model="audioOnly"
          density="compact"
          color="primary"
          hide-details
          :label="
            audioOnly
              ? t('aidj.bili.audio_only', '仅音频 (m4a)')
              : t('aidj.bili.video_full', '视频流 (mp4)')
          "
          class="audio-switch"
        />
      </div>
    </div>

    <!-- Resolved Items List -->
    <div class="bili-items-scroll">
      <div v-if="resolving" class="d-flex flex-column align-center justify-center py-8 ga-2">
        <v-progress-circular indeterminate color="primary" size="32" />
        <span class="text-caption text-medium-emphasis">
          {{ t('aidj.bili.resolving_hint', '正在拉取视频详情与多P分轨…') }}
        </span>
      </div>

      <v-empty-state
        v-else-if="resolvedItems.length === 0"
        icon="mdi-video-plus-outline"
        :title="t('aidj.bili.empty_title', '等待解析视频')"
        :text="t('aidj.bili.empty_hint', '粘贴 BV/AV 号后点击“解析视频”，支持多分P自动拆分')"
        class="my-3"
      />

      <div v-else class="d-flex flex-column ga-2 pb-2">
        <div class="d-flex align-center justify-space-between px-1 pb-1">
          <span class="text-caption text-medium-emphasis">
            {{ `已解析 ${resolvedItems.length} 个条目（点击右侧按钮可删除误加项目）` }}
          </span>
          <v-btn
            variant="text"
            color="error"
            size="small"
            class="clear-all-btn"
            @click="handleClearAll"
          >
            {{ t('aidj.bili.clear_all', '清空全部') }}
          </v-btn>
        </div>

        <div
          v-for="(it, idx) in resolvedItems"
          :key="it.id"
          class="bili-item-card d-flex align-center ga-3 pa-2"
        >
          <!-- Thumbnail cover -->
          <div class="bili-thumb flex-shrink-0">
            <img
              v-if="it.pic"
              :src="it.pic"
              referrerpolicy="no-referrer"
              class="bili-thumb-img"
              alt="cover"
            />
            <div v-else class="bili-thumb-placeholder d-flex align-center justify-center">
              <v-icon size="20">mdi-video</v-icon>
            </div>
            <span class="duration-badge">{{ formatDuration(it.duration) }}</span>
          </div>

          <!-- Video Details -->
          <div class="bili-item-info flex-grow-1 min-w-0">
            <div class="d-flex align-center ga-1 flex-wrap">
              <span class="bili-title text-body-2 font-weight-medium text-truncate">
                {{ it.title }}
              </span>
            </div>

            <!-- Multi-P Badge -->
            <div v-if="it.isMultiPart" class="d-flex align-center ga-2 mt-1">
              <v-chip
                size="x-small"
                color="secondary"
                variant="tonal"
                class="part-chip font-weight-medium"
              >
                {{ `P${it.page}: ${it.partTitle || '分P'}` }}
              </v-chip>
            </div>

            <!-- Author & BVID -->
            <div class="bili-sub text-caption text-medium-emphasis mt-1 d-flex align-center ga-2">
              <span class="text-truncate">{{ `UP: ${it.author}` }}</span>
              <span>•</span>
              <span class="text-mono">{{ it.bvid }}</span>
            </div>
          </div>

          <!-- Delete Item Action -->
          <v-btn
            icon
            size="small"
            variant="text"
            color="error"
            :title="t('aidj.bili.remove_item', '删除该条目')"
            class="remove-btn flex-shrink-0"
            @click="handleRemoveItem(idx)"
          >
            <v-icon size="18">mdi-trash-can-outline</v-icon>
          </v-btn>
        </div>
      </div>
    </div>

    <!-- Footer Action Bar -->
    <div v-if="resolvedItems.length > 0" class="bili-actions px-1 pt-3 d-flex align-center ga-2">
      <v-spacer />
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-download"
        :loading="downloading"
        class="confirm-btn"
        @click="handleConfirmDownload"
      >
        {{
          t('aidj.bili.confirm_download', '确认下载 ({n} 项)').replace(
            '{n}',
            String(resolvedItems.length)
          )
        }}
      </v-btn>
    </div>

    <!-- Snackbar -->
    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="2200">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.bili-download-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.bili-head {
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
}

.count-chip {
  padding-block: 4px !important;
  min-height: 24px !important;
}

.bili-options-box {
  background: rgba(var(--v-theme-surface-bright), 0.05);
  border-radius: 8px;
  margin-bottom: 8px;
}

.slot-select {
  font-size: 0.85rem;
}

.bili-items-scroll {
  max-height: 360px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

.bili-items-scroll::-webkit-scrollbar {
  width: 6px;
}

.bili-items-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.4);
  border-radius: 3px;
}

.bili-item-card {
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-bright), 0.08);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.bili-item-card:hover {
  background: rgba(var(--v-theme-primary), 0.08);
  border-color: rgba(var(--v-theme-primary), 0.3);
}

.bili-thumb {
  position: relative;
  width: 72px;
  height: 48px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
}

.bili-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bili-thumb-placeholder {
  width: 100%;
  height: 100%;
  opacity: 0.6;
}

.duration-badge {
  position: absolute;
  bottom: 2px;
  right: 2px;
  padding: 1px 3px;
  font-size: 0.65rem;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border-radius: 3px;
}

.part-chip {
  padding-block: 2px !important;
  min-height: 20px !important;
  font-size: 0.7rem !important;
}

.resolve-btn,
.confirm-btn {
  font-size: 0.85rem;
}

.clear-input-btn,
.clear-all-btn {
  font-size: 0.78rem;
}

.bili-actions {
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
}
</style>
