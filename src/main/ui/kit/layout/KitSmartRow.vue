<script setup lang="ts">
/**
 * KitSmartRow —— 行级智能排版（kit 的地基积木，其余积木都建在它上面）。
 *
 * 工作循环（对应「规划用下限、运行用实测、CSS 兜底」）：
 *   1. 先按自然尺寸渲染（CSS flex + min-width:0 + flex-wrap）——JS 完全不工作页面也可用；
 *   2. ResizeObserver 观察容器与每个子元素，rAF 里批量读宽度（先读后写，避免 layout thrash）；
 *   3. 用实测宽度 + 声明下限调 planRow，得到 { lines, hidden }；
 *   4. 应用：hidden 的元素进「更多」浮层（或 display:none），lines 决定元素落到第几行
 *      ——用 CSS order 应用，**不搬家 DOM**（keep-alive / 焦点不受影响）；
 *   5. 滞回：宽度变化 <8px 或结构没变就不重规划（见 useContainerWidth / shouldReplan）。
 *
 * 空间不够时的策略顺序（温和 → 激烈）：
 *   缩小（flex-shrink 到 minWidth + 文字 ellipsis，CSS 负责）
 *   → 隐藏（tertiary → secondary，primary 永不隐藏；收进行尾「更多」浮层，不静默消失）
 *   → 换行（`[名字]` 单独一行，`[slider][数值]` 下一行）
 *
 * 任何宽度下都不出现横向溢出 / 横向滚动条：规划保证 Σ(下限)+gap ≤ 可用宽度，
 * CSS 的 flex-shrink + min-width:0 再兜一层（规划过期的那几像素）。
 */
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch
} from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../i18n'
import { useAdaptive, useContainerWidth } from '../composables/useAdaptive'
import { useAnchor } from '../composables/useAnchor'
import { useKitSurface } from '../composables/useKitSurface'
import type { KitAlign } from './align'
import {
  applyNaturalFloor,
  planRow,
  planSignature,
  resolveRowItems,
  rowSlots,
  shouldReplan,
  type PlanKey,
  type PlanRowResult,
  type RowItem
} from './engine'
import {
  smartRowKey,
  type SmartRowContext,
  type SmartRowItemInput,
  type SmartRowSlot
} from './smart-row-context'

const props = defineProps<{
  /** 行标题（可选，渲染在元素上方） */
  label?: string
  /** 行说明（可选，标题下方的小字） */
  hint?: string
  /** 元素间距 px。引擎与 CSS 用同一个值，保证规划与实际排版一致 */
  gap?: number
  /** 隐藏元素的去向：menu = 行尾「更多」浮层（默认）；none = 直接 display:none */
  overflow?: 'menu' | 'none'
  /**
   * 行内对齐（SPEC「行内对齐」）：默认 center——一行之内所有元素共享同一条中线。
   * 只有多行文字、顶部对齐的图标+两行说明这类场景才覆盖，且覆盖会在布局自检里被标出来。
   */
  align?: KitAlign
}>()

const emit = defineEmits<{
  /** 规划结果变化时上报（画廊 / 需要响应退化的调用方用） */
  state: [{ lines: number; hidden: number; tight: boolean }]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
useKitSurface()
const { narrow } = useAdaptive()
const { target, width: containerWidth } = useContainerWidth()

/** 「更多」按钮占用的宽度（图标按钮 40px + 与前一元素的间距） */
const MORE_WIDTH = 40

const popEl = ref<HTMLElement | null>(null)
const moreBtnEl = ref<HTMLElement | null>(null)
const moreOpen = ref(false)

const registry = reactive(new Map<string, SmartRowItemInput & { naturalWidth: number }>())
/** 溢出复核标成的刚性元素：下限抬到实测自然宽度，不被裁 */
const rigid = reactive(new Map<string, boolean>())
const elements = new Map<string, HTMLElement>()
const slots = reactive<Record<string, SmartRowSlot>>({})
const tight = ref(false)
const hiddenCount = ref(0)

let lastKey: PlanKey | null = null
let lastResult: PlanRowResult = { lines: [], hidden: [] }
let childObserver: ResizeObserver | null = null

const gap = (): number => props.gap ?? 8

function register(item: SmartRowItemInput, el: HTMLElement | null): void {
  const prev = registry.get(item.id)
  // 合并而非覆盖：实测自然宽度是 grow-only 缓存，重新登记不能把它抹掉
  registry.set(item.id, { ...item, naturalWidth: prev?.naturalWidth ?? 0 })
  if (el) {
    elements.set(item.id, el)
    childObserver?.observe(el)
  }
  schedule()
}

function unregister(id: string): void {
  const el = elements.get(id)
  if (el) childObserver?.unobserve(el)
  elements.delete(id)
  registry.delete(id)
  rigid.delete(id)
  delete slots[id]
  schedule()
}

const ctx: SmartRowContext = {
  register,
  unregister,
  slots,
  narrow,
  tight,
  hiddenCount,
  overflowTarget: popEl,
  overflowOpen: moreOpen
}
provide(smartRowKey, ctx)

/* ── 测量 → 规划 ─────────────────────────────────────────────────────────── */

let frame = 0

function schedule(): void {
  if (frame) return
  frame = requestAnimationFrame(flush)
}

/** rAF 里批量读宽度（先读后写，避免 layout thrash），再重规划 */
function flush(): void {
  frame = 0
  // 先读（一次批量读完再写，避免 layout thrash）：容器 + 各子元素的实测宽度
  const width = target.value?.clientWidth ?? containerWidth.value
  const measured: Array<[string, number]> = []
  for (const [id, el] of elements) {
    // scrollWidth 才是「内容的自然宽度」：元素被 overflow:hidden 裁住时 clientWidth
    // 只剩盒子宽（=basis），量不到被裁掉的那几个 px
    measured.push([id, Math.max(el.clientWidth, el.scrollWidth)])
  }
  // 后写：回填自然宽度（grow-only，防「实测被压小 → 规划更激进 → 压得更小」的棘轮）。
  // 正在被 grow 拉伸的元素不更新——否则「grow 吃满剩余 → 实测变大 → 下限变大」会来回棘轮，
  // 它的自然宽度在首帧（basis 还是 auto）就已经量到了。
  for (const [id, w] of measured) {
    const entry = registry.get(id)
    if (!entry || w <= 0) continue
    const slot = slots[id]
    const basis = typeof slot?.basis === 'number' ? slot.basis : 0
    if (slot?.grow && w > basis) continue
    if (w > entry.naturalWidth) entry.naturalWidth = w
  }
  plan(width)
  scheduleVerify()
}

/* ── 溢出复核：规划用的是下限，实际渲染可能更宽 → 被 overflow:hidden 裁一截。
     应用后再量一次，谁被裁就把谁标成刚性（下限抬到自然宽度）重规划，直到没有裁切。 ── */
let verifyFrame = 0
let verifyRound = 0

function scheduleVerify(): void {
  if (verifyFrame || verifyRound >= 3) return
  verifyFrame = requestAnimationFrame(verify)
}

function verify(): void {
  verifyFrame = 0
  const clipped: string[] = []
  for (const [id, el] of elements) {
    const slot = slots[id]
    if (!slot || slot.visible === false) continue
    // 弹性元素（省略号文字）本来就越出盒子——scrollWidth 永远大于 clientWidth，跳过
    if (registry.get(id)?.elastic === true) continue
    if (el.scrollWidth > el.clientWidth + 1) clipped.push(id)
  }
  if (!clipped.length) {
    verifyRound = 0
    return
  }
  let changed = false
  for (const id of clipped) {
    if (rigid.get(id)) continue
    rigid.set(id, true)
    changed = true
  }
  if (!changed) {
    verifyRound = 0
    return
  }
  verifyRound++
  schedule()
}

function plan(width: number): void {
  if (width <= 0 || registry.size === 0) {
    // 未测量 / 没有元素：不给指令，让 CSS 自然排布（JS 失效时的兜底形态）
    for (const id of Object.keys(slots)) delete slots[id]
    lastKey = null
    lastResult = { lines: [], hidden: [] }
    tight.value = false
    hiddenCount.value = 0
    moreOpen.value = false
    return
  }
  const inputs = [...registry.values()]
  const naturals: Record<string, number> = {}
  const elastic: Record<string, boolean> = {}
  for (const it of inputs) {
    naturals[it.id] = registry.get(it.id)?.naturalWidth ?? 0
    elastic[it.id] = it.elastic === true
  }
  // 「更多」按钮自身占宽度：先按全宽规划，若有隐藏再让出按钮宽度重规划（最多两轮收敛）
  let reserve = 0
  let resolved: RowItem[] = []
  let result: PlanRowResult = lastResult
  for (let round = 0; round < 2; round++) {
    const available = Math.max(0, width - reserve)
    resolved = applyNaturalFloor(
      resolveRowItems(inputs, available, { narrow: narrow.value }),
      naturals,
      elastic
    )
    const key: PlanKey = { width: available, signature: planSignature(resolved) }
    if (shouldReplan(lastKey, key)) {
      lastKey = key
      lastResult = planRow(resolved, available, { gap: gap() })
    }
    result = lastResult
    const needButton = props.overflow !== 'none' && result.hidden.length > 0
    const nextReserve = needButton ? MORE_WIDTH + gap() : 0
    if (nextReserve === reserve) break
    reserve = nextReserve
  }
  apply(result, resolved)
}

function apply(result: PlanRowResult, resolved: RowItem[]): void {
  const byId = new Map(resolved.map((it) => [it.id, it]))
  const degraded = result.lines.length > 1 || result.hidden.length > 0
  tight.value = degraded
  hiddenCount.value = result.hidden.length
  emit('state', { lines: result.lines.length, hidden: result.hidden.length, tight: degraded })
  for (const slot of rowSlots(result)) {
    const item = byId.get(slot.id)
    slots[slot.id] = {
      visible: slot.visible,
      order: slot.order,
      basis: item && item.minWidth > 0 ? item.minWidth : 'auto',
      grow: item?.grow ?? false,
      tight: degraded
    }
  }
  if (!result.hidden.length) moreOpen.value = false
}

watch([containerWidth, () => registry.size, narrow], () => schedule())
watch(
  () => [props.gap, props.overflow, props.align],
  () => schedule()
)

onMounted(() => {
  childObserver = new ResizeObserver(() => schedule())
  for (const [, el] of elements) childObserver.observe(el)
  schedule()
})
onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  if (verifyFrame) cancelAnimationFrame(verifyFrame)
  verifyFrame = 0
  childObserver?.disconnect()
  childObserver = null
})

/* ── 「更多」溢出浮层 ─────────────────────────────────────────────────────── */

const moreLabel = computed(() => translate(uiLang.value, 'kit.overflow.more', '更多'))
const moreTitle = computed(() => translate(uiLang.value, 'kit.overflow.title', '更多选项'))

function toggleMore(): void {
  moreOpen.value = !moreOpen.value
  // 定位放在 moreOpen 的 watcher 里（等 v-show 生效、能读到浮层真实尺寸）
}

/** 锚定定位：全部测量走 getBoundingClientRect 再 ÷ zoom（页面缩放下混用口径会偏 10%
 *  并被视口右缘切掉，见 useAnchor 的说明）。打开 / 滚动 / 缩放时重算。 */
const { place: placePop } = useAnchor(moreBtnEl, popEl, {
  placement: 'bottom-end',
  active: moreOpen
})

watch(moreOpen, async (open) => {
  if (!open) return
  await nextTick()
  placePop()
  popEl.value?.focus()
})

// 浮层打开期间：点外面 / Esc / 滚动缩放 都要收起来
function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node | null
  if (!target) return
  if (popEl.value?.contains(target) || moreBtnEl.value?.contains(target)) return
  moreOpen.value = false
}
function onDocKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') moreOpen.value = false
}
watch(moreOpen, (open) => {
  if (typeof document === 'undefined') return
  if (open) {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeyDown)
  }
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeyDown)
  }
})
</script>

<template>
  <div class="kit-smart-row" :class="{ 'kit-smart-row--tight': tight }">
    <div v-if="label || hint" class="kit-smart-row__head">
      <span v-if="label" class="kit-smart-row__label text-body-2 font-weight-medium">{{
        label
      }}</span>
      <span v-if="hint" class="kit-smart-row__hint text-caption on-surface-variant">{{
        hint
      }}</span>
    </div>

    <div
      ref="target"
      class="kit-smart-row__line"
      :style="{ gap: `${gap()}px`, '--kit-row-align': align }"
    >
      <slot />
      <span
        v-if="overflow !== 'none' && hiddenCount > 0"
        ref="moreBtnEl"
        class="kit-smart-row__more"
      >
        <v-btn
          size="small"
          variant="text"
          icon
          :aria-label="moreLabel"
          :title="moreLabel"
          @click="toggleMore"
        >
          <v-icon>mdi-dots-horizontal</v-icon>
        </v-btn>
      </span>
    </div>

    <!-- 溢出浮层：常驻 body（v-show 只切显示），被隐藏的控件 teleport 进来，
         所以「更多」点开即有内容，且控件实例不重建（状态不丢） -->
    <Teleport to="body">
      <div
        v-show="moreOpen"
        ref="popEl"
        class="kit-overflow"
        role="dialog"
        tabindex="-1"
        :aria-label="moreTitle"
      >
        <div class="kit-overflow__head">
          <span class="text-subtitle-2">{{ moreTitle }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.kit-smart-row {
  min-width: 0;
}

.kit-smart-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding-bottom: 4px;
}

.kit-smart-row__hint {
  min-width: 0;
}

/* 行容器：flex-wrap 让浏览器按 flex-basis 断行——与引擎同一套算术，
   所以「lines 决定落到第几行」与浏览器实际断行一致；order 只调顺序不搬家。 */
.kit-smart-row__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
}

.kit-smart-row__line--start {
  align-items: flex-start;
}

/* 「更多」按钮排在所有元素之后，且不参与规划（flex:none 防被压缩） */
.kit-smart-row__more {
  order: 9999;
  display: inline-flex;
  flex: none;
}
</style>
