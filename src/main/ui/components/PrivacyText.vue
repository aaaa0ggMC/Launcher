<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../i18n'
import { PRIVACY_REVEAL_ALL, maskText, vPrivacy } from '../privacy'

/**
 * 隐私文本（框架组件，由 campusinfo 的 MaskedText 泛化而来）：
 *
 * - `scope` 非空 = 受保护：默认打码，点击（或 Enter / Space）切换明文；同时打上
 *   `data-privacy`，AI 的快照 / 截图按标签脱敏——**用户点开明文不影响 AI 看到的内容**
 * - 打码长度固定 6..8 个 `•`，不泄露原文长度
 * - 页面级「全部显示」经 PRIVACY_REVEAL_ALL 注入，与实例自身点开状态取并集
 * - 点击 / 按键**不冒泡**：只负责显示切换，不能连带触发外层跳转（磁贴、表格行等）
 * - `scope` 为空 = 纯文本，不加任何交互样式
 */

const props = defineProps<{
  value: string | number | null | undefined
  scope?: string | null
}>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const revealAll = inject(PRIVACY_REVEAL_ALL, null)

const own = ref(false)
const isProtected = computed(() => !!props.scope)
const revealed = computed(() => isProtected.value && (revealAll?.value === true || own.value))

const text = computed(() => {
  const raw = props.value == null ? '' : String(props.value)
  if (!isProtected.value || revealed.value) return raw
  return maskText(raw)
})

const title = computed(() => {
  if (!isProtected.value) return ''
  return translate(
    uiLang.value,
    revealed.value ? 'privacy.text.click_hide' : 'privacy.text.click_reveal',
    revealed.value ? '点击隐藏' : '点击显示'
  )
})

function toggle(): void {
  if (!isProtected.value) return
  own.value = !own.value
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  toggle()
}
</script>

<template>
  <span
    v-if="isProtected"
    v-privacy="scope"
    class="privacy-text"
    role="button"
    tabindex="0"
    :aria-pressed="revealed ? 'true' : 'false'"
    :title="title"
    @click.stop="toggle"
    @keydown.stop="onKeydown"
  >
    {{ text }}
  </span>
  <span v-else>{{ text }}</span>
</template>

<style scoped>
.privacy-text {
  cursor: pointer;
  user-select: none;
}
</style>
