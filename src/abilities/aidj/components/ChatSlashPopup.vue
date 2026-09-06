<script setup lang="ts">
import { inject, ref, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { ChatCommandDef } from './chat-commands'

defineProps<{
  commands: ChatCommandDef[]
  active: number
  bottom: number
}>()

const emit = defineEmits<{
  (e: 'select', index: number): void
  (e: 'apply'): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
</script>

<template>
  <Transition name="cmd-pop">
    <div v-if="commands.length > 0" class="cmd-popup" :style="{ bottom: `${bottom}px` }">
      <div
        v-for="(c, i) in commands"
        :key="c.name"
        class="cmd-item"
        :class="{ 'is-active': i === active }"
        @mousedown.prevent="emit('apply')"
        @mouseenter="emit('select', i)"
      >
        <span class="cmd-name"
          >/{{ c.name }} <span class="cmd-args">{{ c.args }}</span></span
        >
        <span class="cmd-desc">{{ t(c.descKey, c.descFallback) }}</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cmd-popup {
  position: absolute;
  left: 16px;
  right: 16px;
  z-index: 30;
  max-height: 168px;
  overflow-y: auto;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
  padding: 4px;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
}
.cmd-item.is-active {
  background: rgba(var(--v-theme-primary), 0.15);
}
.cmd-name {
  font-family: monospace;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  white-space: nowrap;
}
.cmd-args {
  color: rgb(var(--v-theme-on-surface-variant));
  font-weight: 400;
}
.cmd-desc {
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmd-pop-enter-active,
.cmd-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.cmd-pop-enter-from,
.cmd-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
