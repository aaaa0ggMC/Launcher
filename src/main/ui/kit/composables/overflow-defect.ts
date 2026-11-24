/**
 * 第 2 类信息展示缺陷「溢出 / 被裁」的判定内核（纯函数，可单测）。
 *
 * 五类审计口径（docs/ui-defect-audit.md）里第 2 类的定义：内容被**硬切**且没有揭示
 * 去处——元素自己装不下（scrollWidth > clientWidth）或右缘被祖先 overflow 盒裁掉，
 * 而它又没有「真截断 + 揭示」这条合法降级路径（SPEC §9.5 档 1）。合法裁剪（ellipsis
 * + title/点按浮层）是档 1 的正常工作状态，不算第 2 类；**裁了又没去处**才算缺陷。
 *
 * 判定与 useTruncatable 的「真截断」同口径（自裁 sw>cw / 祖裁 right>clipRight，
 * clipRight 是祖先第一个 overflow 非 visible 盒子的 **padding 右缘**），区别只在
 * 「有没有揭示」：真截断 + 揭示 = 合法；真截断 + 无揭示 = 缺陷（档 1 或本类）。
 */

export interface OverflowProbe {
  /** 自身内容宽 / 盒子宽（布局像素） */
  scrollWidth: number
  clientWidth: number
  /** 自身右缘（视觉像素） */
  right: number
  /** 祖先链第一个 overflow 非 visible 盒子的 padding 右缘；没有则 null */
  clipRight: number | null
  /**
   * 合法降级已就位：真截断状态且揭示原语已挂（.kit-truncated--cut / title 已挂）。
   * 由调用方按 DOM 状态算好传进来。
   */
  revealed: boolean
}

/** 自己这个盒子在装不下内容 */
export function selfOverflows(p: OverflowProbe): boolean {
  return p.clientWidth > 0 && p.scrollWidth > p.clientWidth + 1
}

/** 被祖先 overflow 盒硬裁（padding 边缘口径） */
export function clippedByAncestor(p: OverflowProbe): boolean {
  return p.clipRight !== null && p.right > p.clipRight + 1
}

/**
 * 是不是第 2 类缺陷：真的被裁/溢出，且**没有**揭示去处。
 * 有揭示（真截断 + title/点按）= SPEC 档 1 的合法降级，放行。
 */
export function isOverflowDefect(p: OverflowProbe): boolean {
  if (!selfOverflows(p) && !clippedByAncestor(p)) return false
  return !p.revealed
}
