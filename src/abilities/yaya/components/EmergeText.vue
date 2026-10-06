<script setup lang="ts">
/**
 * 流式文字的「涌现」：新到的文字片段淡入，旧的并回普通文本。
 * 只在 `live` 时生效；关掉现代动效（html.motion-off）时全局 CSS 会去掉动画，文字直接出现。
 * 新文本不是旧文本的延续（比如只显示最后几行的预览、换了一条消息）就整体重置，不做动画。
 */
import { ref, watch } from 'vue'

const props = defineProps<{ text: string; live?: boolean }>()

/** 最多保留几个仍在动画中的片段（更早的并回 settled，避免节点越积越多） */
const MAX_FRESH = 12

const settled = ref('')
const fresh = ref<{ id: number; text: string }[]>([])
let seq = 0
let shown = ''

watch(
  () => [props.text, props.live] as const,
  ([text, live]) => {
    if (!live || !shown || !text.startsWith(shown)) {
      settled.value = text
      fresh.value = []
      shown = text
      return
    }
    const add = text.slice(shown.length)
    shown = text
    if (!add) return
    const list = [...fresh.value, { id: ++seq, text: add }]
    while (list.length > MAX_FRESH) settled.value += list.shift()!.text
    fresh.value = list
  },
  { immediate: true }
)
</script>

<template>
  <span class="emerge-text"
    >{{ settled
    }}<span v-for="part in fresh" :key="part.id" class="emerge-part">{{ part.text }}</span></span
  >
</template>

<style scoped>
.emerge-part {
  animation: yaya-emerge 0.5s ease-out both;
}
@keyframes yaya-emerge {
  from {
    opacity: 0;
    filter: blur(3px);
  }
  to {
    opacity: 1;
    filter: none;
  }
}
</style>
