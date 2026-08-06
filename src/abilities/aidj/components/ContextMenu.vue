<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { renderMarkdown } from '../../../shared/markdown'

defineOptions({ name: 'AidjContextMenu' })

const props = defineProps<{
  modelValue: boolean
  x: number
  y: number
  content: string
  isAi: boolean
  songs?: { name: string }[]
}>()

const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const pos = ref({ x: props.x, y: props.y })
const el = ref<HTMLElement | null>(null)

function close(): void {
  emit('update:modelValue', false)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

function withSongs(text: string): string {
  const songs = props.songs ?? []
  if (!songs.length) return text
  return `${text}\n\n${songs.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}`
}

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || ''
}

function copyRendered(): void {
  const html = renderMarkdown(props.content)
  navigator.clipboard.writeText(withSongs(stripHtml(html) || props.content))
  close()
}

function copyRaw(): void {
  navigator.clipboard.writeText(withSongs(props.content))
  close()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      pos.value = { x: props.x, y: props.y }
      nextTick(() => {
        const rect = el.value?.getBoundingClientRect()
        if (!rect) return
        const margin = 8
        pos.value = {
          x: Math.max(margin, Math.min(props.x, window.innerWidth - rect.width - margin)),
          y: Math.max(margin, Math.min(props.y, window.innerHeight - rect.height - margin))
        }
      })
      document.addEventListener('click', close)
      document.addEventListener('keydown', onKey)
    } else {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }
)
</script>

<template>
  <Teleport to="body">
    <Transition name="ctx">
      <div
        v-if="modelValue"
        ref="el"
        class="aidj-ctx-menu"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        @click.stop
      >
        <button class="aidj-ctx-item" @click="copyRendered">
          <v-icon icon="mdi-content-copy" size="14" />
          <span>复制</span>
        </button>
        <button v-if="isAi" class="aidj-ctx-item" @click="copyRaw">
          <v-icon icon="mdi-code-tags" size="14" />
          <span>CopyRaw</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.aidj-ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 110px;
  padding: 4px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.aidj-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8rem;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.aidj-ctx-item:hover {
  background: rgba(var(--v-theme-primary), 0.15);
}
.ctx-enter-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.ctx-leave-active {
  transition: opacity 0.1s ease;
}
.ctx-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}
.ctx-enter-to {
  opacity: 1;
  transform: scale(1) translateY(0);
}
.ctx-leave-to {
  opacity: 0;
}
</style>
