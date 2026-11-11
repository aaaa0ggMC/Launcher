/**
 * 排版引擎 —— 纯函数，无 DOM、无副作用、可单测。
 *
 * 它只回答一个问题：**按下限装，这一行装得下吗**。
 *
 * `minWidth` 的语义是「低于这个宽度该元素就不可用」，**不是**「它将会是多宽」。
 * 实际渲染多宽由 CSS（flex-basis / flex-shrink / flex-grow）在运行时决定，引擎不预测、
 * 也不需要预测——这让规划保持纯函数，也让「JS 完全不工作页面也可用」成立
 * （见 KitSmartRow：先按自然尺寸渲染，实测后再重规划）。
 *
 * 空间不够时的策略顺序（从温和到激烈，与 DESIGN.md「别用小尺寸逃避布局问题」一致）：
 *   1. 缩小：grow 元素先 flex-shrink 到各自 minWidth，文字 ellipsis（CSS 负责，引擎不参与）
 *   2. 隐藏：tertiary → secondary 依次隐藏（primary 永不隐藏）；隐藏不静默消失，
 *      KitSmartRow 会把它们收进行尾「更多」浮层
 *   3. 换行：还装不下才换行——`[名字]` 单独一行，`[slider][数值]` 下一行
 *
 * Group（KitRowGroup）把若干元素捆成一个规划单元：组内争取同一行，组之间才竞争空间。
 */

/** 元素优先级：primary 永不隐藏（宁可换行）；tertiary 最先被隐藏 */
export type ItemPriority = 'primary' | 'secondary' | 'tertiary'

/** 控件类型：没声明 minWidth 时按类型 + 文字内容推导下限 */
export type ItemKind = 'label' | 'slider' | 'number' | 'icon' | 'control' | 'custom'

/** 规划用的元素：minWidth 已经解析好（声明 / 实测缓存 / 内容推导，见 resolveItemWidth） */
export interface RowItem {
  id: string
  priority: ItemPriority
  /** 下限宽度（px）：低于这个宽度该元素就不可用 */
  minWidth: number
  /** 允许拉伸填满剩余空间（组件据此给 flex-grow；引擎不参与宽度计算） */
  grow?: boolean
  /** 分组 id：同组元素争取排在同一行 */
  group?: string
}

/** 作者输入：只填声明部分，其余由 resolveItemWidth 推导 / 实测缓存补全 */
export interface RowItemInput {
  id: string
  priority: ItemPriority
  /** 作者显式声明的下限（优先级最高，作者说了算） */
  minWidth?: number
  /** 控件类型（内容推导用） */
  kind?: ItemKind
  /** 文字内容（label 用 ch 估算；带文字的控件与类型默认值取大） */
  text?: string
  /** 是否带前置图标（估算 +20px） */
  icon?: boolean
  /** 首帧实测自然宽度（ResizeObserver 量到后回填） */
  naturalWidth?: number
  grow?: boolean
  group?: string
}

export interface PlanRowOptions {
  /** 元素间距（px）。引擎与 CSS 用同一个值，保证规划与实际排版一致 */
  gap: number
}

export interface PlanRowResult {
  /** 每一行的元素（行内保持传入顺序） */
  lines: RowItem[][]
  /** 被隐藏的元素 id（空间不足时按优先级腾位；primary 永不出现） */
  hidden: string[]
}

/* ---------------------------------------------------------------------------
 * 下限从哪来：声明 > 实测缓存 > 内容推导
 * ------------------------------------------------------------------------- */

/** 默认字号：body-2 = 0.875rem */
const DEFAULT_FONT_SIZE = 14
/** 前置图标宽度 + 图标与文字之间的间距 */
const ICON_WIDTH = 20
const ICON_GAP = 8
/** 控件左右内边距合计 */
const CONTROL_PADDING = 8
/** 实测缓存相对自然宽度的收缩系数：能缩到 60% 仍可用 */
const NATURAL_RATIO = 0.6

/** CJK / 全角字符占 1em，其余（拉丁 / 数字 / 空格）按 0.55em 估算 */
const FULL_WIDTH_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/

interface KindPreset {
  /** 内容推导的默认宽度（桌面 / 手机） */
  desktop: number
  mobile: number
  /** 类型下限：实测缓存 clamp 的下界，也是「不可用」的底线 */
  floor: number
}

/**
 * 各控件类型的推导默认值。作者不需要手填任何数字——只有特殊控件才需要显式 minWidth。
 */
const KIND_PRESETS: Record<ItemKind, KindPreset> = {
  // 标签走文字估算，这里只提供下限
  label: { desktop: 0, mobile: 0, floor: 32 },
  slider: { desktop: 120, mobile: 88, floor: 88 },
  number: { desktop: 64, mobile: 64, floor: 56 },
  icon: { desktop: 40, mobile: 40, floor: 40 },
  control: { desktop: 88, mobile: 88, floor: 64 },
  custom: { desktop: 0, mobile: 0, floor: 0 }
}

/** 按字符估算一行文字的像素宽度：CJK 全角 1em，其余 0.55em */
export function estimateTextWidth(text: string, fontSize = DEFAULT_FONT_SIZE): number {
  let em = 0
  for (const ch of text) em += FULL_WIDTH_RE.test(ch) ? 1 : 0.55
  return Math.ceil(em * fontSize)
}

/**
 * 内容推导：没声明 minWidth 时，按控件类型 + 文字内容算出建议下限。
 * 标签/文字用 ch 估算（字数 × 字宽 + 图标 + gap），slider / 数值框 / 图标按钮给类型默认值。
 */
export function deriveMinWidth(item: RowItemInput, opts: { narrow?: boolean } = {}): number {
  const preset = KIND_PRESETS[item.kind ?? 'custom']
  const base = opts.narrow ? preset.mobile : preset.desktop
  const isLabel = item.kind === 'label' || (!item.kind && item.text !== undefined)
  if (isLabel) {
    const text = estimateTextWidth(item.text ?? '')
    const extra = (item.icon ? ICON_WIDTH + ICON_GAP : 0) + CONTROL_PADDING
    return Math.max(preset.floor, text + extra)
  }
  if (item.text) {
    // 带文字的控件（如「确定」按钮）：类型默认值与文字宽度取大
    return Math.max(base, preset.floor, estimateTextWidth(item.text) + CONTROL_PADDING)
  }
  return Math.max(base, preset.floor)
}

/**
 * 下限解析：声明 > 实测缓存 > 内容推导。
 * 实测缓存 = clamp(naturalWidth × 0.6, 类型下限, naturalWidth)：
 * 元素最多可被压缩到自然宽度的 60%，但不低于该控件类型的可用底线。
 */
export function resolveItemWidth(item: RowItemInput, opts: { narrow?: boolean } = {}): number {
  if (typeof item.minWidth === 'number' && item.minWidth > 0) return Math.ceil(item.minWidth)
  const derived = deriveMinWidth(item, opts)
  const natural = item.naturalWidth
  if (typeof natural === 'number' && natural > 0) {
    const preset = KIND_PRESETS[item.kind ?? 'custom']
    return Math.round(Math.min(Math.max(natural * NATURAL_RATIO, preset.floor), natural))
  }
  return derived
}

/**
 * 把作者输入解析成规划用的 RowItem。
 * 顺带把下限夹到 availableWidth 以内：引擎不会因为「元素自身超宽」而隐藏内容
 * （隐藏只按优先级规则发生），夹取后超宽元素独占一行，由 CSS 收缩兜底。
 */
export function resolveRowItems(
  inputs: RowItemInput[],
  availableWidth: number,
  opts: { narrow?: boolean } = {}
): RowItem[] {
  const width = Math.max(0, availableWidth)
  return inputs.map((it) => {
    const resolved = resolveItemWidth(it, opts)
    return {
      id: it.id,
      priority: it.priority,
      minWidth: width > 0 ? Math.min(resolved, width) : resolved,
      grow: it.grow,
      group: it.group
    }
  })
}

/* ---------------------------------------------------------------------------
 * 滞回：宽度变化不超过阈值、结构没变就不重规划
 * ------------------------------------------------------------------------- */

export interface PlanKey {
  /** 容器宽度（px） */
  width: number
  /** items 结构签名 */
  signature: string
}

/** items 结构签名：id / 优先级 / 下限 / 分组 / grow 任一变化都要重规划 */
export function planSignature(items: RowItem[]): string {
  return items
    .map((it) => `${it.id}:${it.priority}:${it.minWidth}:${it.group ?? ''}:${it.grow ? 1 : 0}`)
    .join('|')
}

/**
 * 滞回判断：容器宽度变化不超过阈值（默认 8px）、items 结构没变就不重规划——
 * 防止缩放窗口 / 键盘弹出时规划结果反复横跳。残余的几像素由 CSS flex-shrink 兜底。
 */
export function shouldReplan(prev: PlanKey | null, next: PlanKey, threshold = 8): boolean {
  if (!prev) return true
  if (prev.signature !== next.signature) return true
  return Math.abs(prev.width - next.width) > threshold
}

/* ---------------------------------------------------------------------------
 * planRow：贪心装行 + 事务性腾位 + 换行
 * ------------------------------------------------------------------------- */

const PRIORITY_RANK: Record<ItemPriority, number> = { tertiary: 0, secondary: 1, primary: 2 }

function unitWidth(unit: RowItem[], gap: number): number {
  if (!unit.length) return 0
  let sum = 0
  for (const it of unit) sum += Math.max(0, it.minWidth)
  return sum + gap * (unit.length - 1)
}

/**
 * 把实测自然宽度并回下限（「不裁切」不变量的关键一步）。
 *
 * 引擎用 minWidth 装行，但**实际渲染宽度可能大于 minWidth**（声明的下限是个谎言：
 * 文字估算差几个 px、控件有最小内容宽）。这时元素会被外层 `overflow:hidden` 裁掉一截
 * ——实测复现：自绘 chip 声明 46px、自然 49px，右缘被切 3px。
 *
 * 规则：**刚性元素**（内容不能优雅压缩：chip、按钮、定宽控件）的下限抬到自然宽度；
 * **弹性元素**（省略号文字、百分比宽控件）保持声明下限——它们本来就该被压。
 * 调用方在「溢出复核」里发现谁被裁了，就把谁标成刚性再重规划（见 KitSmartRow）。
 */
export function applyNaturalFloor(
  items: RowItem[],
  natural: Record<string, number>,
  elastic: Record<string, boolean> = {}
): RowItem[] {
  return items.map((it) => {
    const n = natural[it.id]
    if (!n || n <= it.minWidth || elastic[it.id]) return it
    return { ...it, minWidth: Math.ceil(n) }
  })
}

/** Group 的规划宽度 = 成员 minWidth 之和 + 成员间 gap */
export function groupMinWidth(items: RowItem[], gap: number): number {
  return unitWidth(items, gap)
}

interface HideCandidate {
  index: number
  priority: ItemPriority
}

/**
 * 从数组尾部往前找优先级最低的可隐藏元素（primary 永不隐藏；同级取更靠近尾部的）。
 */
function pickHideCandidate(arr: RowItem[], skip: number[]): HideCandidate | null {
  let best: HideCandidate | null = null
  for (let i = arr.length - 1; i >= 0; i--) {
    if (skip.includes(i)) continue
    const priority = arr[i].priority
    if (priority === 'primary') continue
    if (!best || PRIORITY_RANK[priority] < PRIORITY_RANK[best.priority]) {
      best = { index: i, priority }
    }
  }
  return best
}

interface RoomPlan {
  /** 要从当前行隐藏的元素下标 */
  hideLine: number[]
  /** 要从待放单元隐藏的元素下标 */
  hideUnit: number[]
}

/**
 * 事务性腾位：找一组「隐藏哪些元素」能让待放单元放进当前行；腾不成返回 null
 * （调用方换行，且**不丢内容**——失败时不提交任何隐藏）。
 *
 * 候选顺序：全局按优先级从低到高（tertiary → secondary）；同级时**待放单元自己的尾部优先**
 * ——新元素的次要部分先让位，已经渲染出来的内容不闪动；再轮到当前行尾部
 * （这就是「把该行尾部低优先级元素移入 hidden 腾地方」）。
 */
function findRoom(line: RowItem[], unit: RowItem[], gap: number, width: number): RoomPlan | null {
  const hideLine: number[] = []
  const hideUnit: number[] = []
  const rest = (arr: RowItem[], skip: number[]): RowItem[] =>
    arr.filter((_, i) => !skip.includes(i))
  for (;;) {
    const kept = rest(line, hideLine)
    const remaining = rest(unit, hideUnit)
    // 待放单元被整个藏掉了：没什么要放的，直接算腾成了
    // （否则「当前行刚好满」时 room 会是负数，连空单元都塞不进去，白白多换一行）
    if (!remaining.length) return { hideLine, hideUnit }
    const room = width - unitWidth(kept, gap) - (kept.length ? gap : 0)
    if (unitWidth(remaining, gap) <= room) return { hideLine, hideUnit }
    const candUnit = pickHideCandidate(unit, hideUnit)
    const candLine = pickHideCandidate(line, hideLine)
    let chosen: { from: 'unit' | 'line'; index: number; priority: ItemPriority } | null = null
    if (candUnit && candLine) {
      chosen =
        PRIORITY_RANK[candUnit.priority] <= PRIORITY_RANK[candLine.priority]
          ? { from: 'unit', ...candUnit }
          : { from: 'line', ...candLine }
    } else if (candUnit) {
      chosen = { from: 'unit', ...candUnit }
    } else if (candLine) {
      chosen = { from: 'line', ...candLine }
    }
    if (!chosen) return null
    if (chosen.from === 'unit') hideUnit.push(chosen.index)
    else hideLine.push(chosen.index)
  }
}

/**
 * 行级排版规划：贪心从左到右装当前行；当前行装不下时先尝试把低优先级元素移入 hidden
 * 腾地方（tertiary → secondary，primary 永不隐藏），仍装不下才换行。
 *
 * 不变量：任何输入下都不会丢失元素（每个 id 要么在 lines 里，要么在 hidden 里），
 * 且除「单元素自身超宽」外每一行的宽度都不超过 availableWidth。
 */
export function planRow(
  items: RowItem[],
  availableWidth: number,
  opts: PlanRowOptions
): PlanRowResult {
  const gap = Math.max(0, opts.gap ?? 0)
  const width = Math.max(0, availableWidth)
  const lines: RowItem[][] = []
  const hidden: string[] = []
  if (!items.length) return { lines, hidden }

  // 分组：同 group 的元素捆成一个规划单元（单元位置取首次出现处，成员保持相对顺序）
  const units: RowItem[][] = []
  const byGroup = new Map<string, RowItem[]>()
  for (const it of items) {
    if (!it.group) {
      units.push([it])
      continue
    }
    let unit = byGroup.get(it.group)
    if (!unit) {
      unit = []
      byGroup.set(it.group, unit)
      units.push(unit)
    }
    unit.push(it)
  }

  let line: RowItem[] = []
  for (let ui = 0; ui < units.length; ui++) {
    let unit = units[ui]
    for (;;) {
      const room = width - unitWidth(line, gap) - (line.length ? gap : 0)
      if (unitWidth(unit, gap) <= room) {
        line.push(...unit)
        break
      }
      // 装不下：先尝试腾位（事务性——腾不成分文不取，直接换行）
      const plan = findRoom(line, unit, gap, width)
      if (plan) {
        const kept = line.filter((_, i) => !plan.hideLine.includes(i))
        const rest = unit.filter((_, i) => !plan.hideUnit.includes(i))
        for (const i of plan.hideLine) hidden.push(line[i].id)
        for (const i of plan.hideUnit) hidden.push(unit[i].id)
        line = kept
        line.push(...rest)
        break
      }
      // 腾不成：换行后重试同一单元
      if (line.length) {
        lines.push(line)
        line = []
        continue
      }
      // 空行仍装不下：Group 拆成单个元素各自竞争（保留内容，不整组消失）
      if (unit.length > 1) {
        units.splice(ui, 1, ...unit.map((it) => [it]))
        unit = units[ui]
        continue
      }
      // 单元素自身超宽：primary 独占一行（引擎不因宽度隐藏 primary——调用方应把 minWidth 夹到
      // availableWidth 内，resolveRowItems 已做，CSS flex-shrink 再兜底）；
      // secondary / tertiary 在 findRoom 里就已经被藏掉了（装不下还硬排只会溢出）
      line.push(unit[0])
      break
    }
  }
  if (line.length) lines.push(line)
  return { lines, hidden }
}

/* ---------------------------------------------------------------------------
 * 应用：lines 决定元素落到第几行——用 CSS order，不搬家 DOM
 * ------------------------------------------------------------------------- */

export interface RowSlot {
  id: string
  /** 视觉顺序（CSS order） */
  order: number
  visible: boolean
}

/** 把规划结果摊平成「每个元素的排版指令」 */
export function rowSlots(result: PlanRowResult): RowSlot[] {
  const slots: RowSlot[] = []
  let order = 0
  for (const line of result.lines) {
    for (const it of line) slots.push({ id: it.id, order: order++, visible: true })
  }
  for (const id of result.hidden) slots.push({ id, order: order++, visible: false })
  return slots
}
