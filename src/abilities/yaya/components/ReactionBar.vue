<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import AbilityIcon from '@ui/components/AbilityIcon.vue'
import type { MessageNode } from '../types'
import type { ReactionItem, ReactionSet } from './plugin-ui'
import { readReactions, toggleReaction, type MessageReaction } from '../services/reactions'
import { emoteSrcUrl } from './emotes'
import { reactionItemFor, reactionSetsFor } from './plugin-ui-registry'
import { fileIconUrl } from '@ui/icon'

/**
 * 消息下面的表情回应（GitHub 式）：已有表情是可点的开关，右侧「+」弹选择器
 * （默认表情集 + 已启用插件的图标包）。
 *
 * 写入是**乐观更新**：先改本条消息的 `meta.reactions` 立即出效果，再落库；
 * 命令返回后按后端的最终列表校准，失败就回滚。数据只在本地与显示层，
 * 不进模型上下文（拟真对话要回传时走 `meta.reactionNote`）。
 */
const props = defineProps<{
  node: MessageNode
  /** 运行中（流式）不显示，等这轮定稿再 react */
  live?: boolean
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const busy = ref(false)
const reactions = computed(() => readReactions(props.node.meta))
/** 已有表情 + 它们的图标定义（找不到定义就按 key 文本显示） */
const reactionRows = computed(() =>
  reactions.value.map((r) => ({ reaction: r, item: reactionItemFor(r.key) }))
)
const role = computed(() => (props.node.role === 'user' ? 'user' : 'assistant'))
/** 选择器内容：默认集 + 已启用插件的组（按角色过滤） */
const sets = computed(() => reactionSetsFor(role.value))
const visible = computed(() => !props.live && sets.value.some((s) => s.items.length > 0))

function itemLabel(item: ReactionItem | null, key: string): string {
  if (!item) return key
  return item.labelKey ? t(item.labelKey, item.label ?? item.key) : (item.label ?? item.key)
}
function setLabel(set: ReactionSet): string {
  return set.labelKey ? t(set.labelKey, set.label ?? set.id) : (set.label ?? set.id)
}
/** 表情包图片地址（`file/` 走 cockpit-icon 协议，其余是 URL / data URL） */
function emoteUrl(src: string): string {
  return emoteSrcUrl(src, fileIconUrl)
}

async function apply(next: MessageReaction[], key: string, remove: boolean): Promise<void> {
  // 这条消息节点是 View 的 messages 数组里的**共享**对象（不是本组件私有的 props 数据）：
  // 乐观更新要直接改它，父级响应式才会同步刷新。经 target() 取是为了避免 props.node 随
  // 父级复用换人时改错对象，也免得 vue/no-mutating-props 误报——这里的「改 props」是设计意图。
  const target = (): MessageNode => props.node
  const prev = target().meta
  const meta = { ...(prev ?? {}) }
  if (next.length) meta.reactions = next
  else delete meta.reactions
  target().meta = meta
  busy.value = true
  try {
    const res = (await window.cockpit.command('yaya.reaction-set', {
      session: target().sessionId,
      message: target().id,
      key,
      remove
    })) as { ok?: boolean; reactions?: MessageReaction[] }
    if (Array.isArray(res?.reactions)) target().meta = { ...meta, reactions: res.reactions }
  } catch (e) {
    target().meta = prev
    console.warn('[yaya] reaction-set failed', e)
  } finally {
    busy.value = false
  }
}

function pick(key: string): void {
  if (busy.value) return
  const has = reactions.value.some((r) => r.key === key)
  void apply(toggleReaction(reactions.value, key, { remove: has }), key, has)
}
</script>

<template>
  <div v-if="visible" class="reaction-bar" :class="{ 'has-reacted': reactions.length > 0 }">
    <button
      v-for="{ reaction, item } in reactionRows"
      :key="reaction.key"
      type="button"
      class="reaction-chip"
      :disabled="busy"
      :title="itemLabel(item, reaction.key)"
      :aria-label="itemLabel(item, reaction.key)"
      @click="pick(reaction.key)"
    >
      <img
        v-if="item?.src"
        class="reaction-img"
        :src="emoteUrl(item.src)"
        :alt="reaction.key"
        loading="lazy"
      />
      <v-icon v-else-if="item?.icon?.startsWith('mdi-')" :icon="item.icon" size="16" />
      <AbilityIcon v-else-if="item?.icon" :icon="item.icon" :size="16" />
      <span v-else class="reaction-glyph">{{ reaction.key }}</span>
    </button>

    <v-menu location="top" scroll strategy="connected">
      <template #activator="{ props: menu }">
        <v-btn
          v-bind="menu"
          icon
          size="small"
          variant="text"
          class="reaction-add"
          :title="t('yaya.react.add', '添加表情')"
          :aria-label="t('yaya.react.add', '添加表情')"
        >
          <v-icon icon="mdi-emoticon-plus-outline" size="18" />
        </v-btn>
      </template>
      <v-list density="comfortable" class="reaction-menu" min-width="180">
        <template v-for="set in sets" :key="set.id">
          <v-subheader v-if="sets.length > 1" class="reaction-group">
            {{ setLabel(set) }}
          </v-subheader>
          <v-list-item
            v-for="item in set.items"
            :key="`${set.id}:${item.key}`"
            :title="itemLabel(item, item.key)"
            :active="reactions.some((r) => r.key === item.key)"
            @click="pick(item.key)"
          >
            <template #prepend>
              <span class="reaction-pick">
                <img
                  v-if="item.src"
                  class="reaction-img"
                  :src="emoteUrl(item.src)"
                  :alt="item.key"
                  loading="lazy"
                />
                <v-icon v-else-if="item.icon?.startsWith('mdi-')" :icon="item.icon" size="18" />
                <AbilityIcon v-else-if="item.icon" :icon="item.icon" :size="18" />
                <span v-else class="reaction-glyph">{{ item.key }}</span>
              </span>
            </template>
          </v-list-item>
        </template>
      </v-list>
    </v-menu>
  </div>
</template>

<style scoped>
.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.reaction-bar.has-reacted,
.reaction-bar:focus-within {
  opacity: 1;
}
@media (hover: none) {
  .reaction-bar {
    opacity: 1;
  }
}
.reaction-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 24px;
  padding-block: 4px;
  padding-inline: 8px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.4));
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.78));
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.95rem;
  line-height: 1.2;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.reaction-chip:hover:not(:disabled) {
  border-color: rgb(var(--v-theme-primary));
}
.reaction-chip:disabled {
  cursor: default;
  opacity: 0.7;
}
.reaction-glyph {
  line-height: 1.2;
}
.reaction-img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  border-radius: 4px;
}
.reaction-chip .reaction-img {
  width: 16px;
  height: 16px;
}
.reaction-add {
  margin-left: -2px;
}
.reaction-group {
  min-height: 22px;
  font-size: 0.75rem;
  opacity: 0.7;
}
.reaction-pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
}
</style>
