/**
 * kit 的网格令牌 —— 所有 padding / gap / 圆角 / 最小尺寸都从令牌算，不写裸数字。
 * 断点令牌也在这里（useAdaptive 转出去，保持既有导入路径可用）。
 *
 * 设计口径（用户：「所有的组件都采用的是网格式计算&布局」）：
 * - 基础单位 4px：一切尺寸都是它的整数倍，肉眼可对齐；
 * - 栏距 8px（2 单位）：区块间距起步（DESIGN §3「ga-2 起步，密集区至少 ga-1」）；
 * - 触控热区 40px（10 单位）：图标按钮的点击下界（v-btn size=small 只有 ~32px）；
 * - 控件高度：文字按钮 36px（9 单位，DESIGN §3 的 compact 兜底）、图标按钮 32px（8 单位）。
 */

export const GRID = {
  /** 基础单位（px） */
  unit: 4,
  /** 栏距 / 区块间距（px） */
  gutter: 8,
  /** 圆角（px） */
  radius: 12,
  /** 卡片内边距（px） */
  pad: 12,
  /** 触控热区下界（px） */
  touch: 40,
  /** 文字按钮高度（px）——DESIGN §3：compact 下已全局兜底为 36px */
  controlHeight: 36,
  /** 图标按钮高度（px） */
  iconHeight: 32
} as const

/** 网格单位 → px（`grid(3)` = 12px） */
export function grid(n: number): number {
  return GRID.unit * n
}

/** 断点令牌：kit 唯一一套（仓里原有 480/520/560/600/640/720 六种并存，后续迁移都引用这三个） */
export const BREAKPOINTS = {
  /** 小屏：手机 */
  sm: 600,
  /** 中屏：平板 / 窄桌面 */
  md: 960,
  /** 全站窄屏兼容值（App.vue / 各能力的 matchMedia 口径） */
  narrow: 720
} as const

/** 窄屏判定的 media query（单独导出便于单测与检索还有没有手写魔数） */
export function narrowQuery(bp: number): string {
  return `(max-width: ${bp}px)`
}
