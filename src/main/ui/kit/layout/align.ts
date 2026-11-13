/**
 * 行内对齐（SPEC「行内对齐」）——默认 center，可显式覆盖。
 *
 * 硬规则：**一行之内所有元素共享同一条中线**（文字、输入、下拉、滑块、开关、chip、
 * 图标按钮、右侧数值），偏差 ≤ 1px。实现落在机制上：`.kit-control .v-field`
 * 一条治所有 affix，行/元素用 CSS 变量链（--kit-row-align → --kit-item-align →
 * --kit-field-align）传递，缺省全部回落 center。
 *
 * 覆盖必须是少数、有理由、看得见的：只有多行文字、顶部对齐的图标+两行说明这类场景
 * 才传 align，且布局自检（KitDebugOutline）会把偏离行默认对齐模式的元素标出来。
 */
export type KitAlign = 'center' | 'start' | 'end' | 'baseline' | 'stretch'

/** 行的默认对齐（SPEC 硬规则） */
export const DEFAULT_ALIGN: KitAlign = 'center'

/** 是否偏离**所在行**的对齐模式（自检用来决定要不要标出来）；
 *  行自己传的非 center 不算「元素在破坏整齐」——那一整行都是那个模式。 */
export function isAlignOverride(
  align: KitAlign | undefined,
  rowAlign: KitAlign = DEFAULT_ALIGN
): boolean {
  return (align ?? rowAlign) !== rowAlign
}

export interface AlignSample {
  top: number
  height: number
  /** 几何中心 = top + height / 2 */
  center: number
}

/**
 * 把一行的子元素按**视觉行**（flex line）分组：换行的行里，每条 flex line 有各自的
 * 中线——用整个容器当参照会把这些正常换行的元素误判成「没对齐」（实测 232px 档
 * 误报 22px）。同一条 flex line 上的元素中心相同（align-items:center），
 * 不同 line 之间至少隔着一个元素的高度，按半个最大高度聚类即可。
 */
export function clusterLines<T extends AlignSample>(samples: T[]): T[][] {
  const sorted = [...samples].sort((a, b) => a.center - b.center)
  const groups: T[][] = []
  let cur: T[] = []
  let maxH = 0
  for (const s of sorted) {
    if (
      cur.length &&
      Math.abs(s.center - cur[cur.length - 1].center) > Math.max(maxH, s.height) / 2 + 2
    ) {
      groups.push(cur)
      cur = []
      maxH = 0
    }
    cur.push(s)
    maxH = Math.max(maxH, s.height)
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** 一条视觉行的共享中线（取该行所有元素中心的均值） */
export function lineMidpoint(samples: AlignSample[]): number {
  if (!samples.length) return 0
  return samples.reduce((sum, s) => sum + s.center, 0) / samples.length
}
