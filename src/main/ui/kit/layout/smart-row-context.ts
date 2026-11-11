import type { InjectionKey, Ref } from 'vue'
import type { ItemKind, ItemPriority } from './engine'

/** KitRowItem 向 KitSmartRow 登记的信息（作者声明的部分） */
export interface SmartRowItemInput {
  id: string
  priority: ItemPriority
  /** 显式声明的下限；缺省 = 自动（内容推导 / 实测缓存） */
  minWidth?: number
  kind?: ItemKind
  text?: string
  icon?: boolean
  grow?: boolean
  /** KitRowGroup 注入的分组 id */
  group?: string
  /**
   * 内容可优雅压缩（省略号文字 / 百分比宽控件）：允许被压到声明下限以下。
   * 缺省 false = 刚性——实测自然宽度会作为下限并回来，避免被 overflow:hidden 裁掉。
   */
  elastic?: boolean
}

/** 单个元素在行里的排版指令（由 planRow 推导，CSS 应用，DOM 不搬家） */
export interface SmartRowSlot {
  visible: boolean
  /** CSS order */
  order: number
  /** flex-basis：解析出的下限（px）；'auto' = 还没实测，让浏览器按自然尺寸排 */
  basis: number | 'auto'
  grow: boolean
  /** 行内退化态（多行 / 有隐藏）——整体降一档密度的信号 */
  tight: boolean
}

export interface SmartRowContext {
  register(item: SmartRowItemInput, el: HTMLElement | null): void
  unregister(id: string): void
  /** 所有元素的排版指令（响应式） */
  slots: Record<string, SmartRowSlot>
  narrow: Ref<boolean>
  /** 行是否处于退化态（多行 / 有元素被隐藏） */
  tight: Ref<boolean>
  /** 被隐藏（收进「更多」浮层）的元素个数 */
  hiddenCount: Ref<number>
  /** 溢出浮层的挂载点：被隐藏的控件 teleport 到这里（overflow="none" 时为 null） */
  overflowTarget: Ref<HTMLElement | null>
  overflowOpen: Ref<boolean>
}

export const smartRowKey: InjectionKey<SmartRowContext> = Symbol('kit-smart-row')

/** KitRowGroup 注入的分组 id（同组元素争取同一行） */
export const rowGroupKey: InjectionKey<string> = Symbol('kit-row-group')

/** 未接入行（或行还没规划）时的兜底指令：按自然尺寸排在第一行 */
export const DEFAULT_SLOT: SmartRowSlot = {
  visible: true,
  order: 0,
  basis: 'auto',
  grow: false,
  tight: false
}
