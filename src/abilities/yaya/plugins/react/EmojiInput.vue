<script setup lang="ts">
/**
 * react 插件的输入框扩展（R6）：往「+」面板加一个「表情」项，点开与回应条
 * **同一张表情面板**（EmojiPanel），选中的表情插进消息正文——
 * 默认集插 emoji 本体，图标包插 `:短码:`（正文内联表情渲染器认识它，能显示成图）。
 */
import { inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import EmojiPanel from '../../components/EmojiPanel.vue'
import type { PluginInputContext } from '../../components/plugin-input'
import type { ReactionItem } from '../../components/plugin-ui'

const props = defineProps<{ context: PluginInputContext }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const open = ref(false)

let unregister: (() => void) | undefined
onMounted(() => {
  unregister = props.context.addAction({
    id: 'emoji',
    icon: 'mdi-emoticon-outline',
    label: t('yaya.emoji.insert', '表情'),
    description: t('yaya.emoji.insert_desc', '选一个表情插进消息正文'),
    placement: 'item',
    order: 50,
    run: () => {
      open.value = true
    }
  })
})
onBeforeUnmount(() => unregister?.())

function onPick(item: ReactionItem): void {
  const text = item.src || item.icon ? `:${item.key}:` : item.key
  const { start, end } = props.context.selection()
  props.context.replaceRange(start, end, text)
  props.context.focus()
}
</script>

<template>
  <EmojiPanel v-model="open" role="user" @pick="onPick" />
</template>
