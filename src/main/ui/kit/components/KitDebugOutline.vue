<script setup lang="ts">
/**
 * KitDebugOutline —— 「布局自检」尺子（dev/演示用，正式构建默认关）。
 *
 * 打开后：页面里所有元素描边；**溢出容器**的元素高亮成红色
 * （判定：`scrollWidth > clientWidth + 1`，或 rect 超出父级内容框）。
 * 用户自己就能扫出还有哪里有裁剪 / 溢出，不用每次截图。
 *
 * 本身也是 kit 积木：全局样式在 kit.css（`.kit-debug-on` / `.kit-debug-overflow`），
 * 这里只负责开关与扫描。扫描范围默认整个 document（设置页一次看好几节 demo）。
 */
import { onBeforeUnmount, watch } from 'vue'

const props = defineProps<{
  /** 开关（默认关） */
  active: boolean
  /** 扫描间隔（ms）；0 = 只在开启 / resize 时扫一次 */
  interval?: number
}>()

const DEBUG_CLASS = 'kit-debug-on'
const OVERFLOW_CLASS = 'kit-debug-overflow'

function clearMarks(): void {
  for (const el of document.querySelectorAll(`.${OVERFLOW_CLASS}`)) {
    el.classList.remove(OVERFLOW_CLASS)
  }
}

/** 扫一遍：把溢出容器的元素标红 */
function scan(): void {
  clearMarks()
  const all = document.body.querySelectorAll('*')
  for (const node of all) {
    const el = node as HTMLElement
    // 自身被裁：内容比盒子宽（省略号文字会误报，调试工具里可接受——它本来就越界）
    const selfOverflow = el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0
    // 超出父级内容框：子元素右缘越过父级右缘
    const parent = el.parentElement
    let outOfParent = false
    if (parent) {
      const r = el.getBoundingClientRect()
      const pr = parent.getBoundingClientRect()
      outOfParent = r.right > pr.right + 1 || r.left < pr.left - 1
    }
    if (selfOverflow || outOfParent) el.classList.add(OVERFLOW_CLASS)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

function start(): void {
  document.documentElement.classList.add(DEBUG_CLASS)
  scan()
  if (props.interval && props.interval > 0) {
    timer = setInterval(scan, props.interval)
  }
}

function stop(): void {
  document.documentElement.classList.remove(DEBUG_CLASS)
  clearMarks()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(
  () => props.active,
  (on) => {
    if (typeof document === 'undefined') return
    if (on) start()
    else stop()
  },
  { immediate: true }
)

if (typeof window !== 'undefined') {
  const onResize = (): void => {
    if (props.active) scan()
  }
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
}

onBeforeUnmount(stop)
</script>

<template>
  <!-- 无渲染：只改 <html> 的 class 与被扫元素的 class -->
  <span v-if="false" />
</template>
