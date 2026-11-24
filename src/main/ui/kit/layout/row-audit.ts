/**
 * 第 3 类「对齐错乱」与第 4 类「同类尺寸不一致」的判定内核（纯函数，可单测）。
 *
 * 五类审计口径（docs/ui-defect-audit.md）：
 * - 第 3 类：同一视觉行（共享中线）内元素的中线 / 边缘偏差 > 1px——SPEC §4.5「行内对齐」
 *   默认 center，可覆盖为 start / end；对齐是声明出来的，不该靠魔数 margin 冒充
 *   （审计 3-2 的 mt-1 就是魔数对齐）。
 * - 第 4 类：同一行同 kind 的元素尺寸不一致——SPEC「行内三律」之三：差异只能来自
 *   密度阶，不能来自内容长短（用户抓过「一行内胶囊大小不一致」）。宽度契约只对
 *   等宽数值（kit-num，kit.css「读数不跳」）生效；内容驱动宽度的（胶囊、按钮）只比高度。
 *
 * 纯函数只算散布与判定；「哪些元素算一行 / 算同类」的分组策略在探针侧（按 DOM）。
 */

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/** 行内对齐声明（SPEC §4.5）：center 缺省 / start 顶对齐 / end 底对齐 */
export type RowAlign = 'center' | 'start' | 'end'

const span = (values: number[]): number => Math.max(0, Math.max(...values) - Math.min(...values))

/** 中线 y 的散布（max-min，px） */
export function centerSpread(boxes: Box[]): number {
  return span(boxes.map((b) => (b.top + b.bottom) / 2))
}

/** 某条边的散布（max-min，px）：左缘/右缘/顶/底同口径 */
export function edgeSpread(boxes: Box[], edge: keyof Box): number {
  return span(boxes.map((b) => b[edge]))
}

/**
 * 第 3 类判定：一行元素没按声明的对齐排齐（> tolerance px）。
 * center → 中线齐；start → 顶齐；end → 底齐。
 */
export function isAlignmentDefect(
  boxes: Box[],
  align: RowAlign,
  tolerance = 1
): boolean {
  if (boxes.length < 2) return false
  const spread =
    align === 'center'
      ? centerSpread(boxes)
      : align === 'start'
        ? edgeSpread(boxes, 'top')
        : edgeSpread(boxes, 'bottom')
  return spread > tolerance + 0.001
}

export type SizeDim = 'height' | 'width'

const dim = (b: Box, d: SizeDim): number => (d === 'height' ? b.bottom - b.top : b.right - b.left)

/** 尺寸散布：同一行同 kind 元素在指定维度上的差异（max-min，px） */
export function sizeSpread(boxes: Box[], d: SizeDim): number {
  return span(boxes.map((b) => dim(b, d)))
}

/**
 * 第 4 类判定：同一行同 kind 尺寸不一致（> tolerance px）。
 * 高度一律比（胶囊/按钮/控件的节奏底线）；宽度只对等宽数值类比
 * （调用方传 dims 决定，内容驱动宽度的 kind 不传 width）。
 */
export function isSizeDefect(
  boxes: Box[],
  dims: SizeDim[] = ['height'],
  tolerance = 1
): boolean {
  if (boxes.length < 2) return false
  return dims.some((d) => sizeSpread(boxes, d) > tolerance + 0.001)
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 5 类「文字碰撞 / 高低错落」判定（纯函数，可单测）
// ─────────────────────────────────────────────────────────────────────────────

/** 两矩形相交面积（px²，不含仅贴边） */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** 一个矩形是否包含另一个（父子/覆盖层，不算碰撞） */
export function contains(a: Box, b: Box): boolean {
  return a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom
}

/**
 * 碰撞/重叠缺陷：非父子的可见元素矩形相交（> tolerance px²）。
 * 文字被压住、浮标压在控件上（审计 5-4）都是这类；贴边（0 面积）不算。
 */
export function isCollision(a: Box, b: Box, tolerance = 1): boolean {
  return !contains(a, b) && !contains(b, a) && overlapArea(a, b) > tolerance
}

/**
 * 高低错落（视觉断层）：同一行容器里元素的顶缘散布超过「行高」的一半。
 * 行高 = 最矮成员的高度（1px 行/图标不把阈值拉没）。折行到第二行的元素
 * top 差接近整个行高，必然超过一半；正常同排的顶缘差只来自高度差的一半。
 */
export function isStaggered(boxes: Box[], tolerance = 0): boolean {
  if (boxes.length < 2) return false
  const lineH = Math.min(...boxes.map((b) => b.bottom - b.top))
  const topDev = edgeSpread(boxes, 'top')
  return topDev > lineH / 2 + tolerance
}

/** 两文本元素的水平间距（px）：负值 = 重叠，0 = 贴着 */
export function horizontalGap(a: Box, b: Box): number {
  return Math.max(a.left, b.left) - Math.min(a.right, b.right)
}
