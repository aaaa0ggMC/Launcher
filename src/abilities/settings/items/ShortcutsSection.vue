<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-shortcuts' })

import { ref, inject, computed, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import {
  listShortcuts,
  effectiveCombo,
  comboFromEvent,
  groupsOff,
  isGlobalCapable,
  globalStatus,
  shortcutRecording,
  type ShortcutDef
} from '@ui/shortcuts'

/**
 * 快捷键管理（类似游戏的「控制」设置）：按能力分组，点按键 → 按下新组合键；
 * Esc 取消、Backspace/Delete 清除；冲突标红（仍可保存，先匹配到的先触发）；
 * 所有快捷键默认未绑定（防冲突），需用户自己启用；每组可整体禁用，单项 / 整组 / 全部可解除绑定；支持搜索。
 */
const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fb?: string): string => translate(uiLang.value, key, fb)

const user = computed(() => config.value.shortcuts as Record<string, unknown> | undefined)
const off = computed(() => groupsOff(config.value.shortcutGroupsOff))
const globalIds = computed(() => groupsOff(config.value.shortcutGlobal))

async function setGlobal(id: string, on: boolean | null): Promise<void> {
  const next = new Set(globalIds.value)
  if (on) next.add(id)
  else next.delete(id)
  await window.cockpit.setConfig({ shortcutGlobal: [...next] })
}
function canGlobal(d: ShortcutDef): boolean {
  return isGlobalCapable(effectiveCombo(d.id, user.value))
}
/** 全局开了但没注册成功时的原因文本 */
function globalError(d: ShortcutDef): string {
  if (!globalIds.value.has(d.id) || off.value.has(d.group)) return ''
  if (!canGlobal(d)) return t('shortcut.globalNeed2', '全局快捷键需要至少两个修饰键')
  const st = globalStatus[d.id]
  if (!st || st.ok) return ''
  return st.error === 'unsupported'
    ? t('shortcut.globalUnsupported', '当前系统不支持全局快捷键')
    : t('shortcut.globalTaken', '全局注册失败：被其他程序占用或系统拒绝')
}

interface Group {
  id: string
  label: string
  items: ShortcutDef[]
}
const groups = computed<Group[]>(() => {
  const m = new Map<string, Group>()
  for (const d of listShortcuts()) {
    let g = m.get(d.group)
    if (!g) {
      g = {
        id: d.group,
        label:
          d.group === 'shell'
            ? t('shortcut.group.shell', '通用（外壳）')
            : (d.groupLabel ?? d.group),
        items: []
      }
      m.set(d.group, g)
    }
    g.items.push(d)
  }
  return [...m.values()].sort((a, b) =>
    a.id === 'shell' ? -1 : b.id === 'shell' ? 1 : a.label.localeCompare(b.label)
  )
})

const query = ref('')
function itemHaystack(d: ShortcutDef, g: Group): string {
  return [t(d.label, d.fallback), d.fallback, d.id, g.label, effectiveCombo(d.id, user.value)]
    .join(' ')
    .toLowerCase()
}
/** 搜索：名称 / 能力名 / id / 按键；能力名命中则整组显示 */
const shown = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return groups.value
  const terms = q.split(/\s+/)
  return groups.value
    .map((g) => ({
      ...g,
      items: g.items.filter((d) => {
        const h = itemHaystack(d, g)
        return terms.every((w) => h.includes(w))
      })
    }))
    .filter((g) => g.items.length)
})

/** 被多个「已启用」动作占用的组合键 */
const conflicts = computed(() => {
  const count = new Map<string, number>()
  for (const d of listShortcuts()) {
    if (off.value.has(d.group)) continue
    const c = effectiveCombo(d.id, user.value)
    if (c) count.set(c, (count.get(c) ?? 0) + 1)
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([c]) => c))
})
function isConflict(d: ShortcutDef): boolean {
  return !off.value.has(d.group) && conflicts.value.has(effectiveCombo(d.id, user.value))
}

async function saveBindings(next: Record<string, unknown>): Promise<void> {
  await window.cockpit.setConfig({ shortcuts: JSON.parse(JSON.stringify(next)) })
}
async function setBinding(id: string, combo: string): Promise<void> {
  await saveBindings({ ...(user.value ?? {}), [id]: combo })
}
/** 解除绑定（默认就是未绑定） */
async function resetIds(ids: string[]): Promise<void> {
  const next = { ...(user.value ?? {}) }
  for (const id of ids) delete next[id]
  await saveBindings(next)
}
async function setGroupEnabled(id: string, enabled: boolean | null): Promise<void> {
  const next = new Set(off.value)
  if (enabled) next.delete(id)
  else {
    next.add(id)
    // 禁用的组不再监听：正在录制它的某一项就取消
    if (recording.value && listShortcuts().some((d) => d.id === recording.value && d.group === id))
      stopRecording()
  }
  await window.cockpit.setConfig({ shortcutGroupsOff: [...next] })
}

// -- 录制 -----------------------------------------------------------------
const recording = ref<string | null>(null)
function stopRecording(): void {
  recording.value = null
  shortcutRecording.value = false
  window.removeEventListener('keydown', onRecordKey, true)
  window.removeEventListener('pointerdown', onOutsidePointer, true)
  window.removeEventListener('blur', stopRecording)
}
/** 点到别处 / 窗口失焦 = 取消录制（和游戏的控制设置一样） */
function onOutsidePointer(e: PointerEvent): void {
  if (!(e.target as HTMLElement | null)?.closest?.('.sc-key')) stopRecording()
}
function onRecordKey(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const id = recording.value
  if (!id) return
  if (e.key === 'Escape') return stopRecording()
  if (e.key === 'Backspace' || e.key === 'Delete') {
    void setBinding(id, '')
    return stopRecording()
  }
  const combo = comboFromEvent(e)
  if (!combo) return // 纯修饰键 / 没带修饰键：继续等
  void setBinding(id, combo)
  stopRecording()
}
function startRecording(id: string): void {
  stopRecording()
  recording.value = id
  shortcutRecording.value = true
  window.addEventListener('keydown', onRecordKey, true)
  window.addEventListener('pointerdown', onOutsidePointer, true)
  window.addEventListener('blur', stopRecording)
}
onBeforeUnmount(stopRecording)

function comboText(d: ShortcutDef): string {
  const c = effectiveCombo(d.id, user.value)
  return c || t('shortcut.unbound', '未绑定')
}
function isUnbound(d: ShortcutDef): boolean {
  return !effectiveCombo(d.id, user.value)
}

defineExpose({
  toMarkdown: (): string =>
    groups.value
      .map(
        (g) =>
          `**${g.label}**${off.value.has(g.id) ? ` (${t('shortcut.groupOff', '已禁用')})` : ''}\n` +
          g.items
            .map((d) => `- ${t(d.label, d.fallback)}: ${effectiveCombo(d.id, user.value) || '—'}`)
            .join('\n')
      )
      .join('\n\n')
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center flex-wrap ga-3">
      <div class="text-body-2 text-medium-emphasis flex-grow-1">
        {{
          t(
            'shortcut.hint',
            '所有快捷键默认都未绑定，需要你自己启用：点击按键后按下新的组合键；Esc 取消，Backspace / Delete 清除。仅在窗口有焦点时生效，且需带修饰键（F1–F12 除外）。'
          )
        }}
      </div>
      <v-btn
        class="text-none"
        variant="tonal"
        prepend-icon="mdi-keyboard-off-outline"
        @click="resetIds(listShortcuts().map((d) => d.id))"
      >
        {{ t('shortcut.resetAll', '全部解除绑定') }}
      </v-btn>
    </div>

    <v-text-field
      v-model="query"
      prepend-inner-icon="mdi-magnify"
      :placeholder="t('shortcut.search', '搜索快捷键（名称 / 能力 / 按键）')"
      :aria-label="t('shortcut.search', '搜索快捷键（名称 / 能力 / 按键）')"
      variant="outlined"
      density="comfortable"
      clearable
      hide-details
    />
    <div v-if="!shown.length" class="text-body-2 text-medium-emphasis pa-4 text-center">
      {{ t('shortcut.noMatch', '没有匹配的快捷键') }}
    </div>

    <v-card v-for="g in shown" :key="g.id" rounded="lg" variant="tonal">
      <v-card-title class="d-flex align-center flex-wrap ga-2 text-subtitle-2 py-3">
        <span class="flex-grow-1">{{ g.label }}</span>
        <v-switch
          :model-value="!off.has(g.id)"
          :label="t('shortcut.groupEnabled', '启用该组快捷键')"
          color="primary"
          density="compact"
          hide-details
          @update:model-value="(v) => setGroupEnabled(g.id, v)"
        />
        <v-btn class="text-none" variant="text" @click="resetIds(g.items.map((d) => d.id))">
          {{ t('shortcut.resetGroup', '解除本组绑定') }}
        </v-btn>
      </v-card-title>
      <v-divider />
      <v-card-text class="pa-4">
        <div v-for="d in g.items" :key="d.id" class="sc-row" :class="{ 'sc-off': off.has(g.id) }">
          <div class="sc-label">{{ t(d.label, d.fallback) }}</div>
          <v-btn
            class="sc-key text-none"
            :color="recording === d.id ? 'primary' : isConflict(d) ? 'error' : undefined"
            :variant="recording === d.id ? 'flat' : 'tonal'"
            :disabled="off.has(g.id)"
            :aria-label="`${t(d.label, d.fallback)}: ${comboText(d)}`"
            @click="startRecording(d.id)"
          >
            {{ recording === d.id ? t('shortcut.recording', '按下新组合键…') : comboText(d) }}
          </v-btn>
          <v-switch
            :model-value="globalIds.has(d.id)"
            :label="t('shortcut.global', '全局')"
            :disabled="isUnbound(d) || off.has(g.id)"
            color="primary"
            density="compact"
            hide-details
            class="sc-global flex-grow-0"
            @update:model-value="(v) => setGlobal(d.id, v)"
          />
          <v-btn
            icon="mdi-keyboard-off-outline"
            variant="text"
            size="small"
            :disabled="isUnbound(d)"
            :title="t('shortcut.reset', '解除绑定')"
            :aria-label="t('shortcut.reset', '解除绑定')"
            @click="resetIds([d.id])"
          />
          <div v-if="globalError(d)" class="sc-warn text-caption text-error">
            {{ globalError(d) }}
          </div>
          <div v-if="isConflict(d)" class="sc-warn text-caption text-error">
            {{ t('shortcut.conflict', '与其他快捷键冲突') }}
          </div>
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped>
.sc-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding-block: 6px;
}
.sc-label {
  flex: 1 1 200px;
  min-width: 0;
}
.sc-key {
  min-width: 160px;
}
.sc-warn {
  flex-basis: 100%;
  text-align: right;
}
.sc-global {
  flex: 0 0 auto;
}
.sc-off {
  opacity: 0.45;
}

/* Narrow screens (≤720px): the 160px key column plus three actions push the
   buttons out of a phone — let the row take two lines with the actions
   wrapping under the name. */
@media (max-width: 720px) {
  .sc-key {
    min-width: 0;
  }
}
</style>
