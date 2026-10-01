/**
 * 外观配置的应用逻辑（UI 缩放 / 全局字体），主窗口 App.vue 与独立子窗口（如隐私授权窗口）共用——
 * 子窗口是独立的渲染进程，不会继承主窗口的 zoom 与 `--cockpit-font`。
 */

/** config.json 的 `uiScale` 缺省 / 非法时的回落值（与设置页默认一致）。 */
export const DEFAULT_UI_SCALE = 1.1

export function resolveUiScale(raw: unknown): number {
  const scale = Number(raw)
  return Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_UI_SCALE
}

/** 等比缩放当前窗口（Electron webFrame.setZoomFactor）。 */
export function applyUiScale(raw: unknown): void {
  window.cockpit.setZoom(resolveUiScale(raw))
}

/** Characters that could terminate the declaration or break out of the value
 *  when a user-supplied family name is injected as a CSS custom property. */
function sanitizeFontFamily(raw: string): string {
  return raw
    .replace(/["'`;{}()<>\\]/g, '')
    .trim()
    .slice(0, 120)
}

/**
 * Global interface font (设置 → 外观 → 字体). Exposes `--cockpit-font` on
 * <html>; global.css consumes it for `body` + `.v-application` (mono stack is
 * untouched). Modes: default → unset (the built-in Noto CJK stack), system →
 * the platform UI font, custom → the user's family name quoted once, with a
 * system fallback tail. An empty / whitespace custom family falls back to
 * default rather than emitting a broken declaration.
 */
export function applyFont(raw: unknown): void {
  const font = raw as { mode?: string; family?: string } | undefined
  const mode = font?.mode ?? 'default'
  const style = document.documentElement.style
  if (mode === 'system') {
    style.setProperty('--cockpit-font', "system-ui, -apple-system, 'Segoe UI', sans-serif")
    return
  }
  if (mode === 'custom') {
    const family = sanitizeFontFamily(typeof font?.family === 'string' ? font.family : '')
    if (family) {
      style.setProperty('--cockpit-font', `'${family}', system-ui, sans-serif`)
      return
    }
  }
  style.removeProperty('--cockpit-font')
}
