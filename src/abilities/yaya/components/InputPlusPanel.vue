<script setup lang="ts">
/**
 * 输入框「+」面板的内容（宿主的「文件」+ 插件经 `context.addAction` 注入的项）。
 * 上面是大按钮宫格（往输入框里放东西），下面是列表行（开关 / 模式）。
 * 桌面放在输入框上方的弹出菜单里，窄屏 / 触屏放在底部弹层里（外壳由 ChatInputBox 决定）。
 */
import { computed } from 'vue'
import type { InputMenuAction } from './plugin-input'

const props = defineProps<{
  actions: InputMenuAction[]
  /** 底部弹层：宫格按钮更大、每行最多 4 个 */
  sheet?: boolean
}>()

const emit = defineEmits<{ (e: 'run', action: InputMenuAction): void }>()

const tiles = computed(() => props.actions.filter((a) => (a.placement ?? 'tile') === 'tile'))
const items = computed(() => props.actions.filter((a) => a.placement === 'item'))

/** 宫格列数：≤4 个排一行，多了分两行（同 Rikkahub） */
const cols = computed(() => {
  const n = tiles.value.length
  const max = props.sheet ? 4 : 3
  return Math.max(1, Math.min(max, n <= max ? n : Math.ceil(n / 2)))
})

function isActive(a: InputMenuAction): boolean {
  return a.active?.() ?? false
}
function isDisabled(a: InputMenuAction): boolean {
  return a.disabled?.() ?? false
}
</script>

<template>
  <div class="plus-panel" :class="{ 'is-sheet': sheet }">
    <div v-if="tiles.length" class="plus-tiles" :style="{ '--plus-cols': cols }">
      <button
        v-for="a in tiles"
        :key="a.id"
        type="button"
        class="plus-tile"
        :class="{ 'is-active': isActive(a) }"
        :disabled="isDisabled(a)"
        :title="a.description || a.label"
        :aria-label="a.label"
        :aria-pressed="a.active ? isActive(a) : undefined"
        @pointerdown.prevent
        @click="emit('run', a)"
      >
        <v-icon :icon="a.icon" :size="sheet ? 28 : 24" />
        <span class="plus-tile-label">{{ a.label }}</span>
      </button>
    </div>
    <v-list v-if="items.length" density="comfortable" class="plus-items bg-transparent pa-0">
      <v-list-item
        v-for="a in items"
        :key="a.id"
        :prepend-icon="a.icon"
        :disabled="isDisabled(a)"
        rounded="lg"
        :aria-pressed="a.active ? isActive(a) : undefined"
        @click="emit('run', a)"
      >
        <v-list-item-title>{{ a.label }}</v-list-item-title>
        <v-list-item-subtitle v-if="a.description" class="plus-item-desc">
          {{ a.description }}
        </v-list-item-subtitle>
        <template v-if="a.active" #append>
          <v-switch
            :model-value="isActive(a)"
            color="primary"
            density="compact"
            hide-details
            inset
            tabindex="-1"
            aria-hidden="true"
            class="pointer-events-none"
          />
        </template>
      </v-list-item>
    </v-list>
  </div>
</template>

<style scoped>
.plus-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  min-width: 280px;
  max-width: 400px;
}
.plus-panel.is-sheet {
  max-width: none;
  min-width: 0;
  padding: 16px 16px 20px;
}
.plus-tiles {
  display: grid;
  grid-template-columns: repeat(var(--plus-cols, 3), minmax(0, 1fr));
  gap: 8px;
}
.plus-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 76px;
  padding: 12px 8px;
  border-radius: 16px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  color: rgb(var(--v-theme-on-surface));
  transition:
    background 0.15s,
    border-radius 0.15s;
  cursor: pointer;
  min-width: 0;
}
.is-sheet .plus-tile {
  min-height: 88px;
  border-radius: 20px;
}
.plus-tile:hover:not(:disabled) {
  background: rgba(var(--v-theme-on-surface), 0.1);
}
.plus-tile:active:not(:disabled) {
  border-radius: 10px;
}
.plus-tile.is-active {
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
}
.plus-tile:disabled {
  opacity: 0.45;
  cursor: default;
}
.plus-tile-label {
  max-width: 100%;
  font-size: 0.8125rem;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plus-item-desc {
  white-space: normal;
  -webkit-line-clamp: 2;
}
.pointer-events-none {
  pointer-events: none;
}
</style>
