<script setup lang="ts">
/**
 * KitTruncated —— 截断揭示原语的包裹件（SPEC「信息降级链」档 1）。
 *
 * 会 ellipsis 的积木一律用它包一层（新积木 checklist：会截断就必须接截断揭示），
 * 它一次给齐三条腿里的两条：
 *   桌面：原生 title（只在真截断时挂，没截断不挂——避免满屏 title）；
 *   触摸：点按 / 回车弹出全文浮层（kit 自绘，Teleport + useAnchor，和「更多」
 *        浮层同一套定位与玻璃样式，不新造第三套）。
 * 第三条腿（priority 整元素隐藏 → 行尾「更多」浮层显示全文）由 KitSmartRow 负责。
 *
 * 自己带 ellipsis 样式：调用方只要把内容放进来，不用再写一遍 nowrap/ellipsis。
 *
 * 模板结构纪律（踩过血亏）：**根节点必须只有 span 这一个节点**。Teleport 只能放 span
 * 内部（写成兄弟就变 fragment）；模板根级连 HTML 注释都不行——Vue 会把 [注释, span]
 * 编译成 Fragment，调用方传的 class / attrs 全部被静默丢弃（实测：.kit-setting-row__label
 * 的字号、.kit-chip__text 等消费方样式集体失效了整整一版）。注释只许写进 script 文档
 * 或元素内部。
 */
import { computed, nextTick, onScopeDispose, ref } from 'vue'
import { useAnchor } from '../composables/useAnchor'
import { useTruncatable } from '../composables/useTruncatable'

const props = defineProps<{
  /** 全文（title 与揭示浮层用）；缺省取包裹内容的文本 */
  text?: string
}>()

const el = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)

/** 缺省全文 = 包裹内容的文本（截断时 innerText 仍是全文，ellipsis 只是视觉裁剪） */
const full = computed(() => props.text ?? el.value?.textContent?.trim() ?? '')

const { truncated, title, tipOpen, toggleTip, closeTip } = useTruncatable(el, full)

/** 锚定定位：全部测量走 getBoundingClientRect 再 ÷ zoom（页面缩放下混用口径会偏 10%） */
const { place } = useAnchor(el, pop, { placement: 'bottom-end', active: tipOpen })

async function openTip(): Promise<void> {
  if (!truncated.value) return
  toggleTip()
  if (tipOpen.value) {
    await nextTick()
    place()
  }
}

/**
 * 点按 = 揭示手势（SPEC 信息降级链档 1 触摸腿）。
 * 真截断时接管这次点击（stopPropagation）：不然「看全文」会顺带触发宿主控件——
 * 下拉触发器会把菜单弹起来盖住浮层（KitSelect 实测）、胶囊会把 click 发给消费方。
 * 没截断时不拦：KitTruncated 对正常点击完全透明，控件该怎么响应还怎么响应。
 */
function onReveal(e: MouseEvent | KeyboardEvent): void {
  if (!truncated.value) return
  e.stopPropagation()
  void openTip()
}

// 浮层打开期间：点外面 / Esc 收起
if (typeof document !== 'undefined') {
  const onDown = (e: MouseEvent): void => {
    if (!tipOpen.value) return
    const t = e.target as Node | null
    if (t && (el.value?.contains(t) || pop.value?.contains(t))) return
    closeTip()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeTip()
  }
  document.addEventListener('mousedown', onDown)
  document.addEventListener('keydown', onKey)
  onScopeDispose(() => {
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey)
  })
}
</script>

<template>
  <span
    ref="el"
    class="kit-truncated"
    :class="{ 'kit-truncated--cut': truncated }"
    :title="title"
    :tabindex="truncated ? 0 : undefined"
    :role="truncated ? 'button' : undefined"
    :aria-label="truncated ? full : undefined"
    @click="onReveal($event)"
    @keydown.enter.prevent="onReveal($event)"
  >
    <slot />
    <Teleport to="body">
      <div v-show="tipOpen" ref="pop" class="kit-truncate-tip" role="tooltip">
        {{ full }}
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
/* 截断样式归这里：会 ellipsis 的积木不用再各写一遍 */
.kit-truncated {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 真截断时才可点（没截断不拦点击、不加 role） */
.kit-truncated--cut {
  cursor: pointer;
}
</style>
