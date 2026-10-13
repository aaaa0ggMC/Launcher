<script setup lang="ts">
/**
 * react 插件的输入框扩展（R6）：往「+」面板加一个「表情」项，点开与回应条
 * **同一张表情面板**（EmojiPanel），选中的表情插进消息正文——
 * 默认集插 emoji 本体，图标包插 `:短码:`（正文内联表情渲染器认识它，能显示成图）。
 */
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import EmojiPanel from '../../components/EmojiPanel.vue'
import type { PluginInputContext } from '../../components/plugin-input'
import type { ReactionItem } from '../../components/plugin-ui'

const props = defineProps<{ context: PluginInputContext }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const open = ref(false)
/** 打开时输入框有焦点（键盘开着）：关掉面板后把焦点还回去，键盘不被表情对话框挤掉 */
let refocusOnClose = false

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
      refocusOnClose = document.activeElement instanceof HTMLTextAreaElement
      open.value = true
    }
  })
})
onBeforeUnmount(() => unregister?.())

watch(open, (o) => {
  // 对话框抢焦点是 a11y 行为，但 Vuetify 关闭时只还给 activator（这里没有 activator）——
  // 不主动还的话，焦点落到 body、手机上键盘一收输入框就降下去
  if (!o && refocusOnClose) {
    refocusOnClose = false
    props.context.focus()
  }
})

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
