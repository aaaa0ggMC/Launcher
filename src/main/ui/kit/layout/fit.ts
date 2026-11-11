/**
 * 「内容占容器 80%」规则 —— kit 的正式排版规则，余下 20% 做呼吸。
 *
 * 来源：设计规范里「内容占据容器的 80% 是理想状态」。落到工程上就是一条可算的判据：
 * 内容的最大边长占比 ≤ 80% = roomy；≤ 100% = tight（还够用，但没呼吸）；
 * > 100% = overflow（必须降档，否则裁切 / 出滚动条）。
 *
 * 适用于圆形 stat、输入框、chip、图标按钮、徽标——凡是「定宽盒子里放内容」的地方。
 * 纯函数部分在这里（可单测）；DOM 测量在 useFitBox / KitFitBox。
 */

export type FitState = 'roomy' | 'tight' | 'overflow'

export interface BoxSize {
  width: number
  height: number
}

/** 内容占容器的最大边长占比（0 = 空，>1 = 溢出） */
export function fitRatio(content: BoxSize, container: BoxSize): number {
  if (container.width <= 0 || container.height <= 0) return 0
  return Math.max(content.width / container.width, content.height / container.height)
}

/** 判定当前是 roomy / tight / overflow */
export function fitState(content: BoxSize, container: BoxSize): FitState {
  const r = fitRatio(content, container)
  if (r <= 0) return 'roomy'
  if (r <= 0.8) return 'roomy'
  if (r <= 1) return 'tight'
  return 'overflow'
}

/**
 * 降档系数：把内容压进容器的 80% 需要的缩放（1 = 不用动）。
 * overflow 时 < 1（降字号 / 降内边距），否则 1。
 * 有 0.5 下限：再夸张也只压一半——剩下的交给调用方按 fit 状态做更激进的退化
 * （藏次要信息），而不是把文字缩到看不见。
 */
export function fitScale(content: BoxSize, container: BoxSize, target = 0.8): number {
  const r = fitRatio(content, container)
  if (r <= 0 || r <= target) return 1
  return Math.max(0.5, target / r)
}

/** 圆形 stat 的直径推导：文字占直径的 80% → 直径 = 文本尺寸 × 1.25，夹在 min/max 之间 */
export function circleDiameter(text: BoxSize, min = 40, max = 120): number {
  const longest = Math.max(text.width, text.height)
  return Math.round(Math.min(Math.max(longest * 1.25, min), max))
}
