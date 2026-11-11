<script setup lang="ts">
/**
 * KitHint —— ✓/✗ 提示行（「什么时候用 / 不要用什么」）。
 * tone=ok 用 success 色 + 对勾，tone=warn 用 warning 色 + 叉，plain 走弱化正文色。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../i18n'

const props = withDefaults(defineProps<{ tone?: 'ok' | 'warn' | 'plain' }>(), { tone: 'plain' })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const icon = computed(() =>
  props.tone === 'ok'
    ? 'mdi-check-circle-outline'
    : props.tone === 'warn'
      ? 'mdi-close-circle-outline'
      : ''
)
const cls = computed(() => (props.tone === 'plain' ? 'kit-hint--plain' : `kit-hint--${props.tone}`))
const aria = computed(() =>
  props.tone === 'ok'
    ? translate(uiLang.value, 'kit.hint.ok', '推荐')
    : props.tone === 'warn'
      ? translate(uiLang.value, 'kit.hint.warn', '避免')
      : ''
)
</script>

<template>
  <div
    class="kit-hint"
    :class="cls"
    :role="aria ? 'note' : undefined"
    :aria-label="aria || undefined"
  >
    <v-icon v-if="icon" class="kit-hint__icon" :icon="icon" :size="16" />
    <span><slot /></span>
  </div>
</template>
