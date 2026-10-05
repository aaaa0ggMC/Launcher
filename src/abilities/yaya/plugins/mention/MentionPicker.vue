<script setup lang="ts">
/**
 * `@` 点名候选框：浮在输入框上方（窄屏占满宽度）。
 *
 * 只负责展示与点选：键盘上下选 / 回车确认 / Esc 关闭的**策略**在 mention 插件
 * （MentionInput.vue）里，这里把弹窗内按下的键回传给它；焦点不离开（手动模式除外）。
 * 手动模式（工具栏 @ 按钮打开）多一个可聚焦的搜索框，键入即重新查候选。
 */
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { MentionCandidate } from '../../services/plugins/mention'

const props = defineProps<{
  items: MentionCandidate[]
  active: number
  loading: boolean
  /** 文本触发的查询（输入框里 `@` 后面那段） */
  query: string
  /** 手动模式：显示搜索框，键也由搜索框回传给插件 */
  manual?: boolean
  /** 手动模式搜索框里的文字 */
  search?: string
}>()

const emit = defineEmits<{
  (e: 'select', item: MentionCandidate): void
  (e: 'hover', index: number): void
  (e: 'close'): void
  (e: 'search', text: string): void
  (e: 'keydown', event: KeyboardEvent): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const KIND_LABEL = computed<Record<MentionCandidate['kind'], string>>(() => ({
  builtin: t('yaya.mention.kind_plugin', '插件'),
  mcp: 'MCP',
  skill: 'Skill',
  tool: t('yaya.mention.kind_tool', '工具')
}))

const listEl = ref<HTMLElement | null>(null)
const searchBox = ref<{ focus: () => void } | null>(null)

/** 手动模式的搜索框：值归插件（它负责重新查候选），这里只转发 */
const searchModel = computed({
  get: () => props.search ?? '',
  set: (v: string) => emit('search', v)
})

function onSearchKeyDown(e: KeyboardEvent): void {
  // 策略（选 / 关 / 上下移）都在插件里，含输入法组合期的保护
  emit('keydown', e)
}

/** 手动模式一打开就把焦点给搜索框（供筛选）；关掉时由插件还给输入框 */
function focusSearch(): void {
  void nextTick(() => searchBox.value?.focus())
}
onMounted(() => {
  if (props.manual) focusSearch()
})
watch(
  () => props.manual,
  (v) => {
    if (v) focusSearch()
  }
)

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
  <div class="mention-pop" role="listbox" :aria-label="t('yaya.mention.title', '点名插件')">
    <div class="mention-head">
      <span v-if="!manual" class="mention-head-title text-medium-emphasis">
        {{ t('yaya.mention.title', '点名插件') }}
        <span v-if="query" class="mention-query">@{{ query }}</span>
      </span>
      <v-text-field
        v-else
        ref="searchBox"
        v-model="searchModel"
        class="mention-search"
        density="default"
        variant="solo-filled"
        flat
        hide-details
        :placeholder="t('yaya.mention.search', '搜索插件 / 工具')"
        :aria-label="t('yaya.mention.search', '搜索插件 / 工具')"
        @keydown="onSearchKeyDown"
      />
      <v-btn
        icon="mdi-close"
        variant="text"
        size="small"
        :title="t('yaya.close', '关闭')"
        :aria-label="t('yaya.close', '关闭')"
        @pointerdown.prevent
        @click="emit('close')"
      />
    </div>
    <div ref="listEl" class="mention-list">
      <div v-if="loading && !items.length" class="mention-empty">
        <v-progress-circular indeterminate size="18" width="2" />
      </div>
      <div v-else-if="!items.length" class="mention-empty text-medium-emphasis">
        {{ t('yaya.mention.empty', '没有匹配的插件') }}
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
        @pointerdown.prevent
        @mouseenter="emit('hover', i)"
        @click="emit('select', item)"
      >
        <v-icon :icon="item.icon || 'mdi-puzzle-outline'" size="20" class="mention-icon" />
        <span class="mention-text">
          <span class="mention-label">
            {{ item.label }}
            <span class="mention-kind">{{ KIND_LABEL[item.kind] }}</span>
            <span v-if="!item.enabled" class="mention-off">
              {{ t('yaya.mention.off', '未启用 · 点名后本对话启用') }}
            </span>
          </span>
          <span class="mention-desc text-medium-emphasis">
            <template v-if="item.tools">
              {{ te('yaya.mention.tools_count', { n: String(item.tools) }, '{n} 个工具') }} ·
            </template>
            {{ item.description }}
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
.mention-head-title {
  min-width: 0;
}
/* 手动模式搜索框：占满标题行剩下的宽度，输入不抢走焦点之外的任何东西 */
.mention-search {
  flex: 1 1 auto;
  min-width: 0;
}
.mention-search :deep(.v-field) {
  border-radius: 10px;
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
