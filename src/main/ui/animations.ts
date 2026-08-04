/**
 * Available page-switch transitions (设置 → 外观 → 界面动画).
 * `key` is the CSS class suffix (`page-<key>`); `labelKey` is the i18n key.
 * Add a new entry here + a `.page-<key>-*` block in global.css to extend.
 */
export const PAGE_TRANSITIONS = [
  { key: 'fade', labelKey: 'animation.fade' },
  { key: 'slide', labelKey: 'animation.slide' },
  { key: 'slide-up', labelKey: 'animation.slideUp' },
  { key: 'zoom', labelKey: 'animation.zoom' },
  { key: 'flip', labelKey: 'animation.flip' }
] as const

export type PageTransitionKey = (typeof PAGE_TRANSITIONS)[number]['key']
