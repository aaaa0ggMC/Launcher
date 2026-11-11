/**
 * @ui/kit —— Launcher 内置 UI 库（框架代码，不是 ability）。
 *
 * 唯一 barrel，**显式导出**（不用 glob）：导入路径稳定，tree-shaking 友好，
 * 精简构建（toggle.json）也不会误伤。ability 里这样用：
 *
 *   import { KitPage, KitSmartRow, KitSettingRow } from '@ui/kit'
 *
 * 设计规范见 docs/launcher-ui.md（每个积木「什么时候用 / 不要用什么」）。
 */
import './kit.css'

// 排版引擎（纯函数，可单测；其余积木都建在它上面）
export {
  deriveMinWidth,
  estimateTextWidth,
  groupMinWidth,
  planRow,
  planSignature,
  resolveItemWidth,
  resolveRowItems,
  rowSlots,
  shouldReplan,
  type ItemKind,
  type ItemPriority,
  type PlanKey,
  type PlanRowOptions,
  type PlanRowResult,
  type RowItem,
  type RowItemInput,
  type RowSlot
} from './layout/engine'

// 网格令牌（所有尺寸从令牌算）
export { BREAKPOINTS, GRID, grid, narrowQuery } from './layout/tokens'

// 布局地基
export { default as KitGrid } from './layout/KitGrid.vue'
export { default as KitPage } from './layout/KitPage.vue'
export { default as KitSection } from './layout/KitSection.vue'
export { default as KitSmartRow } from './layout/KitSmartRow.vue'
export { default as KitRowItem } from './layout/KitRowItem.vue'
export { default as KitRowGroup } from './layout/KitRowGroup.vue'

// 设置行特化（P0）
export { default as KitNumberStepper } from './components/KitNumberStepper.vue'
export { default as KitSettingRow } from './components/KitSettingRow.vue'
export { default as KitCircleStat } from './components/KitCircleStat.vue'
export { default as KitTitle } from './components/KitTitle.vue'
export { default as KitProse } from './components/KitProse.vue'
export { default as KitCaption } from './components/KitCaption.vue'
export { default as KitHint } from './components/KitHint.vue'
export { default as KitCodeInline } from './components/KitCodeInline.vue'
export { default as KitImport } from './components/KitImport.vue'
export { default as KitDebugOutline } from './components/KitDebugOutline.vue'
export { default as KitPlaceholder } from './components/KitPlaceholder.vue'

// 测量 / 断点 / 材质 / 适配原语
export {
  appVh,
  useAdaptive,
  useContainerWidth,
  useNarrow,
  type Adaptive
} from './composables/useAdaptive'
export { anchorPosition, rootZoom, useAnchor, type AnchorPlacement } from './composables/useAnchor'
export { installKitSurface, useKitSurface } from './composables/useKitSurface'
export { useFitBox } from './composables/useFitBox'
export { circleDiameter, fitRatio, fitScale, fitState, type FitState } from './layout/fit'

// 行内上下文类型（给要读取行状态的调用方）
export { smartRowKey, rowGroupKey, DEFAULT_SLOT } from './layout/smart-row-context'
export type { SmartRowContext, SmartRowItemInput, SmartRowSlot } from './layout/smart-row-context'
