import { inject, type InjectionKey } from 'vue'

/**
 * 打开某个能力的设置 —— 框架 API（shell 由 App.vue provide）。
 *
 *   const settings = useSettings()
 *   if (settings.has('campusinfo')) settings.open('campusinfo')
 *
 * - 设置页（settings 能力）存在 → 跳到设置页，并直接定位到该能力的分类（可选到具体设置项）；
 * - 设置页不存在（被移除 / 禁用）→ 弹出浮窗，只显示该能力注入的设置项。
 *
 * 能力因此不再依赖 settings 能力：只要它在 `index.ts` 的 `settings` 里注入了设置，
 * 用户总能打开。不要再用 `activate('settings', {})` 这种硬编码跳转。
 */
export interface SettingsTarget {
  /** 能力 id（`index.ts` 的 id） */
  ability: string
  /** 该能力的某个设置分类 key（`settings[].key`）；缺省 = 第一个 */
  category?: string
  /** 分类下的某个设置项 key（`items[].key`）；缺省 = 只定位到分类 */
  item?: string
}

/** open 的结果：page = 跳到设置页，dialog = 弹出浮窗，none = 该能力没有注入设置 */
export type SettingsOpenResult = 'page' | 'dialog' | 'none'

export interface SettingsApi {
  /** 该能力（可选：某个分类）是否注入了设置 —— 用来决定是否显示「去设置」按钮 */
  has: (ability: string, category?: string) => boolean
  open: (target: string | SettingsTarget) => SettingsOpenResult
}

export const SETTINGS_API: InjectionKey<SettingsApi> = Symbol('cockpit:settings-api')

const NONE: SettingsApi = { has: () => false, open: () => 'none' }

export function useSettings(): SettingsApi {
  return inject(SETTINGS_API, NONE)
}

export function normalizeTarget(t: string | SettingsTarget): SettingsTarget {
  return typeof t === 'string' ? { ability: t } : t
}
