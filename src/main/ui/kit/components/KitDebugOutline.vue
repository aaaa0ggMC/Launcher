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
import { onBeforeUnmount, ref, watch } from 'vue'

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

/**
 * 扫一遍：把**真正被裁**的元素标红。
 *
 * 单位口径（P0-A 的教训）：全程只用布局像素——`clientWidth` / `scrollWidth` /
 * `offsetLeft` / `offsetWidth`，**一个 rect 都不用**。`getBoundingClientRect()`
 * 在页面缩放（设置→外观→界面缩放，`zoom`）下返回视觉像素，和上面几个混用会让
 * 任何元素都「超出」（实测：zoom=1.1 时 174 个元素误报 23 个，再经
 * `.kit-debug-overflow *` 后代规则放大成「整页全红」）。
 *
 * 判定收敛到「会被裁」这一类真 bug：
 *   1. 自身 overflow 是 hidden/clip，且 scrollWidth > clientWidth → 内容真被切；
 *   2. 右缘超出**包含块**（offsetParent，不是 DOM 父级——绝对定位元素的包含块
 *      本来就不是父元素，拿 DOM 父级比必然误报）的内容框，且包含块会裁它。
 * Vuetify 内部那些「故意越界」的（滑块圆点的 ripple、开关轨道、省略号文字）
 * 因为包含块不裁它们，不再误报。
 */
function scan(): void {
  clearMarks()
  const all = document.body.querySelectorAll('*')
  for (const node of all) {
    const el = node as HTMLElement
    if (el === debugHost) continue
    const cs = getComputedStyle(el)
    const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowX === 'auto'
    const scrolls = cs.overflowX === 'scroll'
    // 1) 自身把内容裁了
    const selfClipped =
      (clips || scrolls) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1
    // 2) 越出包含块的内容框，且包含块会裁它
    const box = el.offsetParent as HTMLElement | null
    let outOfBox = false
    if (box && box !== el) {
      const bcs = getComputedStyle(box)
      const boxClips = bcs.overflowX === 'hidden' || bcs.overflowX === 'clip'
      if (boxClips) {
        const right = el.offsetLeft + el.offsetWidth
        outOfBox = right > box.clientWidth + 2
      }
    }
    if (selfClipped || outOfBox) el.classList.add(OVERFLOW_CLASS)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
/** 自检开关所在的宿主：排除自身，否则「给自己描边」也会被算成溢出 */
let debugHost: HTMLElement | null = null

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

const hostEl = ref<HTMLElement | null>(null)
watch(hostEl, (el) => {
  debugHost = el
})
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
  <!-- 无渲染：只改 <html> 的 class 与被扫元素的 class（挂个隐藏宿主用于自排除） -->
  <span ref="hostEl" style="display: none" aria-hidden="true" />
</template>
