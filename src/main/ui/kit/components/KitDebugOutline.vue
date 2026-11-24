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
import { clusterLines, lineMidpoint } from '../layout/align'

const props = withDefaults(
  defineProps<{
    /** 开关（默认关） */
    active: boolean
    /** 扫描间隔（ms）；0 = 只在开启 / resize 时扫一次 */
    interval?: number
    /**
     * 自检模式：overflow = 溢出标红（原有）；align = 行内对齐（画行中线、标偏差 >1px 的
     * 元素，覆盖默认对齐的标另一种颜色并注明 align 值）；both = 两个一起（缺省）。
     */
    mode?: 'overflow' | 'align' | 'both'
  }>(),
  { mode: 'both' }
)

const DEBUG_CLASS = 'kit-debug-on'
const OVERFLOW_CLASS = 'kit-debug-overflow'
const ALIGN_MARK_CLASS = 'kit-debug-align'
const ALIGN_BAD_CLASS = 'kit-debug-align--bad'
const ALIGN_OVERRIDE_CLASS = 'kit-debug-align--override'
const EDGE_BAD_CLASS = 'kit-debug-edge--bad'
const SIZE_BAD_CLASS = 'kit-debug-size--bad'
const TRUNCATED_CLASS = 'kit-debug-truncated'
/** 行中线偏差阈值（px）——SPEC「行内对齐」：一行之内所有元素共享同一条中线 */
const ALIGN_TOLERANCE = 1

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
function clearAlignMarks(): void {
  for (const el of document.querySelectorAll(`.${ALIGN_MARK_CLASS}`)) {
    el.classList.remove(ALIGN_MARK_CLASS, ALIGN_BAD_CLASS, ALIGN_OVERRIDE_CLASS)
    delete (el as HTMLElement).dataset.kitAlignDev
    delete (el as HTMLElement).dataset.kitAlign
  }
}

/**
 * 行内对齐自检：逐行量每个子元素的几何中心 vs 行中线，偏差 >1px 的标出来；
 * 覆盖了行默认对齐的标另一种颜色并把 align 值写进 dataset（默认的只描边不标色）。
 */
function scanAlign(): void {
  clearAlignMarks()
  for (const row of document.querySelectorAll('.kit-smart-row__line')) {
    const kids = [...row.children].filter((c) => {
      const el = c as HTMLElement
      return el !== debugHost && getComputedStyle(el).display !== 'none'
    }) as HTMLElement[]
    if (kids.length < 2) continue
    const rowAlign = getComputedStyle(row).getPropertyValue('--kit-row-align').trim() || 'center'
    // 按视觉行（flex line）分组：换行的行里每条 line 有各自中线
    const samples = kids.map((el) => {
      const r = el.getBoundingClientRect()
      return {
        el,
        top: r.top,
        height: r.height,
        center: r.top + r.height / 2,
        left: r.left,
        right: r.right
      }
    })
    for (const line of clusterLines(samples)) {
      if (line.length < 2) continue
      const mid = lineMidpoint(line)
      for (const s of line) {
        const el = s.el
        const dev = Math.round((s.center - mid) * 10) / 10
        const own = getComputedStyle(el).getPropertyValue('--kit-item-align').trim()
        const field = el.querySelector('.v-field') as HTMLElement | null
        const fieldAlign = field
          ? getComputedStyle(field).getPropertyValue('--kit-field-align').trim()
          : ''
        const align = own || fieldAlign || rowAlign
        el.classList.add(ALIGN_MARK_CLASS)
        el.dataset.kitAlignDev = String(dev)
        el.dataset.kitAlign = align
        if (Math.abs(dev) > ALIGN_TOLERANCE) el.classList.add(ALIGN_BAD_CLASS)
        if (align !== rowAlign) el.classList.add(ALIGN_OVERRIDE_CLASS)
      }
    }
    checkEdges(row, samples)
    checkSizes(samples)
  }
}

/**
 * 同类尺寸（SPEC「行内三律」第三条）：同一行里同 kind 的元素高度必须一致——
 * 差异只能来自密度阶，不能来自内容长短。反例就是手写胶囊（无 nowrap / 无高度兜底），
 * 行内一紧文字折行、胶囊变高，一行里一个两行高一个一行高。
 * 这里按「同 kind + 同密度档」分组比高度，不一致的标出来。
 */
function checkSizes(samples: { el: HTMLElement; height: number }[]): void {
  if (samples.length < 2) return
  const groups = new Map<string, { el: HTMLElement; height: number }[]>()
  for (const s of samples) {
    const kind =
      s.el.dataset.kitKind ||
      (s.el.querySelector('.kit-chip')
        ? 'chip'
        : s.el.querySelector('.v-switch')
          ? 'switch'
          : s.el.querySelector('.kit-stepper')
            ? 'stepper'
            : s.el.querySelector('.v-slider')
              ? 'slider'
              : s.el.querySelector('.v-select, .kit-inline-select')
                ? 'select'
                : 'other')
    if (kind === 'other') continue
    const list = groups.get(kind) ?? []
    list.push(s)
    groups.set(kind, list)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const max = Math.max(...list.map((x) => x.height))
    for (const x of list) {
      if (max - x.height > ALIGN_TOLERANCE) x.el.classList.add(SIZE_BAD_CLASS)
    }
  }
}

/**
 * 左缘 / 右缘对齐线（SPEC「行内对齐」）：
 *  ① 左缘同线——同一行换行后，每条视觉行**首个**元素的左缘应彼此同线（= 行标签左缘）；
 *  ② 右缘贴行尾——每行**末个**元素的右缘应与行右缘同线（数值贴行尾）。
 * 不齐的标出来（kit-debug-edge--bad），让「谁没对齐」能用眼睛验证。
 */
function checkEdges(
  row: Element,
  samples: { el: HTMLElement; left: number; right: number }[]
): void {
  if (samples.length < 2) return
  const rowRect = row.getBoundingClientRect()
  const groups = clusterLines(
    samples.map((s) => ({
      ...s,
      top: 0,
      height: 1,
      center: s.el.getBoundingClientRect().top + s.el.getBoundingClientRect().height / 2
    }))
  )
  if (groups.length < 1) return
  const firsts = groups.map((g) => g[0])
  const leftRef = Math.min(...firsts.map((f) => f.left))
  for (const f of firsts) {
    if (Math.abs(f.left - leftRef) > ALIGN_TOLERANCE) f.el.classList.add(EDGE_BAD_CLASS)
  }
  const lasts = groups.map((g) => g[g.length - 1])
  const rightRef = Math.max(...lasts.map((l) => l.right))
  for (const l of lasts) {
    if (
      Math.abs(l.right - rightRef) > ALIGN_TOLERANCE &&
      Math.abs(l.right - rowRect.right) > ALIGN_TOLERANCE
    ) {
      l.el.classList.add(EDGE_BAD_CLASS)
    }
  }
}

function clearTruncateMarks(): void {
  for (const el of document.querySelectorAll(`.${TRUNCATED_CLASS}`)) {
    el.classList.remove(TRUNCATED_CLASS)
  }
}

/**
 * 截断标记（SPEC「信息降级链」自检腿）：把**真截断**（ellipsis + nowrap +
 * scrollWidth > clientWidth）的元素描出来——这页哪里有信息被降级，一眼可见。
 * 判定口径与 useTruncatable 一致（布局像素，页面缩放在两种口径下都成立）。
 */
function scanTruncated(): void {
  clearTruncateMarks()
  for (const el of document.body.querySelectorAll('*')) {
    const node = el as HTMLElement
    if (node === debugHost) continue
    const cs = getComputedStyle(node)
    if (cs.textOverflow !== 'ellipsis' || cs.whiteSpace === 'normal') continue
    if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
      node.classList.add(TRUNCATED_CLASS)
    }
  }
}

function scan(): void {
  clearMarks()
  clearAlignMarks()
  clearTruncateMarks()
  if (props.mode !== 'align') {
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
  if (props.mode !== 'overflow') scanAlign()
  scanTruncated()
}

let timer: ReturnType<typeof setInterval> | null = null
/** 自检开关所在的宿主：排除自身，否则「给自己描边」也会被算成溢出 */
let debugHost: HTMLElement | null = null

function start(): void {
  document.documentElement.classList.add(DEBUG_CLASS)
  scan()
  // 行内元素是**异步注册**的（引擎等子元素 register 后才 apply CSS），开启这一刻
  // 常常还没上树——首次 scan 会扫出 0 个标记，用户以为自检坏了。补两拍延迟扫描
  // （rAF + 一帧之后），异步内容落地后再扫一次。仍算「开启时扫」，不改 interval 语义。
  requestAnimationFrame(() => {
    if (props.active) scan()
    requestAnimationFrame(() => {
      if (props.active) scan()
    })
  })
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
  
  <span ref="hostEl" style="display: none" aria-hidden="true" />
</template>
