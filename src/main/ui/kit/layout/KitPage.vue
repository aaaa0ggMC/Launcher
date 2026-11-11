<script setup lang="ts">
/**
 * KitPage —— 页面外壳，三种滚动模式。
 *
 * - `document`：正常文档流，整页垂直滚动（设置类长表单）。沿用宿主 v-container 的边距
 *   （窄屏 px-3 = 12px，见 SPEC「断点令牌」）。
 * - `app`：`position:absolute; inset:0` 铺满宿主可视区，页面级零滚动，内部区域各自滚
 *   （聊天 / 日志 / 控制台：固定顶栏 + 可滚内容 + 固定底栏）。
 * - `canvas`：同样 `absolute; inset:0`，但内部区域按内容高度排、超出自行内滚，
 *   内容真的超过视口时外壳才滚（ft / dashboard / 地图类全幅页面：两个滚动条都在）。
 *
 * 为什么用 `absolute; inset:0` 而不是 `calc(100vh - 96px)`：那个 96 是
 * 「appbar 高 + 容器 padding」的魔数，appbar 实测高度会变（bili/View.vue 的注释记录
 * 实测 55px，不是历史文档口径的 48/64px），魔数壳就短一截。绝对定位不依赖任何
 * 魔数，键盘弹出时也跟着可视区收。高度计算一律走 viewport.ts 的 `--app-vh`，
 * 不写裸 `100vh`。
 *
 * app / canvas 是**通栏**外壳（不等宿主容器边距）：内部区域自己给内边距。
 * 代价是宿主包裹层（App.vue 的 .page-host）的 min-height 会让外壳下面多出一条空滚动条
 * ——挂载期间把它的 min-height 临时置 0（settings/View.vue 同款机制），离开时还原。
 */
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'

const props = defineProps<{
  /** document = 整页滚动（默认）；app = 页面级零滚动、内部各自滚；canvas = 内部滚 + 外壳可滚 */
  mode?: 'document' | 'app' | 'canvas'
  /** 可读行宽（px）；'none' = 通栏（默认） */
  maxWidth?: number | 'none'
  /** 自己负责左右边距：窄屏 12px（SPEC「断点令牌」的 px-3，不是 px-2）。宿主 v-container 已给准时不用传 */
  gutter?: boolean
}>()

const rootEl = ref<HTMLElement | null>(null)
const pinned = (): boolean => (props.mode ?? 'document') !== 'document'

/** 宿主包裹层：App.vue 的 .page-host（拿不到就退一级父元素） */
function hostWrap(): HTMLElement | null {
  const root = rootEl.value
  if (!root) return null
  const host = root.closest('.page-host')
  return (host as HTMLElement | null) ?? root.parentElement
}

function holdHost(): void {
  if (!pinned()) return
  const wrap = hostWrap()
  if (wrap) wrap.style.minHeight = '0px'
}

function releaseHost(): void {
  const wrap = hostWrap()
  if (wrap) wrap.style.minHeight = ''
}

onMounted(holdHost)
onActivated(holdHost)
onDeactivated(releaseHost)
onBeforeUnmount(releaseHost)
</script>

<template>
  <div
    ref="rootEl"
    class="kit-page"
    :class="[
      `kit-page--${mode ?? 'document'}`,
      { 'kit-page--gutter': gutter, 'kit-page--max': maxWidth && maxWidth !== 'none' }
    ]"
    :style="maxWidth && maxWidth !== 'none' ? { maxWidth: `${maxWidth}px` } : undefined"
  >
    <slot />
  </div>
</template>

<style scoped>
.kit-page {
  min-width: 0;
}

/* document：正常文档流，整页垂直滚动 */
.kit-page--document {
  display: block;
}

/* app / canvas：铺满宿主可视区。flex 列 + min-height:0 让内部滚动区能正常收缩，
   不依赖任何魔数（见文件头说明）。横划交给页面自己的手势，别被浏览器当成导航。 */
.kit-page--app,
.kit-page--canvas {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  touch-action: pan-y pinch-zoom;
}

/* app：外壳不出滚动条（SPEC「页面外壳」）——内容只能进内部滚动区 */
.kit-page--app {
  overflow: hidden;
}

/* canvas：内容超高时外壳照常滚（两个滚动条都在），内部区域仍各自滚 */
.kit-page--canvas {
  overflow: auto;
}

/* 手机端左右边距 12px（SPEC「断点令牌」：px-3，不要 px-2） */
.kit-page--gutter {
  padding-inline: 0;
}

@media (max-width: 720px) {
  .kit-page--gutter {
    padding-inline: 12px;
  }
}

/* 可读行宽：与 inset:0 共存时用 margin auto 居中（over-constrained 下的标准行为） */
.kit-page--max {
  margin-inline: auto;
}
</style>
