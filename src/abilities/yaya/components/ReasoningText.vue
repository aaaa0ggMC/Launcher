<script setup lang="ts">
/**
 * 思考内容。闭源模型（Gemini / OpenAI / Claude）给的是**思考摘要**：一段段「**小标题**」+ 说明，
 * 小标题单独成行加粗显示（不渲染整段 Markdown，免得流式时满屏星号乱跳）；原始思维链没有小标题，原样显示。
 * 正在输出的最后一段用 EmergeText 做涌现动画。
 */
import { computed } from 'vue'
import EmergeText from './EmergeText.vue'
import { reasoningSections } from './reasoning-brief'

const props = defineProps<{ text: string; live?: boolean }>()

const sections = computed(() => reasoningSections(props.text))
</script>

<template>
  <span v-if="sections.length === 1 && !sections[0].title" class="reasoning-text">
    <EmergeText :text="text" :live="live" />
  </span>
  <span v-else class="reasoning-text">
    <span v-for="(s, i) in sections" :key="i" class="rs-section">
      <strong v-if="s.title" class="rs-title">{{ s.title }}</strong>
      <EmergeText
        v-if="s.body"
        class="rs-body"
        :text="s.body"
        :live="live && i === sections.length - 1"
      />
    </span>
  </span>
</template>

<style scoped>
.rs-section {
  display: block;
}
.rs-section + .rs-section {
  margin-top: 8px;
}
.rs-title {
  display: block;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.82);
}
.rs-body {
  display: block;
}
</style>
