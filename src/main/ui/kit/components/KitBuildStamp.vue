<script setup lang="ts">
/* global __KIT_BUILD__ */
/**
 * KitBuildStamp —— 构建版本标记（gallery 页脚）。
 *
 * 为什么要有它：我们和用户之间一直在猜「用户跑的是哪一版」，用户看不到新功能时
 * 第一步应该是看这个号，而不是再截一轮图。构建期由 electron.vite.config.ts 的
 * define 注入「最后触碰 src/ 的 commit」短 hash + 构建时间（与 ui-probe 门禁核对
 * 基准同口径——跨口径比较会在 merge / 纯工具提交时误报，踩过两轮）。
 */
// 注意必须用裸标识符：Vite 的 define 只替换标识符，写 globalThis.__KIT_BUILD__
// （成员访问）不会被替换，产物里会留下字面量、页面显示空白（踩过）。
const build: { hash: string; time: string } | undefined =
  typeof __KIT_BUILD__ === 'undefined' ? undefined : __KIT_BUILD__
</script>

<template>
  <span v-if="build" class="kit-build-stamp" :title="`构建于 ${build.time}`">
    构建 {{ build.hash }}
  </span>
</template>

<style scoped>
.kit-build-stamp {
  font-size: 0.6875rem;
  line-height: 1.4;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
