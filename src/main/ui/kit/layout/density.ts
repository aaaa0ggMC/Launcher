import { inject, provide } from 'vue'
import type { InjectionKey } from 'vue'

/**
 * 密度上下文（SPEC「密度阶」）：控件层**不要求调用方记参数**。
 *
 * 背景（用户第三次提「combobox 根本没改过」）：inline 档做好了，但密度要靠每个调用方
 * 记得传 `size="inline"`——demo 和迁移过的分区一忘就前功尽弃，用户看到的就是「没改过」。
 * 现在由容器提供：`KitSettingRow`  provide 'inline'，控件层未显式传 size 时读它；
 * 在设置行里 = inline（35px underlined），在外面 = input（44px outlined）。
 * 显式 `size` prop 仍然优先（逃生门）。
 */
export type KitDensity = 'input' | 'inline'

export const kitDensityKey: InjectionKey<KitDensity> = Symbol('kit-density')

/** 容器侧：给子树提供密度 */
export function provideDensity(d: KitDensity): void {
  provide(kitDensityKey, d)
}

/** 控件侧：解析生效的密度（显式 prop > 上下文 > input） */
export function resolveDensity(
  explicit: KitDensity | undefined,
  ctx: KitDensity | undefined
): KitDensity {
  return explicit ?? ctx ?? 'input'
}

/** 控件侧：读上下文（组件里用） */
export function useKitDensity(): KitDensity | undefined {
  return inject(kitDensityKey, undefined)
}
