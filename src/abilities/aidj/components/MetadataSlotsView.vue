<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, inject, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { MetadataSlotInfo, MetadataSlotEntry } from '../services/metadata-slots'

const emit = defineEmits<{
  (e: 'back'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// State
const loading = ref(false)
const slots = ref<MetadataSlotInfo[]>([])
const activeWriteSlot = ref('default')
const biliDefaultSlot = ref('Bilibili-Current.metadata')
const totalActiveSongs = ref(0)

// Single slot inspection / detail view
const viewMode = ref<'list' | 'detail'>('list')
const selectedSlot = ref<MetadataSlotInfo | null>(null)
const entries = ref<MetadataSlotEntry[]>([])
const entriesLoading = ref(false)
const searchFilter = ref('')

// Dialog for creating a new slot
const createDialogOpen = ref(false)
const newSlotName = ref('')
const createBusy = ref(false)

// Dialog for safe deleting a slot
const deleteDialogOpen = ref(false)
const slotToDelete = ref<MetadataSlotInfo | null>(null)
const deleteBusy = ref(false)

// Snackbar
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

async function loadSlots(): Promise<void> {
  loading.value = true
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-list')) as {
      ok: boolean
      slots: MetadataSlotInfo[]
      activeWriteSlot: string
      biliDefaultSlot?: string
      totalActiveSongs: number
      error?: string
    }
    if (res?.ok) {
      slots.value = res.slots || []
      activeWriteSlot.value = res.activeWriteSlot || 'default'
      biliDefaultSlot.value = res.biliDefaultSlot || 'Bilibili-Current.metadata'
      totalActiveSongs.value = res.totalActiveSongs || 0
    } else {
      showSnack(res?.error || t('aidj.slots.load_failed', '加载槽位列表失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    loading.value = false
  }
}

async function handleToggleSlot(slot: MetadataSlotInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-toggle', {
      slot: slot.id
    })) as {
      ok: boolean
      slots: MetadataSlotInfo[]
      totalActiveSongs: number
      error?: string
    }
    if (res?.ok) {
      slots.value = res.slots
      totalActiveSongs.value = res.totalActiveSongs
    } else {
      showSnack(res?.error || t('aidj.slots.toggle_failed', '切换槽位失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  }
}

async function handleSetWriteTarget(slot: MetadataSlotInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-set-write', {
      slot: slot.id
    })) as {
      ok: boolean
      activeWriteSlot: string
      error?: string
    }
    if (res?.ok) {
      activeWriteSlot.value = res.activeWriteSlot
      for (const s of slots.value) {
        s.isWriteTarget =
          s.id === res.activeWriteSlot || (s.isDefault && res.activeWriteSlot === 'default')
      }
      showSnack(t('aidj.slots.write_target_set', '已设为构建写入目标槽位'))
    }
  } catch (e) {
    showSnack(String(e), 'error')
  }
}

async function openDetail(slot: MetadataSlotInfo): Promise<void> {
  selectedSlot.value = slot
  viewMode.value = 'detail'
  searchFilter.value = ''
  await loadEntries(slot.id)
}

async function loadEntries(slotId: string): Promise<void> {
  entriesLoading.value = true
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-entries', {
      slot: slotId
    })) as {
      ok: boolean
      slot: MetadataSlotInfo
      entries: MetadataSlotEntry[]
      error?: string
    }
    if (res?.ok) {
      entries.value = res.entries || []
      if (res.slot) {
        selectedSlot.value = res.slot
      }
    } else {
      showSnack(res?.error || t('aidj.slots.entries_failed', '获取条目失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    entriesLoading.value = false
  }
}

function backToList(): void {
  viewMode.value = 'list'
  selectedSlot.value = null
  entries.value = []
  searchFilter.value = ''
  loadSlots()
}

async function handleToggleEntry(entry: MetadataSlotEntry): Promise<void> {
  if (!selectedSlot.value) return
  const nextEnabled = !entry.enabled
  entry.enabled = nextEnabled

  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-toggle', {
      slot: selectedSlot.value.id,
      song: entry.name,
      enabled: nextEnabled
    })) as {
      ok: boolean
      selectedCount: number
      triState: 'all' | 'partial' | 'none'
      totalActiveSongs: number
      error?: string
    }
    if (res?.ok) {
      selectedSlot.value.selectedCount = res.selectedCount
      selectedSlot.value.triState = res.triState
      totalActiveSongs.value = res.totalActiveSongs
    } else {
      entry.enabled = !nextEnabled // rollback
      showSnack(res?.error || t('aidj.slots.toggle_item_failed', '切换单曲失败'), 'error')
    }
  } catch (e) {
    entry.enabled = !nextEnabled
    showSnack(String(e), 'error')
  }
}

async function handleToggleAllEntries(enableAll: boolean): Promise<void> {
  if (!selectedSlot.value) return
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-toggle-all', {
      slot: selectedSlot.value.id,
      enableAll
    })) as {
      ok: boolean
      selectedCount: number
      triState: 'all' | 'partial' | 'none'
      totalActiveSongs: number
      error?: string
    }
    if (res?.ok) {
      for (const e of entries.value) {
        e.enabled = enableAll
      }
      selectedSlot.value.selectedCount = res.selectedCount
      selectedSlot.value.triState = res.triState
      totalActiveSongs.value = res.totalActiveSongs
    }
  } catch (e) {
    showSnack(String(e), 'error')
  }
}

async function handleCreateSlot(): Promise<void> {
  const name = newSlotName.value.trim()
  if (!name) return
  createBusy.value = true
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-create', {
      name
    })) as {
      ok: boolean
      slot?: MetadataSlotInfo
      error?: string
    }
    if (res?.ok) {
      createDialogOpen.value = false
      newSlotName.value = ''
      showSnack(t('aidj.slots.create_success', '槽位创建成功'))
      await loadSlots()
    } else {
      showSnack(res?.error || t('aidj.slots.create_failed', '创建失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    createBusy.value = false
  }
}

async function handleSetBiliDefault(slot: MetadataSlotInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-set-bili-default', {
      slot: slot.id
    })) as {
      ok: boolean
      biliDefaultSlot: string
      error?: string
    }
    if (res?.ok) {
      biliDefaultSlot.value = res.biliDefaultSlot
      for (const s of slots.value) {
        s.isBiliDefault = s.id === res.biliDefaultSlot
      }
      showSnack(t('aidj.slots.bili_default_set', '已设为B站默认写入槽位'))
    } else {
      showSnack(res?.error || t('aidj.slots.set_failed', '设置失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  }
}

function openDeleteDialog(slot: MetadataSlotInfo, e?: Event): void {
  e?.stopPropagation()
  if (slot.isDefault) return
  slotToDelete.value = slot
  deleteDialogOpen.value = true
}

async function confirmDeleteSlot(): Promise<void> {
  if (!slotToDelete.value) return
  deleteBusy.value = true
  try {
    const res = (await window.cockpit.command('aidj.metadata-slots-delete', {
      slot: slotToDelete.value.id
    })) as { ok: boolean; error?: string }
    if (res?.ok) {
      showSnack(t('aidj.slots.delete_success', '槽位已安全移除 (文件已重命名备份)'))
      deleteDialogOpen.value = false
      slotToDelete.value = null
      await loadSlots()
    } else {
      showSnack(res?.error || t('aidj.slots.delete_failed', '删除失败'), 'error')
    }
  } catch (e) {
    showSnack(String(e), 'error')
  } finally {
    deleteBusy.value = false
  }
}

// Filtered entries for detail virtual scroll
const filteredEntries = computed(() => {
  const q = searchFilter.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter((e) => {
    const m = e.metadata
    const nameMatch = e.name.toLowerCase().includes(q)
    const reviewMatch = (m.review || '').toLowerCase().includes(q)
    const genreMatch = Array.isArray(m.genre)
      ? m.genre.some((g) => g.toLowerCase().includes(q))
      : String(m.genre || '')
          .toLowerCase()
          .includes(q)
    const emotionMatch = Array.isArray(m.emotion)
      ? m.emotion.some((em) => em.toLowerCase().includes(q))
      : String(m.emotion || '')
          .toLowerCase()
          .includes(q)
    return nameMatch || reviewMatch || genreMatch || emotionMatch
  })
})

let slotsUnsub: (() => void) | null = null

onMounted(() => {
  loadSlots()
  if (window.cockpit?.on) {
    slotsUnsub = window.cockpit.on('cockpit:aidj-slots-changed', (ev: unknown) => {
      const event = ev as Record<string, unknown>
      if (typeof event?.totalActiveSongs === 'number') {
        totalActiveSongs.value = event.totalActiveSongs
      }
      if (viewMode.value === 'list') {
        loadSlots()
      }
    })
  }
})

onUnmounted(() => {
  if (slotsUnsub) {
    slotsUnsub()
    slotsUnsub = null
  }
})
</script>

<template>
  <div class="slots-container">
    <!-- VIEW MODE: LIST -->
    <template v-if="viewMode === 'list'">
      <!-- Header -->
      <div class="slots-head d-flex align-center ga-2 pb-3">
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
          {{ t('aidj.slots.title', '元数据槽位 (Metadata Slots)') }}
        </span>
        <v-chip size="small" color="primary" variant="flat" class="ml-1 active-chip">
          {{
            t('aidj.slots.active_count', '生效: {n} 首').replace('{n}', String(totalActiveSongs))
          }}
        </v-chip>
        <v-spacer />
        <v-btn
          variant="tonal"
          prepend-icon="mdi-plus"
          class="create-btn"
          @click="createDialogOpen = true"
        >
          {{ t('aidj.slots.create', '新建合集') }}
        </v-btn>
        <v-btn
          icon
          size="small"
          variant="text"
          :loading="loading"
          :title="t('aidj.sessions.refresh', '刷新')"
          @click="loadSlots"
        >
          <v-icon size="18">mdi-refresh</v-icon>
        </v-btn>
      </div>

      <!-- Slots List -->
      <div class="slots-scroll">
        <v-empty-state
          v-if="!loading && slots.length === 0"
          icon="mdi-database-outline"
          :title="t('aidj.slots.empty', '暂无元数据槽位')"
          class="my-4"
        />
        <div v-else class="d-flex flex-column ga-2 pb-2">
          <div
            v-for="s in slots"
            :key="s.id"
            class="slot-card"
            :class="{ 'is-write-target': s.isWriteTarget, 'is-disabled': !s.enabled }"
            @click="openDetail(s)"
          >
            <!-- Tri-state Toggle -->
            <button
              class="tristate-toggle-btn"
              :title="t('aidj.slots.toggle_all_hint', '点击切换全选/未选')"
              @click.stop="handleToggleSlot(s, $event)"
            >
              <v-icon v-if="s.triState === 'all'" size="20" color="primary">
                mdi-checkbox-marked
              </v-icon>
              <v-icon v-else-if="s.triState === 'partial'" size="20" color="primary">
                mdi-minus-box
              </v-icon>
              <v-icon v-else size="20" class="text-medium-emphasis">
                mdi-checkbox-blank-outline
              </v-icon>
            </button>

            <!-- Info -->
            <div class="slot-info flex-grow-1 min-w-0">
              <div class="d-flex align-center ga-2 flex-wrap">
                <span class="slot-name text-truncate font-weight-medium">{{ s.name }}</span>
                <v-chip
                  v-if="s.isWriteTarget"
                  size="x-small"
                  color="success"
                  variant="flat"
                  class="tag-chip"
                >
                  {{ t('aidj.slots.write_target', '写入目标') }}
                </v-chip>
                <v-chip
                  v-else-if="s.isBiliDefault"
                  size="x-small"
                  color="info"
                  variant="outlined"
                  class="tag-chip"
                >
                  {{ t('aidj.slots.bili_target', 'B站默认') }}
                </v-chip>
              </div>
              <div class="slot-meta text-caption text-medium-emphasis mt-1">
                {{ `${s.selectedCount} / ${s.totalCount} 首生效` }}
              </div>
            </div>

            <!-- Actions Group -->
            <div class="d-flex align-center ga-1" @click.stop>
              <v-btn
                v-if="!s.isWriteTarget"
                variant="text"
                prepend-icon="mdi-pencil-box-outline"
                class="target-btn"
                @click="handleSetWriteTarget(s, $event)"
              >
                {{ t('aidj.slots.set_write', '设为写入') }}
              </v-btn>
              <v-btn
                v-if="!s.isBiliDefault"
                variant="text"
                prepend-icon="mdi-video-box"
                class="target-btn"
                @click="handleSetBiliDefault(s, $event)"
              >
                {{ t('aidj.slots.set_bili_default', '设为B站默认') }}
              </v-btn>
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('aidj.slots.view_items', '查看条目')"
                @click="openDetail(s)"
              >
                <v-icon size="18">mdi-chevron-right</v-icon>
              </v-btn>
              <v-btn
                v-if="!s.isDefault"
                icon
                size="small"
                variant="text"
                color="error"
                :title="t('aidj.slots.delete', '删除槽位')"
                @click="openDeleteDialog(s, $event)"
              >
                <v-icon size="16">mdi-trash-can-outline</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- VIEW MODE: DETAIL (SLOT ITEMS SLIDING WINDOW) -->
    <template v-else-if="viewMode === 'detail' && selectedSlot">
      <!-- Detail Head -->
      <div class="slots-head d-flex align-center ga-2 pb-2">
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('aidj.sessions.back', '返回列表')"
          @click="backToList"
        >
          <v-icon size="18">mdi-arrow-left</v-icon>
        </v-btn>
        <span class="text-body-2 font-weight-medium text-truncate">
          {{ selectedSlot.name }}
        </span>
        <v-chip size="small" variant="flat" color="primary" class="active-chip">
          {{ `${selectedSlot.selectedCount} / ${selectedSlot.totalCount} 首` }}
        </v-chip>
        <v-spacer />
        <v-btn variant="text" class="bulk-btn" @click="handleToggleAllEntries(true)">
          {{ t('aidj.slots.select_all', '全选') }}
        </v-btn>
        <v-btn variant="text" class="bulk-btn" @click="handleToggleAllEntries(false)">
          {{ t('aidj.slots.deselect_all', '全不选') }}
        </v-btn>
      </div>

      <!-- Search Filter -->
      <div class="px-1 pb-3">
        <v-text-field
          v-model="searchFilter"
          density="compact"
          variant="outlined"
          hide-details
          prepend-inner-icon="mdi-magnify"
          :placeholder="t('aidj.slots.search_placeholder', '搜索歌曲名、流派、情绪、乐评…')"
          clearable
        />
      </div>

      <!-- Virtual Scroll Sliding Window -->
      <div class="detail-scroll-wrap">
        <div v-if="entriesLoading" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary" size="28" />
        </div>
        <v-empty-state
          v-else-if="filteredEntries.length === 0"
          icon="mdi-music-note-off"
          :title="t('aidj.slots.no_entries', '未找到匹配的歌曲条目')"
          class="my-4"
        />
        <v-virtual-scroll
          v-else
          :items="filteredEntries"
          :item-height="68"
          height="320"
          class="virtual-items-list"
        >
          <template #default="{ item }">
            <div
              class="entry-row d-flex align-center ga-2 px-2 py-2"
              :class="{ 'is-disabled': !item.enabled }"
              @click="handleToggleEntry(item)"
            >
              <button class="entry-toggle-btn" @click.stop="handleToggleEntry(item)">
                <v-icon
                  size="18"
                  :color="item.enabled ? 'primary' : undefined"
                  :class="{ 'text-medium-emphasis': !item.enabled }"
                >
                  {{ item.enabled ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}
                </v-icon>
              </button>

              <div class="entry-content flex-grow-1 min-w-0">
                <div class="entry-title text-body-2 font-weight-medium text-truncate">
                  {{ item.name }}
                </div>
                <div class="d-flex align-center ga-1 mt-1 flex-wrap">
                  <v-chip
                    v-if="item.metadata.genre"
                    size="x-small"
                    variant="tonal"
                    color="secondary"
                    class="meta-chip"
                  >
                    {{
                      Array.isArray(item.metadata.genre)
                        ? item.metadata.genre.join('/')
                        : item.metadata.genre
                    }}
                  </v-chip>
                  <v-chip
                    v-if="item.metadata.emotion"
                    size="x-small"
                    variant="tonal"
                    color="primary"
                    class="meta-chip"
                  >
                    {{
                      Array.isArray(item.metadata.emotion)
                        ? item.metadata.emotion.join('/')
                        : item.metadata.emotion
                    }}
                  </v-chip>
                  <span
                    v-if="item.metadata.review"
                    class="text-caption text-medium-emphasis text-truncate flex-grow-1"
                  >
                    {{ item.metadata.review }}
                  </span>
                </div>
              </div>
            </div>
          </template>
        </v-virtual-scroll>
      </div>
    </template>

    <!-- Create Slot Dialog -->
    <v-dialog v-model="createDialogOpen" max-width="400">
      <v-card class="pa-2">
        <v-card-title class="text-body-1 font-weight-bold">
          {{ t('aidj.slots.create_title', '新建元数据集合') }}
        </v-card-title>
        <v-card-text class="pt-2">
          <p class="text-caption text-medium-emphasis pb-3">
            {{
              t(
                'aidj.slots.create_hint',
                '将在 ~/.config/LinuxCockpit/aidj/metadata/ 目录下创建独立的 .metadata 槽位文件。'
              )
            }}
          </p>
          <v-text-field
            v-model="newSlotName"
            variant="outlined"
            density="compact"
            autofocus
            :placeholder="t('aidj.slots.name_placeholder', '如 AnimeOST / JPop-2024')"
            hide-details
            @keyup.enter="handleCreateSlot"
          />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-0 ga-2">
          <v-spacer />
          <v-btn variant="text" @click="createDialogOpen = false">
            {{ t('aidj.cancel', '取消') }}
          </v-btn>
          <v-btn color="primary" variant="flat" :loading="createBusy" @click="handleCreateSlot">
            {{ t('aidj.slots.create_confirm', '创建') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Safe Delete Confirmation Dialog -->
    <v-dialog v-model="deleteDialogOpen" max-width="440">
      <v-card v-if="slotToDelete" class="pa-2">
        <v-card-title class="text-body-1 font-weight-bold d-flex align-center ga-2 text-error">
          <v-icon size="20" color="error">mdi-alert-circle-outline</v-icon>
          {{ t('aidj.slots.delete_dialog_title', '安全删除槽位') }}
        </v-card-title>
        <v-card-text class="pt-2">
          <p class="text-body-2 font-weight-medium pb-2">
            {{
              t('aidj.slots.delete_confirm_msg', '确定要删除槽位「{name}」吗？').replace(
                '{name}',
                slotToDelete.name
              )
            }}
          </p>
          <v-alert type="info" variant="tonal" density="compact" class="text-caption mb-1">
            {{
              t(
                'aidj.slots.delete_safety_note',
                '为防止数据意外丢失，本地物理文件不会被永久擦除，而是自动重命名为 .deleted 备份保存。如需彻底删除可手动前往目录清理。'
              )
            }}
          </v-alert>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2 ga-2">
          <v-spacer />
          <v-btn variant="text" :disabled="deleteBusy" @click="deleteDialogOpen = false">
            {{ t('aidj.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" variant="flat" :loading="deleteBusy" @click="confirmDeleteSlot">
            {{ t('aidj.slots.delete_confirm_btn', '确认删除') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar -->
    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="2000">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.slots-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.slots-head {
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
}

.slots-scroll {
  max-height: 380px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

.slots-scroll::-webkit-scrollbar,
.virtual-items-list::-webkit-scrollbar {
  width: 6px;
}

.slots-scroll::-webkit-scrollbar-thumb,
.virtual-items-list::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.4);
  border-radius: 3px;
}

.slot-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-bright), 0.08);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.slot-card:hover {
  background: rgba(var(--v-theme-primary), 0.1);
  border-color: rgba(var(--v-theme-primary), 0.35);
}

.slot-card.is-write-target {
  border-color: rgba(var(--v-theme-success), 0.4);
}

.slot-card.is-disabled {
  opacity: 0.65;
}

.tristate-toggle-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-radius: 4px;
  transition: background-color 0.15s ease;
}

.tristate-toggle-btn:hover {
  background: rgba(var(--v-theme-primary), 0.16);
}

.slot-name {
  font-size: 0.88rem;
}

.slot-meta {
  font-size: 0.75rem;
}

.active-chip {
  padding-block: 4px !important;
  min-height: 24px !important;
}

.tag-chip,
.meta-chip {
  padding-block: 2px !important;
  min-height: 20px !important;
  font-size: 0.68rem !important;
}

.create-btn,
.target-btn,
.bulk-btn {
  font-size: 0.8rem;
  letter-spacing: 0.02em;
}

.detail-scroll-wrap {
  min-height: 0;
  flex: 1;
}

.entry-row {
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.12s ease;
  margin-bottom: 2px;
}

.entry-row:hover {
  background: rgba(var(--v-theme-primary), 0.1);
}

.entry-row.is-disabled {
  opacity: 0.55;
}

.entry-toggle-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
}
</style>
