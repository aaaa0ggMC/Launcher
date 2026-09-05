<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj' })

import { ref, onMounted, markRaw } from 'vue'
import type { Component } from 'vue'
import YarjLoading from './YarjLoading.vue'

const isLoaded = ref(false)
const viewComponent = ref<Component | null>(null)
const innerViewRef = ref<{ onActivate?: (target: Record<string, unknown>) => void } | null>(null)

defineExpose({
  onActivate: (target: Record<string, unknown>) => {
    innerViewRef.value?.onActivate?.(target)
  }
})

// 在组件挂载后，通过 requestAnimationFrame 确保第一帧的 YarjLoading 动画
// 已经切实绘制到屏幕上后，再异步加载重量级 View.vue 及其底图依赖库，
// 从而彻底杜绝“点击侧栏后先卡顿、然后才跳出加载画面”的浏览器主线程阻塞现象。
onMounted(() => {
  requestAnimationFrame(() => {
    setTimeout(async () => {
      try {
        const mod = await import('./View.vue')
        viewComponent.value = markRaw(mod.default)
        isLoaded.value = true
      } catch (err) {
        console.error('Failed to load Yarj View:', err)
      }
    }, 16)
  })
})
</script>

<template>
  <div class="yarj-container-root flex-grow-1">
    <component :is="viewComponent" v-if="viewComponent" ref="innerViewRef" class="flex-grow-1" />
    <YarjLoading v-if="!isLoaded" />
  </div>
</template>

<style scoped>
.yarj-container-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
