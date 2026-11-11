<script setup lang="ts">
/**
 * KitEmpty —— 空状态（v-empty-state 的薄封装）。
 *
 * 观感已由 global.css 的 .v-empty-state* 规则统一（主色圆底 + 半粗标题 + 弱化说明），
 * 这里只补三件页面作者每次都要的：actions 插槽、语义 icon 表、以及「可操作」形态。
 * 不要在手写大图标空状态（SPEC「空状态」）。
 */
import { computed } from 'vue'
import { useKitSurface } from '../composables/useKitSurface'

const props = withDefaults(
  defineProps<{
    /** mdi 图标；缺省按 kind 查语义表 */
    icon?: string
    /** 场景语义：查内置 icon 表 */
    kind?: 'list' | 'search' | 'error' | 'network' | 'file' | 'music' | 'chat' | 'custom'
    title?: string
    text?: string
  }>(),
  { kind: 'custom' }
)

useKitSurface()

/** 语义 icon 表：这个页面本来该有什么，就取那个图标（SPEC「空状态」） */
const KIND_ICONS: Record<string, string> = {
  list: 'mdi-playlist-remove',
  search: 'mdi-magnify-close',
  error: 'mdi-alert-circle-outline',
  network: 'mdi-lan-disconnect',
  file: 'mdi-file-remove-outline',
  music: 'mdi-music-note-off',
  chat: 'mdi-chat-minus-outline',
  custom: 'mdi-inbox-outline'
}

const icon = computed(() => props.icon || KIND_ICONS[props.kind] || KIND_ICONS.custom)
</script>

<template>
  <v-empty-state class="kit-empty" :icon="icon" :title="title" :text="text">
    <template v-if="$slots.actions" #default>
      <div class="kit-empty__actions">
        <slot name="actions" />
      </div>
    </template>
  </v-empty-state>
</template>

<style scoped>
.kit-empty {
  min-width: 0;
}

/* actions 居中 + 可换行；按钮遵守 SPEC「文字按钮默认密度」 */
.kit-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
</style>
