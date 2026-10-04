<script setup lang="ts">
import { computed } from 'vue'
import OutsiderItem from './OutsiderItem.vue'
import { visibleOutsiders } from '../outsider'

/**
 * Outsider SDK 的宿主层（App.vue 挂一个）。整层是 AI 禁区；`html.agent-pass`
 * （inspector 注入鼠标事件期间）时完全不接收指针，AI 的点击穿过它落到下面的页面。
 * 模态的（授权）排在最上面。
 */
const list = computed(() =>
  [...visibleOutsiders.value].sort(
    (a, b) => Number(!!a.entry.attrs.modal) - Number(!!b.entry.attrs.modal)
  )
)
</script>

<template>
  <div v-if="list.length" v-agent-forbidden class="outsider-layer" data-outsider-layer>
    <OutsiderItem v-for="o in list" :key="o.entry.id" :entry="o.entry" :data="o.props" />
  </div>
</template>

<style scoped>
.outsider-layer {
  position: fixed;
  inset: 0;
  z-index: 2450;
  pointer-events: none;
}
</style>

<style>
/* inspector 注入鼠标事件期间：悬浮层对指针完全透明（只影响 AI 的这几毫秒） */
html.agent-pass [data-outsider-layer],
html.agent-pass [data-outsider-layer] * {
  pointer-events: none !important;
}
</style>
