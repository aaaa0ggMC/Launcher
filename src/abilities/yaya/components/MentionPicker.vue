<script setup lang="ts">
/**
 * `@` 点名候选框：浮在输入框上方（窄屏占满宽度）。键盘上下选、回车确认、Esc 关闭由
 * ChatInputBox 处理（焦点留在输入框里）；这里只负责展示与点选。
 */
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'

export interface MentionItem {
  ref: string
  label: string
  kind: 'builtin' | 'mcp' | 'skill' | 'tool'
  description: string
  icon?: string
  enabled: boolean
  plugin?: string
}

const props = defineProps<{
  items: MentionItem[]
  active: number
  loading: boolean
  query: string
}>()
const emit = defineEmits<{
  (e: 'select', item: MentionItem): void
  (e: 'hover', index: number): void
  (e: 'close'): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const KIND_LABEL = computed<Record<MentionItem['kind'], string>>(() => ({
  builtin: t('yaya.mention.kind_plugin', '插件'),
  mcp: 'MCP',
  skill: 'Skill',
  tool: t('yaya.mention.kind_tool', '工具')
}))

const listEl = ref<HTMLElement | null>(null)
watch(
  () => props.active,
  async (i) => {
    await nextTick()
    listEl.value
      ?.querySelector<HTMLElement>(`[data-index="${i}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
)
</script>

<template>
  <div class="mention-pop" role="listbox" :aria-label="t('yaya.mention.title', '点名插件 / 工具')">
    <div class="mention-head">
      <span class="text-medium-emphasis">
        {{ t('yaya.mention.title', '点名插件 / 工具') }}
        <span v-if="query" class="mention-query">@{{ query }}</span>
      </span>
      <v-btn
        icon="mdi-close"
        variant="text"
        size="small"
        :title="t('yaya.close', '关闭')"
        :aria-label="t('yaya.close', '关闭')"
        @mousedown.prevent
        @click="emit('close')"
      />
    </div>
    <div ref="listEl" class="mention-list">
      <div v-if="loading && !items.length" class="mention-empty">
        <v-progress-circular indeterminate size="18" width="2" />
      </div>
      <div v-else-if="!items.length" class="mention-empty text-medium-emphasis">
        {{ t('yaya.mention.empty', '没有匹配的插件或工具') }}
      </div>
      <button
        v-for="(item, i) in items"
        :key="item.ref"
        type="button"
        role="option"
        class="mention-item"
        :class="{ 'is-active': i === active }"
        :aria-selected="i === active"
        :data-index="i"
        @mousedown.prevent
        @mouseenter="emit('hover', i)"
        @click="emit('select', item)"
      >
        <v-icon
          :icon="item.kind === 'tool' ? 'mdi-wrench-outline' : item.icon || 'mdi-puzzle-outline'"
          size="20"
          class="mention-icon"
        />
        <span class="mention-text">
          <span class="mention-label">
            {{ item.label }}
            <span class="mention-kind">{{ KIND_LABEL[item.kind] }}</span>
            <span v-if="!item.enabled" class="mention-off">
              {{ t('yaya.mention.off', '未启用 · 点名后本对话启用') }}
            </span>
          </span>
          <span class="mention-desc text-medium-emphasis">
            {{ item.plugin ? `${item.plugin} · ` : '' }}{{ item.description }}
          </span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mention-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 8;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.mention-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 6px 16px;
  font-size: 0.8rem;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.mention-query {
  margin-left: 6px;
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.mention-list {
  max-height: min(320px, calc(var(--app-vh, 100vh) * 0.45));
  overflow-y: auto;
  padding: 4px;
}
.mention-empty {
  display: flex;
  justify-content: center;
  padding: 16px;
  font-size: 0.85rem;
}
.mention-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.mention-item.is-active {
  background: rgba(var(--v-theme-primary), 0.12);
}
.mention-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: rgb(var(--v-theme-primary));
}
.mention-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mention-label {
  font-size: 0.875rem;
  font-weight: 600;
  word-break: break-all;
}
.mention-kind {
  margin-left: 6px;
  font-size: 0.7rem;
  font-weight: 500;
  opacity: 0.6;
}
.mention-off {
  margin-left: 6px;
  font-size: 0.7rem;
  font-weight: 500;
  color: rgb(var(--v-theme-warning));
}
.mention-desc {
  font-size: 0.78rem;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
@media (max-width: 720px) {
  .mention-pop {
    max-width: none;
  }
}
</style>
