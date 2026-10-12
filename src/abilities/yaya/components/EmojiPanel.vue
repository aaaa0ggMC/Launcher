<script setup lang="ts">
/**
 * 表情面板（R5：弹窗式，取代旧的小菜单）：
 * - 分类 = 表情集（`reactionSets`：默认集 + 已启用插件的图标包），分组显示；
 * - 顶部搜索（跨组按 key / label 匹配）；
 * - 两种用法：回应模式（ReactionBar 的「+」→ `pick` 回调里点按切换）与
 *   插入模式（react 插件的输入框 item → 把表情塞进消息正文）。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import { fileIconUrl } from '@ui/icon'
import type { ReactionItem, ReactionSet } from './plugin-ui'
import { reactionSetsFor } from './plugin-ui-registry'
import { emoteSrcUrl } from './emotes'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** 哪一侧用（表情集有角色过滤）；回应条按消息角色传，插入模式固定用户侧 */
    role?: 'user' | 'assistant'
    /** 当前已有的表情 key（回应模式高亮用） */
    activeKeys?: string[]
  }>(),
  { role: 'assistant', activeKeys: () => [] }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'pick', item: ReactionItem): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const query = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

interface Group {
  id: string
  label: string
  items: ReactionItem[]
}

/** 分类分组：每个表情集一组；搜索同时命中组名与条目（key / label） */
const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  const out: Group[] = []
  for (const set of reactionSetsFor(props.role) as ReactionSet[]) {
    if (!set.items.length) continue
    const label = set.labelKey ? t(set.labelKey, set.label ?? set.id) : (set.label ?? set.id)
    const items = set.items.filter(
      (i) =>
        !q ||
        i.key.toLowerCase().includes(q) ||
        (i.label ?? '').toLowerCase().includes(q) ||
        label.toLowerCase().includes(q)
    )
    if (items.length) out.push({ id: set.id, label, items })
  }
  return out
})

const totalCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

function itemLabel(item: ReactionItem): string {
  return item.labelKey ? t(item.labelKey, item.label ?? item.key) : (item.label ?? item.key)
}
function emoteUrl(src: string): string {
  return emoteSrcUrl(src, fileIconUrl)
}
function choose(item: ReactionItem): void {
  emit('pick', item)
  open.value = false
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" scrollable>
    <v-card rounded="lg" class="emoji-panel">
      <v-card-title class="emoji-head">
        <span class="text-subtitle-2">{{ t('yaya.emoji.title', '表情') }}</span>
        <v-text-field
          v-model="query"
          variant="outlined"
          density="compact"
          hide-details
          clearable
          :placeholder="t('yaya.emoji.search', '搜索表情')"
          prepend-inner-icon="mdi-magnify"
          class="emoji-search"
        />
      </v-card-title>

      <v-card-text class="emoji-body">
        <div v-if="!totalCount" class="emoji-empty text-medium-emphasis">
          {{ t('yaya.emoji.empty', '没有匹配的表情') }}
        </div>

        <section v-for="g in groups" :key="g.id" class="emoji-group">
          <div class="emoji-cat text-medium-emphasis">{{ g.label }}</div>
          <div class="emoji-grid">
            <button
              v-for="item in g.items"
              :key="item.key"
              type="button"
              class="emoji-cell"
              :class="{ active: activeKeys.includes(item.key) }"
              :title="itemLabel(item)"
              :aria-label="itemLabel(item)"
              @click="choose(item)"
            >
              <img
                v-if="item.src"
                class="emoji-img"
                :src="emoteUrl(item.src)"
                :alt="item.key"
                loading="lazy"
              />
              <v-icon v-else-if="item.icon?.startsWith('mdi-')" :icon="item.icon" size="22" />
              <AbilityIcon v-else-if="item.icon" :icon="item.icon" :size="22" />
              <span v-else class="emoji-glyph">{{ item.key }}</span>
            </button>
          </div>
        </section>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.emoji-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-block: 14px 10px;
  flex-wrap: wrap;
}
.emoji-search {
  flex: 1 1 220px;
  min-width: 0;
}
.emoji-body {
  padding-block: 4px 16px;
}
.emoji-group + .emoji-group {
  margin-top: 14px;
}
.emoji-cat {
  font-size: 0.78rem;
  margin-bottom: 6px;
}
.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 4px;
}
.emoji-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s;
}
.emoji-cell:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.emoji-cell.active {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.16);
}
.emoji-glyph {
  font-size: 1.4rem;
  line-height: 1;
}
.emoji-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.emoji-empty {
  padding-block: 24px;
  text-align: center;
  font-size: 0.875rem;
}
</style>
